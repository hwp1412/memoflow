'use strict';

// Metric computation for the MF-US-1 offline simulation (SPEC A13.2 M01-M08).
//
// Definitions are explicit so no metric can quietly change its denominator:
//
//   reviewEvents                 one entry per processed review event
//   topicsProcessedAtLeastOnce   unique topics that were reviewed at least once
//   completedTopics              topics that received COMPLETE
//   neverProcessed               topics with ZERO review events in the window
//   outstandingAtEnd             active topics whose effective due is on/before
//                                the last simulated day and that still need a
//                                next review (includes topics processed earlier
//                                and due again)
//
// M01 waiting uses review events only. Work that is still outstanding at the
// end is a CENSORED observation and is reported as its own backlog
// distribution; it is never folded into the processed average.
//
// M08 reports both unique anomaly identities and raw occurrences, because a
// broken topic can be re-reported on several simulated days.

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

function computeMetrics({
  processed,
  neverProcessed = [],
  outstandingAtEnd = [],
  daily,
  completions,
  topicsProcessed,
  initialTopics,
  totalTopics,
  errors,
  eventCounts,
  startDate,
  endDate,
}) {
  const waits = processed.map(record => record.waitDays);
  const highWaits = processed.filter(record => record.priority <= 20).map(record => record.waitDays);
  const lowProcessed = processed.filter(record => record.priority >= 80);
  const lowWaits = lowProcessed.map(record => record.waitDays);

  const outstandingAges = outstandingAtEnd.map(record => record.ageDays);
  const lowOutstanding = outstandingAtEnd.filter(record => record.priority >= 80);

  const totalUsed = daily.reduce((total, day) => total + day.usedMinutes, 0);
  const totalBudget = daily.reduce((total, day) => total + day.budgetMinutes, 0);
  const daysOverBudget = daily.filter(day => day.usedMinutes > day.budgetMinutes).length;
  const overMinutes = daily.reduce((total, day) => total + Math.max(0, day.usedMinutes - day.budgetMinutes), 0);
  const idealOverdueByDay = daily.map(day => day.idealOverdueCount);

  return {
    m01Waiting: {
      unit: 'calendar days from effective due to the review that processed it',
      reviewEvents: processed.length,
      topicsProcessedAtLeastOnce: topicsProcessed,
      avgWaitDays: round(mean(waits), 2),
      p95WaitDays: percentile(waits, 0.95),
      maxWaitDays: waits.length ? Math.max(...waits) : 0,
      neverProcessedCount: neverProcessed.length,
      outstandingAtEndCount: outstandingAtEnd.length,
      outstandingOldestAgeDays: outstandingAges.length ? Math.max(...outstandingAges) : 0,
      outstandingAvgAgeDays: round(mean(outstandingAges), 2),
      note: 'waiting statistics come from review events only; outstanding work is a censored backlog reported separately and never added to the processed average',
    },
    m02HighPriority: {
      band: 'P1-P20',
      reviewEvents: highWaits.length,
      avgWaitDays: round(mean(highWaits), 2),
      p95WaitDays: percentile(highWaits, 0.95),
      maxWaitDays: highWaits.length ? Math.max(...highWaits) : 0,
    },
    m03LowPriority: {
      band: 'P80-P100',
      reviewEvents: lowWaits.length,
      maxWaitDays: lowWaits.length ? Math.max(...lowWaits) : 0,
      avgWaitDays: round(mean(lowWaits), 2),
      neverProcessedLowCount: neverProcessed.filter(record => record.priority >= 80).length,
      outstandingAtEndLowCount: lowOutstanding.length,
      outstandingOldestAgeDays: lowOutstanding.length ? Math.max(...lowOutstanding.map(record => record.ageDays)) : 0,
      note: 'the oldest backlog is computed from P80-P100 outstanding topics only, not from all priorities',
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
      neverProcessedCount: neverProcessed.length,
      outstandingAtEndCount: outstandingAtEnd.length,
      initialTopics,
      totalTopics,
      completionRateOfInitial: initialTopics ? round(completions / initialTopics, 3) : 0,
      completionRateOfAllTopics: totalTopics ? round(completions / totalTopics, 3) : 0,
      completionRateOfProcessed: topicsProcessed ? round(completions / topicsProcessed, 3) : 0,
      note: 'initialTopics excludes topics added during the run; totalTopics includes them. The three counts and rates are never merged',
    },
    m07Interventions: {
      source: 'simulated strategy actions (not real user behaviour)',
      byType: { ...eventCounts },
    },
    m08Anomalies: {
      uniqueAnomalies: errors.uniqueTotal,
      occurrences: errors.occurrenceTotal,
      byCode: { ...errors.byCode },
      occurrencesByCode: { ...errors.occurrencesByCode },
      byStage: { ...errors.byStage },
      samples: errors.samples.slice(0, 10),
      note: 'byCode counts unique (stage, code, topic) identities; occurrencesByCode counts every re-report, e.g. the same broken note over several days',
    },
    window: { startDate, endDate, days: daily.length },
  };
}

module.exports = { computeMetrics, percentile, mean, round };
