'use strict';

// Pure dashboard model (PR-10). It never writes and never reads a real vault.

const { selectDailyQueue, effectiveDue, compareDate } = require('../scheduling/index.js');
const { evaluateRuntimeMode } = require('../scheduling/runtime-mode-guard.js');
const { formatDate } = require('../integration/obsidian-storage-adapter.js');

function buildTopicView(topic, mode, dateFormat) {
  const view = {
    stableId: topic.mf_id,
    type: topic.type,
    status: topic.status,
    priority: topic.priority,
    intervalDays: topic.mf_interval_days,
    aFactor: topic.a_factor,
    reviewCount: topic.review_count,
    idealDue: topic.mf_ideal_due,
    notBefore: topic.mf_not_before ?? null,
    effectiveDue: effectiveDue(topic),
    mode,
    nextReviewProjection: null,
    projectionWarning: null,
  };
  try {
    view.nextReviewProjection = formatDate(view.effectiveDue, dateFormat);
  } catch (error) {
    view.projectionWarning = error.code || 'E_DATE_FORMAT_UNSUPPORTED';
  }
  return view;
}

function buildDashboardModel({ topics, today, queueConfig, mode, conditions = {}, dateFormat = null, migration = null, recovery = null, mercy = null }) {
  const evaluation = evaluateRuntimeMode(mode, conditions);
  const queue = selectDailyQueue(topics, queueConfig, today);
  const details = [];
  let cards = 0;
  for (const topic of topics) {
    if (!topic || typeof topic !== 'object') continue;
    if (topic.type === 'card') {
      cards += 1;
      continue;
    }
    if (topic.type !== 'source' && topic.type !== 'extract') continue;
    try {
      details.push(buildTopicView(topic, evaluation.mode, dateFormat));
    } catch (error) {
      // Invalid topic fields are reported by the queue's invalid list instead.
    }
  }
  return {
    mode: evaluation.mode,
    authoritativeScheduler: evaluation.authoritativeScheduler,
    allowed: evaluation.allowed,
    blockers: evaluation.blockers,
    // Real Obsidian Unified execution is never enabled by this PR.
    writeEnabled: false,
    dateFormat,
    today,
    queue: {
      selected: queue.selected,
      deferredByBudget: queue.deferredByBudget,
      postponed: queue.postponed,
      notYetDue: queue.notYetDue,
      excluded: queue.excluded,
      unsupported: queue.unsupported,
      invalid: queue.invalid,
      budget: queue.budget,
      workload: queue.workload,
      overdueCount: details.filter(view => compareDate(view.effectiveDue, today) < 0).length,
    },
    topics: details,
    cardsExcluded: cards,
    migration: migration ? { summary: migration.summary ?? null, planId: migration.planId ?? null } : null,
    recovery: recovery ? { pendingCount: recovery.pendingCount ?? (recovery.records ? recovery.records.length : 0) } : null,
    mercy: mercy ? { summary: mercy.summary ?? null, items: mercy.items ?? [] } : null,
  };
}

module.exports = { buildDashboardModel };
