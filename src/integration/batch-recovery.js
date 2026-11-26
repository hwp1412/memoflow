'use strict';

// Startup reconcile for durable batch records (Mercy / Boost).
//
// A batch record is business intent, not a WAL entry. On startup we compare the
// persisted plan (absolute targets) with the REAL topic state and classify every
// item. The reconcile is metadata-only:
//   * it never writes a topic (no authorization at startup);
//   * it persists the derived batch status back through the batch store;
//   * it blocks topics whose state cannot be explained by the plan, so no
//     further event can be applied on top of an unknown outcome.
//
// It must never "retry" an increment: Boost compares the persisted absolute
// target, never a freshly computed delta.

const { STATUS } = require('./batch-runner.js');

const ITEM_STATE = Object.freeze({
  applied: 'applied',
  pending: 'pending',
  conflict: 'conflict',
  unknown: 'unknown',
  undone: 'undone',
});

function normalizeNotBefore(value) {
  if (value == null || value === 'null' || value === '') return null;
  return String(value);
}

function mercyItemState(item, entry) {
  if (!entry) return { state: ITEM_STATE.unknown, reason: 'E_TOPIC_NOT_FOUND' };
  const current = normalizeNotBefore(entry.frontmatter ? entry.frontmatter.mf_not_before : null);
  if (current === normalizeNotBefore(item.notBefore)) return { state: ITEM_STATE.applied, reason: null };
  if (current === normalizeNotBefore(item.currentNotBefore)) return { state: ITEM_STATE.pending, reason: null };
  return { state: ITEM_STATE.conflict, reason: 'E_EXTERNAL_CHANGE' };
}

function boostItemState(target, entry) {
  if (!entry) return { state: ITEM_STATE.unknown, reason: 'E_TOPIC_NOT_FOUND' };
  const current = Number(entry.frontmatter ? entry.frontmatter.priority : NaN);
  if (!Number.isFinite(current)) return { state: ITEM_STATE.unknown, reason: 'E_PRIORITY_INVALID' };
  if (current === Number(target.to)) return { state: ITEM_STATE.applied, reason: null };
  if (current === Number(target.from)) return { state: ITEM_STATE.pending, reason: null };
  return { state: ITEM_STATE.conflict, reason: 'E_PRIORITY_CHANGED' };
}

function classifyBatch(batch, entriesByTopicId) {
  if (!batch || typeof batch !== 'object' || typeof batch.batchId !== 'string') {
    return { reason: 'E_BATCH_RECORD_INVALID', items: [], state: ITEM_STATE.unknown };
  }
  if (batch.kind === 'MERCY') {
    if (!Array.isArray(batch.items)) return { reason: 'E_BATCH_RECORD_INCOMPLETE', items: [], state: ITEM_STATE.unknown };
    const items = batch.items.map(item => ({
      topicId: item.topicId,
      path: item.path,
      basename: item.basename,
      ...mercyItemState(item, entriesByTopicId.get(String(item.topicId || '').toLowerCase())),
    }));
    return { reason: null, items };
  }
  if (batch.kind === 'BOOST') {
    const targets = Array.isArray(batch.targets) ? batch.targets : null;
    if (!targets) return { reason: 'E_BATCH_RECORD_INCOMPLETE', items: [], state: ITEM_STATE.unknown };
    const items = targets.map(target => ({
      topicId: target.topicId,
      path: target.path,
      basename: target.basename,
      ...boostItemState(target, entriesByTopicId.get(String(target.topicId || '').toLowerCase())),
    }));
    return { reason: null, items };
  }
  return { reason: 'E_BATCH_KIND_UNKNOWN', items: [] };
}

function deriveStatus(batch, items, recordProblem) {
  if (recordProblem) return { status: 'requires-manual-recovery', reason: recordProblem };
  const applied = items.filter(item => item.state === ITEM_STATE.applied).length;
  const conflicts = items.filter(item => item.state === ITEM_STATE.conflict || item.state === ITEM_STATE.unknown).length;
  if (conflicts > 0) return { status: applied > 0 ? 'partial' : 'requires-manual-recovery', reason: 'E_BATCH_NEEDS_REVIEW' };
  if (applied === items.length && items.length > 0) return { status: 'applied', reason: null };
  if (applied > 0) return { status: 'partial', reason: null };
  return { status: batch.status === 'uncertain' ? 'uncertain' : 'prepared', reason: null };
}

async function reconcileBatches({ store, storage, batches = null } = {}) {
  if (!store || typeof store.listBatches !== 'function') {
    return { batches: [], blockedTopicIds: [], summary: { error: 'E_BATCH_STORE_REQUIRED' } };
  }
  if (!storage || typeof storage.readTopic !== 'function') {
    return { batches: [], blockedTopicIds: [], summary: { error: 'E_STORAGE_REQUIRED' } };
  }

  const list = batches || await store.listBatches({ unfinishedOnly: true });
  const reports = [];
  const blockedTopicIds = new Set();

  for (const batch of list) {
    const itemsByKey = new Map();
    const recordProblem = batch.kind === 'MERCY'
      ? (Array.isArray(batch.items) ? null : 'E_BATCH_RECORD_INCOMPLETE')
      : batch.kind === 'BOOST'
        ? (Array.isArray(batch.targets) ? null : 'E_BATCH_RECORD_INCOMPLETE')
        : 'E_BATCH_KIND_UNKNOWN';

    const ids = [];
    if (!recordProblem) {
      for (const entry of (batch.kind === 'MERCY' ? batch.items : batch.targets)) {
        if (entry && entry.topicId) ids.push(entry.topicId);
      }
    }
    for (const topicId of ids) {
      const located = await storage.readTopic(topicId);
      itemsByKey.set(String(topicId).toLowerCase(), located && located.entry ? located.entry : null);
      if (located && located.duplicates && located.duplicates.length) {
        blockedTopicIds.add(String(topicId).toLowerCase());
      }
    }

    const classified = recordProblem
      ? { reason: recordProblem, items: [] }
      : classifyBatch(batch, itemsByKey);
    const derived = deriveStatus(batch, classified.items || [], classified.reason);

    for (const item of classified.items || []) {
      if (item.state === ITEM_STATE.conflict || item.state === ITEM_STATE.unknown) {
        blockedTopicIds.add(String(item.topicId).toLowerCase());
      }
    }
    if (derived.status === 'requires-manual-recovery' && classified.items && classified.items.length === 0) {
      // A corrupt record cannot name its topics; nothing to block, but it stays
      // visible as manual recovery.
    }

    const nextRecord = {
      ...batch,
      status: derived.status,
      recovery: {
        reason: derived.reason,
        items: classified.items || [],
        checkedAt: new Date().toISOString(),
      },
    };
    if (nextRecord.status !== batch.status || !batch.recovery) {
      const saved = await store.saveBatch(nextRecord);
      reports.push({ batchId: batch.batchId, kind: batch.kind, status: derived.status, reason: derived.reason, items: classified.items || [], persisted: saved.ok });
    } else {
      reports.push({ batchId: batch.batchId, kind: batch.kind, status: derived.status, reason: derived.reason, items: classified.items || [], persisted: true });
    }
  }

  return {
    batches: reports,
    blockedTopicIds: [...blockedTopicIds],
    summary: {
      checked: reports.length,
      applied: reports.filter(report => report.status === 'applied').length,
      partial: reports.filter(report => report.status === 'partial').length,
      manual: reports.filter(report => report.status === 'requires-manual-recovery').length,
      pending: reports.filter(report => ['prepared', 'uncertain'].includes(report.status)).length,
      blockedTopicIds: [...blockedTopicIds],
    },
  };
}

module.exports = { ITEM_STATE, reconcileBatches, classifyBatch, mercyItemState, boostItemState, normalizeNotBefore };
