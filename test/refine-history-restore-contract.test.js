'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SCHEMA_VERSION,
  VERSION_RESTORE_SCHEMA_VERSION,
  SUPPORTED_OPERATION_SCHEMAS,
  RefineError,
  createRefineOperation,
  createRestoreOperation,
  createVersionRestoreOperation,
  validateOperationIntegrity,
  validateRestoreRelationship,
  assertNoRestoreCycle,
  latestTrustedState,
  assertCurrentTrustedState,
  makeState,
} = require('../src/data/refine-history.js');
const { RefineHistoryStore } = require('../src/data/refine-store.js');

const NOTE = 'Extracts/Restore.md';
const A = '---\ntype: extract\npriority: 50\n---\nAlpha beta\n';
const B = '---\ntype: extract\npriority: 50\n---\nHi beta\n';
const C = '---\ntype: extract\npriority: 50\n---\nHi\n';

class MemoryAdapter {
  constructor() {
    this.files = new Map();
    this.dirs = new Set();
    this.writes = [];
  }
  async exists(path) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path) { this.dirs.add(path); }
  async read(path) {
    if (!this.files.has(path)) throw new Error(`missing: ${path}`);
    return this.files.get(path);
  }
  async write(path, text) {
    this.writes.push(path);
    this.files.set(path, String(text));
  }
  async rename(from, to) {
    if (!this.files.has(from)) throw new Error(`missing: ${from}`);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  async list(path) {
    const prefix = `${path}/`;
    const files = [...this.files.keys()]
      .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map(file => file.slice(prefix.length));
    return { files, folders: [] };
  }
}

function afterContent(op) {
  return `${op.before.frontmatter}${op.after.body}`;
}

async function refine(fullContent, replacement = 'Hi', start = 0, end = 5) {
  return createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath: NOTE,
    fullContent,
    selection: { start, end },
    replacementText: replacement,
  });
}

function entry(operation, status) {
  return { operation, state: makeState(operation.operationId, status) };
}

async function seededStore() {
  const adapter = new MemoryAdapter();
  const store = new RefineHistoryStore({ adapter, historyRoot: 'History/refine' });
  const op1 = await refine(A);
  await store.writeOperation(op1);
  await store.setStatus(op1.operationId, 'applied');
  await store.markVerified(op1.operationId, afterContent(op1));
  return { adapter, store, op1 };
}

test('v1 refine remains readable and v2 restore is a supported distinct schema', async () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(VERSION_RESTORE_SCHEMA_VERSION, 2);
  assert.equal(SUPPORTED_OPERATION_SCHEMAS.has(1), true);
  assert.equal(SUPPORTED_OPERATION_SCHEMAS.has(2), true);

  const op = await refine(A);
  assert.equal(op.schemaVersion, 1);
  const result = await validateOperationIntegrity(op);
  assert.equal(result.operation.operationId, op.operationId);

  const v2 = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
    targetSide: 'before',
  });
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.restoreOf, op.operationId);
  assert.equal(v2.restoreTarget.operationId, op.operationId);
  assert.equal(v2.restoreTarget.side, 'before');
  assert.equal(v2.restoreTarget.bodyHash, op.note.bodyHash);
  assert.equal(v2.restoreTarget.bodyBytes, op.note.bodyBytes);
  await validateOperationIntegrity(v2);
  await validateRestoreRelationship(v2, op);
});

test('v2 restoreTarget is required and cannot be added to v1', async () => {
  const op = await refine(A);
  const v2 = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
  });
  const missing = JSON.parse(JSON.stringify(v2));
  delete missing.restoreTarget;
  await assert.rejects(() => validateOperationIntegrity(missing), error => error.code === 'INVALID_RESTORE_TARGET');

  const badV1 = JSON.parse(JSON.stringify(op));
  badV1.restoreTarget = v2.restoreTarget;
  await assert.rejects(() => validateOperationIntegrity(badV1), error => error.code === 'INVALID_RESTORE_TARGET');
});

test('v2 restoreTarget tampering is rejected', async () => {
  const op = await refine(A);
  const v2 = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
  });
  const badHash = JSON.parse(JSON.stringify(v2));
  badHash.restoreTarget.bodyHash = '0'.repeat(64);
  await assert.rejects(() => validateOperationIntegrity(badHash), error => error.code === 'RESTORE_TARGET_HASH_MISMATCH');

  const badBytes = JSON.parse(JSON.stringify(v2));
  badBytes.restoreTarget.bodyBytes += 1;
  await assert.rejects(() => validateOperationIntegrity(badBytes), error => error.code === 'RESTORE_TARGET_HASH_MISMATCH');

  const badRef = JSON.parse(JSON.stringify(v2));
  badRef.restoreTarget.operationId = crypto.randomUUID();
  await assert.rejects(() => validateOperationIntegrity(badRef), error => error.code === 'RESTORE_TARGET_MISMATCH');

  const self = JSON.parse(JSON.stringify(v2));
  self.restoreOf = self.operationId;
  self.restoreTarget.operationId = self.operationId;
  await assert.rejects(() => validateOperationIntegrity(self), error => error.code === 'RESTORE_CYCLE');
});

test('target side selection and cross-note references are explicit', async () => {
  const op = await refine(A);
  const before = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
    targetSide: 'before',
  });
  const after = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
    targetSide: 'after',
  });
  assert.equal(before.after.body, 'Alpha beta\n');
  assert.equal(after.after.body, 'Hi beta\n');
  await validateRestoreRelationship(before, op);
  await validateRestoreRelationship(after, op);

  const other = await createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath: 'Extracts/Other.md',
    fullContent: A,
    selection: { start: 0, end: 5 },
    replacementText: 'X',
  });
  await assert.rejects(() => createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: other,
  }), error => error.code === 'RESTORE_CROSS_NOTE');
});

test('latest trusted state is not simply the last raw event', async () => {
  const op1 = await refine(A);
  const op2 = await refine(B, 'X');
  const trusted = latestTrustedState([entry(op1, 'verified'), entry(op2, 'verified')]);
  assert.equal(trusted.operationId, op2.operationId);

  assert.throws(
    () => latestTrustedState([entry(op1, 'verified'), entry(op2, 'prepared')]),
    error => error.code === 'UNRESOLVED_HISTORY',
  );
  assert.throws(
    () => latestTrustedState([entry(op1, 'verified'), entry(op2, 'failed')]),
    error => error.code === 'UNRESOLVED_HISTORY',
  );
  const restore = await createRestoreOperation({
    operationId: crypto.randomUUID(),
    latestOperation: op2,
    currentContent: afterContent(op2),
    currentNotePath: NOTE,
  });
  assert.throws(
    () => latestTrustedState([entry(op1, 'verified'), entry(op2, 'verified'), entry(restore, 'verified')]),
    error => error.code === 'RESTORE_PENDING',
  );
  assert.throws(
    () => latestTrustedState([]),
    error => error.code === 'NO_TRUSTED_STATE',
  );
});

test('current body must match latest trusted body and editor must match disk', async () => {
  const op = await refine(A);
  const entries = [entry(op, 'verified')];
  const ok = await assertCurrentTrustedState({
    entries,
    notePath: NOTE,
    currentContent: B,
    editorContent: B,
  });
  assert.equal(ok.currentBodyHash, op.after.bodyHash);
  await assert.rejects(
    () => assertCurrentTrustedState({ entries, notePath: NOTE, currentContent: C }),
    error => error.code === 'CURRENT_BODY_NOT_TRUSTED',
  );
  await assert.rejects(
    () => assertCurrentTrustedState({ entries, notePath: NOTE, currentContent: B, editorContent: C }),
    error => error.code === 'EDITOR_NOT_SAVED',
  );
});

test('restore cycles and unknown fields are handled explicitly', async () => {
  const a = { operationId: crypto.randomUUID(), restoreOf: 'b' };
  const b = { operationId: 'b', restoreOf: a.operationId };
  const map = new Map([[a.operationId, a], [b.operationId, b]]);
  assert.throws(() => assertNoRestoreCycle(a, map), error => error.code === 'RESTORE_CYCLE');

  const op = await refine(A);
  const v2 = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
  });
  v2.futureExtension = { ignored: true };
  await validateOperationIntegrity(v2);

  const mismatch = JSON.parse(JSON.stringify(v2));
  mismatch.restoreOf = crypto.randomUUID();
  await assert.rejects(() => validateOperationIntegrity(mismatch), error => error.code === 'RESTORE_TARGET_MISMATCH');
});

test('planVersionRestore returns a before target and never writes', async () => {
  const { adapter, store, op1 } = await seededStore();
  const writesBefore = adapter.writes.length;
  const plan = await store.planVersionRestore({
    notePath: NOTE,
    currentContent: B,
    targetOperationId: op1.operationId,
    targetSide: 'before',
  });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.operation.schemaVersion, 2);
  assert.equal(plan.operation.after.body, 'Alpha beta\n');
  assert.equal(plan.target.side, 'before');
  assert.equal(adapter.writes.length, writesBefore);
});

test('planVersionRestore returns noop for current target and rejects invalid targets', async () => {
  const { store, op1 } = await seededStore();
  const noop = await store.planVersionRestore({
    notePath: NOTE,
    currentContent: B,
    targetOperationId: op1.operationId,
    targetSide: 'after',
  });
  assert.equal(noop.status, 'noop');
  assert.equal(noop.reason, 'TARGET_EQUALS_CURRENT');

  await assert.rejects(() => store.planVersionRestore({
    notePath: NOTE,
    currentContent: B,
    targetOperationId: crypto.randomUUID(),
    targetSide: 'after',
  }), error => error.code === 'RESTORE_TARGET_NOT_FOUND');

  await assert.rejects(() => store.planVersionRestore({
    notePath: NOTE,
    currentContent: C,
    targetOperationId: op1.operationId,
    targetSide: 'after',
  }), error => error.code === 'CURRENT_BODY_NOT_TRUSTED');
});

test('planVersionRestore rejects an unresolved latest state and preserves history', async () => {
  const { adapter, store, op1 } = await seededStore();
  await store.writeOperation(await refine(B, 'X'));
  const filesBefore = new Map(adapter.files);
  const writesBefore = adapter.writes.length;
  await assert.rejects(() => store.planVersionRestore({
    notePath: NOTE,
    currentContent: C,
    targetOperationId: op1.operationId,
  }), error => error.code === 'UNRESOLVED_HISTORY');
  assert.deepEqual(adapter.files, filesBefore);
  assert.equal(adapter.writes.length, writesBefore);
});

test('state completion semantics reject missing state and ordinary restored records', async () => {
  const op = await refine(A);
  assert.throws(
    () => latestTrustedState([{ operation: op, state: { operationId: op.operationId, status: 'conflict', missingState: true } }]),
    error => error.code === 'UNRESOLVED_HISTORY',
  );
  assert.throws(
    () => latestTrustedState([entry(op, 'restored')]),
    error => error.code === 'INVALID_HISTORY_STATE',
  );
});

test('unsupported future schema and editor dirty input are rejected', async () => {
  const op = await refine(A);
  const v2 = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op,
  });
  const v3 = JSON.parse(JSON.stringify(v2));
  v3.schemaVersion = 3;
  await assert.rejects(() => validateOperationIntegrity(v3), error => error.code === 'UNSUPPORTED_SCHEMA');

  const entries = [entry(op, 'verified')];
  await assert.rejects(() => assertCurrentTrustedState({
    entries,
    notePath: NOTE,
    currentContent: B,
    editorContent: C,
  }), error => error.code === 'EDITOR_NOT_SAVED');
});

test('planVersionRestore can plan again after a restore event', async () => {
  const { adapter, store, op1 } = await seededStore();
  const op2 = await refine(B, 'X');
  await store.writeOperation(op2);
  await store.setStatus(op2.operationId, 'applied');
  await store.markVerified(op2.operationId, afterContent(op2));
  const restore = await createRestoreOperation({
    operationId: crypto.randomUUID(),
    latestOperation: op2,
    currentContent: afterContent(op2),
    currentNotePath: NOTE,
  });
  await store.writeOperation(restore);
  await store.setStatus(restore.operationId, 'applied');
  await store.markVerified(restore.operationId, afterContent(restore));
  await store.markRestored(restore.operationId, afterContent(restore));

  const writesBefore = adapter.writes.length;
  const plan = await store.planVersionRestore({
    notePath: NOTE,
    currentContent: afterContent(restore),
    targetOperationId: op1.operationId,
    targetSide: 'before',
  });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.operation.after.body, 'Alpha beta\n');
  assert.equal(adapter.writes.length, writesBefore);
});

test('internally self-consistent v2 record pointing at the wrong history snapshot is rejected', async () => {
  const op1 = await refine(A, 'Hi');
  const op2 = await refine(B, 'X');
  const v2 = await createVersionRestoreOperation({
    operationId: crypto.randomUUID(),
    currentContent: B,
    currentNotePath: NOTE,
    targetOperation: op1,
    targetSide: 'after',
  });
  // Keep every internal hash/byte field self-consistent, but point at op2.
  // `restoreOf` and restoreTarget still agree; only the real target snapshot differs.
  v2.restoreOf = op2.operationId;
  v2.restoreTarget.operationId = op2.operationId;
  await validateOperationIntegrity(v2);
  await assert.rejects(
    () => validateRestoreRelationship(v2, op2),
    error => error.code === 'RESTORE_RELATION_MISMATCH',
  );
});
