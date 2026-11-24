'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  RefineHistoryStore,
  DEFAULT_HISTORY_ROOT,
} = require('../src/data/refine-store.js');
const {
  MAX_NOTE_BYTES,
  createRefineOperation,
  RefineError,
} = require('../src/data/refine-history.js');

const uuid = () => crypto.randomUUID();
const notePath = 'Extracts/E.md';
const baseContent = '---\ntype: extract\n---\nHello world\n';

class MemoryAdapter {
  constructor() {
    this.files = new Map();
    this.dirs = new Set();
    this.writeFailures = [];
    this.readFailures = [];
    this.renameFailures = [];
    this.badReadPaths = new Set();
    this.overwriteRename = true;
    this.writes = [];
  }
  async exists(path) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path) { this.dirs.add(path); }
  async read(path) {
    if (this.readFailures.some(pattern => path.includes(pattern))) throw new Error(`read failed: ${path}`);
    if (!this.files.has(path)) throw new Error(`missing: ${path}`);
    if (this.badReadPaths.has(path)) return 'corrupt-readback';
    return this.files.get(path);
  }
  async write(path, data) {
    this.writes.push(path);
    if (this.writeFailures.some(pattern => path.includes(pattern))) throw new Error(`write failed: ${path}`);
    this.files.set(path, String(data));
  }
  async rename(from, to) {
    if (this.renameFailures.some(pattern => from.includes(pattern) || to.includes(pattern))) {
      throw new Error(`rename failed: ${from} -> ${to}`);
    }
    if (!this.files.has(from)) throw new Error(`missing: ${from}`);
    if (!this.overwriteRename && this.files.has(to)) throw new Error(`target exists: ${to}`);
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

async function storeWithAdapter() {
  const adapter = new MemoryAdapter();
  const store = new RefineHistoryStore({ adapter, historyRoot: 'Test History/refine' });
  return { adapter, store };
}

async function operation(overrides = {}) {
  return createRefineOperation({
    operationId: uuid(),
    notePath,
    fullContent: baseContent,
    selection: { start: 0, end: 5 },
    replacementText: 'Hi',
    ...overrides,
  });
}

function afterContent(op) {
  return `${op.before.frontmatter}${op.after.body}`;
}

async function verifyOp(store, op, currentContent = afterContent(op)) {
  const entry = await store.readEntry(op.operationId);
  if (entry.state.status === 'prepared') await store.setStatus(op.operationId, 'applied');
  return store.markVerified(op.operationId, currentContent);
}

test('store writes immutable operation plus separate state and reads them back', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  const result = await store.writeOperation(op);
  assert.equal(result.softLimitExceeded, false);
  assert.ok(adapter.files.has(store.operationPath(op.operationId)));
  assert.ok(adapter.files.has(store.statePath(op.operationId)));
  const entry = await store.readEntry(op.operationId);
  assert.equal(entry.operation.before.fullContent, baseContent);
  assert.equal(entry.state.status, 'prepared');
  assert.equal(entry.operation.status, undefined, 'immutable snapshot must not contain status');
});

test('duplicate operation id is rejected without overwriting the original', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  const before = await store.readOperation(op.operationId);
  await assert.rejects(() => store.writeOperation(op), error => error.code === 'DUPLICATE_OPERATION');
  assert.deepEqual(await store.readOperation(op.operationId), before);
});

test('state transitions must be explicit and verified history is discoverable', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await assert.rejects(() => store.setStatus(op.operationId, 'verified'), error => error.code === 'VERIFICATION_REQUIRED');
  await assert.rejects(() => store.setStatus(op.operationId, 'restored'), error => error.code === 'VERIFICATION_REQUIRED');
  await assert.rejects(() => store.markVerified(op.operationId, afterContent(op)), error => error.code === 'VERIFICATION_REQUIRED');
  await store.setStatus(op.operationId, 'applied');
  await assert.rejects(() => store.markVerified(op.operationId, '---\ntype: extract\n---\nwrong\n'), error => error.code === 'VERIFICATION_MISMATCH');
  await store.markVerified(op.operationId, afterContent(op));
  const latest = await store.latestVerified(notePath);
  assert.equal(latest.operation.operationId, op.operationId);
  assert.equal(latest.state.status, 'verified');
});

test('unresolved prepared/applied/conflict history blocks latest verified lookup', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');
  await store.setStatus(op.operationId, 'conflict');
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');
});

test('history write failure leaves no operation/state and no note writes', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  adapter.writeFailures.push('op-tmp');
  await assert.rejects(() => store.writeOperation(op), error => error.code === 'HISTORY_WRITE_FAILED');
  assert.equal(adapter.files.has(store.operationPath(op.operationId)), false);
  assert.equal(adapter.files.has(store.statePath(op.operationId)), false);
  assert.ok(adapter.writes.every(path => path.startsWith('Test History/refine/')));
  assert.equal(adapter.files.has(notePath), false);
});

test('rename failure leaves the temp diagnostic file and no committed operation', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  adapter.renameFailures.push('.op-tmp-');
  await assert.rejects(() => store.writeOperation(op), error => error.code === 'HISTORY_WRITE_FAILED');
  assert.equal(adapter.files.has(store.operationPath(op.operationId)), false);
  assert.ok([...adapter.files.keys()].some(path => path.includes('.op-tmp-')));
  assert.ok(adapter.writes.every(path => path.startsWith('Test History/refine/')));
});

test('readback mismatch prevents committing history', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  const originalWrite = adapter.write.bind(adapter);
  adapter.write = async (path, data) => {
    await originalWrite(path, data);
    if (path.includes('.op-tmp-')) adapter.badReadPaths.add(path);
  };
  await assert.rejects(() => store.writeOperation(op), error => error.code === 'HISTORY_READBACK_MISMATCH');
  assert.equal(adapter.files.has(store.operationPath(op.operationId)), false);
});

test('state write failure preserves the immutable operation for diagnosis', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  adapter.writeFailures.push('state-tmp');
  await assert.rejects(
    () => store.writeOperation(op),
    error => error.code === 'HISTORY_WRITE_FAILED' && error.details.operationPersisted === true,
  );
  assert.ok(adapter.files.has(store.operationPath(op.operationId)));
  assert.equal(adapter.files.has(store.statePath(op.operationId)), false);
  assert.equal((await store.readOperation(op.operationId)).operationId, op.operationId);
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');
});

test('missing or corrupt state is unresolved, not silently ignored', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  adapter.files.delete(store.statePath(op.operationId));
  const entries = await store.listEntries(notePath);
  assert.equal(entries[0].state.status, 'conflict');
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');

  const { adapter: adapter2, store: store2 } = await storeWithAdapter();
  const op2 = await operation();
  await store2.writeOperation(op2);
  adapter2.files.set(store2.statePath(op2.operationId), '{broken');
  await assert.rejects(() => store2.listEntries(notePath), error => error.code === 'STATE_CORRUPT');
});

test('corrupt or missing history is reported and never guessed', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  adapter.files.set(store.operationPath(op.operationId), '{broken');
  await assert.rejects(() => store.readOperation(op.operationId), error => error.code === 'HISTORY_CORRUPT');
  await assert.rejects(() => store.readOperation(uuid()), error => error.code === 'HISTORY_MISSING');
});

test('note path rename does not auto-match history and leaves old history intact', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  await assert.rejects(() => store.latestVerified('Extracts/Renamed.md'), error => error.code === 'NO_VERIFIED_HISTORY');
  assert.ok(adapter.files.has(store.operationPath(op.operationId)));
  assert.equal((await store.latestVerified(notePath)).operation.operationId, op.operationId);
});

test('more than 20 operations is soft-limited, not rejected or auto-deleted', async () => {
  const { store } = await storeWithAdapter();
  let last;
  for (let i = 0; i < 21; i++) {
    const op = await operation();
    last = await store.writeOperation(op);
    await verifyOp(store, op);
  }
  assert.equal(last.softLimitExceeded, true);
  assert.equal(await store.historyCount(notePath), 21);
});

test('note over 1 MiB is rejected before any history is written', async () => {
  const { adapter, store } = await storeWithAdapter();
  const huge = 'x'.repeat(MAX_NOTE_BYTES + 1);
  await assert.rejects(() => store.prepareRefine({
    operationId: uuid(), notePath, fullContent: huge,
    selection: { start: 0, end: 1 }, replacementText: '',
  }), error => error.code === 'NOTE_TOO_LARGE');
  assert.equal(adapter.files.size, 0);
});

test('restore plan preserves current frontmatter and writes only history, not the note', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  const current = '---\ntype: extract\npriority: 99\n---\nHi world\n';
  const plan = await store.planRestore(notePath, current);
  assert.equal(plan.operation.restoreOf, op.operationId);
  assert.equal(plan.operation.after.body, 'Hello world\n');
  await store.writeRestorePlan(plan);
  assert.ok(adapter.files.has(store.operationPath(plan.operation.operationId)));
  assert.equal(adapter.files.has(notePath), false);
  assert.equal(adapter.files.get(store.operationPath(plan.operation.operationId)).includes('priority: 99'), true);
});

test('restore refuses changed body and unresolved history', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  await assert.rejects(() => store.planRestore(notePath, '---\ntype: extract\n---\nUser edit\n'), error => error.code === 'RESTORE_CONFLICT');

  const op2 = await operation();
  await store.writeOperation(op2);
  await assert.rejects(() => store.planRestore(notePath, '---\ntype: extract\n---\nHi world\n'), error => error.code === 'UNRESOLVED_HISTORY');
});

test('all store writes remain under the injected history root', async () => {
  const { adapter, store } = await storeWithAdapter();
  await store.writeOperation(await operation());
  assert.ok(adapter.writes.length > 0);
  assert.ok(adapter.writes.every(path => path.startsWith(`${DEFAULT_HISTORY_ROOT}/`) || path.startsWith('Test History/refine/')));
  assert.equal(adapter.files.has(notePath), false);
});

test('state update failure after a body-like applied state preserves applied history', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await store.setStatus(op.operationId, 'applied');
  adapter.writeFailures.push('state-tmp');
  await assert.rejects(() => store.markVerified(op.operationId, afterContent(op)), error => error.code === 'HISTORY_WRITE_FAILED');
  const entry = await store.readEntry(op.operationId);
  assert.equal(entry.state.status, 'applied');
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');
});

test('a prepared operation blocks a new operation with another UUID', async () => {
  const { adapter, store } = await storeWithAdapter();
  const first = await operation();
  await store.writeOperation(first);
  const second = await operation();
  await assert.rejects(() => store.writeOperation(second), error => error.code === 'UNRESOLVED_HISTORY');
  assert.equal(adapter.files.has(store.operationPath(second.operationId)), false);
  assert.equal((await store.listEntries(notePath)).length, 1);
});

test('restored event becomes the latest restorable history', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  const plan = await store.planRestore(notePath, '---\ntype: extract\n---\nHi world\n');
  await store.writeRestorePlan(plan);
  const restoreId = plan.operation.operationId;
  await store.setStatus(restoreId, 'applied');
  await store.markVerified(restoreId, afterContent(plan.operation));
  await store.markRestored(restoreId, afterContent(plan.operation));
  assert.equal((await store.latestVerified(notePath)).operation.operationId, op.operationId);
  assert.equal((await store.latestRestorable(notePath)).operation.operationId, restoreId);
});

test('failed, conflict and missing state records block a new operation', async () => {
  for (const terminal of ['failed', 'conflict']) {
    const { store } = await storeWithAdapter();
    const first = await operation();
    await store.writeOperation(first);
    await store.setStatus(first.operationId, terminal);
    const second = await operation();
    await assert.rejects(() => store.writeOperation(second), error => error.code === 'UNRESOLVED_HISTORY');
  }

  const { adapter, store } = await storeWithAdapter();
  const first = await operation();
  await store.writeOperation(first);
  adapter.files.delete(store.statePath(first.operationId));
  const second = await operation();
  await assert.rejects(() => store.writeOperation(second), error => error.code === 'UNRESOLVED_HISTORY');
});

test('prepareRefine is also blocked by unresolved history', async () => {
  const { store } = await storeWithAdapter();
  await store.writeOperation(await operation());
  await assert.rejects(() => store.prepareRefine({
    operationId: uuid(), notePath, fullContent: baseContent,
    selection: { start: 0, end: 5 }, replacementText: 'B',
  }), error => error.code === 'UNRESOLVED_HISTORY');
});

test('verified status requires a matching Extract body and cannot be set directly', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await store.setStatus(op.operationId, 'applied');
  await assert.rejects(() => store.setStatus(op.operationId, 'verified'), error => error.code === 'VERIFICATION_REQUIRED');
  await assert.rejects(
    () => store.markVerified(op.operationId, '---\ntype: source\n---\nHi world\n'),
    error => error.code === 'CURRENT_TYPE_UNSUPPORTED',
  );
  await assert.rejects(
    () => store.markVerified(op.operationId, '---\ntype: extract\n---\nWrong body\n'),
    error => error.code === 'VERIFICATION_MISMATCH',
  );
  await assert.rejects(
    () => store.markVerified(op.operationId, 'Hi world\n'),
    error => error.code === 'CURRENT_TYPE_UNKNOWN',
  );
  const verified = await store.markVerified(op.operationId, afterContent(op));
  assert.equal(verified.status, 'verified');
  await assert.rejects(() => store.setStatus(op.operationId, 'restored'), error => error.code === 'VERIFICATION_REQUIRED');
});

test('restore plan rejects current Source, missing type and ambiguous type', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  for (const current of [
    '---\ntype: source\n---\nHi world\n',
    '---\npriority: 50\n---\nHi world\n',
    '---\ntype: extract\ntype: source\n---\nHi world\n',
  ]) {
    await assert.rejects(() => store.planRestore(notePath, current), error =>
      ['CURRENT_TYPE_UNSUPPORTED', 'CURRENT_TYPE_UNKNOWN', 'CURRENT_TYPE_AMBIGUOUS'].includes(error.code));
  }
});

test('non-overwriting rename failure preserves the previous state file', async () => {
  const { adapter, store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await store.setStatus(op.operationId, 'applied');
  const stateBefore = await store.readState(op.operationId);
  adapter.overwriteRename = false;
  await assert.rejects(() => store.markVerified(op.operationId, afterContent(op)), error => error.code === 'HISTORY_WRITE_FAILED');
  const stateAfter = await store.readState(op.operationId);
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(stateAfter.status, 'applied');
  assert.ok([...adapter.files.keys()].some(path => path.includes('.state-tmp-')));
});


test('restore plan writing is blocked by unresolved history', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  const plan = await store.planRestore(notePath, '---\ntype: extract\n---\nHi world\n');
  await store.writeOperation(await operation({ replacementText: 'pending' }));
  await assert.rejects(() => store.writeRestorePlan(plan), error => error.code === 'UNRESOLVED_HISTORY');
});

test('ordinary refine operation cannot be marked restored', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  await assert.rejects(
    () => store.markRestored(op.operationId, afterContent(op)),
    error => error.code === 'NOT_RESTORE_OPERATION',
  );
});

test('restore event with missing reference cannot be marked restored', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await verifyOp(store, op);
  const plan = await store.planRestore(notePath, '---\ntype: extract\n---\nHi world\n');
  const broken = JSON.parse(JSON.stringify(plan.operation));
  broken.restoreOf = uuid();
  await store.writeOperation(broken);
  await store.setStatus(broken.operationId, 'applied');
  await store.markVerified(broken.operationId, afterContent(broken));
  await assert.rejects(
    () => store.markRestored(broken.operationId, afterContent(broken)),
    error => error.code === 'RESTORE_REFERENCE_MISSING',
  );
});
