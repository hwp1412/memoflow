'use strict';

// PR-05 — A13.2 offline simulation: eight scenarios over the real pure core.
//
// All data is synthetic and in-memory; the simulator never reads a vault, the
// clock or the network, and every run is reproducible from its seed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const scenarios = require('./helpers/simulation/scenarios.js');
const {
  selectDailyQueue,
  compareDate,
  calendarDayDifference,
} = require('../src/scheduling/index.js');

const {
  scenarioS01, scenarioS02, scenarioS03, scenarioS04,
  scenarioS05, scenarioS06, scenarioS07, scenarioS08, scenarioComparison,
} = scenarios;
const { simulate } = require('./helpers/simulation/runner.js');
const { makeTopic, offsetDate } = require('./helpers/simulation/fixtures.js');

function simulateLight() {
  const topics = [];
  for (let index = 0; index < 5; index += 1) {
    topics.push(makeTopic({ seq: 960000 + index, type: 'extract', priority: 5, today: '2026-01-05', idealDue: '2026-01-05' }));
  }
  for (let index = 0; index < 50; index += 1) {
    topics.push(makeTopic({ seq: 961000 + index, type: 'extract', priority: 90, today: '2026-01-05', idealDue: offsetDate('2026-01-05', -3) }));
  }
  return simulate({ seed: 606, topics, days: 30, startDate: '2026-01-05' }).metrics;
}

test('S01: 100 / 1,000 / 10,000 topics produce complete metrics', () => {
  const started = performance.now();
  const runs = [
    { scale: 100, days: 180 },
    { scale: 1000, days: 180 },
    { scale: 10000, days: 60 },
  ].map(({ scale, days }) => {
    const run = scenarioS01({ scale, days });
    const { metrics } = run.result;
    assert.ok(metrics.m01Waiting.reviewEvents > 0, `scale ${scale}`);
    assert.ok(metrics.m01Waiting.avgWaitDays >= 0);
    assert.ok(metrics.m01Waiting.p95WaitDays >= metrics.m01Waiting.avgWaitDays - 1e-9);
    assert.ok(metrics.m04DailyBudget.utilization <= 1, `scale ${scale} budget`);
    assert.ok(metrics.m05IdealOverdue.max >= 0);
    assert.ok(metrics.m06Completion.topicsProcessedAtLeastOnce > 0);
    assert.ok(Number.isFinite(metrics.m08Anomalies.uniqueAnomalies));
    assert.equal(run.result.topics.length >= scale, true);
    return { scale, days, metrics, errors: run.result.errors.total };
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60000, `scale suite took ${elapsed.toFixed(0)}ms`);
  console.log('[sim] S01', runs.map(run => `${run.scale}@${run.days}d avg=${run.metrics.m01Waiting.avgWaitDays} outstanding=${run.metrics.m01Waiting.outstandingAtEndCount} errors=${run.errors}`).join(' | '));
});

test('S02: twenty new extracts per day never touch the parent topic', () => {
  const run = scenarioS02({ days: 60 });
  assert.equal(run.created.length, 60 * 20);
  assert.deepEqual(run.parentAfter, run.parentBefore, 'creating children must not change the parent');
  assert.ok(run.result.outstandingAtEnd.length > 0, 'the backlog should grow');
  const overdue = run.result.daily.map(day => day.idealOverdueCount);
  assert.ok(overdue[overdue.length - 1] > overdue[0], 'ideal backlog grows under sustained intake');
  assert.ok(run.result.metrics.m04DailyBudget.utilization > 0);
});

test('S03: a fourteen-day gap adds no fictional reviews and the backlog recovers', () => {
  const run = scenarioS03({ days: 45, gapStart: 10, gapLength: 14 });
  const gapStartDate = run.result.daily[10].date;
  const gapEndDate = run.result.daily[23].date;
  const gapDays = run.result.daily.slice(10, 24);
  assert.equal(gapDays.every(day => day.selectedCount === 0), true);
  assert.equal(gapDays.every(day => day.usedMinutes === 0), true);
  assert.equal(
    run.result.processed.some(record => compareDate(record.date, gapStartDate) >= 0 && compareDate(record.date, gapEndDate) <= 0),
    false
  );
  const afterGap = run.result.processed.filter(record => compareDate(record.date, gapEndDate) > 0);
  assert.ok(afterGap.length > 0, 'learning resumes after the gap');
  assert.ok(run.result.metrics.m05IdealOverdue.max > 0);
});

test('S04: five levels keep independent schedules and never alter the source', () => {
  const run = scenarioS04({ days: 20 });
  assert.equal(run.chain.length, 5);
  assert.equal(new Set(run.chain.map(topic => topic.mf_id)).size, 5);
  assert.deepEqual(run.result.topics[0], run.sourceBefore, 'the parent source is untouched');
  const childIds = new Set(run.chain.slice(1).map(topic => topic.mf_id));
  const reviewed = new Set(run.result.processed.filter(record => childIds.has(record.stableId)).map(record => record.stableId));
  assert.equal(reviewed.size, 4, 'every extract level was reviewed independently');
  const idealDues = run.result.topics.map(topic => topic.mf_ideal_due);
  assert.equal(new Set(idealDues.slice(1)).size >= 1, true);
});

test('S05: the daily budget is respected and oversized work is deferred, not lost', () => {
  const run = scenarioS05({ days: 5 });
  assert.ok(run.day0.budget.usedMinutes <= 30);
  assert.ok(run.day0.selected.length <= 6);
  assert.equal(run.day0.selected.every(entry => entry.estimatedMinutes <= 30), true);
  assert.equal(run.day0.deferredByBudget.some(entry => entry.stableId === run.large.mf_id), true);
  assert.equal(run.day0.selected.some(entry => entry.stableId === run.large.mf_id), false);
  assert.equal(run.result.daily.every(day => day.usedMinutes <= day.budgetMinutes), true);
  assert.equal(run.result.processed.some(record => record.stableId === run.large.mf_id), false);
});

test('S06: age bonus stays capped and low-priority starvation is reported', () => {
  const run = scenarioS06({ days: 60 });
  const { metrics } = run.result;
  assert.ok(metrics.m02HighPriority.reviewEvents > 0);
  // The scenario deliberately over-subscribes high-priority intake, so low
  // priority work may never be reached. That is a REPORTED finding, not a
  // reason to change the algorithm: the backlog must stay visible.
  assert.ok(metrics.m03LowPriority.outstandingAtEndLowCount > 0, 'low priority backlog is reported');
  assert.ok(metrics.m03LowPriority.maxWaitDays >= 0);
  assert.ok(metrics.m03LowPriority.outstandingOldestAgeDays >= 0);
  console.log('[sim] S06 starvation', JSON.stringify({
    lowProcessed: metrics.m03LowPriority.reviewEvents,
    lowOutstanding: metrics.m03LowPriority.outstandingAtEndLowCount,
    lowOldestAge: metrics.m03LowPriority.outstandingOldestAgeDays,
    highProcessed: metrics.m02HighPriority.reviewEvents,
  }));

  // With spare capacity the same queue does serve low priority work.
  const light = simulateLight();
  assert.ok(light.m03LowPriority.reviewEvents > 0, 'low priority is served when capacity allows');

  // Bonus cap: a very overdue topic cannot gain more than 20 levels.
  const ancient = {
    type: 'extract', status: 'active', priority: 50,
    mf_id: '00000000-0000-4000-8000-000000009999',
    mf_ideal_due: '2020-01-01', mf_not_before: null, estimated_minutes: 5,
  };
  const queue = selectDailyQueue([ancient], undefined, '2026-01-05');
  const entry = queue.selected[0];
  assert.equal(entry.ageBonus, 20);
  assert.equal(entry.effectivePriority, 30);
  assert.equal(entry.priority, 50, 'the raw priority is never rewritten');
});

test('S07: Mercy preview, apply, partial failure, undo and resume hold their invariants', () => {
  const run = scenarioS07();
  assert.equal(run.plan.summary.assignedCount, 4);
  assert.equal(run.applied.summary.appliedCount, 4);
  assert.equal(run.partialEdited.summary.conflictCount, 1);
  assert.equal(run.partialEdited.summary.appliedCount, 3);
  assert.equal(run.undone.summary.undoneCount, 4);
  assert.equal(run.firstUndo.summary.undoneCount, 1);
  assert.equal(run.firstUndo.summary.missingCount, 3);
  assert.equal(run.resumed.batch.status, 'undone');
  assert.equal(run.staleError, 'E_MERCY_PLAN_STALE');
  assert.equal(run.duplicateApply.summary.conflictCount, 1);
  assert.deepEqual(Object.keys(run.windows), ['3', '7', '14', '30']);
  assert.deepEqual(run.windows[3].length, 3);
  assert.deepEqual(run.windows[30].length, 30);

  // Undo restores each original mf_not_before (including a pre-existing date).
  const origins = run.topics.map(topic => topic.mf_not_before ?? null);
  assert.deepEqual(run.undone.topics.map(topic => topic.mf_not_before), origins);

  // Learning state never moves.
  for (const before of run.topics) {
    const after = run.applied.topics.find(topic => topic.mf_id === before.mf_id);
    assert.equal(after.mf_interval_days, before.mf_interval_days);
    assert.equal(after.a_factor, before.a_factor);
    assert.equal(after.review_count, before.review_count);
    assert.equal(after.mf_ideal_due, before.mf_ideal_due);
    assert.equal(after.priority, before.priority);
  }
});

test('S08: anomalies are reported and never contaminate valid topics', () => {
  const run = scenarioS08();
  const codes = run.queue.invalid.map(item => item.code);
  for (const expected of ['E_TOPIC_TYPE', 'E_PRIORITY_RANGE', 'E_DATE_INVALID', 'E_QUEUE_ID_REQUIRED', 'E_DUPLICATE_ID']) {
    assert.ok(codes.includes(expected), expected);
  }
  assert.equal(codes.filter(code => code === 'E_DUPLICATE_ID').length, 2);
  const selectedIds = run.queue.selected.map(entry => entry.stableId);
  assert.equal(selectedIds.length, 3);
  for (const topic of run.queue.selected) assert.ok(topic.priority > 0);

  // Event anomalies: E1 -> E2 -> E1 replay and a stale revision.
  assert.equal(run.events.firstApplied, true);
  assert.equal(run.events.secondApplied, true);
  assert.equal(run.events.replayDuplicate, true);
  assert.equal(run.events.reviewCount, 2, 'the replay never counts a third review');
  assert.equal(run.revisionConflict, 'E_REVISION_CONFLICT');
});

test('simulation runs are reproducible from their seed', () => {
  const first = scenarioS03({ days: 45 });
  const second = scenarioS03({ days: 45 });
  assert.deepEqual(first.result.metrics, second.result.metrics);
  assert.deepEqual(first.result.processed, second.result.processed);
  assert.deepEqual(first.result.topics, second.result.topics);
});

test('Legacy proxy vs Unified comparison is reproducible and clearly labelled', () => {
  const run = scenarioComparison({ count: 300, days: 90 });
  assert.equal(run.legacy.proxy, true);
  assert.ok(run.legacy.proxyLimitations.length >= 3);
  assert.ok(run.unified.metrics.m01Waiting.reviewEvents > 0);
  assert.ok(run.legacy.metrics.m01Waiting.reviewEvents > 0);
  for (const metrics of [run.unified.metrics, run.legacy.metrics]) {
    assert.ok(metrics.m04DailyBudget.totalUsedMinutes >= 0);
    assert.ok(metrics.m06Completion.completionRateOfInitial >= 0);
  }
  // Same seed and input, so the comparison itself must be deterministic.
  const again = scenarioComparison({ count: 300, days: 90 });
  assert.deepEqual(again.unified.metrics, run.unified.metrics);
  assert.deepEqual(again.legacy.metrics, run.legacy.metrics);
  console.log('[sim] CMP unified', run.unified.metrics.m01Waiting.avgWaitDays, 'legacy', run.legacy.metrics.m01Waiting.avgWaitDays);
});

test('the daily-loop simulator never violates the reading budget', () => {
  const run = scenarioS03({ days: 45 });
  for (const day of run.result.daily) {
    assert.ok(day.usedMinutes <= day.budgetMinutes, day.date);
    assert.ok(day.selectedCount <= day.candidateCount);
  }
  const gapReviewCount = run.result.processed.length;
  assert.ok(gapReviewCount > 0);
});

// ---- end-of-window backlog vs never processed (review fix 1) --------------

test('a topic reviewed earlier and due again belongs to outstandingAtEnd, not neverProcessed', () => {
  const active = makeTopic({
    seq: 970001,
    type: 'extract',
    priority: 50,
    today: '2026-01-05',
    idealDue: '2026-01-05',
    intervalDays: 1,
    aFactor: 1.5,
  });
  const done = makeTopic({ seq: 970002, type: 'extract', priority: 50, today: '2026-01-05', idealDue: '2026-01-05', status: 'done' });
  const future = makeTopic({ seq: 970003, type: 'extract', priority: 50, today: '2026-01-05', idealDue: offsetDate('2026-01-05', 10) });

  // Review once on the first day, then stop processing so the topic is due
  // again before the window ends without being handled a second time.
  const run = simulate({
    seed: 1,
    topics: [active, done, future],
    days: 5,
    startDate: '2026-01-05',
    skipWhen: ({ offset }) => offset >= 1,
  });

  assert.deepEqual(run.processed.map(record => record.stableId), [active.mf_id]);
  assert.equal(run.processed.length, 1);
  assert.equal(run.neverProcessed.some(record => record.stableId === active.mf_id), false);
  const outstanding = run.outstandingAtEnd.find(record => record.stableId === active.mf_id);
  assert.ok(outstanding, 'the re-due topic is part of the end-of-window backlog');
  assert.equal(outstanding.ageDays, 2);
  assert.equal(outstanding.reviewCount, 1, 'its history is still accurate');
  assert.equal(run.topics.find(topic => topic.mf_id === active.mf_id).review_count, 1);
  assert.equal(run.outstandingAtEnd.some(record => record.stableId === done.mf_id), false);
  assert.equal(run.outstandingAtEnd.some(record => record.stableId === future.mf_id), false);
  assert.equal(run.metrics.m01Waiting.outstandingAtEndCount, 1);
  assert.equal(run.metrics.m06Completion.neverProcessedCount, 2);
  assert.equal(run.metrics.m06Completion.reviewEvents, 1);
  assert.equal(run.metrics.m06Completion.topicsProcessedAtLeastOnce, 1);
});

test('S08 rename keeps identity, links and scheduling untouched', () => {
  const run = scenarioS08();
  const rename = run.rename;
  assert.notEqual(rename.before.path, rename.after.path);
  assert.notEqual(rename.before.basename, rename.after.basename);
  assert.equal(rename.after.mfId, rename.before.mfId);
  for (const field of ['parentId', 'rootId', 'priority', 'idealDue', 'interval', 'aFactor', 'reviewCount', 'revision']) {
    assert.equal(rename.after[field], rename.before[field], field);
  }
  assert.deepEqual(rename.orderAfter, rename.orderBefore, 'stable order does not depend on path or title');
});
