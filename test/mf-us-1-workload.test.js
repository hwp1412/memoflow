'use strict';

// PR-03 — seven-day workload forecast (SPEC A6.4, A12).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_QUEUE_CONFIG,
  createQueueConfig,
  forecastFromEntries,
  workloadWindow,
  selectDailyQueue,
} = require('../src/scheduling/index.js');

const TODAY = '2026-11-24';

function entry(idealDue, effectiveDue, estimatedMinutes = 5) {
  return { idealDue, effectiveDue, estimatedMinutes };
}

test('the window is seven calendar days starting today', () => {
  const dates = workloadWindow(TODAY, 7);
  assert.equal(dates.length, 7);
  assert.equal(dates[0], TODAY);
  assert.equal(dates[6], '2026-11-30');

  const forecast = forecastFromEntries([], DEFAULT_QUEUE_CONFIG, TODAY);
  assert.equal(forecast.days.length, 7);
  assert.equal(forecast.startDate, TODAY);
  assert.equal(forecast.endDate, '2026-11-30');
  assert.deepEqual(forecast.totals, {
    idealDueCount: 0,
    effectiveDueCount: 0,
    plannedMinutes: 0,
    overloadMinutes: 0,
    overloadedDays: 0,
  });
});

test('ideal and effective due are counted on separate axes', () => {
  const forecast = forecastFromEntries([
    entry('2026-11-20', '2026-12-01'), // overdue but postponed into the window
    entry(TODAY, TODAY),
  ], DEFAULT_QUEUE_CONFIG, TODAY);

  const today = forecast.days[0];
  assert.equal(today.date, TODAY);
  assert.equal(today.idealDueCount, 1); // only the second entry
  assert.equal(today.effectiveDueCount, 1);
  assert.equal(today.plannedMinutes, 5);

  // The postponed entry is invisible in the 7-day window on its ideal axis
  // (2026-11-20 is before today) but appears on its effective day, 12-01.
  assert.equal(forecast.days.find(day => day.date === '2026-12-01'), undefined);
  assert.equal(forecast.totals.idealDueCount, 1);
  assert.equal(forecast.totals.effectiveDueCount, 1);
});

test('a postponement inside the window moves load without erasing the ideal count', () => {
  const forecast = forecastFromEntries([
    entry('2026-11-26', '2026-11-29', 15),
  ], DEFAULT_QUEUE_CONFIG, TODAY);
  const idealDay = forecast.days.find(day => day.date === '2026-11-26');
  const effectiveDay = forecast.days.find(day => day.date === '2026-11-29');
  assert.equal(idealDay.idealDueCount, 1);
  assert.equal(idealDay.effectiveDueCount, 0);
  assert.equal(idealDay.plannedMinutes, 0);
  assert.equal(effectiveDay.idealDueCount, 0);
  assert.equal(effectiveDay.effectiveDueCount, 1);
  assert.equal(effectiveDay.plannedMinutes, 15);
  assert.equal(forecast.totals.plannedMinutes, 15);
});

test('budget and overload are computed per day', () => {
  const entries = [
    entry(TODAY, TODAY, 10),
    entry(TODAY, TODAY, 10),
    entry(TODAY, TODAY, 10),
    entry(TODAY, TODAY, 10), // 40 minutes vs a 30-minute budget
  ];
  const forecast = forecastFromEntries(entries, DEFAULT_QUEUE_CONFIG, TODAY);
  assert.equal(forecast.days[0].plannedMinutes, 40);
  assert.equal(forecast.days[0].budgetMinutes, 30);
  assert.equal(forecast.days[0].overloadMinutes, 10);
  assert.equal(forecast.totals.overloadMinutes, 10);
  assert.equal(forecast.totals.overloadedDays, 1);
});

test('the configured budget is reflected in every day', () => {
  const forecast = forecastFromEntries([entry(TODAY, TODAY, 12)], createQueueConfig({ dailyBudgetMinutes: 5 }), TODAY);
  assert.equal(forecast.budgetMinutes, 5);
  assert.equal(forecast.days[0].budgetMinutes, 5);
  assert.equal(forecast.days[0].overloadMinutes, 7);
});

test('window boundaries are inclusive of today+6 and exclusive of today+7', () => {
  const forecast = forecastFromEntries([
    entry(TODAY, TODAY),
    entry('2026-11-30', '2026-11-30'),
    entry('2026-12-01', '2026-12-01'),
    entry('2026-11-23', '2026-11-23'),
  ], DEFAULT_QUEUE_CONFIG, TODAY);
  assert.equal(forecast.totals.idealDueCount, 2); // today and 11-30
  assert.equal(forecast.totals.effectiveDueCount, 2);
  assert.equal(forecast.days.some(day => day.date === '2026-12-01'), false);
});

test('forecast is order independent and never mutates its input', () => {
  const entries = Object.freeze([
    Object.freeze(entry(TODAY, TODAY, 10)),
    Object.freeze(entry('2026-11-26', '2026-11-26', 5)),
    Object.freeze(entry('2026-11-26', '2026-11-27', 15)),
  ]);
  const first = forecastFromEntries(entries, DEFAULT_QUEUE_CONFIG, TODAY);
  const second = forecastFromEntries([...entries].reverse(), DEFAULT_QUEUE_CONFIG, TODAY);
  assert.deepEqual(first, second);
  assert.equal(entries[0].estimatedMinutes, 10);
});

test('the queue embeds a workload forecast for accepted topics only', () => {
  const result = selectDailyQueue([
    { type: 'extract', status: 'active', priority: 50, mf_id: '00000000-0000-4000-8000-000000000001', mf_ideal_due: TODAY },
    { type: 'extract', status: 'done', priority: 50, mf_id: '00000000-0000-4000-8000-000000000002', mf_ideal_due: TODAY },
    { type: 'extract', status: 'active', priority: 50, mf_id: '00000000-0000-4000-8000-000000000003', mf_ideal_due: '2026-11-30' },
  ], undefined, TODAY);

  assert.equal(result.workload.days.length, 7);
  assert.equal(result.workload.days[0].idealDueCount, 1); // done topic excluded
  assert.equal(result.workload.days[0].effectiveDueCount, 1);
  assert.equal(result.workload.days[6].idealDueCount, 1); // 11-30
});

test('forecast cannot change a topic schedule', () => {
  const input = { type: 'source', status: 'active', priority: 50, mf_id: '00000000-0000-4000-8000-000000000010', mf_ideal_due: TODAY };
  const snapshot = JSON.parse(JSON.stringify(input));
  const result = selectDailyQueue([input], undefined, TODAY);
  assert.equal(result.workload.totals.effectiveDueCount, 1);
  assert.deepEqual(input, snapshot);
});
