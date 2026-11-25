'use strict';

// PR-03 — properties and preliminary performance for the daily queue
// (SPEC A13.1, A14).

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  createQueueConfig,
  selectDailyQueue,
} = require('../src/scheduling/index.js');

const TODAY = '2026-11-24';

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function topic(n, overrides = {}) {
  return {
    type: n % 3 === 0 ? 'source' : 'extract',
    status: 'active',
    priority: (n % 100) + 1,
    mf_id: uuid(n),
    mf_ideal_due: '2026-11-20',
    mf_not_before: null,
    ...overrides,
  };
}

test('identical input always produces identical output', () => {
  const input = [
    topic(1),
    topic(2, { priority: 7 }),
    topic(3, { mf_ideal_due: '2026-11-10' }),
    topic(4, { mf_not_before: '2026-12-01' }),
    topic(5, { mf_ideal_due: '2026-12-20' }),
  ];
  const first = selectDailyQueue(input, undefined, TODAY);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(selectDailyQueue(input, undefined, TODAY), first);
  }
});

test('inputs are never mutated', () => {
  const input = Object.freeze([Object.freeze(topic(1, { estimated_minutes: 5 })), Object.freeze(topic(2))]);
  const snapshot = JSON.parse(JSON.stringify(input));
  selectDailyQueue(input, undefined, TODAY);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});

test('the budget is never exceeded and selection stays consistent', () => {
  for (const budget of [1, 5, 10, 30, 60, 1440]) {
    const config = createQueueConfig({ dailyBudgetMinutes: budget });
    const result = selectDailyQueue(
      Array.from({ length: 40 }, (_, index) => topic(index + 1, { estimated_minutes: 1 + (index % 20) })),
      config,
      TODAY
    );
    assert.ok(result.budget.usedMinutes <= budget, `budget ${budget}`);
    const sum = result.selected.reduce((total, entry) => total + entry.estimatedMinutes, 0);
    assert.equal(sum, result.budget.usedMinutes);
  }
});

test('a topic that is not yet due is never selected', () => {
  const result = selectDailyQueue(
    Array.from({ length: 30 }, (_, index) => topic(index + 1, { mf_ideal_due: '2026-12-0' + ((index % 9) + 1) })),
    createQueueConfig({ dailyBudgetMinutes: 1440 }),
    TODAY
  );
  assert.equal(result.selected.length, 0);
  assert.equal(result.notYetDue.length, 30);
});

test('a Card is never part of any MF-US-1 bucket except invalid', () => {
  const result = selectDailyQueue([
    topic(1, { type: 'card' }),
    topic(2, { type: 'card', priority: 1 }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 0);
  assert.equal(result.deferredByBudget.length, 0);
  assert.equal(result.postponed.length, 0);
  assert.equal(result.notYetDue.length, 0);
  assert.equal(result.invalid.every(item => item.code === 'E_TOPIC_TYPE'), true);
});

test('effective priority always stays within 1..100', () => {
  for (let priority = 1; priority <= 100; priority += 1) {
    for (const overdue of [0, 6, 7, 30, 140, 365, 3650]) {
      const result = selectDailyQueue([
        topic(1, {
          priority,
          mf_ideal_due: addDays(TODAY, -overdue),
        }),
      ], createQueueConfig({ dailyBudgetMinutes: 1440 }), TODAY);
      const entry = result.selected[0] || result.deferredByBudget[0];
      assert.ok(entry.effectivePriority >= 1 && entry.effectivePriority <= 100);
      assert.equal(entry.priority, priority);
    }
  }
});

test('permuting a large input does not change the selected queue', () => {
  const pool = Array.from({ length: 200 }, (_, index) => topic(index + 1));
  const reference = selectDailyQueue(pool, undefined, TODAY).selected.map(entry => entry.stableId);
  const reversed = pool.slice().reverse();
  assert.deepEqual(selectDailyQueue(reversed, undefined, TODAY).selected.map(entry => entry.stableId), reference);
});

test('10,000 topics are processed well inside the A14 target', () => {
  const pool = Array.from({ length: 10000 }, (_, index) => topic(index + 1, {
    mf_ideal_due: addDays('2026-11-01', index % 40),
    estimated_minutes: 1 + (index % 15),
  }));

  const started = performance.now();
  const result = selectDailyQueue(pool, undefined, TODAY);
  const elapsed = performance.now() - started;

  assert.equal(result.budget.candidateCount + result.postponed.length + result.notYetDue.length, 10000);
  assert.ok(result.selected.length <= 6, 'at most six 5-minute tasks fit a 30-minute budget');
  assert.ok(result.budget.usedMinutes <= 30);
  assert.ok(elapsed < 500, `10k topics took ${elapsed.toFixed(1)}ms, expected < 500ms`);
  console.log(`[perf] 10,000 topics: ${elapsed.toFixed(1)}ms, selected ${result.selected.length}`);
});

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
