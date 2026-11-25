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
//   with today.
//
// Backlog rule (owner review): work that is already overdue and still
// available must show up in today's REAL load. Per day:
//   idealDueCount   items whose ideal due falls on that day ("newly due")
//   effectiveDueCount items whose effective due falls on that day
//   plannedMinutes  cost of the effective-due items of that day
//   backlogCount    available overdue items (effective due before today),
//                   reported ONCE on the today row — never spread over the
//                   window (distribution belongs to Mercy, not the forecast)
//   backlogMinutes  cost of those overdue items
//   availableCount/availableMinutes  planned + backlog for that day
//   overloadMinutes max(0, availableMinutes - budget)
//
// Totals add two backlog signals that are independent of the window:
//   idealBacklogCount / idealBacklogMinutes — every entry with ideal due before
//   today, including topics postponed beyond the window. They keep the original
//   backlog visible without pretending it is processable now.

const { fail } = require('./errors.js');
const { assertQueueConfig } = require('./queue-config.js');
const { assertDateString, addCalendarDays, compareDate } = require('./dates.js');

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
  assertDateString(today, 'today');

  const dates = workloadWindow(today, cfg.workloadDays);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const days = dates.map(date => ({
    date,
    idealDueCount: 0,
    effectiveDueCount: 0,
    plannedMinutes: 0,
    backlogCount: 0,
    backlogMinutes: 0,
    availableCount: 0,
    availableMinutes: 0,
    budgetMinutes: cfg.dailyBudgetMinutes,
    overloadMinutes: 0,
  }));

  const totals = {
    idealDueCount: 0,
    effectiveDueCount: 0,
    plannedMinutes: 0,
    backlogCount: 0,
    backlogMinutes: 0,
    availableCount: 0,
    availableMinutes: 0,
    overloadMinutes: 0,
    overloadedDays: 0,
    idealBacklogCount: 0,
    idealBacklogMinutes: 0,
  };

  for (const entry of entries) {
    // Window-independent backlog signal (includes postponed work).
    if (compareDate(entry.idealDue, today) < 0) {
      totals.idealBacklogCount += 1;
      totals.idealBacklogMinutes += entry.estimatedMinutes;
    }

    const idealIndex = indexByDate.get(entry.idealDue);
    if (idealIndex !== undefined) days[idealIndex].idealDueCount += 1;

    const effectiveIndex = indexByDate.get(entry.effectiveDue);
    if (effectiveIndex !== undefined) {
      days[effectiveIndex].effectiveDueCount += 1;
      days[effectiveIndex].plannedMinutes += entry.estimatedMinutes;
    }

    // Available overdue work is counted once, on today's row.
    if (compareDate(entry.effectiveDue, today) < 0) {
      days[0].backlogCount += 1;
      days[0].backlogMinutes += entry.estimatedMinutes;
    }
  }

  for (const day of days) {
    day.availableCount = day.effectiveDueCount + day.backlogCount;
    day.availableMinutes = day.plannedMinutes + day.backlogMinutes;
    day.overloadMinutes = Math.max(0, day.availableMinutes - day.budgetMinutes);
    totals.idealDueCount += day.idealDueCount;
    totals.effectiveDueCount += day.effectiveDueCount;
    totals.plannedMinutes += day.plannedMinutes;
    totals.backlogCount += day.backlogCount;
    totals.backlogMinutes += day.backlogMinutes;
    totals.availableCount += day.availableCount;
    totals.availableMinutes += day.availableMinutes;
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
