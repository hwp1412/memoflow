'use strict';

// HOST-CLOSURE P0 — shared contracts: batch runner, topic projection, legacy
// write guard. Pure modules only; no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS, planBatch, classifyOutcome, runBatch, aggregateStatus, describeBatch, BatchContractError,
} = require('../src/integration/batch-runner.js');
const { projectTopic, projectTopics, toQueueTopic, AUTHORITY } = require('../src/integration/topic-projection.js');
const { guardLegacySchedulingWrite, isUnifiedMode } = require('../src/integration/host-write-guard.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-26';

function item(id, overrides = {}) {
  return { path: `Sources/${id}.md`, basename: id, topicId: id, type: 'source', status: 'active', ...overrides };
}

// ---- batch runner --------------------------------------------------------

test('a batch pins today, sorts deterministically and refuses duplicate ids', () => {
  const plan = planBatch({
    kind: 'POSTPONE', batchId: 'b1', today: TODAY,
    items: [item(uuid(2)), item(uuid(1)), item(uuid(3), { type: 'card' }), item(uuid(4), { status: 'done' })],
  });
  assert.equal(plan.today, TODAY);
  assert.deepEqual(plan.items.map(node => node.topicId), [uuid(1), uuid(2)]);
  assert.equal(plan.skipped.length, 2);

  assert.throws(
    () => planBatch({ kind: 'POSTPONE', batchId: 'b2', today: TODAY, items: [item(uuid(5)), item(uuid(5), { path: 'Extracts/X.md' })] }),
    error => error instanceof BatchContractError && error.code === 'E_BATCH_DUPLICATE_ID',
  );
  assert.throws(() => planBatch({ kind: '', batchId: 'b', today: TODAY, items: [] }), error => error.code === 'E_BATCH_KIND');
  assert.throws(() => planBatch({ kind: 'x', batchId: '', today: TODAY, items: [] }), error => error.code === 'E_BATCH_ID');
  assert.throws(() => planBatch({ kind: 'x', batchId: 'b', today: '26-11-2026', items: [] }), error => error.code === 'E_BATCH_TODAY');
});

test('outcomes are classified into the eight shared statuses', () => {
  assert.equal(classifyOutcome({ status: 'applied' }).status, STATUS.applied);
  assert.equal(classifyOutcome({ status: 'duplicate' }).status, STATUS.duplicate);
  assert.equal(classifyOutcome({ status: 'no-op', reason: 'NO_LATER' }).status, STATUS.noOp);
  assert.equal(classifyOutcome({ status: 'conflict', reason: 'E_X' }).status, STATUS.conflict);
  assert.equal(classifyOutcome({ status: 'uncertain' }).status, STATUS.uncertain);
  assert.equal(classifyOutcome({ status: 'requires-manual-recovery', reason: 'E_M' }).status, STATUS.uncertain);
  assert.equal(classifyOutcome({ status: 'blocked', reason: 'E_ID' }).status, STATUS.blocked);
  assert.equal(classifyOutcome({ status: 'failed', reason: 'E_F' }).status, STATUS.failed);
  assert.equal(classifyOutcome({ status: 'weird' }).status, STATUS.failed);
  assert.equal(classifyOutcome(null).status, STATUS.failed);
});

test('a batch runs sequentially and aggregates honestly', async () => {
  const plan = planBatch({
    kind: 'SET_PRIORITY', batchId: 'b3', today: TODAY,
    items: [item(uuid(11)), item(uuid(12)), item(uuid(13))],
  });
  const seen = [];
  const outcome = await runBatch({
    plan,
    runItem: async node => {
      seen.push(node.topicId);
      if (node.topicId === uuid(12)) return { status: 'conflict', reason: 'E_REVISION_MISMATCH' };
      return { status: 'applied' };
    },
  });
  assert.deepEqual(seen, [uuid(11), uuid(12), uuid(13)]);
  assert.equal(outcome.status, 'partial');
  assert.deepEqual(outcome.counts, { applied: 2, duplicate: 0, noOp: 0, skipped: 0, blocked: 0, conflict: 1, failed: 0, uncertain: 0 });
  const report = describeBatch(outcome, { label: '设置优先级' });
  assert.match(report.message, /非原子/);
  assert.doesNotMatch(report.message, /\/Users\//, 'reports never include absolute paths');
});

test('all no-op is reported as no-op, and uncertain is never success', async () => {
  const plan = planBatch({ kind: 'POSTPONE', batchId: 'b4', today: TODAY, items: [item(uuid(21)), item(uuid(22))] });
  const noop = await runBatch({ plan, runItem: async () => ({ status: 'no-op', reason: 'NO_LATER_THAN_EXISTING' }) });
  assert.equal(noop.status, STATUS.noOp);
  assert.equal(aggregateStatus(noop.counts), STATUS.noOp);

  const uncertain = await runBatch({
    plan,
    runItem: async node => (node.topicId === uuid(21) ? { status: 'uncertain', reason: 'E_WRITE_UNVERIFIED' } : { status: 'applied' }),
  });
  assert.equal(uncertain.status, STATUS.uncertain);
  assert.equal(uncertain.counts.uncertain, 1);
  assert.match(describeBatch(uncertain, { label: '延期' }).message, /未确认 1/);
});

test('verifyItem blocks a changed node and a throwing runner becomes failed', async () => {
  const plan = planBatch({ kind: 'BOOST', batchId: 'b5', today: TODAY, items: [item(uuid(31)), item(uuid(32))] });
  const outcome = await runBatch({
    plan,
    verifyItem: node => (node.topicId === uuid(32) ? { ok: false, code: 'E_ITEM_CHANGED' } : { ok: true }),
    runItem: async node => {
      if (node.topicId === uuid(31)) throw Object.assign(new Error('boom'), { code: 'E_RUN_FAILED' });
      return { status: 'applied' };
    },
  });
  assert.equal(outcome.counts.failed, 1);
  assert.equal(outcome.counts.blocked, 1);
  assert.equal(outcome.status, 'failed');
});

// ---- topic projection ----------------------------------------------------

function fm(overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, a_factor: 1.5, review_count: 2,
    interval: 8, next_review: '2026-12-01', date_added: '2026-10-01',
    mf_id: uuid(41), mf_revision: 3, mf_scheduler_version: 1,
    mf_ideal_due: '2026-12-01', mf_not_before: null, mf_interval_days: 8,
    ...overrides,
  };
}
const file = { path: 'Sources/A.md', basename: 'A' };

test('unified projection is the only writable/queue authority', () => {
  const projected = projectTopic({ tfile: file, fm: fm() }, { mode: 'unified' });
  assert.equal(projected.authority, AUTHORITY.unified);
  assert.equal(projected.writable, true);
  assert.equal(projected.queueEligible, true);
  assert.equal(projected.effectiveDue, '2026-12-01');
  assert.equal(projected.revision, 3);

  const noId = projectTopic({ tfile: file, fm: fm({ mf_id: undefined }) }, { mode: 'unified' });
  assert.equal(noId.writable, false);
  assert.ok(noId.blockers.includes('ID_NOT_PERSISTED'));
  assert.equal(noId.queueEligible, false);

  const card = projectTopic({ tfile: file, fm: fm({ type: 'card' }) }, { mode: 'unified' });
  assert.deepEqual(card.blockers, ['CARD']);
  assert.equal(card.writable, false);
  assert.equal(card.queueEligible, false);

  const done = projectTopic({ tfile: file, fm: fm({ status: 'done' }) }, { mode: 'unified' });
  assert.equal(done.writable, true, 'REACTIVATE must be able to read a done topic');
  assert.equal(done.queueEligible, false);

  const inbox = projectTopic({ tfile: file, fm: fm({ status: 'inbox' }) }, { mode: 'unified' });
  assert.equal(inbox.writable, false);
  assert.ok(inbox.blockers.includes('STATUS_UNSUPPORTED'));
});

test('legacy projection is read-only and never claims unified writability', () => {
  const legacy = projectTopic({ tfile: file, fm: fm({ mf_id: undefined }) }, { mode: 'legacy' });
  assert.equal(legacy.authority, AUTHORITY.legacy);
  assert.equal(legacy.writable, false);
  assert.equal(legacy.idealDue, '2026-12-01');
  assert.equal(legacy.intervalDays, 8);
  assert.equal(legacy.blockers.includes('STATUS_NEEDS_MIGRATION'), false);
  assert.equal(projectTopic({ tfile: file, fm: fm({ status: 'pending' }) }, { mode: 'legacy' }).queueEligible, false);

  const queueTopic = toQueueTopic(projectTopic({ tfile: file, fm: fm() }, { mode: 'unified' }));
  assert.equal(queueTopic.mf_id, uuid(41));
  assert.equal(queueTopic.mf_ideal_due, '2026-12-01');
  assert.equal(queueTopic.mf_interval_days, 8);
  assert.equal(queueTopic.next_review, undefined, 'no legacy field may leak into the unified queue input');
});

test('not_before overrides effective due without changing ideal due', () => {
  const projected = projectTopic({ tfile: file, fm: fm({ mf_not_before: '2026-12-10' }) }, { mode: 'unified' });
  assert.equal(projected.idealDue, '2026-12-01');
  assert.equal(projected.notBefore, '2026-12-10');
  assert.equal(projected.effectiveDue, '2026-12-10');
});

// ---- legacy write guard --------------------------------------------------

test('the guard blocks residual legacy writes only in unified mode, once per feature', () => {
  const plugin = { settings: { mf_us1_mode: 'legacy' } };
  assert.equal(isUnifiedMode(plugin), false);
  assert.equal(guardLegacySchedulingWrite(plugin, 'Boost').blocked, false);

  plugin.settings.mf_us1_mode = 'unified';
  const first = guardLegacySchedulingWrite(plugin, 'Boost');
  const second = guardLegacySchedulingWrite(plugin, 'Boost');
  assert.equal(first.blocked, true);
  assert.equal(first.first, true);
  assert.equal(first.code, 'E_UNIFIED_LEGACY_WRITE_BLOCKED');
  assert.equal(second.first, false, 'repeat failure must not notify again');
  assert.equal(guardLegacySchedulingWrite(plugin, 'Mercy').first, true);
});
