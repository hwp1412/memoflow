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
  const occurrencesByCode = {};
  const byStage = {};
  const samples = [];
  const seen = new Set();
  let occurrences = 0;
  return {
    add(stage, code, sample = {}) {
      occurrences += 1;
      occurrencesByCode[code] = (occurrencesByCode[code] || 0) + 1;
      const key = `${stage}:${code}:${sample.stableId || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      byCode[code] = (byCode[code] || 0) + 1;
      byStage[stage] = (byStage[stage] || 0) + 1;
      if (samples.length < 20) samples.push({ stage, code, ...sample });
    },
    result() {
      return {
        uniqueTotal: Object.values(byCode).reduce((total, value) => total + value, 0),
        occurrenceTotal: occurrences,
        byCode,
        occurrencesByCode,
        byStage,
        samples,
      };
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
  // Capture the initial population by stable id so COMPLETE can be attributed
  // to the group it actually belongs to (initial vs added during the run).
  const initialIds = new Set(topics.map(topic => topic.mf_id));
  const initialCount = topics.length;
  let eventSeq = 0;
  let completions = 0;
  let completedInitialTopics = 0;
  let completedAddedTopics = 0;

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
          if (initialIds.has(state[position].mf_id)) completedInitialTopics += 1;
          else completedAddedTopics += 1;
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

  // Two distinct end-of-window sets:
  //   neverProcessed   zero review events in the whole window (any status)
  //   outstandingAtEnd active, effective due <= endDate, still awaiting a next
  //                    review. A topic reviewed earlier and due again belongs
  //                    here even though it was processed once.
  const neverProcessed = state
    .filter(topic => !processedIds.has(topic.mf_id))
    .map(topic => ({
      stableId: topic.mf_id,
      priority: topic.priority,
      status: topic.status,
    }));

  const outstandingAtEnd = [];
  for (const topic of state) {
    if (topic.status !== 'active') continue;
    const due = effectiveDue(topic);
    if (compareDate(due, endDate) > 0) continue;
    outstandingAtEnd.push({
      stableId: topic.mf_id,
      priority: topic.priority,
      ageDays: Math.max(0, calendarDayDifference(endDate, due)),
      reviewCount: topic.review_count,
    });
  }

  const errorResult = errors.result();
  const metrics = computeMetrics({
    processed,
    neverProcessed,
    outstandingAtEnd,
    daily,
    completions,
    completedInitialTopics,
    completedAddedTopics,
    topicsProcessed: processedIds.size,
    initialTopics: initialCount,
    totalTopics: state.length,
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
    neverProcessed,
    outstandingAtEnd,
    // Compatibility alias: same content as outstandingAtEnd. New callers must
    // use outstandingAtEnd; `unresolved` is kept only for older consumers.
    unresolved: outstandingAtEnd,
    errors: errorResult,
    eventCounts,
    completions,
    completedInitialTopics,
    completedAddedTopics,
    metrics,
  };
}

module.exports = { simulate, createErrorCollector };
