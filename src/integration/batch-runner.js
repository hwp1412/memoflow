'use strict';

// Shared batch runner (HOST-CLOSURE P0).
//
// A batch is host-level orchestration over independent per-Topic events. It is
// NOT a transaction: no batch WAL, no rollback, no cross-file atomicity. Batch
// business state (Mercy preview/intent, Boost target list) is owned by the
// feature module and persisted separately; this runner only plans, orders,
// executes and aggregates.
//
// Contracts frozen here are shared by Subtree POSTPONE, Boost, Mercy and state
// operations:
//   * one stable id may appear only once in a batch;
//   * the node set and `today` are fixed at planning time;
//   * execution is sequential in a deterministic order;
//   * every node yields one of eight statuses;
//   * `uncertain` is never reported as success.

const STATUS = Object.freeze({
  applied: 'applied',
  duplicate: 'duplicate',
  noOp: 'no-op',
  skipped: 'skipped',
  blocked: 'blocked',
  conflict: 'conflict',
  failed: 'failed',
  uncertain: 'uncertain',
});

const DEFAULT_SKIP_STATUSES = Object.freeze(['done', 'dismissed', 'container']);

const COUNT_KEY = Object.freeze({
  applied: 'applied',
  duplicate: 'duplicate',
  'no-op': 'noOp',
  skipped: 'skipped',
  blocked: 'blocked',
  conflict: 'conflict',
  failed: 'failed',
  uncertain: 'uncertain',
});

function emptyCounts() {
  return { applied: 0, duplicate: 0, noOp: 0, skipped: 0, blocked: 0, conflict: 0, failed: 0, uncertain: 0 };
}

function compareItems(left, right) {
  return String(left.topicId || left.key || left.path).localeCompare(String(right.topicId || right.key || right.path));
}

class BatchContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BatchContractError';
    this.code = code;
    this.details = details;
  }
}

function planBatch({ kind, batchId, items, today, skipStatuses = DEFAULT_SKIP_STATUSES, skipTypes = ['card'] } = {}) {
  if (typeof kind !== 'string' || !kind) throw new BatchContractError('E_BATCH_KIND', 'a batch kind is required');
  if (typeof batchId !== 'string' || !batchId) throw new BatchContractError('E_BATCH_ID', 'a stable batch id is required');
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new BatchContractError('E_BATCH_TODAY', 'batch today must be a pinned YYYY-MM-DD date');
  }
  if (!Array.isArray(items)) throw new BatchContractError('E_BATCH_ITEMS', 'batch items must be an array');

  const ordered = [...items].sort(compareItems);
  const seen = new Map();
  for (const item of ordered) {
    if (!item || typeof item !== 'object') throw new BatchContractError('E_BATCH_ITEM', 'batch item must be an object');
    if (!item.topicId) continue;
    const key = String(item.topicId).toLowerCase();
    if (seen.has(key)) {
      throw new BatchContractError('E_BATCH_DUPLICATE_ID', `duplicate stable id in ${kind} batch: ${item.topicId}`, {
        topicId: item.topicId,
        paths: [seen.get(key).path, item.path],
      });
    }
    seen.set(key, item);
  }

  const runnable = [];
  const skipped = [];
  for (const item of ordered) {
    if (skipTypes.includes(item.type)) {
      skipped.push({ ...item, status: STATUS.skipped, reason: 'TYPE_SKIPPED' });
      continue;
    }
    if (skipStatuses.includes(item.status)) {
      skipped.push({ ...item, status: STATUS.skipped, reason: `STATUS_${String(item.status).toUpperCase()}` });
      continue;
    }
    runnable.push(item);
  }
  return { kind, batchId, today, items: runnable, skipped };
}

function classifyOutcome(outcome) {
  if (!outcome || typeof outcome.status !== 'string') return { status: STATUS.failed, reason: 'E_NODE_NO_RESULT' };
  switch (outcome.status) {
    case 'applied': return { status: STATUS.applied, reason: null };
    case 'duplicate': return { status: STATUS.duplicate, reason: null };
    case 'no-op': return { status: STATUS.noOp, reason: outcome.reason || null };
    case 'skipped': return { status: STATUS.skipped, reason: outcome.reason || 'SKIPPED' };
    case 'blocked': return { status: STATUS.blocked, reason: outcome.reason || 'BLOCKED' };
    case 'conflict': return { status: STATUS.conflict, reason: outcome.reason || null };
    case 'uncertain': return { status: STATUS.uncertain, reason: outcome.reason || null };
    case 'requires-manual-recovery': return { status: STATUS.uncertain, reason: outcome.reason || 'MANUAL_RECOVERY' };
    case 'failed': return { status: STATUS.failed, reason: outcome.reason || null };
    default: return { status: STATUS.failed, reason: outcome.reason || outcome.status };
  }
}

async function runBatchInOrder(plan, { runItem, verifyItem = null, onProgress = null } = {}) {
  if (!plan || !Array.isArray(plan.items)) throw new BatchContractError('E_BATCH_PLAN', 'a plan is required');
  if (typeof runItem !== 'function') throw new BatchContractError('E_BATCH_RUNNER', 'runItem is required');

  const results = [];
  for (const item of plan.items) {
    let outcome;
    try {
      if (typeof verifyItem === 'function') {
        const verdict = verifyItem(item);
        if (verdict && verdict.ok === false) outcome = { status: 'blocked', reason: verdict.code || 'E_ITEM_CHANGED' };
      }
      if (!outcome) outcome = await runItem(item);
    } catch (error) {
      outcome = { status: 'failed', reason: (error && error.code) || 'E_NODE_FAILED', message: error && error.message };
    }
    const classified = classifyOutcome(outcome);
    const entry = {
      path: item.path,
      basename: item.basename,
      topicId: item.topicId || null,
      status: classified.status,
      reason: classified.reason,
    };
    results.push(entry);
    if (typeof onProgress === 'function') onProgress(entry);
  }
  return results;
}

function aggregateStatus(counts) {
  if (counts.uncertain > 0) return STATUS.uncertain;
  const problematic = counts.conflict + counts.failed + counts.blocked;
  if (problematic > 0) return (counts.applied + counts.duplicate) > 0 ? 'partial' : STATUS.failed;
  if ((counts.applied + counts.duplicate) > 0) return STATUS.applied;
  return STATUS.noOp; // all no-op (or nothing runnable) is never a failure
}

function summarise({ plan, results, skipped = plan ? plan.skipped : [] }) {
  const counts = emptyCounts();
  for (const entry of results) counts[COUNT_KEY[entry.status]] += 1;
  counts.skipped += skipped.length;
  return {
    batchId: plan ? plan.batchId : null,
    kind: plan ? plan.kind : null,
    days: plan ? plan.days : undefined,
    today: plan ? plan.today : null,
    results,
    skipped,
    counts,
    total: results.length + skipped.length,
    status: aggregateStatus(counts),
  };
}

async function runBatch({ plan, runItem, verifyItem = null, onProgress = null } = {}) {
  const results = await runBatchInOrder(plan, { runItem, verifyItem, onProgress });
  return summarise({ plan, results });
}

function describeBatch(outcome, { label = '批量操作', unit = '节点' } = {}) {
  if (!outcome) return { message: `${label}没有结果。`, problems: [], nonAtomic: false };
  const counts = outcome.counts || emptyCounts();
  const problematic = (outcome.results || []).filter(entry => ['blocked', 'conflict', 'failed', 'uncertain'].includes(entry.status));
  const problems = problematic.slice(0, 3).map(entry => `${entry.basename}（${entry.status}${entry.reason ? `/${entry.reason}` : ''}）`);
  const nonAtomic = ['partial', 'uncertain', 'failed'].includes(outcome.status);
  const details = `已应用 ${counts.applied}，重复 ${counts.duplicate}，无变化 ${counts.noOp}，跳过 ${counts.skipped}，`
    + `阻断 ${counts.blocked}，冲突 ${counts.conflict}，失败 ${counts.failed}，未确认 ${counts.uncertain}`;
  const headline = outcome.status === STATUS.noOp
    ? `${label}：没有需要变更的${unit}。`
    : `${label}：${outcome.total} 个${unit} · ${details}。`;
  const detail = problems.length ? ` 需处理：${problems.join('；')}${problematic.length > 3 ? ` 等 ${problematic.length} 项` : ''}。` : '';
  const warning = nonAtomic ? ' 非原子批量操作：已修改的项不会自动回滚。' : '';
  return { message: headline + detail + warning, problems, nonAtomic, status: outcome.status };
}

module.exports = {
  STATUS,
  DEFAULT_SKIP_STATUSES,
  COUNT_KEY,
  BatchContractError,
  planBatch,
  classifyOutcome,
  runBatchInOrder,
  runBatch,
  aggregateStatus,
  summarise,
  describeBatch,
  emptyCounts,
};
