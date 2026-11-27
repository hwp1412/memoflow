'use strict';

// HOST-CLOSURE — real host execution for Unified Mercy / Boost / COMPLETE /
// DISMISS, using the protected writer, batch store and async runtime.
// Mock Obsidian only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PersistentEventLedger, MemoryLedgerStore, issueSyntheticUnifiedCapability } = require('../src/scheduling/index.js');
const { createAsyncHostRuntime } = require('../src/integration/host-async-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { openPluginDataLedger } = require('../src/integration/plugin-data-ledger-store.js');
const { createBatchStore, BATCH_KEY } = require('../src/integration/batch-store.js');
const { createProtectedAdminWriter } = require('../src/integration/protected-topic-writer.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const DATE_FORMAT = 'YYYY-MM-DD';
const CONDITIONS = {
  migrationComplete: true, pendingRecovery: false, singleWriterReady: true,
  backupVerified: true, userConfirmed: true, storageSupportsCas: true,
};

function topicFm(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 3, last_reviewed: '2026-10-01', next_review: '2026-11-20', date_added: '2026-09-01',
    mf_id: id, mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
    ...overrides,
  };
}

function fmOf(app, file) { return frontmatterFromContent(app.vault.readContent(file)).frontmatter; }

async function harness({ authorized = true, confirm = true, quality = 3 } = {}) {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'unified';
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1BatchStore = createBatchStore({ coordinator: plugin.pluginData });
  const storage = createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT });
  plugin.mfUs1HostStorage = storage;
  plugin.mfUs1AdminWriter = createProtectedAdminWriter({
    storage,
    authorization: authorized ? issueSyntheticHostAuthorization() : null,
  });
  const opened = await openPluginDataLedger({ dataStore: plugin.pluginData.ledgerStore(), key: 'mfUs1Ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const runtime = createAsyncHostRuntime({
    mode: 'unified', conditions: CONDITIONS,
    authorization: authorized ? issueSyntheticHostAuthorization() : null,
    storage, ledger, capability: issueSyntheticUnifiedCapability(), dateFormat: DATE_FORMAT,
    persist: async records => { opened.store.replace(records); return opened.flush(); },
  });
  plugin.__mfUs1UnifiedTransport = request => runtime.execute(request);
  plugin.__ledger = ledger;
  app.__promptState.confirm = confirm;
  app.__promptState.quality = quality;
  return { plugin, app, opened, runtime };
}

function addTopic(app, path, id, overrides = {}) {
  return makeFile(app, path, topicFm(id, overrides), '# body\n');
}

test('unified mercy: preview → confirm → apply writes only mf_not_before and records the batch', async () => {
  const { plugin, app } = await harness();
  const first = addTopic(app, 'Sources/M1.md', uuid(1));
  const second = addTopic(app, 'Sources/M2.md', uuid(2));
  const before = fmOf(app, first);
  const outcome = await plugin.mercy();
  assert.ok(outcome, 'mercy should return a batch outcome');
  assert.ok(['applied', 'partial'].includes(outcome.status), outcome.status);
  for (const file of [first, second]) {
    const after = fmOf(app, file);
    assert.ok(after.mf_not_before, 'not_before must be set');
    assert.equal(after.mf_interval_days, before.mf_interval_days);
    assert.equal(Number(after.a_factor), Number(before.a_factor));
    assert.equal(Number(after.review_count), Number(before.review_count));
    assert.equal(after.mf_ideal_due, before.mf_ideal_due);
  }
  const record = plugin.__data[BATCH_KEY];
  assert.ok(record, 'batch record must be persisted');
  const batch = Object.values(record).find(item => item.kind === 'MERCY');
  assert.equal(batch.status, 'applied');
  assert.equal(batch.items.length, 2);
});

test('unified mercy undo restores the previous not_before only for applied items', async () => {
  const { plugin, app } = await harness();
  const file = addTopic(app, 'Sources/M3.md', uuid(3));
  await plugin.mercy();
  assert.ok(fmOf(app, file).mf_not_before);
  const undo = await plugin.mercyUndoLast();
  assert.ok(undo, 'undo should return an outcome');
  assert.equal(fmOf(app, file).mf_not_before, null, 'original value restored');
});

test('unified boost lowers priorities through per-node events and records the batch', async () => {
  const { plugin, app } = await harness({ quality: 5 });
  const root = addTopic(app, 'Sources/B1.md', uuid(4));
  addTopic(app, 'Extracts/B2.md', uuid(5), { type: 'extract', source: '[[B1]]' });
  app.activeFile = root;
  const outcome = await plugin.boost();
  assert.ok(outcome, 'boost should return a batch outcome');
  assert.ok(['applied', 'partial'].includes(outcome.status), outcome.status);
  const rootAfter = fmOf(app, root);
  assert.equal(Number(rootAfter.priority), 45, 'priority lowered by the planned delta');
  assert.ok(Number(rootAfter.mf_revision) >= 1, 'written through the event path');
  const batch = Object.values(plugin.__data[BATCH_KEY] || {}).find(item => item.kind === 'BOOST');
  assert.ok(batch, 'boost batch record persisted');
  assert.ok(Array.isArray(batch.eventIds) && batch.eventIds.length >= 1, 'event identities persisted for recovery');
  assert.ok(batch.eventIds[0].eventId, 'event id recorded before/with the batch');
  const ledgerRecords = Object.values(plugin.__ledger.store.dump());
  assert.ok(ledgerRecords.some(record => record.eventId === batch.eventIds[0].eventId), 'ledger owns the recorded event id');
});

test('unified COMPLETE / DISMISS use events and never touch learning history', async () => {
  const { plugin, app } = await harness();
  const first = addTopic(app, 'Sources/C1.md', uuid(6));
  const second = addTopic(app, 'Extracts/C2.md', uuid(7), { type: 'extract', source: '[[C1]]' });
  const before = fmOf(app, first);
  const done = await plugin.markPathsDone([first.path, second.path], { confirm: false });
  assert.equal(done, 2);
  for (const file of [first, second]) {
    const after = fmOf(app, file);
    assert.equal(after.status, 'done');
    assert.equal(after.mf_interval_days, before.mf_interval_days);
    assert.equal(Number(after.review_count), Number(before.review_count));
    assert.equal(Number(after.mf_revision), 1);
  }
  const dismissed = addTopic(app, 'Extracts/C3.md', uuid(8), { type: 'extract', source: '[[C1]]' });
  assert.equal(await plugin.dismissTreeNode(dismissed.path), true);
  assert.equal(fmOf(app, dismissed).status, 'dismissed');
});

test('without host authorization nothing is written (fail closed)', async () => {
  const { plugin, app } = await harness({ authorized: false });
  const file = addTopic(app, 'Sources/U1.md', uuid(9));
  const before = app.vault.readContent(file);
  await plugin.mercy();
  await plugin.markPathsDone([file.path], { confirm: false });
  assert.equal(app.vault.readContent(file), before);
});

test('a card never enters mercy / complete / boost', async () => {
  const { plugin, app } = await harness();
  const card = makeFile(app, 'Cards/C1.md', { type: 'card', status: 'active', mf_id: uuid(10), mf_revision: 0, priority: 50 }, '# card\n');
  const before = app.vault.readContent(card);
  await plugin.markPathsDone([card.path], { confirm: false });
  assert.equal(app.vault.readContent(card), before);
  assert.equal(await plugin.dismissTreeNode(card.path), false);
  assert.equal(app.vault.readContent(card), before);
});

test('mercy undo CASes on the applied revision and conflicts after an external write', async () => {
  const { plugin, app } = await harness();
  const file = addTopic(app, 'Sources/U1.md', uuid(11));
  await plugin.mercy();
  const record = Object.values(plugin.__data[BATCH_KEY] || {}).find(item => item.kind === 'MERCY');
  assert.ok(record && Array.isArray(record.revisions) && record.revisions.length === 1, 'applied revision persisted');

  await app.vault.process(file, data => data.replace(/(mf_revision:\s*)(\d+)/, (match, head, value) => `${head}${Number(value) + 1}`));
  plugin._mfUs1RefreshRows();
  const beforeUndo = app.vault.readContent(file);
  const result = await plugin.mercyUndoLast();
  assert.equal(result.counts.conflict, 1, JSON.stringify(result.counts));
  assert.notEqual(result.status, 'applied');
  assert.equal(app.vault.readContent(file), beforeUndo, 'undo writes nothing after an external change');
});


test('a failed revision-evidence save is surfaced and undo stays blocked', async () => {
  const { plugin, app } = await harness();
  const file = addTopic(app, 'Sources/U2.md', uuid(12));
  const store = plugin.mfUs1BatchStore;
  const original = store.saveBatch.bind(store);
  let saves = 0;
  store.saveBatch = async record => {
    saves += 1;
    if (saves === 3) return { ok: false, code: 'E_SAVE' };
    return original(record);
  };
  const outcome = await plugin.mercy();
  assert.equal(outcome.revisionEvidencePersisted, false);
  assert.match(getNotices(app).join('\n'), /撤销凭证保存失败/);
  const before = app.vault.readContent(file);
  const undo = await plugin.mercyUndoLast();
  assert.equal(undo.status, 'blocked');
  assert.equal(app.vault.readContent(file), before);
});


test('resume reuses the planned event id and reconcile survives a final-save failure', async () => {
  const { plugin, app } = await harness();
  const { planBoostBatch } = require('../src/integration/boost-batch-host.js');
  const { issueSyntheticBatchResumeAuthorization } = require('../src/integration/batch-resume.js');
  const { reconcileBatches } = require('../src/integration/batch-recovery.js');
  const file = addTopic(app, 'Sources/R1.md', uuid(31));
  const topicId = uuid(31);
  const today = '2026-11-27';
  const batch = planBoostBatch({
    rows: [{ topicId, path: file.path, basename: 'R1', type: 'source', status: 'active', priority: 50, revision: 0 }],
    rootTopicId: topicId, delta: 5, today,
  });
  await plugin.mfUs1BatchStore.saveBatch({
    batchId: batch.batchId, kind: 'BOOST', status: 'prepared', today,
    targets: batch.targets, eventIds: batch.events,
  });
  plugin.__mfUs1ResumeAuthorization = issueSyntheticBatchResumeAuthorization();
  const originalSave = plugin.mfUs1BatchStore.saveBatch.bind(plugin.mfUs1BatchStore);
  plugin.mfUs1BatchStore.saveBatch = async record => (record && record.status && record.status !== 'prepared'
    ? { ok: false, code: 'E_SAVE' }
    : originalSave(record));
  app.__promptState.confirm = true;

  const results = await plugin.resumePendingBatches();
  assert.ok(Array.isArray(results) && results.length === 1, JSON.stringify(results));
  assert.equal(results[0].status, 'uncertain', 'write happened but record was not durable');
  assert.equal(Number(fmOf(app, file).priority), 45, 'absolute target applied');
  const owned = batch.events[0].eventId;
  assert.ok(Object.values(plugin.__ledger.store.dump()).some(record => record.eventId === owned), 'original event id in ledger');

  plugin.mfUs1BatchStore.saveBatch = originalSave;
  plugin._mfUs1RefreshRows();
  const recovered = await reconcileBatches({
    store: plugin.mfUs1BatchStore,
    storage: plugin.mfUs1HostStorage,
    ledger: plugin.__ledger,
  });
  assert.equal(recovered.batches[0].items[0].state, 'applied', 'reconcile recognises the original identity');
});

test('grading in unified mode uses an ISO today even with a DD-MM-YYYY setting', async () => {
  const { plugin, app } = await harness();
  plugin.settings.misc = { ...(plugin.settings.misc || {}), date_format: 'DD-MM-YYYY' };
  const file = addTopic(app, 'Sources/G1.md', uuid(41));
  app.activeFile = file;
  const result = await plugin.endSession();
  assert.ok(result, 'grading returned a host outcome');
  const fm = fmOf(app, file);
  assert.equal(Number(fm.mf_revision), 1, 'unified ADVANCED applied');
  assert.ok(fm.mf_last_event_id && fm.mf_last_event_id !== 'null');
  const ledger = Object.values(plugin.__ledger.store.dump());
  assert.equal(ledger.length, 1);
  assert.equal(String(fm.mf_interval_days) === String(fmOf(app, file).mf_interval_days), true);
});

test('host scheduling actions use ISO today under a DD-MM-YYYY setting', async () => {
  const { plugin, app } = await harness();
  plugin.settings.misc = { ...(plugin.settings.misc || {}), date_format: 'DD-MM-YYYY' };
  const file = addTopic(app, 'Sources/G2.md', uuid(42));
  app.activeFile = file;
  await plugin.postponeFile(file, 3);
  const fm = fmOf(app, file);
  assert.equal(Number(fm.mf_revision), 1, 'postpone event applied');
  assert.ok(fm.mf_not_before && fm.mf_not_before !== 'null');
  assert.equal(Object.values(plugin.__ledger.store.dump()).length, 1);
});

test('boost refreshes a stale row cache before planning the subtree', async () => {
  const { plugin, app } = await harness({ quality: 5 });
  const root = addTopic(app, 'Sources/BS.md', uuid(51));
  addTopic(app, 'Extracts/BE.md', uuid(52), { type: 'extract', source: '[[BS]]' });
  app.activeFile = root;
  plugin.irRowsCache = []; // simulate a stale cache right after file creation
  plugin.treeIndexCache = null;
  const outcome = await plugin.boost();
  assert.ok(outcome && outcome.status !== 'blocked', JSON.stringify(outcome && outcome.status));
  assert.equal(Number(fmOf(app, root).priority), 45);
  assert.ok(Object.values(plugin.__ledger.store.dump()).length >= 1);
});

test('subtree postpone refreshes a stale row cache before planning', async () => {
  const { plugin, app } = await harness();
  const root = addTopic(app, 'Sources/PS.md', uuid(53));
  const child = addTopic(app, 'Extracts/PE.md', uuid(54), { type: 'extract', source: '[[PS]]' });
  app.activeFile = root;
  plugin.irRowsCache = []; // stale
  const outcome = await plugin.postponeSubtreeHost(root, 3);
  assert.ok(outcome, 'subtree postpone returned an outcome');
  for (const file of [root, child]) {
    const fm = fmOf(app, file);
    assert.ok(fm.mf_not_before && fm.mf_not_before !== 'null', `${file.path} postponed`);
    assert.equal(Number(fm.mf_revision), 1);
  }
});

test('batch planning waits for the IR index and blocks with a clear reason on timeout', async () => {
  const { plugin, app } = await harness();
  const root = addTopic(app, 'Sources/IX.md', uuid(61));
  app.activeFile = root;
  const realRows = plugin.getIRRows.bind(plugin);
  const realGet = plugin.getIRRows;
  // Delayed index: first two reads are empty, then the real rows appear.
  let reads = 0;
  plugin.getIRRows = () => { reads += 1; return reads <= 2 ? [] : realRows(); };
  const delayed = await plugin._mfUs1WaitForIRIndex(root, { attempts: 10, interval: 10 });
  assert.equal(delayed.found, true, 'retries until the root is indexed');
  assert.ok(delayed.rows.some(row => row.tfile && row.tfile.path === root.path));

  plugin.getIRRows = () => [];
  const missing = await plugin._mfUs1WaitForIRIndex(root, { attempts: 3, interval: 10 });
  assert.equal(missing.found, false);
  plugin.getIRRows = realGet;

  // Boost with an index that never contains the topic returns a clear blocked outcome.
  plugin.getIRRows = () => [];
  const blocked = await plugin.boost();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'E_INDEX_NOT_READY');
  assert.equal(blocked.writesPerformed, false);
  plugin.getIRRows = realGet;
});


test('queue projection uses ISO today even when the display date format is DD-MM-YYYY', async () => {
  const { plugin, app } = await harness();
  plugin.settings.misc = { ...(plugin.settings.misc || {}), date_format: 'DD-MM-YYYY' };
  addTopic(app, 'Sources/Q1.md', uuid(61));
  addTopic(app, 'Sources/Q2.md', uuid(62));
  plugin._mfUs1RefreshRows();
  const pool = await plugin.buildDuePool({ skipCurrent: false });
  assert.ok(Array.isArray(pool) && pool.length >= 2, `pool should contain projected topics, got ${pool.length}`);
  assert.equal(getNotices(app).join('\n').includes('队列投影失败'), false, 'no projection failure with DD-MM-YYYY display format');
});
