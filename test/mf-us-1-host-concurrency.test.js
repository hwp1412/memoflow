'use strict';

// P2-US1-HOST-RUNTIME-01 follow-up — Topic serialisation, ledger save ordering,
// resolver staleness and the surrounding safety contracts.
//
// Mock Obsidian + in-memory data only. No real Vault, no Obsidian process.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PersistentEventLedger, MemoryLedgerStore, issueSyntheticUnifiedCapability } = require('../src/scheduling/index.js');
const { sha256Hex } = require('../src/scheduling/migration-hash.js');
const { createAsyncHostRuntime } = require('../src/integration/host-async-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { openPluginDataLedger, createKeyedDataStore, createObsidianPluginDataStore } = require('../src/integration/plugin-data-ledger-store.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { createPlugin, makeFile } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';
const FORMAT = 'YYYY-MM-DD';
const CONDITIONS = {
  migrationComplete: true,
  pendingRecovery: false,
  singleWriterReady: true,
  backupVerified: true,
  userConfirmed: true,
  storageSupportsCas: true,
};

function topicFm(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 3, a_factor: 1.5,
    review_count: 0, last_reviewed: '', next_review: '2026-11-27', date_added: '2026-10-01',
    mf_id: id, mf_parent_id: 'null', mf_root_id: 'null', mf_ideal_due: '2026-11-27',
    mf_not_before: 'null', mf_interval_days: 3, mf_last_event_id: 'null', mf_revision: 0,
    mf_scheduler_version: 1,
    ...overrides,
  };
}

function addTopic(app, path, id, overrides = {}) {
  return makeFile(app, path, topicFm(id, overrides), '# Body\n\nKeep this paragraph exactly.\n');
}

function content(app, file) { return app.vault.readContent(file); }
function fmOf(app, file) { return frontmatterFromContent(content(app, file)).frontmatter; }

async function setup({ saveHook = null, mode = 'unified', authorization = issueSyntheticHostAuthorization() } = {}) {
  const { plugin, app } = createPlugin();
  plugin.settings.mf_us1_mode = mode;
  const dataStore = createKeyedDataStore({});
  const opened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const resolver = createVaultTopicResolver({ app });
  const storage = createObsidianAsyncTopicStorage({ app, resolveFile: resolver, dateFormat: FORMAT });
  let saves = 0;
  const persist = async records => {
    saves += 1;
    if (typeof saveHook === 'function') {
      // A hook may delay and return null to let the real save proceed.
      const decision = await saveHook(saves, records);
      if (decision) return decision;
    }
    opened.store.replace(records);
    return opened.flush();
  };
  const runtime = createAsyncHostRuntime({
    mode, conditions: CONDITIONS, authorization, storage, ledger,
    capability: issueSyntheticUnifiedCapability(), dateFormat: FORMAT, persist,
  });
  return { plugin, app, runtime, ledger, opened, storage, resolver, dataStore, saveCount: () => saves };
}

function advance(topicId, eventId, overrides = {}) {
  return {
    eventId, topicId, type: 'ADVANCED', payload: null, expectedRevision: 0,
    today: TODAY, calendarDate: TODAY, algorithmVersion: 1, dateFormat: FORMAT,
    ...overrides,
  };
}

// ---- A. Topic-level serialisation ----------------------------------------

test('two different events for the same Topic are serialised', async (t) => {
  const { app, runtime, storage } = await setup();
  const topicId = uuid(1);
  const file = addTopic(app, 'Sources/A.md', topicId);
  const originalProcess = app.vault.process.bind(app.vault);
  let casCalls = 0;
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  app.vault.process = async (target, fn) => {
    casCalls += 1;
    if (casCalls === 1) { firstStarted(); await gate; }
    return originalProcess(target, fn);
  };
  t.after(() => { app.vault.process = originalProcess; });

  const first = runtime.execute(advance(topicId, uuid(11)));
  await started;
  const second = runtime.execute(advance(topicId, uuid(12)));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(casCalls, 1, 'the second event must not reach CAS while the first is in flight');

  releaseFirst();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 'applied');
  assert.equal(two.status, 'conflict');
  assert.equal(two.reason, 'E_REVISION_MISMATCH');
  assert.equal(fmOf(app, file).review_count, 1);
});

test('the same eventId fired concurrently applies once and reports duplicate once', async () => {
  const { app, runtime } = await setup();
  const topicId = uuid(2);
  const file = addTopic(app, 'Sources/B.md', topicId);
  const eventId = uuid(21);
  const [one, two] = await Promise.all([
    runtime.execute(advance(topicId, eventId)),
    runtime.execute(advance(topicId, eventId)),
  ]);
  const statuses = [one.status, two.status].sort();
  assert.deepEqual(statuses, ['applied', 'duplicate']);
  assert.equal(fmOf(app, file).review_count, 1);
});

test('a later event with a stale revision conflicts instead of overwriting', async () => {
  const { app, runtime } = await setup();
  const topicId = uuid(3);
  const file = addTopic(app, 'Sources/C.md', topicId);
  const first = await runtime.execute(advance(topicId, uuid(31)));
  assert.equal(first.status, 'applied');
  const stale = await runtime.execute(advance(topicId, uuid(32)));
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.reason, 'E_REVISION_MISMATCH');
  assert.equal(fmOf(app, file).review_count, 1);
});

test('an uncertain write blocks every later event for that Topic', async () => {
  const { app, runtime } = await setup({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const topicId = uuid(4);
  const file = addTopic(app, 'Sources/D.md', topicId);
  const first = await runtime.execute(advance(topicId, uuid(41)));
  assert.equal(first.status, 'uncertain');
  assert.deepEqual(runtime.view().blockedTopicIds, [topicId]);

  const second = await runtime.execute(advance(topicId, uuid(42), { expectedRevision: 1 }));
  assert.equal(second.status, 'requires-manual-recovery');
  assert.equal(second.reason, 'E_TOPIC_INTENT_STATE_UNKNOWN');
  assert.equal(fmOf(app, file).review_count, 1);
});

test('an exception inside execution releases the Topic lock', async () => {
  const { app, runtime, ledger } = await setup();
  const topicId = uuid(5);
  addTopic(app, 'Sources/E.md', topicId);
  const originalPrepare = ledger.prepare.bind(ledger);
  ledger.prepare = () => { throw Object.assign(new Error('boom'), { code: 'E_INJECTED' }); };
  await assert.rejects(() => runtime.execute(advance(topicId, uuid(51))), error => error.code === 'E_INJECTED');
  ledger.prepare = originalPrepare;
  const retry = await runtime.execute(advance(topicId, uuid(52)));
  assert.equal(retry.status, 'applied');
});

// ---- B. Ledger persistence ordering --------------------------------------

test('a delayed save for one Topic cannot drop another Topic record', async () => {
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const { app, runtime, dataStore } = await setup({
    saveHook: count => (count === 1 ? gate.then(() => null) : null),
  });
  const firstId = uuid(6);
  const secondId = uuid(7);
  addTopic(app, 'Sources/F.md', firstId);
  addTopic(app, 'Sources/G.md', secondId);
  const first = runtime.execute(advance(firstId, uuid(61)));
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = runtime.execute(advance(secondId, uuid(62)));
  releaseFirst();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 'applied');
  assert.equal(two.status, 'applied');

  const reopened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  const records = reopened.store.dump();
  assert.equal(records[uuid(61)].status, 'applied');
  assert.equal(records[uuid(62)].status, 'applied');
});

test('a failed intent save for a second Topic does not disturb the first', async () => {
  let failAt = 0;
  const { app, runtime } = await setup({ saveHook: count => (count === failAt ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const firstId = uuid(8);
  const secondId = uuid(9);
  const firstFile = addTopic(app, 'Sources/H.md', firstId);
  const secondFile = addTopic(app, 'Sources/I.md', secondId);
  const one = await runtime.execute(advance(firstId, uuid(81)));
  assert.equal(one.status, 'applied');
  assert.equal(fmOf(app, firstFile).review_count, 1);

  failAt = 3; // the next save is the second Topic's intent
  const two = await runtime.execute(advance(secondId, uuid(82)));
  assert.equal(two.status, 'failed');
  assert.equal(two.writesPerformed, false);
  assert.equal(fmOf(app, secondFile).review_count, 0);
});

test('a rejected save is reported as a dependency failure, never as success', async () => {
  const { app, runtime } = await setup({
    saveHook: () => Promise.reject(new Error('disk full')),
  });
  const topicId = uuid(10);
  const file = addTopic(app, 'Sources/J.md', topicId);
  const result = await runtime.execute(advance(topicId, uuid(101)));
  assert.equal(result.status, 'failed');
  assert.equal(result.writesPerformed, false);
  assert.ok(['E_LEDGER_SAVE_THREW', 'E_LEDGER_SAVE_FAILED'].includes(result.reason));
  assert.equal(fmOf(app, file).review_count, 0);
});

test('concurrent ledger and settings saves both survive (adapter serialisation)', async () => {
  const plugin = { __data: { settings: { theme: 'dark' } }, async loadData() { return this.__data; }, async saveData(data) { this.__data = data; } };
  const store = createObsidianPluginDataStore(plugin);
  await Promise.all([
    store.saveData('mfUs1Ledger', { version: 1, records: { a: 1 } }),
    store.saveData('settings', { theme: 'light' }),
  ]);
  assert.deepEqual(plugin.__data.mfUs1Ledger, { version: 1, records: { a: 1 } });
  assert.deepEqual(plugin.__data.settings, { theme: 'light' });
});

// ---- C. MetadataCache staleness ------------------------------------------

test('a fresh note missing from MetadataCache is found by the direct-read fallback', async (t) => {
  const { app, runtime, resolver } = await setup();
  const topicId = uuid(11);
  const file = addTopic(app, 'Sources/K.md', topicId);
  const original = app.metadataCache.getFileCache;
  app.metadataCache.getFileCache = (candidate) => (candidate.path === file.path ? null : original.call(app.metadataCache, candidate));
  t.after(() => { app.metadataCache.getFileCache = original; });

  const result = await runtime.execute(advance(topicId, uuid(111)));
  assert.equal(result.status, 'applied');
  assert.equal(fmOf(app, file).review_count, 1);
  assert.equal(typeof resolver.remember, 'function');
});

test('duplicate mf_id is refused instead of picking one note', async () => {
  const { app, runtime } = await setup();
  const topicId = uuid(12);
  addTopic(app, 'Sources/L1.md', topicId);
  const second = addTopic(app, 'Sources/L2.md', topicId);
  const before = content(app, second);
  const result = await runtime.execute(advance(topicId, uuid(121)));
  assert.equal(result.status, 'conflict');
  assert.ok(['E_DUPLICATE_TOPIC_ID', 'E_TOPIC_ID_MISMATCH'].includes(result.reason), result.reason);
  assert.equal(content(app, second), before);
});

test('a stale cache pointing at the wrong note fails closed instead of writing it', async (t) => {
  const { app, runtime } = await setup();
  const topicId = uuid(13);
  const realFile = addTopic(app, 'Sources/M.md', topicId);
  const wrong = makeFile(app, 'Sources/Wrong.md', topicFm(uuid(99)), '# wrong\n');
  const original = app.metadataCache.getFileCache;
  app.metadataCache.getFileCache = (candidate) => {
    if (candidate.path === wrong.path) return { frontmatter: { mf_id: topicId } };
    if (candidate.path === realFile.path) return null;
    return original.call(app.metadataCache, candidate);
  };
  t.after(() => { app.metadataCache.getFileCache = original; });
  const beforeWrong = content(app, wrong);
  const result = await runtime.execute(advance(topicId, uuid(131)));
  assert.equal(result.status, 'conflict');
  assert.equal(result.writesPerformed, false);
  assert.equal(content(app, wrong), beforeWrong, 'the wrong note must never be written');
});

// ---- D. Safety diagnostics -----------------------------------------------

test('a recovered duplicate whose result cannot be saved is uncertain, not duplicate', async () => {
  let failSaves = false;
  const { app, ledger, runtime } = await setup({
    saveHook: () => (failSaves ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null),
  });
  const topicId = uuid(14);
  const file = addTopic(app, 'Sources/N.md', topicId, { mf_revision: 1 });
  const currentHash = sha256Hex(content(app, file));
  ledger.prepare({
    eventId: uuid(141), topicId, type: 'ADVANCED', payload: null, expectedRevision: 0,
    algorithmVersion: 1, today: TODAY, calendarDate: TODAY, dateFormat: FORMAT, configDigest: sha256Hex('null'),
  }, { beforeHash: sha256Hex('other'), expectedAfterHash: currentHash, fields: {}, before: {}, after: {} });
  failSaves = true;
  const result = await runtime.execute(advance(topicId, uuid(141)));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.duplicate, false);
  assert.equal(result.verified, false);
});

test('a CAS read-back failure reports writesPerformed as unknown, not false', async (t) => {
  const { app, runtime } = await setup();
  const topicId = uuid(15);
  const file = addTopic(app, 'Sources/O.md', topicId);
  const originalRead = app.vault.read.bind(app.vault);
  let processDone = false;
  const originalProcess = app.vault.process.bind(app.vault);
  app.vault.process = async (target, fn) => { const out = await originalProcess(target, fn); processDone = true; return out; };
  app.vault.read = async target => {
    if (processDone) throw new Error('injected read failure');
    return originalRead(target);
  };
  t.after(() => { app.vault.read = originalRead; app.vault.process = originalProcess; });
  const result = await runtime.execute(advance(topicId, uuid(151)));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, null);
});

test('a definite CAS rejection reports writesPerformed false', async () => {
  const { app, runtime } = await setup();
  const topicId = uuid(16);
  const file = addTopic(app, 'Sources/P.md', topicId);
  await app.vault.process(file, data => data.replace('mf_revision: 0', 'mf_revision: 5'));
  const result = await runtime.execute(advance(topicId, uuid(161)));
  assert.equal(result.status, 'conflict');
  assert.equal(result.writesPerformed, false);
});

test('recovery clears the runtime block for the resolved Topic', async () => {
  const { app, runtime, ledger, storage, dataStore } = await setup({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const topicId = uuid(17);
  const file = addTopic(app, 'Sources/Q.md', topicId);
  const first = await runtime.execute(advance(topicId, uuid(171)));
  assert.equal(first.status, 'uncertain');
  assert.deepEqual(runtime.view().blockedTopicIds, [topicId]);

  const recovery = await runtime.recover();
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recovered[0].status, 'applied');
  assert.deepEqual(runtime.view().blockedTopicIds, []);
  assert.equal(fmOf(app, file).review_count, 1);
});

// ---- E. Startup recovery vs execute --------------------------------------

async function reopenRuntime(context, overrides = {}) {
  const reopened = await openPluginDataLedger({ dataStore: context.dataStore, key: 'mfUs1Ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(reopened.store.dump()));
  const runtime = createAsyncHostRuntime({
    mode: 'unified',
    conditions: CONDITIONS,
    authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({
      app: context.app,
      resolveFile: createVaultTopicResolver({ app: context.app }),
      dateFormat: FORMAT,
    }),
    ledger,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: FORMAT,
    persist: async records => { reopened.store.replace(records); return reopened.flush(); },
    ...overrides,
  });
  return { reopened, ledger, runtime };
}

// A prepared record survives in the durable ledger, but its result never did.
async function preparedState() {
  const context = await setup({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const topicId = uuid(20);
  const file = addTopic(context.app, 'Sources/R.md', topicId);
  const first = await context.runtime.execute(advance(topicId, uuid(201)));
  assert.equal(first.status, 'uncertain');
  return { ...context, topicId, file };
}

test('a pending durable record blocks a different eventId before any recovery', async () => {
  const context = await preparedState();
  const { runtime } = await reopenRuntime(context);
  const before = content(context.app, context.file);
  const result = await runtime.execute(advance(context.topicId, uuid(202), { expectedRevision: 0 }));
  assert.equal(result.status, 'requires-manual-recovery');
  assert.equal(result.reason, 'E_RECOVERY_PENDING');
  assert.equal(content(context.app, context.file), before);
  assert.deepEqual(runtime.view().blockedTopicIds, [context.topicId]);
});

test('recover and execute for the same Topic never interleave', async () => {
  const context = await preparedState();
  const { runtime } = await reopenRuntime(context);
  const originalRead = context.app.vault.read.bind(context.app.vault);
  let armed = true;
  let releaseRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  context.app.vault.read = async file => {
    if (armed) { armed = false; await gate; }
    return originalRead(file);
  };
  const recovering = runtime.recover();
  await new Promise(resolve => setTimeout(resolve, 10));
  const pending = runtime.execute(advance(context.topicId, uuid(203), { expectedRevision: 0 }));
  let settled = false;
  pending.then(() => { settled = true; }).catch(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false, 'execute must wait for the in-flight recovery of the same Topic');
  releaseRead();
  const [recovery, result] = await Promise.all([recovering, pending]);
  assert.equal(recovery.recovered.length, 1);
  // The write had already landed, so recovery both applied it and released the
  // Topic; the waiting event then sees the newer revision instead of writing.
  assert.equal(recovery.recovered[0].status, 'applied');
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_REVISION_MISMATCH');
  assert.equal(fmOf(context.app, context.file).review_count, 1);
});

test('a failed recovery keeps blocking while other Topics stay usable', async () => {
  const context = await preparedState();
  const before = content(context.app, context.file);
  // The topic changed outside the ledger: reconciliation cannot classify it.
  await context.app.vault.process(context.file, () => before.replace('Keep this paragraph exactly.', 'Externally edited body.'));
  const { runtime } = await reopenRuntime(context);
  const recovery = await runtime.recover();
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recovered[0].status, 'requires-manual-recovery');
  assert.deepEqual(runtime.view().blockedTopicIds, [context.topicId]);

  const blocked = await runtime.execute(advance(context.topicId, uuid(204), { expectedRevision: 0 }));
  assert.equal(blocked.status, 'requires-manual-recovery');

  const otherTopic = uuid(21);
  const otherFile = addTopic(context.app, 'Sources/S.md', otherTopic);
  const free = await runtime.execute(advance(otherTopic, uuid(205)));
  assert.equal(free.status, 'applied');
  assert.equal(fmOf(context.app, otherFile).review_count, 1);
});

test('a throwing recovery leaves the startup gate closed until a retry succeeds', async () => {
  const context = await preparedState();
  const { runtime } = await reopenRuntime(context);
  const originalRead = context.app.vault.read.bind(context.app.vault);

  // A storage read that returns garbage makes readTopic throw, which propagates
  // out of recover() before any record could be classified.
  context.app.vault.read = async () => null;
  await assert.rejects(() => runtime.recover());
  assert.equal(runtime.view().recoveryPending, true);
  assert.equal(runtime.view().writeEnabled, false, 'recovery has not completed yet');

  const blocked = await runtime.execute(advance(context.topicId, uuid(206), { expectedRevision: 1 }));
  assert.equal(blocked.status, 'requires-manual-recovery');
  assert.equal(blocked.reason, 'E_RECOVERY_PENDING');

  context.app.vault.read = originalRead;
  const retry = await runtime.recover();
  assert.equal(retry.recovered.length, 1);
  assert.equal(retry.recovered[0].status, 'applied');
  assert.equal(runtime.view().recoveryPending, false);
  assert.equal(runtime.view().writeEnabled, true);

  const resumed = await runtime.execute(advance(context.topicId, uuid(207), { expectedRevision: 1 }));
  assert.equal(resumed.status, 'applied');
  assert.equal(fmOf(context.app, context.file).review_count, 2);
});
