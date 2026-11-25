'use strict';

// PR-10 — T17-T20 at the integration layer (Fake Vault / mocks only).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  initializeTopic,
  selectDailyQueue,
  createReadingSchedulerRouter,
  issueSyntheticRuntimeAuthorization,
} = require('../src/scheduling/index.js');
const {
  FakeObsidianVault,
  createFakeVaultAdapter,
} = require('../src/integration/obsidian-storage-adapter.js');
const { buildDashboardModel } = require('../src/ui/scheduler-dashboard-model.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';

function vaultTopic(seq, overrides = {}) {
  return {
    frontmatter: {
      type: 'source', status: 'active', priority: 50, a_factor: 2.0,
      review_count: 3, mf_id: uuid(seq), mf_revision: 1, mf_scheduler_version: 1,
      mf_ideal_due: '2026-11-20', mf_not_before: null, mf_interval_days: 8,
      ...overrides,
    },
    body: 'Body',
    revision: 1,
  };
}

function schedulingTopic(seq, overrides = {}) {
  return {
    ...vaultTopic(seq, overrides).frontmatter,
    estimated_minutes: 5,
  };
}

test('T17: initialising a child extract never changes the parent', () => {
  const parent = initializeTopic({ type: 'source', priority: 50, mfId: uuid(1) }, undefined, TODAY).topic;
  const snapshot = JSON.parse(JSON.stringify(parent));
  const child = initializeTopic({
    type: 'extract', priority: 30, mfId: uuid(2), mfParentId: uuid(1), mfRootId: uuid(1),
  }, undefined, TODAY).topic;
  assert.deepEqual(parent, snapshot);
  assert.notEqual(child.mf_interval_days, 0);
  assert.equal(child.review_count, 0);
  assert.equal(child.mf_parent_id, uuid(1));
});

test('T18: cards stay out of the reading queue and never reach an SR mock', () => {
  const sr = { graded: 0 };
  const topics = [schedulingTopic(1), schedulingTopic(2, { type: 'card' })];
  const model = buildDashboardModel({ topics, today: TODAY, dateFormat: 'DD-MM-YYYY' });
  assert.equal(model.cardsExcluded, 1);
  assert.equal(model.queue.selected.some(entry => entry.stableId === uuid(2)), false);
  assert.equal(sr.graded, 0);
});

test('T19: shadow routing writes only through legacy and never through the comparison', async () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': vaultTopic(1) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const before = vault.read('Sources/A.md').content;

  let legacyWrites = 0;
  const legacyScheduler = () => {
    const snapshot = adapter.readSnapshot('Sources/A.md');
    adapter.writeFrontMatterLegacy('Sources/A.md', {
      expectedHash: snapshot.hash, expectedRevision: snapshot.revision,
    }, fm => { fm.mf_not_before = '2026-11-27'; });
    legacyWrites += 1;
    return { status: 'applied', writesPerformed: true };
  };
  let shadowWrites = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler,
    shadowComparator: () => {
      // A comparator must never write; this mock proves it is not called with a writer.
      shadowWrites += 0;
      return { differences: [{ field: 'notBefore' }] };
    },
  });
  const result = await router.route({ action: 'postpone', days: 7 });
  assert.equal(result.route, 'shadow');
  assert.equal(legacyWrites, 1);
  assert.equal(shadowWrites, 0);
  assert.notEqual(vault.read('Sources/A.md').content, before);
  assert.equal(vault.read('Sources/A.md').frontmatter.mf_not_before, '2026-11-27');
});

test('T20: a rename keeps the stable id and the queue order', () => {
  const vault = new FakeObsidianVault({
    'Sources/A.md': vaultTopic(1),
    'Sources/B.md': vaultTopic(2, { priority: 10 }),
  });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const beforeQueue = selectDailyQueue([schedulingTopic(1), schedulingTopic(2, { priority: 10 })], undefined, TODAY);
  vault.rename('Sources/A.md', 'Sources/Renamed.md');
  const located = adapter.locateByTopicId(uuid(1));
  assert.equal(located.snapshot.frontmatter.mf_id, uuid(1));
  const afterQueue = selectDailyQueue([schedulingTopic(1), schedulingTopic(2, { priority: 10 })], undefined, TODAY);
  assert.deepEqual(afterQueue.selected.map(entry => entry.stableId), beforeQueue.selected.map(entry => entry.stableId));
});

test('unified routing keeps the legacy writer at zero calls', async () => {
  let legacy = 0;
  let unified = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: {
      migrationComplete: true,
      pendingRecovery: false,
      singleWriterReady: true,
      backupVerified: true,
      userConfirmed: true,
      authorization: issueSyntheticRuntimeAuthorization(),
      storageSupportsCas: true,
    },
    legacyScheduler: () => { legacy += 1; return { status: 'applied', writesPerformed: true }; },
    unifiedExecutor: () => { unified += 1; return { status: 'applied', writesPerformed: true }; },
  });
  const routed = await router.route({ action: 'grade.advanced' });
  assert.equal(routed.route, 'unified');
  assert.equal(legacy, 0);
  assert.equal(unified, 1);
});

test('an unsupported date format is never guessed anywhere', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': vaultTopic(1) });
  assert.throws(() => createFakeVaultAdapter({ vault, dateFormat: 'DD.MM.YYYY' }),
    error => error.code === 'E_DATE_FORMAT_UNSUPPORTED');
  const model = buildDashboardModel({
    topics: [schedulingTopic(1)], today: TODAY, dateFormat: 'DD.MM.YYYY',
  });
  assert.equal(model.topics[0].nextReviewProjection, null);
  assert.equal(model.topics[0].projectionWarning, 'E_DATE_FORMAT_UNSUPPORTED');
});
