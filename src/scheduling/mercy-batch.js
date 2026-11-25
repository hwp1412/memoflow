'use strict';

// Mercy batch application and safe undo, pure and in-memory (SPEC A7.2-A7.3,
// A11, A13 T16).
//
// A batch is an explicit value supplied by the caller: no clock, no randomness,
// no storage. Applying returns new topic objects and a batch record; undoing
// restores each item's ORIGINAL mf_not_before (null included) and refuses to
// overwrite anything the user changed after the batch.
//
// Safety rules added after review:
//   * a plan is day-scoped: applying it on another day is refused outright;
//   * duplicate stable ids in the CURRENT topic list make every affected item
//     a conflict instead of silently picking one of the two topics;
//   * a topic that stopped being an active Source/Extract, or whose Priority /
//     Ideal Due / effective due changed without a revision bump, is a conflict;
//   * undo is resumable: an already restored item reports `already-undone`
//     without another revision bump, missing topics can be restored later, and
//     a partially undone batch finishes as `undone`.

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { assertDateString } = require('./dates.js');
const {
  validateRevision,
  validateTopicType,
  validateStatus,
  validateEstimatedMinutes,
} = require('./schema.js');
const { resolveStableId } = require('./queue.js');
const { assertQueueConfig } = require('./queue-config.js');
const { effectiveDueOf: mercyEffectiveDueOf } = require('./mercy.js');

const BATCH_KEYS = Object.freeze([
  'batchId',
  'algorithmVersion',
  'appliedOn',
  'windowDays',
  'status',
  'items',
]);

function readRevision(topic) {
  try {
    return validateRevision(topic.mf_revision, 'mf_revision');
  } catch {
    return null;
  }
}

// Identity index. A duplicated stable id is recorded instead of overwritten so
// callers can reject the affected items rather than guessing which topic is
// meant.
function indexTopics(topics) {
  if (!Array.isArray(topics)) {
    fail('E_OBJECT_REQUIRED', 'topics must be an array', { field: 'topics' });
  }
  const byId = new Map();
  const duplicates = new Set();
  topics.forEach((topic, index) => {
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)) return;
    let identity;
    try {
      identity = resolveStableId(topic);
    } catch {
      return; // an unreadable identity cannot match a batch item
    }
    if (byId.has(identity)) duplicates.add(identity);
    else byId.set(identity, { topic, index });
  });
  return { byId, duplicates };
}

// The effective cost of a topic right now: the explicit estimate when present,
// otherwise the type default. Never falls back when the explicit value is bad.
function currentEffectiveMinutes(topic, type, queueConfig) {
  if (topic.estimated_minutes == null) {
    return { minutes: queueConfig.defaultMinutes[type] };
  }
  try {
    return { minutes: validateEstimatedMinutes(topic.estimated_minutes) };
  } catch (error) {
    return { error };
  }
}

function isSchedulableTopic(topic) {
  try {
    validateTopicType(topic.type);
    validateStatus(topic.status);
    return topic.status === 'active';
  } catch {
    return false;
  }
}

function assertPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    fail('E_MERCY_PLAN_INVALID', 'plan must be the object returned by previewMercy', { field: 'plan' });
  }
  if (typeof plan.batchId !== 'string' || plan.batchId.length === 0) {
    fail('E_MERCY_PLAN_INVALID', 'plan.batchId is required', { field: 'batchId' });
  }
  if (!Array.isArray(plan.items)) {
    fail('E_MERCY_PLAN_INVALID', 'plan.items must be an array', { field: 'items' });
  }
  for (const item of plan.items) {
    if (item.status !== 'assigned' && item.status !== 'noop') {
      fail('E_MERCY_PLAN_INVALID', `plan item ${item.stableId} has an unsupported status`, {
        stableId: item.stableId,
        status: item.status,
      });
    }
    if (typeof item.stableId !== 'string' || item.stableId.length === 0) {
      fail('E_MERCY_PLAN_INVALID', 'plan items need a stableId', { item });
    }
    if (item.status === 'assigned') {
      if (item.type !== 'source' && item.type !== 'extract') {
        fail('E_MERCY_PLAN_INVALID', `plan item ${item.stableId} needs a source/extract type`, {
          stableId: item.stableId,
          type: item.type,
        });
      }
      if (typeof item.estimatedMinutes !== 'number' || !Number.isInteger(item.estimatedMinutes)) {
        fail('E_MERCY_PLAN_INVALID', `plan item ${item.stableId} needs an integer estimatedMinutes`, {
          stableId: item.stableId,
          estimatedMinutes: item.estimatedMinutes,
        });
      }
    }
  }
  return plan;
}

function assertFreshPlan(plan, today) {
  assertDateString(today, 'today');
  if (typeof plan.today !== 'string') {
    fail('E_MERCY_PLAN_STALE', 'plan has no preview day; generate a fresh preview', { field: 'plan.today' });
  }
  if (plan.today !== today) {
    fail('E_MERCY_PLAN_STALE', 'this Mercy preview was generated for a different day; preview again', {
      plannedOn: plan.today,
      today,
    });
  }
}

// SPEC A7.2 — apply the plan to current topics. Caller keeps the returned
// topics; nothing is written anywhere.
function applyMercyBatch(plan, topics, today = undefined) {
  assertPlan(plan);
  assertFreshPlan(plan, today);
  const queueConfig = assertQueueConfig(plan.queueConfig);
  const { byId, duplicates } = indexTopics(topics);
  const updated = topics.slice();
  const results = [];
  const batchItems = [];

  for (const item of plan.items) {
    if (duplicates.has(item.stableId)) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'DUPLICATE_ID', changed: false });
      continue;
    }
    const found = byId.get(item.stableId);
    if (!found) {
      results.push({ stableId: item.stableId, status: 'missing', changed: false });
      continue;
    }
    if (item.status === 'noop') {
      results.push({ stableId: item.stableId, status: 'noop', changed: false });
      batchItems.push({
        stableId: item.stableId,
        applyStatus: 'noop',
        revisionBefore: item.revisionBefore,
        revisionAfter: item.revisionBefore,
        notBeforeBefore: item.notBeforeBefore,
        notBeforeAfter: item.notBeforeBefore,
        effectiveDueBefore: item.effectiveDueBefore,
        effectiveDueAfter: item.effectiveDueBefore,
      });
      continue;
    }

    const { topic, index } = found;

    if (!isSchedulableTopic(topic)) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'NOT_SCHEDULABLE', changed: false });
      continue;
    }
    if (topic.type !== item.type) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'TOPIC_TYPE_CHANGED',
        expected: item.type,
        actual: topic.type,
        changed: false,
      });
      continue;
    }
    const currentMinutes = currentEffectiveMinutes(topic, topic.type, queueConfig);
    if (currentMinutes.error) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'INVALID_ESTIMATED_MINUTES',
        code: currentMinutes.error.code,
        actual: topic.estimated_minutes ?? null,
        changed: false,
      });
      continue;
    }
    if (currentMinutes.minutes !== item.estimatedMinutes) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'ESTIMATED_MINUTES_CHANGED',
        expected: item.estimatedMinutes,
        actual: currentMinutes.minutes,
        changed: false,
      });
      continue;
    }

    const revision = readRevision(topic);
    if (revision == null) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'INVALID_REVISION', changed: false });
      continue;
    }
    if (revision !== item.revisionBefore) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'REVISION_MISMATCH',
        expected: item.revisionBefore,
        actual: revision,
        changed: false,
      });
      continue;
    }
    if ((topic.mf_not_before ?? null) !== item.notBeforeBefore) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'NOT_BEFORE_CHANGED',
        expected: item.notBeforeBefore,
        actual: topic.mf_not_before ?? null,
        changed: false,
      });
      continue;
    }
    // Fields that shaped the plan must still match, even if revision did not move.
    if (item.priority != null && topic.priority !== item.priority) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'PRIORITY_CHANGED', expected: item.priority, actual: topic.priority, changed: false });
      continue;
    }
    if (item.idealDue != null && topic.mf_ideal_due !== item.idealDue) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'IDEAL_DUE_CHANGED', expected: item.idealDue, actual: topic.mf_ideal_due, changed: false });
      continue;
    }
    const effectiveNow = mercyEffectiveDueOf(topic.mf_ideal_due, topic.mf_not_before ?? null);
    if (item.effectiveDueBefore != null && effectiveNow !== item.effectiveDueBefore) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'EFFECTIVE_DUE_CHANGED', expected: item.effectiveDueBefore, actual: effectiveNow, changed: false });
      continue;
    }

    const next = {
      ...topic,
      mf_not_before: item.notBeforeAfter,
      mf_revision: revision + 1,
    };
    updated[index] = next;
    results.push({
      stableId: item.stableId,
      status: 'applied',
      changed: true,
      revisionBefore: revision,
      revisionAfter: next.mf_revision,
      notBeforeBefore: item.notBeforeBefore,
      notBeforeAfter: item.notBeforeAfter,
    });
    batchItems.push({
      stableId: item.stableId,
      applyStatus: 'applied',
      revisionBefore: revision,
      revisionAfter: next.mf_revision,
      notBeforeBefore: item.notBeforeBefore,
      notBeforeAfter: item.notBeforeAfter,
      effectiveDueBefore: item.effectiveDueBefore,
      effectiveDueAfter: item.effectiveDueAfter,
    });
  }

  const applied = results.filter(result => result.status === 'applied').length;
  const conflicts = results.filter(result => result.status === 'conflict').length;
  const missing = results.filter(result => result.status === 'missing').length;
  const status = applied === 0
    ? (conflicts > 0 || missing > 0 ? 'conflict' : 'noop')
    : ((conflicts > 0 || missing > 0) ? 'partially-applied' : 'applied');

  const batch = {
    batchId: plan.batchId,
    algorithmVersion: ALGORITHM_VERSION,
    appliedOn: today,
    windowDays: plan.windowDays,
    status,
    items: batchItems,
  };

  return {
    algorithmVersion: ALGORITHM_VERSION,
    batch,
    results,
    topics: updated,
    summary: {
      appliedCount: applied,
      noopCount: results.filter(result => result.status === 'noop').length,
      conflictCount: conflicts,
      missingCount: missing,
      totalCount: results.length,
    },
    explain: {
      text: `Mercy 批次 ${plan.batchId}：应用 ${applied} 项，无变化 ${results.filter(result => result.status === 'noop').length} 项，冲突 ${conflicts} 项，缺失 ${missing} 项。`,
      data: { batchId: plan.batchId, status, appliedOn: today },
    },
  };
}

// SPEC A7.3 / A13 T16 — restore each item's original mf_not_before. Conflict
// items are reported and skipped; the rest of the batch still undoes, and the
// undo can be resumed until every applied item has been restored.
function undoMercyBatch(batch, topics, today = undefined) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    fail('E_MERCY_BATCH_INVALID', 'batch must be the record returned by applyMercyBatch', { field: 'batch' });
  }
  if (typeof batch.batchId !== 'string' || !Array.isArray(batch.items)) {
    fail('E_MERCY_BATCH_INVALID', 'batch needs batchId and items', { field: 'batch' });
  }
  assertDateString(today, 'today');
  const { byId, duplicates } = indexTopics(topics);
  const updated = topics.slice();
  const results = [];
  const nextItems = batch.items.map(item => ({ ...item }));

  const legacyFullyUndone = batch.status === 'undone';

  for (let position = 0; position < batch.items.length; position += 1) {
    const item = batch.items[position];

    if (item.applyStatus !== 'applied') {
      results.push({ stableId: item.stableId, status: 'nothing-to-undo', changed: false });
      continue;
    }
    // Idempotent resume: an item already restored (or a batch marked undone by
    // an older version) must not be touched again.
    if (item.undoState === 'undone' || (legacyFullyUndone && item.undoState == null)) {
      results.push({ stableId: item.stableId, status: 'already-undone', changed: false });
      continue;
    }
    if (duplicates.has(item.stableId)) {
      results.push({ stableId: item.stableId, status: 'conflict', reason: 'DUPLICATE_ID', changed: false });
      continue;
    }
    const found = byId.get(item.stableId);
    if (!found) {
      results.push({ stableId: item.stableId, status: 'missing', changed: false });
      continue;
    }

    const { topic, index } = found;
    const revision = readRevision(topic);
    if (revision == null || revision !== item.revisionAfter) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'REVISION_MISMATCH',
        expected: item.revisionAfter,
        actual: revision,
        changed: false,
      });
      continue;
    }
    if ((topic.mf_not_before ?? null) !== item.notBeforeAfter) {
      results.push({
        stableId: item.stableId,
        status: 'conflict',
        reason: 'NOT_BEFORE_CHANGED',
        expected: item.notBeforeAfter,
        actual: topic.mf_not_before ?? null,
        changed: false,
      });
      continue;
    }

    const next = {
      ...topic,
      mf_not_before: item.notBeforeBefore,
      mf_revision: revision + 1,
    };
    updated[index] = next;
    nextItems[position] = { ...item, undoState: 'undone', undoneRevision: next.mf_revision };
    results.push({
      stableId: item.stableId,
      status: 'undone',
      changed: true,
      restoredNotBefore: item.notBeforeBefore,
      revisionBefore: revision,
      revisionAfter: next.mf_revision,
    });
  }

  const undone = results.filter(result => result.status === 'undone').length;
  const conflicts = results.filter(result => result.status === 'conflict').length;
  const missing = results.filter(result => result.status === 'missing').length;
  const pending = nextItems.filter(item => item.applyStatus === 'applied' && item.undoState !== 'undone').length;
  const status = pending === 0 ? 'undone' : 'partially-undone';

  const nextBatch = {
    ...batch,
    undoneOn: today,
    undoResults: results,
    status,
    items: nextItems,
  };

  return {
    algorithmVersion: ALGORITHM_VERSION,
    batch: nextBatch,
    results,
    topics: updated,
    summary: {
      undoneCount: undone,
      conflictCount: conflicts,
      missingCount: missing,
      alreadyUndoneCount: results.filter(result => result.status === 'already-undone').length,
      pendingCount: pending,
      totalCount: results.length,
    },
    explain: {
      text: `Mercy 撤销（批次 ${batch.batchId}）：本次恢复 ${undone} 项，已撤销 ${results.filter(result => result.status === 'already-undone').length} 项，冲突 ${conflicts} 项，缺失 ${missing} 项${pending > 0 ? `；仍有 ${pending} 项待恢复。` : '；批次已全部恢复。'}`,
      data: { batchId: batch.batchId, status, undoneOn: today, pendingCount: pending },
    },
  };
}

module.exports = {
  applyMercyBatch,
  undoMercyBatch,
  indexTopics,
  readRevision,
  isSchedulableTopic,
};
