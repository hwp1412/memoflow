'use strict';

// HOST-CLOSURE — durable batch store and protected admin writer (Mercy).
// Mock plugin/vault only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { createBatchStore, BATCH_KEY } = require('../src/integration/batch-store.js');
const { createProtectedAdminWriter } = require('../src/integration/protected-topic-writer.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { createPlugin, makeFile, makeSettings } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

class FakePlugin {
  constructor(data = {}) { this.data = JSON.parse(JSON.stringify(data)); }
  async loadData() { return JSON.parse(JSON.stringify(this.data)); }
  async saveData(next) { this.data = JSON.parse(JSON.stringify(next)); }
}

function topicFm(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 3, last_reviewed: '2026-10-01', next_review: '2026-11-20',
    date_added: '2026-09-01',
    mf_id: id, mf_revision: 2, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8,
    ...overrides,
  };
}

function fmOf(app, file) {
  return frontmatterFromContent(app.vault.readContent(file)).frontmatter;
}

// ---- batch store ---------------------------------------------------------

test('batch records live in their own reserved key and never disturb settings/ledger', async () => {
  const plugin = new FakePlugin({ theme: 'dark', mfUs1Ledger: { version: 1, records: {} } });
  const coordinator = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY] });
  const store = createBatchStore({ coordinator });

  assert.equal((await store.saveBatch({ batchId: 'b1', kind: 'MERCY', status: 'prepared', items: [] })).ok, true);
  assert.equal((await store.saveBatch({ batchId: 'b2', kind: 'BOOST', status: 'applied', items: [] })).ok, true);

  assert.deepEqual(plugin.data.theme, 'dark');
  assert.deepEqual(plugin.data.mfUs1Ledger, { version: 1, records: {} });
  assert.equal(plugin.data[BATCH_KEY].b1.status, 'prepared');
  assert.equal(plugin.data[BATCH_KEY].b2.status, 'applied');

  const db = createBatchStore({ coordinator });
  assert.equal((await db.getBatch('b1')).kind, 'MERCY');
  assert.deepEqual((await db.listBatches({ unfinishedOnly: true })).map(record => record.batchId), ['b1']);
  assert.equal((await db.latestBatch('BOOST')).batchId, 'b2');
});

test('a failed batch save is reported, not swallowed', async () => {
  const plugin = new FakePlugin({});
  const coordinator = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY] });
  const store = createBatchStore({ coordinator });
  plugin.saveData = async () => { throw new Error('disk full'); };
  const result = await store.saveBatch({ batchId: 'b9', kind: 'MERCY', status: 'prepared' });
  assert.equal(result.ok, false);
  assert.ok(result.code);
});

// ---- protected admin writer ---------------------------------------------

function setupWriter(overrides = {}) {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  const file = makeFile(app, 'Sources/A.md', topicFm(uuid(1), overrides), '# body\n');
  const storage = createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: 'YYYY-MM-DD' });
  return {
    plugin, app, file, storage,
    writer: createProtectedAdminWriter({ storage, authorization: issueSyntheticHostAuthorization() }),
  };
}

test('the admin writer changes only mf_not_before and bumps the revision', async () => {
  const { app, file, writer } = setupWriter();
  const before = fmOf(app, file);
  const result = await writer.write({ topicId: uuid(1), updates: { mf_not_before: '2026-12-05' } });
  assert.equal(result.status, 'applied');
  const after = fmOf(app, file);
  assert.equal(after.mf_not_before, '2026-12-05');
  assert.equal(Number(after.mf_revision), Number(before.mf_revision) + 1);
  assert.equal(after.mf_interval_days, before.mf_interval_days);
  assert.equal(Number(after.review_count), Number(before.review_count));
  assert.equal(after.mf_ideal_due, before.mf_ideal_due);
});

test('the admin writer refuses forbidden fields, changed input and stale status', async () => {
  const { app, file, writer } = setupWriter();
  const before = app.vault.readContent(file);
  const forbidden = await writer.write({ topicId: uuid(1), updates: { interval: 1 } });
  assert.equal(forbidden.status, 'failed');
  assert.match(String(forbidden.reason), /E_FIELD_NOT_WRITABLE/);

  const changed = await writer.write({ topicId: uuid(1), updates: { mf_not_before: '2026-12-05' }, expectedNotBefore: '2026-01-01' });
  assert.equal(changed.status, 'conflict');
  assert.equal(changed.reason, 'E_INPUT_CHANGED');
  assert.equal(app.vault.readContent(file), before);

  const doneFile = makeFile(app, 'Sources/Done.md', topicFm(uuid(2), { status: 'done' }), '# done\n');
  const doneBefore = app.vault.readContent(doneFile);
  const done = await writer.write({ topicId: uuid(2), updates: { mf_not_before: '2026-12-05' } });
  assert.equal(done.status, 'conflict');
  assert.equal(done.reason, 'E_TOPIC_NOT_ACTIVE');
  assert.equal(app.vault.readContent(doneFile), doneBefore);
});

test('the admin writer refuses to construct with a forbidden writable field', () => {
  const { storage } = setupWriter();
  assert.throws(
    () => createProtectedAdminWriter({ storage, allowedFields: ['mf_not_before', 'interval'] }),
    error => error.code === 'E_FIELD_FORBIDDEN',
  );
});

test('an unauthorized admin writer refuses every write', async () => {
  const { app, file, storage } = setupWriter();
  const writer = createProtectedAdminWriter({ storage, authorization: null });
  const before = app.vault.readContent(file);
  const result = await writer.write({ topicId: uuid(1), updates: { mf_not_before: '2026-12-05' } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'E_UNIFIED_NOT_AUTHORIZED');
  assert.equal(app.vault.readContent(file), before);
});
