'use strict';

// Subtree postpone orchestration (HOST-SUBTREE-01).
//
// The spec has no "subtree" primitive: a subtree postpone is the host applying
// one A5.2 POSTPONE event to every node of the subtree. This module only plans,
// orders, runs and summarises those per-node events. It never writes
// Frontmatter and never recomputes scheduling.
//
// There is deliberately NO batch WAL: each node keeps its own Intent → CAS →
// read-back → ledger record, and re-running the batch is made safe by A5.2
// itself (`mf_not_before = max(old, ideal, today+N)`), so an already postponed
// node degrades to `no-op` instead of moving twice.

const { sha256Hex } = require('../scheduling/migration-hash.js');

const SKIP_STATUSES = new Set(['done', 'container', 'dismissed']);

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

function compareNodes(left, right) {
  return String(left.stableId || left.path).localeCompare(String(right.stableId || right.path));
}

function planSubtreePostpone({ nodes, rootTopicId, days, today } = {}) {
  if (!Array.isArray(nodes)) throw Object.assign(new Error('nodes must be an array'), { code: 'E_SUBTREE_NODES' });
  if (typeof rootTopicId !== 'string' || !rootTopicId) {
    throw Object.assign(new Error('the root topic needs a persistent id'), { code: 'E_ROOT_ID_REQUIRED' });
  }
  if (!Number.isInteger(days) || days < 1) throw Object.assign(new Error('days must be a positive integer'), { code: 'E_POSTPONE_DAYS_INVALID' });
  if (typeof today !== 'string' || !today) throw Object.assign(new Error('today must be fixed for the whole batch'), { code: 'E_TODAY_REQUIRED' });

  const ordered = [...nodes].sort(compareNodes);

  // A stable id must appear at most once: two different notes sharing an id
  // would make "postpone this subtree" ambiguous, so the whole batch refuses
  // before any write. (Same rule as the queue's duplicate-id guard; no new
  // persistent identity index is introduced.)
  const seen = new Map();
  for (const node of ordered) {
    if (!node.topicId) continue;
    const key = String(node.topicId).toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      throw Object.assign(
        new Error(`duplicate stable id in subtree: ${node.topicId}`),
        { code: 'E_DUPLICATE_SUBTREE_ID', details: { topicId: node.topicId, paths: [previous.path, node.path] } },
      );
    }
    seen.set(key, node);
  }

  const batchId = sha256Hex(`subtree-postpone:${rootTopicId}:${days}:${today}:${ordered.map(node => node.stableId || node.path).join(',')}`);

  const runnable = [];
  const skipped = [];
  for (const node of ordered) {
    if (node.type === 'card') {
      skipped.push({ path: node.path, basename: node.basename, reason: 'CARD' });
      continue;
    }
    if (SKIP_STATUSES.has(node.status)) {
      skipped.push({ path: node.path, basename: node.basename, reason: `STATUS_${String(node.status).toUpperCase()}` });
      continue;
    }
    runnable.push(node);
  }
  return { batchId, days, today, nodes: runnable, skipped };
}

function classifyOutcome(outcome) {
  if (!outcome || typeof outcome.status !== 'string') return { status: STATUS.failed, reason: 'E_NODE_NO_RESULT' };
  switch (outcome.status) {
    case 'applied': return { status: STATUS.applied, reason: null };
    case 'duplicate': return { status: STATUS.duplicate, reason: null };
    case 'no-op': return { status: STATUS.noOp, reason: outcome.reason || null };
    case 'conflict': return { status: STATUS.conflict, reason: outcome.reason || null };
    case 'uncertain': return { status: STATUS.uncertain, reason: outcome.reason || null };
    case 'requires-manual-recovery': return { status: STATUS.uncertain, reason: outcome.reason || 'MANUAL_RECOVERY' };
    case 'blocked': return { status: STATUS.blocked, reason: outcome.reason || 'BLOCKED' };
    case 'failed': return { status: STATUS.failed, reason: outcome.reason || null };
    default: return { status: STATUS.failed, reason: outcome.reason || outcome.status };
  }
}

async function runSubtreePostpone({ plan, runNode, verifyNode = null, onProgress = null } = {}) {
  if (!plan || !Array.isArray(plan.nodes)) throw Object.assign(new Error('a plan is required'), { code: 'E_SUBTREE_PLAN' });
  if (typeof runNode !== 'function') throw Object.assign(new Error('runNode is required'), { code: 'E_SUBTREE_RUNNER' });

  const results = [];
  for (const node of plan.nodes) {
    let outcome;
    try {
      if (typeof verifyNode === 'function') {
        const verdict = verifyNode(node);
        if (verdict && verdict.ok === false) {
          outcome = { status: 'blocked', reason: verdict.code || 'E_SUBTREE_CHANGED' };
        }
      }
      if (!outcome && !node.topicId) {
        outcome = { status: 'blocked', reason: 'E_ID_NOT_PERSISTED' };
      }
      if (!outcome) outcome = await runNode(node);
    } catch (error) {
      outcome = { status: 'failed', reason: (error && error.code) || 'E_NODE_FAILED', message: error && error.message };
    }
    const classified = classifyOutcome(outcome);
    const entry = {
      path: node.path,
      basename: node.basename,
      topicId: node.topicId || null,
      status: classified.status,
      reason: classified.reason,
    };
    results.push(entry);
    if (typeof onProgress === 'function') onProgress(entry);
  }

  const skipped = (plan.skipped || []).map(item => ({ ...item, status: STATUS.skipped }));
  const counts = {
    applied: 0, duplicate: 0, noOp: 0, skipped: skipped.length,
    blocked: 0, conflict: 0, failed: 0, uncertain: 0,
  };
  const COUNT_KEY = {
    applied: 'applied', duplicate: 'duplicate', 'no-op': 'noOp', skipped: 'skipped',
    blocked: 'blocked', conflict: 'conflict', failed: 'failed', uncertain: 'uncertain',
  };
  for (const result of results) counts[COUNT_KEY[result.status]] += 1;
  const total = results.length + skipped.length;

  return {
    batchId: plan.batchId,
    days: plan.days,
    today: plan.today,
    results,
    skipped,
    counts,
    total,
    status: aggregateStatus(counts),
  };
}

function aggregateStatus(counts) {
  const problematic = counts.conflict + counts.failed + counts.blocked;
  if (counts.uncertain > 0) return STATUS.uncertain;
  if (problematic > 0) {
    return (counts.applied + counts.duplicate) > 0 ? 'partial' : STATUS.failed;
  }
  if ((counts.applied + counts.duplicate) > 0) return STATUS.applied;
  if (counts.noOp > 0) return STATUS.noOp;
  return STATUS.noOp;
}

function describeBatchOutcome(outcome) {
  if (!outcome) return { message: '子树延期没有结果。', problems: [], nonAtomic: false };
  const counts = outcome.counts || {};
  const parts = [
    `已应用 ${counts.applied || 0}`,
    `无变化 ${counts.noOp || 0}`,
    `跳过 ${counts.skipped || 0}`,
    `阻断 ${counts.blocked || 0}`,
    `冲突 ${counts.conflict || 0}`,
    `失败 ${counts.failed || 0}`,
    `未确认 ${counts.uncertain || 0}`,
  ];
  const problematic = (outcome.results || []).filter(item => ['blocked', 'conflict', 'failed', 'uncertain'].includes(item.status));
  const problems = problematic.slice(0, 3).map(item => `${item.basename}（${item.status}${item.reason ? `/${item.reason}` : ''}）`);
  const nonAtomic = ['partial', 'uncertain', 'failed'].includes(outcome.status);
  const headline = outcome.status === STATUS.noOp
    ? `子树延期 +${outcome.days}d：没有节点需要再推迟（全部无变化）。`
    : `子树延期 +${outcome.days}d：${outcome.total} 个节点 · ${parts.join('，')}。`;
  const detail = problems.length ? ` 需处理：${problems.join('；')}${problematic.length > 3 ? ` 等 ${problematic.length} 项` : ''}。` : '';
  const warning = nonAtomic ? ' 非原子批量操作：已修改的节点不会自动回滚。' : '';
  return { message: headline + detail + warning, problems, nonAtomic, status: outcome.status };
}

module.exports = {
  STATUS,
  SKIP_STATUSES,
  planSubtreePostpone,
  runSubtreePostpone,
  aggregateStatus,
  describeBatchOutcome,
};
