'use strict';

// Legacy reference model — a PROXY, not the real upstream scheduler.
//
// The upstream Toolkit grading path (`_gradeTopic` in the root main.js) depends
// on Obsidian state and has write side effects, so it cannot be driven from a
// pure offline simulation. This module reproduces the documented legacy
// decision rules that are visible in the repository and that the simulation can
// exercise without touching a vault:
//
//   * first review       interval = max(1, ceil(priority * 0.15))
//   * later reviews      interval = max(1, round(interval * aFactor)), aFactor = 2.0
//   * due test           next_review <= today (no not_before model)
//   * ordering           legacy `urgency` descending:
//                        (101 - priority) * 10 + (today - next_review) * 2
//   * budget             the same synthetic minutes budget as Unified
//
// Known differences from the real upstream code, which is why this is labelled
// a proxy:
//   * the real a_factor is progress-aware (log2 of remaining pages/seconds) and
//     needs page metadata the simulation does not have; a fixed 2.0 is used;
//   * the real queue mixes SR cards, reads Vault metadata and writes frontmatter;
//     none of that is replicated;
//   * Mercy / not_before / effective due do not exist in the legacy model.
// Results are therefore only a rule-level comparison, never a claim that the
// old plugin behaved identically.

const {
  addCalendarDays,
  calendarDayDifference,
  compareDate,
} = require('../../../src/scheduling/index.js');
const { DEFAULT_QUEUE_CONFIG } = require('../../../src/scheduling/index.js');
const { computeMetrics } = require('./metrics.js');

const LEGACY_A_FACTOR = 2.0;

function legacyFirstInterval(priority) {
  return Math.max(1, Math.ceil(priority * 0.15));
}

function legacyNextInterval(interval, priority, reviewCount) {
  if (reviewCount === 0 || !(interval > 0)) return legacyFirstInterval(priority);
  return Math.max(1, Math.round(interval * LEGACY_A_FACTOR));
}

function toLegacyTopic(topic) {
  return {
    stableId: topic.mf_id,
    type: topic.type,
    priority: topic.priority,
    interval: topic.mf_interval_days,
    reviewCount: topic.review_count,
    nextReview: topic.mf_ideal_due,
    status: topic.status,
    minutes: topic.estimated_minutes == null
      ? DEFAULT_QUEUE_CONFIG.defaultMinutes[topic.type]
      : topic.estimated_minutes,
  };
}

function simulateLegacy({ topics, days, startDate, dailyBudgetMinutes = 30, completionReviews = 3 }) {
  const state = topics.map(toLegacyTopic);
  const processed = [];
  const daily = [];
  const processedIds = new Set();
  let completions = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = addCalendarDays(startDate, offset);
    const due = state.filter(topic => topic.status === 'active' && compareDate(topic.nextReview, date) <= 0);
    due.sort((left, right) => {
      const leftUrgency = (101 - left.priority) * 10 + calendarDayDifference(date, left.nextReview) * 2;
      const rightUrgency = (101 - right.priority) * 10 + calendarDayDifference(date, right.nextReview) * 2;
      if (leftUrgency !== rightUrgency) return rightUrgency - leftUrgency;
      return left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0;
    });

    let usedMinutes = 0;
    let selectedCount = 0;
    for (const topic of due) {
      if (usedMinutes + topic.minutes > dailyBudgetMinutes) continue;
      const waitDays = Math.max(0, calendarDayDifference(date, topic.nextReview));
      usedMinutes += topic.minutes;
      selectedCount += 1;
      processed.push({ date, stableId: topic.stableId, priority: topic.priority, type: topic.type, minutes: topic.minutes, waitDays });
      processedIds.add(topic.stableId);
      topic.interval = legacyNextInterval(topic.interval, topic.priority, topic.reviewCount);
      topic.reviewCount += 1;
      topic.nextReview = addCalendarDays(date, topic.interval);
      if (topic.reviewCount >= completionReviews) {
        topic.status = 'done';
        completions += 1;
      }
    }

    const idealOverdueCount = state.filter(topic => topic.status === 'active' && compareDate(topic.nextReview, date) < 0).length;
    daily.push({ date, usedMinutes, budgetMinutes: dailyBudgetMinutes, idealOverdueCount, selectedCount, candidateCount: due.length });
  }

  const endDate = addCalendarDays(startDate, days - 1);
  const neverProcessed = state
    .filter(topic => !processedIds.has(topic.stableId))
    .map(topic => ({ stableId: topic.stableId, priority: topic.priority, status: topic.status }));
  const outstandingAtEnd = [];
  for (const topic of state) {
    if (topic.status !== 'active') continue;
    if (compareDate(topic.nextReview, endDate) > 0) continue;
    outstandingAtEnd.push({ stableId: topic.stableId, priority: topic.priority, ageDays: Math.max(0, calendarDayDifference(endDate, topic.nextReview)), reviewCount: topic.reviewCount });
  }

  const errors = { uniqueTotal: 0, occurrenceTotal: 0, byCode: {}, occurrencesByCode: {}, byStage: {}, samples: [] };
  const metrics = computeMetrics({
    processed,
    neverProcessed,
    outstandingAtEnd,
    daily,
    completions,
    topicsProcessed: processedIds.size,
    initialTopics: topics.length,
    totalTopics: state.length,
    errors,
    eventCounts: { ADVANCED: processed.length, COMPLETE: completions },
    startDate,
    endDate,
  });

  return {
    mode: 'legacy-proxy',
    proxy: true,
    proxyLimitations: [
      'fixed a_factor 2.0 instead of the progress-aware legacy value',
      'no SR cards, no Vault metadata, no frontmatter writes',
      'no not_before / effective due / Mercy in the legacy model',
    ],
    startDate,
    endDate,
    days,
    topics: state,
    processed,
    daily,
    neverProcessed,
    outstandingAtEnd,
    unresolved: outstandingAtEnd,
    metrics,
  };
}

module.exports = { simulateLegacy, legacyFirstInterval, legacyNextInterval, LEGACY_A_FACTOR };
