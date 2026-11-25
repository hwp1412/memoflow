'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRefineOperation, makeState } = require('../src/data/refine-history.js');
const { RefineHistoryStore } = require('../src/data/refine-store.js');

class Adapter {
  constructor() { this.files = new Map(); this.dirs = new Set(); }
  async exists(path) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path) { this.dirs.add(path); }
  async read(path) { if (!this.files.has(path)) throw new Error('missing'); return this.files.get(path); }
  async write(path, text) { this.files.set(path, String(text)); }
  async rename(from, to) { this.files.set(to, this.files.get(from)); this.files.delete(from); }
  async list(path) {
    const prefix = `${path}/`;
    return { files: [...this.files.keys()].filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes('/')).map(f => f.slice(prefix.length)), folders: [] };
  }
}

async function op(notePath, text = 'Alpha beta\n') {
  return createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath,
    fullContent: `---\ntype: extract\npriority: 50\n---\n${text}`,
    selection: { start: 0, end: 5 },
    replacementText: 'Hi',
  });
}

test('detailed listing keeps valid entries and reports corrupt entries/state/orphans', async () => {
  const adapter = new Adapter();
  const store = new RefineHistoryStore({ adapter, historyRoot: 'History/refine' });
  const note = 'Extracts/History.md';
  const good = await op(note);
  await store.writeOperation(good);
  await store.setStatus(good.operationId, 'applied');
  await store.markVerified(good.operationId, `---\ntype: extract\npriority: 50\n---\nHi beta\n`);

  const orphan = await op('Old/History.md');
  await store.writeOperation(orphan);

  const badState = await op(note, 'Second body\n');
  await store.writeOperation(badState);
  const statePath = `${store.root}/${badState.operationId}.state.json`;
  adapter.files.set(statePath, '{broken');

  adapter.files.set(`${store.root}/${crypto.randomUUID()}.json`, '{broken-op');

  const detailed = await store.listEntriesDetailed(note);
  assert.equal(detailed.entries.length, 2);
  assert.equal(detailed.entries.some(entry => entry.operation.operationId === good.operationId), true);
  assert.equal(detailed.entries.some(entry => entry.operation.operationId === badState.operationId), true);
  assert.equal(detailed.entries.some(entry => entry.operation.operationId === orphan.operationId), false);
  assert.ok(detailed.errors.some(error => error.code === 'HISTORY_CORRUPT'));
  assert.ok(detailed.errors.some(error => error.code === 'STATE_CORRUPT'));
  assert.deepEqual(detailed.orphanPaths, ['Old/History.md']);
  assert.ok(detailed.bytes > 0);
  const badEntry = detailed.entries.find(entry => entry.operation.operationId === badState.operationId);
  assert.equal(badEntry.state.missingState, true);
});

test('strict listEntries still rejects corrupt history (restore remains guarded)', async () => {
  const adapter = new Adapter();
  const store = new RefineHistoryStore({ adapter, historyRoot: 'History/refine' });
  const note = 'Extracts/Strict.md';
  const good = await op(note);
  await store.writeOperation(good);
  const statePath = `${store.root}/${good.operationId}.state.json`;
  adapter.files.set(statePath, '{broken');
  await assert.rejects(() => store.listEntries(note), error => error.code === 'STATE_CORRUPT');
});
