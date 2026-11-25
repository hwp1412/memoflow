'use strict';

// Mercy batch application and safe undo, pure and in-memory (SPEC A7.2-A7.3,
// A11, A13 T16).
//
// A batch is an explicit value supplied by the caller: no clock, no randomness,
// no storage. Applying returns new topic objects and a batch record; undoing
// restores each item's ORIGINAL mf_not_before (null included) and refuses to
// overwrite anything the user changed after the batch.
//
// Revision contract: an item that really changes mf_not_before increments
// mf_revision by exactly one; a no-op never changes revision; a conflict or a
// missing topic changes nothing at all.

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { assertDateString } = require('./dates.js');
const { validateRevision } = require('./schema.js');
const { resolveStableId } = require('./queue.js');

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

function indexTopics(topics) {
  if (!Array.isArray(topics)) {
    fail('E_OBJECT_REQUIRED', 'topics must be an array', { field: 'topics' });
  }
  const byId = new Map();
  topics.forEach((topic, index) => {
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)) return;
    try {
      byId.set(resolveStableId(topic), { topic, index });
    } catch {
      // A topic without a readable identity cannot match a batch item.
    }
  });
  return byId;
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
  }
  return plan;
}

// SPEC A7.2 — apply the plan to current topics. Caller keeps the returned
// topics; nothing is written anywhere.
function applyMercyBatch(plan, topics, today = undefined) {
  assertPlan(plan);
  assertDateString(today, 'today');
  const byId = indexTopics(topics);
  const updated = topics.slice();
  const results = [];
  const batchItems = [];

  for (const item of plan.items) {
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
// items are reported and skipped; the rest of the batch still undoes.
function undoMercyBatch(batch, topics, today = undefined) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    fail('E_MERCY_BATCH_INVALID', 'batch must be the record returned by applyMercyBatch', { field: 'batch' });
  }
  for (const key of Object.keys(batch)) {
    if (!BATCH_KEYS.includes(key) && key !== 'undoneOn' && key !== 'undoResults') {
      // Extra audit keys are tolerated, but the record must still look like one.
      continue;
    }
  }
  if (typeof batch.batchId !== 'string' || !Array.isArray(batch.items)) {
    fail('E_MERCY_BATCH_INVALID', 'batch needs batchId and items', { field: 'batch' });
  }
  assertDateString(today, 'today');

  const byId = indexTopics(topics);
  const updated = topics.slice();
  const results = [];

  if (batch.status === 'undone') {
    for (const item of batch.items) {
      results.push({ stableId: item.stableId, status: 'already-undone', changed: false });
    }
    return {
      algorithmVersion: ALGORITHM_VERSION,
      batch,
      results,
      topics: updated,
      summary: { undoneCount: 0, conflictCount: 0, missingCount: 0, alreadyUndoneCount: results.length, totalCount: results.length },
      explain: { text: `Mercy 批次 ${batch.batchId} 已经撤销过，未重复修改任何 Topic。`, data: { batchId: batch.batchId } },
    };
  }

  for (const item of batch.items) {
    if (item.applyStatus !== 'applied') {
      results.push({ stableId: item.stableId, status: 'nothing-to-undo', changed: false });
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
  const nextBatch = {
    ...batch,
    undoneOn: today,
    undoResults: results,
    status: conflicts > 0 || missing > 0 ? 'partially-undone' : 'undone',
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
      alreadyUndoneCount: 0,
      totalCount: results.length,
    },
    explain: {
      text: `Mercy 撤销（批次 ${batch.batchId}）：恢复 ${undone} 项，冲突 ${conflicts} 项，缺失 ${missing} 项${conflicts > 0 || missing > 0 ? '；冲突项未覆盖用户后续修改。' : '。'}`,
      data: { batchId: batch.batchId, status: nextBatch.status, undoneOn: today },
    },
  };
}

module.exports = {
  applyMercyBatch,
  undoMercyBatch,
  indexTopics,
  readRevision,
};
