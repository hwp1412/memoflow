'use strict';

// Metric computation for the MF-US-1 offline simulation (SPEC A13.2 M01-M08).
//
// Definitions are deliberately explicit so no metric can quietly change its
// denominator:
//   M01 waiting      Effective Due -> processing date, in calendar days. Topics
//                    still unresolved at the end are reported separately (never
//                    dropped from the report) with their backlog age.
//   M02 high priority P1-P20 waiting distribution.
//   M03 low priority P80-P100 waiting: max wait plus oldest unresolved backlog.
//   M04 daily budget  used minutes vs budget, over-budget minutes. Mercy planned
//                    overload is reported separately by the scenario, never mixed
//                    into reading-budget usage.
//   M05 ideal overdue active topics whose ideal due already passed and are not
//                    yet processed. POSTPONE/Mercy never remove them from this
//                    ideal backlog.
//   M06 completion    three distinct numbers: processed events, topics processed
//                    at least once, topics completed (COMPLETE).
//   M07 interventions simulated strategy actions by event type (explicitly
//                    labelled simulated, not real user behaviour).
//   M08 anomalies     errors by code and by stage, each with a sample.

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeMetrics({ processed, unresolved, daily, completions, topicsProcessed, initialCount, errors, eventCounts, startDate, endDate }) {
  const waits = processed.map(record => record.waitDays);
  const highWaits = processed.filter(record => record.priority <= 20).map(record => record.waitDays);
  const lowProcessed = processed.filter(record => record.priority >= 80);
  const lowWaits = lowProcessed.map(record => record.waitDays);
  const unresolvedAges = unresolved.map(record => record.ageDays);

  const totalUsed = daily.reduce((total, day) => total + day.usedMinutes, 0);
  const totalBudget = daily.reduce((total, day) => total + day.budgetMinutes, 0);
  const daysOverBudget = daily.filter(day => day.usedMinutes > day.budgetMinutes).length;
  const overMinutes = daily.reduce((total, day) => total + Math.max(0, day.usedMinutes - day.budgetMinutes), 0);
  const idealOverdueByDay = daily.map(day => day.idealOverdueCount);

  return {
    m01Waiting: {
      unit: 'calendar days from effective due to processing',
      processedCount: processed.length,
      avgWaitDays: round(mean(waits), 2),
      p95WaitDays: percentile(waits, 0.95),
      maxWaitDays: waits.length ? Math.max(...waits) : 0,
      unresolvedCount: unresolved.length,
      unresolvedOldestAgeDays: unresolvedAges.length ? Math.max(...unresolvedAges) : 0,
      unresolvedAvgAgeDays: round(mean(unresolvedAges), 2),
      note: 'unresolved topics are reported separately, never removed from the denominator',
    },
    m02HighPriority: {
      band: 'P1-P20',
      processedCount: highWaits.length,
      avgWaitDays: round(mean(highWaits), 2),
      p95WaitDays: percentile(highWaits, 0.95),
      maxWaitDays: highWaits.length ? Math.max(...highWaits) : 0,
    },
    m03LowPriority: {
      band: 'P80-P100',
      processedCount: lowWaits.length,
      maxWaitDays: lowWaits.length ? Math.max(...lowWaits) : 0,
      avgWaitDays: round(mean(lowWaits), 2),
      unresolvedLowCount: unresolved.filter(record => record.priority >= 80).length,
      unresolvedOldestAgeDays: unresolved.length ? Math.max(...unresolvedAges) : 0,
    },
    m04DailyBudget: {
      days: daily.length,
      totalUsedMinutes: totalUsed,
      totalBudgetMinutes: totalBudget,
      utilization: totalBudget === 0 ? 0 : round(totalUsed / totalBudget, 3),
      overBudgetMinutes: overMinutes,
      daysOverBudget,
      maxDailyOverMinutes: daily.reduce((max, day) => Math.max(max, Math.max(0, day.usedMinutes - day.budgetMinutes)), 0),
    },
    m05IdealOverdue: {
      max: idealOverdueByDay.length ? Math.max(...idealOverdueByDay) : 0,
      avg: round(mean(idealOverdueByDay), 2),
      final: idealOverdueByDay.length ? idealOverdueByDay[idealOverdueByDay.length - 1] : 0,
      note: 'POSTPONE/Mercy do not remove a topic from the ideal backlog',
    },
    m06Completion: {
      reviewEvents: processed.length,
      topicsProcessedAtLeastOnce: topicsProcessed,
      completedTopics: completions,
      initialTopics: initialCount,
      completionRateOfInitial: initialCount ? round(completions / initialCount, 3) : 0,
      completionRateOfProcessed: topicsProcessed ? round(completions / topicsProcessed, 3) : 0,
      note: 'processed events, processed topics and COMPLETE are three different numbers',
    },
    m07Interventions: {
      source: 'simulated strategy actions (not real user behaviour)',
      byType: { ...eventCounts },
    },
    m08Anomalies: {
      total: errors.total,
      byCode: { ...errors.byCode },
      byStage: { ...errors.byStage },
      samples: errors.samples.slice(0, 10),
    },
    window: { startDate, endDate, days: daily.length },
  };
}

module.exports = { computeMetrics, percentile, mean, round };
