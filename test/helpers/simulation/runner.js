'use strict';

// Deterministic day-by-day simulator for MF-US-1 (SPEC A13.2).
//
// The loop only touches synthetic topics and the production pure functions
// (selectDailyQueue, applyEvent). Time advances through an explicit calendar;
// nothing reads the clock. A run is reproducible from (seed, scenario, days).

const {
  selectDailyQueue,
  applyEvent,
  effectiveDue,
  addCalendarDays,
  calendarDayDifference,
  compareDate,
} = require('../../../src/scheduling/index.js');
const { makeEvent } = require('./fixtures.js');
const { computeMetrics } = require('./metrics.js');

function createErrorCollector() {
  const byCode = {};
  const byStage = {};
  const samples = [];
  const seen = new Set();
  return {
    add(stage, code, sample = {}) {
      const key = `${stage}:${code}:${sample.stableId || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      byCode[code] = (byCode[code] || 0) + 1;
      byStage[stage] = (byStage[stage] || 0) + 1;
      if (samples.length < 20) samples.push({ stage, code, ...sample });
    },
    result() {
      return { total: Object.values(byCode).reduce((total, value) => total + value, 0), byCode, byStage, samples };
    },
  };
}

// options:
//   topics        initial synthetic topics (copied, never mutated)
//   days          simulated calendar days
//   startDate     first simulated day
//   dailyAdd      ({ offset, date, state }) => Topic[]  (optional)
//   queueConfig   created by createQueueConfig (optional)
//   completionReviews  COMPLETE after this many reviews (default 3)
//   skipWhen      ({ offset, date }) => boolean  (no processing on those days)
function simulate(options) {
  const {
    seed = 0,
    topics,
    days,
    startDate,
    dailyAdd = null,
    queueConfig = undefined,
    completionReviews = 3,
    skipWhen = () => false,
  } = options;

  const state = topics.map(topic => ({ ...topic }));
  const positions = new Map(state.map((topic, index) => [topic.mf_id, index]));
  const processed = [];
  const daily = [];
  const eventCounts = {};
  const errors = createErrorCollector();
  const processedIds = new Set();
  const initialCount = topics.length;
  let eventSeq = 0;
  let completions = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = addCalendarDays(startDate, offset);

    if (typeof dailyAdd === 'function') {
      for (const topic of dailyAdd({ offset, date, state })) {
        positions.set(topic.mf_id, state.length);
        state.push(topic);
      }
    }

    const queue = selectDailyQueue(state, queueConfig, date);
    for (const item of queue.invalid) {
      errors.add('queue', item.code, { date, stableId: item.details && item.details.stableId ? item.details.stableId : null });
    }
    for (const item of queue.unsupported) {
      errors.add('queue', item.code || 'E_STATUS_UNSUPPORTED', { date, stableId: item.stableId });
    }

    const idealOverdueCount = state.filter(topic => (
      topic.status === 'active' && compareDate(topic.mf_ideal_due, date) < 0
    )).length;

    let usedMinutes = 0;
    let selectedCount = 0;

    if (!skipWhen({ offset, date })) {
      for (const entry of queue.selected) {
        const position = positions.get(entry.stableId);
        if (position == null) continue;
        const topic = state[position];
        const waitDays = Math.max(0, calendarDayDifference(date, entry.effectiveDue));

        const advanced = applyEvent(
          topic,
          makeEvent(++eventSeq, 'ADVANCED', topic, { today: date }),
          undefined,
          date
        );
        state[position] = advanced.topic;
        eventCounts.ADVANCED = (eventCounts.ADVANCED || 0) + 1;
        processed.push({
          date,
          stableId: entry.stableId,
          priority: entry.priority,
          type: entry.type,
          minutes: entry.estimatedMinutes,
          waitDays,
          reviewCount: advanced.topic.review_count,
        });
        processedIds.add(entry.stableId);
        usedMinutes += entry.estimatedMinutes;
        selectedCount += 1;

        if (advanced.topic.review_count >= completionReviews) {
          const done = applyEvent(
            state[position],
            makeEvent(++eventSeq, 'COMPLETE', state[position], { today: date }),
            undefined,
            date
          );
          state[position] = done.topic;
          eventCounts.COMPLETE = (eventCounts.COMPLETE || 0) + 1;
          completions += 1;
        }
      }
    }

    daily.push({
      date,
      candidateCount: queue.budget.candidateCount,
      selectedCount,
      usedMinutes,
      budgetMinutes: queue.budget.budgetMinutes,
      idealOverdueCount,
    });
  }

  const endDate = addCalendarDays(startDate, days - 1);
  const unresolved = [];
  for (const topic of state) {
    if (topic.status !== 'active') continue;
    if (processedIds.has(topic.mf_id)) continue;
    const due = effectiveDue(topic);
    if (compareDate(due, endDate) > 0) continue;
    unresolved.push({
      stableId: topic.mf_id,
      priority: topic.priority,
      ageDays: Math.max(0, calendarDayDifference(endDate, due)),
    });
  }

  const errorResult = errors.result();
  const metrics = computeMetrics({
    processed,
    unresolved,
    daily,
    completions,
    topicsProcessed: processedIds.size,
    initialCount,
    errors: errorResult,
    eventCounts,
    startDate,
    endDate,
  });

  return {
    seed,
    startDate,
    endDate,
    days,
    topics: state,
    processed,
    daily,
    unresolved,
    errors: errorResult,
    eventCounts,
    completions,
    metrics,
  };
}

module.exports = { simulate, createErrorCollector };
