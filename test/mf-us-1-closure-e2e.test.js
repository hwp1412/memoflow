'use strict';

// P2-US1-1.0-CLOSURE — synthetic end-to-end single-writer lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  initializeTopic,
  SyntheticUnifiedStorage,
  PersistentEventLedger,
  MemoryLedgerStore,
  MemoryBatchStore,
  issueSyntheticUnifiedCapability,
  issueSyntheticMercyConfirmation,
  previewMercy,
  prepareUnifiedMercyBatch,
  applyUnifiedMercyBatch,
  undoUnifiedMercyBatch,
} = require('../src/scheduling/index.js');
const { createHostRuntime, issueSyntheticHostAuthorization, evaluateHostRuntime } = require('../src/integration/host-runtime.js');
const { openPluginDataLedger } = require('../src/integration/plugin-data-ledger-store.js');
const { createKeyedDataStore } = require('../src/integration/plugin-data-ledger-store.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';
const CONDITIONS = {
  migrationComplete: true,
  pendingRecovery: false,
  singleWriterReady: true,
  backupVerified: true,
  userConfirmed: true,
  storageSupportsCas: true,
};

function entry(topic) {
  return { mfId: topic.mf_id, revision: topic.mf_revision, frontmatter: { ...topic }, body: 'Body' };
}

function frontmatter(storage, path) {
  return storage.read(path).frontmatter;
}

async function openDurable(dataStore) {
  const opened = await openPluginDataLedger({ dataStore, key: 'ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  return { opened, ledger };
}

function makeRuntime({ storage, ledger, opened, authorization = issueSyntheticHostAuthorization(), mode = 'unified', conditions = CONDITIONS }) {
  return createHostRuntime({
    mode,
    conditions,
    authorization,
    storage,
    ledger,
    capability: issueSyntheticUnifiedCapability(),
    persist: async records => {
      opened.store.replace(records);
      return opened.flush();
    },
  });
}

test('Source -> Extract -> review -> postpone -> mercy -> restart -> duplicate -> undo -> complete -> reactivate', async () => {
  const source = initializeTopic({ type: 'source', priority: 50, mfId: uuid(1) }, undefined, TODAY).topic;
  const extract = initializeTopic({
    type: 'extract', priority: 30, mfId: uuid(2), mfParentId: uuid(1), mfRootId: uuid(1),
  }, undefined, TODAY).topic;
  const storage = new SyntheticUnifiedStorage({
    'Sources/1.md': entry(source),
    'Sources/2.md': entry(extract),
  });
  const dataStore = createKeyedDataStore();
  const { opened, ledger } = await openDurable(dataStore);
  const runtime = makeRuntime({ storage, ledger, opened });
  assert.equal(runtime.view().writeEnabled, true);

  const advanced = {
    eventId: uuid(1001), topicId: uuid(1), type: 'ADVANCED', payload: {},
    expectedRevision: 0, algorithmVersion: 1, today: TODAY, calendarDate: TODAY,
  };
  const first = await runtime.execute(advanced);
  assert.equal(first.status, 'applied');
  assert.equal(frontmatter(storage, 'Sources/1.md').review_count, 1);
  assert.equal(frontmatter(storage, 'Sources/1.md').mf_revision, 1);

  const postpone = {
    ...advanced, eventId: uuid(1002), type: 'POSTPONE', payload: { days: 7 }, expectedRevision: 1,
  };
  assert.equal((await runtime.execute(postpone)).status, 'applied');
  assert.equal(frontmatter(storage, 'Sources/1.md').mf_not_before, '2026-12-01');
  assert.equal(frontmatter(storage, 'Sources/1.md').review_count, 1);

  // Mercy uses the PR-09 persisted batch protocol on the same storage.
  const rows = [
    { ...frontmatter(storage, 'Sources/1.md'), mf_ideal_due: '2026-11-20', mf_not_before: null, estimated_minutes: 5, type: 'source' },
    { ...frontmatter(storage, 'Sources/2.md'), mf_ideal_due: '2026-11-20', mf_not_before: null, estimated_minutes: 5, type: 'extract' },
  ];
  const plan = previewMercy(rows, { windowDays: 3, batchId: 'closure-mercy' }, TODAY);
  const batch = prepareUnifiedMercyBatch(plan, { batchId: 'closure-mercy', dateFormat: 'DD-MM-YYYY' });
  const batchStore = new MemoryBatchStore();
  const mercyDeps = {
    mode: { mode: 'unified' }, storage, batchStore,
    capability: issueSyntheticUnifiedCapability(),
    confirmation: issueSyntheticMercyConfirmation(batch.batchId, batch.previewDigest),
  };
  const applied = applyUnifiedMercyBatch(batch, mercyDeps);
  assert.equal(applied.writesPerformed, true);
  const afterMercy = frontmatter(storage, 'Sources/2.md');
  assert.notEqual(afterMercy.mf_not_before, null);
  assert.equal(afterMercy.review_count, 0);

  // Restart from the durable snapshot.
  const reopened = await openDurable(dataStore);
  assert.equal(reopened.opened.healthy, true);
  const restarted = makeRuntime({ storage, ledger: reopened.ledger, opened: reopened.opened });
  const replay = await restarted.execute(advanced);
  assert.equal(replay.status, 'duplicate');
  assert.equal(frontmatter(storage, 'Sources/1.md').review_count, 1);

  // Undo restores the pre-Mercy not-before.
  const undone = undoUnifiedMercyBatch(batch, mercyDeps);
  assert.equal(undone.writesPerformed, true);
  assert.equal(frontmatter(storage, 'Sources/2.md').mf_not_before, null);

  const currentRevision = frontmatter(storage, 'Sources/1.md').mf_revision;
  const complete = {
    ...advanced, eventId: uuid(1003), type: 'COMPLETE', payload: {}, expectedRevision: currentRevision,
  };
  assert.equal((await restarted.execute(complete)).status, 'applied');
  assert.equal(frontmatter(storage, 'Sources/1.md').status, 'done');

  const reactivate = {
    ...advanced, eventId: uuid(1004), type: 'REACTIVATE', payload: { idealDue: '2026-12-15' },
    expectedRevision: frontmatter(storage, 'Sources/1.md').mf_revision,
  };
  assert.equal((await restarted.execute(reactivate)).status, 'applied');
  assert.equal(frontmatter(storage, 'Sources/1.md').status, 'active');
  assert.equal(frontmatter(storage, 'Sources/1.md').mf_ideal_due, '2026-12-15');
});

test('real runtimes stay locked; synthetic authorization clears only with every condition', () => {
  const locked = evaluateHostRuntime({ mode: 'unified', conditions: CONDITIONS });
  assert.equal(locked.allowed, false);
  assert.ok(locked.blockers.includes('PRODUCTION_WRITE_UNAUTHORIZED'));

  const token = issueSyntheticHostAuthorization();
  const allowed = evaluateHostRuntime({ mode: 'unified', conditions: CONDITIONS, authorization: token });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.synthetic, true);

  const incomplete = evaluateHostRuntime({
    mode: 'unified', conditions: { ...CONDITIONS, backupVerified: false }, authorization: token,
  });
  assert.equal(incomplete.allowed, false);
  assert.ok(incomplete.blockers.includes('BACKUP_NOT_VERIFIED'));
});

test('a unified failure never falls back to legacy and writes nothing', async () => {
  const topic = initializeTopic({ type: 'source', priority: 50, mfId: uuid(3) }, undefined, TODAY).topic;
  const storage = new SyntheticUnifiedStorage({ 'Sources/3.md': entry(topic) });
  const dataStore = createKeyedDataStore();
  const { opened, ledger } = await openDurable(dataStore);
  const runtime = makeRuntime({ storage, ledger, opened });
  let legacyCalls = 0;
  await assert.rejects(
    runtime.execute({
      eventId: uuid(1005), topicId: uuid(3), type: 'ADVANCED', expectedRevision: 99,
      algorithmVersion: 1, today: TODAY, calendarDate: TODAY,
    }, {
      legacy: async () => { legacyCalls += 1; return { status: 'applied', writesPerformed: true }; },
    }).then(result => { if (result.status === 'conflict') throw Object.assign(new Error('conflict'), { code: 'E_CONFLICT' }); return result; }),
    error => ['E_REVISION_MISMATCH', 'E_CONFLICT', 'E_REVISION_STALE'].includes(error.code)
  );
  assert.equal(legacyCalls, 0);
  assert.equal(frontmatter(storage, 'Sources/3.md').mf_revision, 0);
});

test('a ledger flush failure turns an applied write into uncertain', async () => {
  const topic = initializeTopic({ type: 'source', priority: 50, mfId: uuid(4) }, undefined, TODAY).topic;
  const storage = new SyntheticUnifiedStorage({ 'Sources/4.md': entry(topic) });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore());
  const runtime = createHostRuntime({
    mode: 'unified', conditions: CONDITIONS, authorization: issueSyntheticHostAuthorization(),
    storage, ledger, capability: issueSyntheticUnifiedCapability(),
    persist: async () => ({ ok: false, code: 'E_LEDGER_SAVE_FAILED' }),
  });
  const result = await runtime.execute({
    eventId: uuid(1006), topicId: uuid(4), type: 'ADVANCED', expectedRevision: 0,
    algorithmVersion: 1, today: TODAY, calendarDate: TODAY,
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.ledgerError, 'E_LEDGER_SAVE_FAILED');
  assert.equal(frontmatter(storage, 'Sources/4.md').review_count, 1);
});

test('startup recovery reports blocked topics for prepared records', async () => {
  const topic = initializeTopic({ type: 'source', priority: 50, mfId: uuid(5) }, undefined, TODAY).topic;
  const storage = new SyntheticUnifiedStorage({ 'Sources/5.md': entry(topic) });
  const store = new MemoryLedgerStore({
    [uuid(1007)]: {
      eventId: uuid(1007), topicId: uuid(5), fingerprint: 'a'.repeat(64), type: 'ADVANCED',
      algorithmVersion: 1, expectedRevision: 0, today: TODAY, eventDate: TODAY,
      status: 'prepared', beforeHash: '0'.repeat(64), expectedAfterHash: '1'.repeat(64),
      afterHash: null, actualRevision: null,
    },
  });
  const runtime = createHostRuntime({
    mode: 'unified', conditions: CONDITIONS, authorization: issueSyntheticHostAuthorization(),
    storage, ledger: new PersistentEventLedger(store), capability: issueSyntheticUnifiedCapability(),
  });
  assert.deepEqual(runtime.view().blockedTopicIds, [uuid(5)]);
  const recovery = await runtime.recover();
  assert.equal(recovery.recovered.length, 1);
  assert.ok(['uncertain', 'requires-manual-recovery'].includes(recovery.recovered[0].status));
  assert.deepEqual(recovery.blockedTopicIds, [uuid(5)]);
});

// ---- mode switch UI model and resetCurrent ruling ------------------------

const { buildHostModeView } = require('../src/ui/host-mode-model.js');

test('the mode view lists blockers and never enables a real unified write', () => {
  const locked = buildHostModeView({ mode: 'unified', conditions: CONDITIONS });
  assert.equal(locked.writeEnabled, false);
  assert.equal(locked.canSwitchToUnified, false);
  assert.ok(locked.blockers.includes('PRODUCTION_WRITE_UNAUTHORIZED'));
  assert.equal(locked.checklist.find(item => item.code === 'PRODUCTION_WRITE_UNAUTHORIZED').ok, false);

  const synthetic = buildHostModeView({
    mode: 'unified', conditions: CONDITIONS, authorization: issueSyntheticHostAuthorization(),
  });
  assert.equal(synthetic.writeEnabled, true);
  assert.equal(synthetic.synthetic, true);
  assert.equal(synthetic.reason, null);
});
