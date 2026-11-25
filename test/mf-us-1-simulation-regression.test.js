'use strict';

// PR-05 — regression checks for the simulation harness itself: metric formulas,
// scenario catalogue, legacy rules and fixed-seed structure.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SCENARIOS, scenarioS05, scenarioS07 } = require('./helpers/simulation/scenarios.js');
const { computeMetrics, percentile, mean } = require('./helpers/simulation/metrics.js');
const { legacyFirstInterval, legacyNextInterval, LEGACY_A_FACTOR } = require('./helpers/simulation/legacy-reference.js');

test('the scenario catalogue covers S01-S08 and the comparison run', () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), ['CMP', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08']);
});

test('percentile and mean follow their documented definitions', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(percentile([], 0.95), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(value => percentile([value], 0.95)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
});

test('completion metrics keep the three definitions apart', () => {
  const metrics = computeMetrics({
    processed: [
      { waitDays: 0, priority: 10 },
      { waitDays: 2, priority: 10 },
      { waitDays: 5, priority: 90 },
    ],
    unresolved: [{ priority: 90, ageDays: 40 }],
    daily: [{ usedMinutes: 20, budgetMinutes: 30, idealOverdueCount: 2 }],
    completions: 1,
    topicsProcessed: 2,
    initialCount: 10,
    errors: { total: 0, byCode: {}, byStage: {}, samples: [] },
    eventCounts: { ADVANCED: 3 },
    startDate: '2026-01-05',
    endDate: '2026-01-05',
  });
  assert.equal(metrics.m01Waiting.processedCount, 3);
  assert.equal(metrics.m01Waiting.unresolvedCount, 1);
  assert.equal(metrics.m01Waiting.avgWaitDays, 2.33); // (0 + 2 + 5) / 3 rounded to 2 decimals
  assert.equal(metrics.m06Completion.reviewEvents, 3);
  assert.equal(metrics.m06Completion.topicsProcessedAtLeastOnce, 2);
  assert.equal(metrics.m06Completion.completedTopics, 1);
  assert.equal(metrics.m06Completion.completionRateOfInitial, 0.1);
  assert.equal(metrics.m06Completion.completionRateOfProcessed, 0.5);
  assert.equal(metrics.m05IdealOverdue.max, 2);
  assert.equal(metrics.m08Anomalies.total, 0);
});

test('unresolved topics are never removed from the waiting report', () => {
  const metrics = computeMetrics({
    processed: [{ waitDays: 1, priority: 30 }],
    unresolved: [{ priority: 30, ageDays: 99 }],
    daily: [],
    completions: 0,
    topicsProcessed: 1,
    initialCount: 2,
    errors: { total: 0, byCode: {}, byStage: {}, samples: [] },
    eventCounts: {},
    startDate: '2026-01-05',
    endDate: '2026-01-05',
  });
  assert.equal(metrics.m01Waiting.unresolvedCount, 1);
  assert.equal(metrics.m01Waiting.unresolvedOldestAgeDays, 99);
  assert.equal(metrics.m01Waiting.avgWaitDays, 1, 'unresolved topics do not silently join the processed average');
});

test('legacy interval rules follow the documented formulas', () => {
  assert.equal(LEGACY_A_FACTOR, 2);
  assert.equal(legacyFirstInterval(50), 8); // ceil(7.5)
  assert.equal(legacyFirstInterval(1), 1);
  assert.equal(legacyFirstInterval(100), 15);
  assert.equal(legacyNextInterval(0, 50, 0), 8, 'first review recomputes from Priority');
  assert.equal(legacyNextInterval(8, 50, 1), 16);
  assert.equal(legacyNextInterval(9, 50, 2), 18);
});

test('S05 keeps its structural promises for the fixed seed', () => {
  const run = scenarioS05({ days: 5 });
  assert.equal(run.day0.budget.budgetMinutes, 30);
  assert.ok(run.day0.budget.usedMinutes <= 30);
  assert.equal(run.day0.deferredByBudget.length >= 1, true);
  assert.equal(run.result.daily.every(day => day.usedMinutes <= day.budgetMinutes), true);
});

test('S07 keeps its structural promises for the fixed seed', () => {
  const run = scenarioS07();
  assert.equal(run.plan.summary.assignedCount, 4);
  assert.equal(run.applied.batch.status, 'applied');
  assert.equal(run.partialEdited.batch.status, 'partially-applied');
  assert.equal(run.undone.batch.status, 'undone');
  assert.equal(run.resumed.batch.status, 'undone');
  assert.equal(run.staleError, 'E_MERCY_PLAN_STALE');
  assert.deepEqual(run.windows[7].length, 7);
});
