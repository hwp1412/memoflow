'use strict';

// Seven-day workload forecast (SPEC A6.4, A12).
//
// Read-only projection: it never mutates a topic, never reschedules and never
// feeds back into the queue. Ideal due and effective due are counted on
// separate axes, so a POSTPONE moves the effective load without erasing the
// original backlog.
//
// Window definition (explicit, because A6.4 does not spell it out):
//   the window is [today, today + days - 1] — `days` calendar days starting
//   with today. This is flagged as an open interpretation in the PR document.

const { fail } = require('./errors.js');
const { assertQueueConfig } = require('./queue-config.js');
const { assertDateString, addCalendarDays } = require('./dates.js');

function workloadWindow(today, days) {
  assertDateString(today, 'today');
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 366) {
    fail('E_WORKLOAD_WINDOW_INVALID', 'workload window must be an integer within 1..366 days', { days });
  }
  const dates = [];
  for (let offset = 0; offset < days; offset += 1) dates.push(addCalendarDays(today, offset));
  return dates;
}

// `entries` are already accepted, active Source/Extract entries carrying
// { idealDue, effectiveDue, estimatedMinutes }.
function forecastFromEntries(entries, config, today) {
  const cfg = assertQueueConfig(config);
  if (!Array.isArray(entries)) {
    fail('E_OBJECT_REQUIRED', 'forecastFromEntries expects an array of entries', { field: 'entries' });
  }
  const dates = workloadWindow(today, cfg.workloadDays);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const days = dates.map(date => ({
    date,
    idealDueCount: 0,
    effectiveDueCount: 0,
    plannedMinutes: 0,
    budgetMinutes: cfg.dailyBudgetMinutes,
    overloadMinutes: 0,
  }));

  for (const entry of entries) {
    const idealIndex = indexByDate.get(entry.idealDue);
    if (idealIndex !== undefined) days[idealIndex].idealDueCount += 1;
    const effectiveIndex = indexByDate.get(entry.effectiveDue);
    if (effectiveIndex !== undefined) {
      days[effectiveIndex].effectiveDueCount += 1;
      days[effectiveIndex].plannedMinutes += entry.estimatedMinutes;
    }
  }

  const totals = {
    idealDueCount: 0,
    effectiveDueCount: 0,
    plannedMinutes: 0,
    overloadMinutes: 0,
    overloadedDays: 0,
  };
  for (const day of days) {
    day.overloadMinutes = Math.max(0, day.plannedMinutes - day.budgetMinutes);
    totals.idealDueCount += day.idealDueCount;
    totals.effectiveDueCount += day.effectiveDueCount;
    totals.plannedMinutes += day.plannedMinutes;
    totals.overloadMinutes += day.overloadMinutes;
    if (day.overloadMinutes > 0) totals.overloadedDays += 1;
  }

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    days,
    totals,
    budgetMinutes: cfg.dailyBudgetMinutes,
  };
}

module.exports = { workloadWindow, forecastFromEntries };
