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
  await assert.rejects(() => store.setStatus(op.operationId, 'verified'), error => error.code === 'INVALID_STATUS_TRANSITION');
  await store.setStatus(op.operationId, 'applied');
  await store.setStatus(op.operationId, 'verified');
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

  const op2 = await operation();
  await store.writeOperation(op2);
  adapter.files.set(store.statePath(op2.operationId), '{broken');
  await assert.rejects(() => store.listEntries(notePath), error => error.code === 'STATE_CORRUPT');
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
  await store.setStatus(op.operationId, 'applied');
  await store.setStatus(op.operationId, 'verified');
  await assert.rejects(() => store.latestVerified('Extracts/Renamed.md'), error => error.code === 'NO_VERIFIED_HISTORY');
  assert.ok(adapter.files.has(store.operationPath(op.operationId)));
  assert.equal((await store.latestVerified(notePath)).operation.operationId, op.operationId);
});

test('more than 20 operations is soft-limited, not rejected or auto-deleted', async () => {
  const { store } = await storeWithAdapter();
  let last;
  for (let i = 0; i < 21; i++) {
    last = await store.writeOperation(await operation());
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
  await store.setStatus(op.operationId, 'applied');
  await store.setStatus(op.operationId, 'verified');
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
  await store.setStatus(op.operationId, 'applied');
  await store.setStatus(op.operationId, 'verified');
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
  await assert.rejects(() => store.setStatus(op.operationId, 'verified'), error => error.code === 'HISTORY_WRITE_FAILED');
  const entry = await store.readEntry(op.operationId);
  assert.equal(entry.state.status, 'applied');
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');
});

test('distinct concurrent writes remain separate immutable histories', async () => {
  const { store } = await storeWithAdapter();
  const [first, second] = await Promise.all([store.writeOperation(await operation()), store.writeOperation(await operation())]);
  assert.notEqual(first.operation.operationId, second.operation.operationId);
  const entries = await store.listEntries(notePath);
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map(entry => entry.operation.operationId)).size, 2);
  // No instance memory lock is claimed; both histories are unresolved until
  // their real body writes are verified by 1B.
  await assert.rejects(() => store.latestVerified(notePath), error => error.code === 'UNRESOLVED_HISTORY');
});

test('restored event becomes the latest restorable history', async () => {
  const { store } = await storeWithAdapter();
  const op = await operation();
  await store.writeOperation(op);
  await store.setStatus(op.operationId, 'applied');
  await store.setStatus(op.operationId, 'verified');
  const plan = await store.planRestore(notePath, '---\ntype: extract\n---\nHi world\n');
  await store.writeRestorePlan(plan);
  const restoreId = plan.operation.operationId;
  await store.setStatus(restoreId, 'applied');
  await store.setStatus(restoreId, 'verified');
  await store.setStatus(restoreId, 'restored');
  assert.equal((await store.latestVerified(notePath)).operation.operationId, op.operationId);
  assert.equal((await store.latestRestorable(notePath)).operation.operationId, restoreId);
});
