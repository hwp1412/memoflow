'use strict';

// Explicit, authorized resume for unfinished Mercy/Boost batches.
//
// Startup reconcile is read-only. This module is the only place that may finish
// a batch, and only with an explicit authorization token supplied by the caller.
// It reuses the persisted absolute targets: Boost never recomputes a delta, and
// Mercy never re-solves the allocation.

const { STATUS, summarise } = require('./batch-runner.js');
const { hasPriorResult, hasLedgerEvidence } = require('./batch-recovery.js');

const SYNTHETIC_RESUME = new WeakSet();

function issueSyntheticBatchResumeAuthorization() {
  const token = Object.freeze({ kind: 'synthetic-batch-resume' });
  SYNTHETIC_RESUME.add(token);
  return token;
}

function hasBatchResumeAuthorization(token) {
  return Boolean(token && typeof token === 'object' && SYNTHETIC_RESUME.has(token));
}

function normalizeNotBefore(value) {
  if (value == null || value === 'null' || value === '') return null;
  return String(value);
}

async function resumeBatch({ store, batchId, readTopic, runItem, ledger = null, authorization = null } = {}) {
  if (!hasBatchResumeAuthorization(authorization)) {
    return { status: 'blocked', reason: 'E_BATCH_RESUME_NOT_AUTHORIZED', counts: null };
  }
  if (!store || typeof store.getBatch !== 'function') return { status: 'failed', reason: 'E_BATCH_STORE_REQUIRED' };
  if (typeof readTopic !== 'function' || typeof runItem !== 'function') {
    return { status: 'failed', reason: 'E_BATCH_RESUME_DEPS' };
  }
  const batch = await store.getBatch(batchId);
  if (!batch) return { status: 'failed', reason: 'E_BATCH_NOT_FOUND' };
  if (['applied', 'undone'].includes(batch.status)) {
    return { status: 'no-op', reason: 'E_BATCH_ALREADY_SETTLED', counts: null, batch };
  }

  const ownedEvents = new Map();
  for (const event of Array.isArray(batch.eventIds) ? batch.eventIds : []) {
    if (event && event.topicId && event.eventId) ownedEvents.set(String(event.topicId).toLowerCase(), event);
  }

  const results = [];
  if (batch.kind === 'MERCY') {
    for (const item of Array.isArray(batch.items) ? batch.items : []) {
      const located = await readTopic(item.topicId);
      const entry = located && located.entry;
      if (!entry) { results.push({ topicId: item.topicId, path: item.path, basename: item.basename, status: STATUS.blocked, reason: 'E_TOPIC_NOT_FOUND' }); continue; }
      const current = normalizeNotBefore(entry.frontmatter.mf_not_before);
      if (current === normalizeNotBefore(item.notBefore)) {
        // A matching value is not proof: without a persisted applied result the
        // node stays uncertain and nothing is rewritten as success.
        if (!hasPriorResult(batch, item.topicId)) {
          results.push({ ...pick(item), status: STATUS.uncertain, reason: 'E_NO_BATCH_EVIDENCE' });
          continue;
        }
        results.push({ ...pick(item), status: STATUS.applied, reason: null });
        continue;
      }
      if (current !== normalizeNotBefore(item.currentNotBefore)) { results.push({ ...pick(item), status: STATUS.conflict, reason: 'E_INPUT_CHANGED' }); continue; }
      const outcome = await runItem({ topicId: item.topicId, path: item.path, notBefore: item.notBefore, currentNotBefore: item.currentNotBefore, revision: entry.revision });
      results.push({ ...pick(item), status: classify(outcome), reason: outcome && outcome.reason });
    }
  } else if (batch.kind === 'BOOST') {
    for (const target of Array.isArray(batch.targets) ? batch.targets : []) {
      const located = await readTopic(target.topicId);
      const entry = located && located.entry;
      if (!entry) { results.push({ topicId: target.topicId, path: target.path, basename: target.basename, status: STATUS.blocked, reason: 'E_TOPIC_NOT_FOUND' }); continue; }
      const current = Number(entry.frontmatter.priority);
      if (current === Number(target.to)) {
        const evidence = hasPriorResult(batch, target.topicId) || hasLedgerEvidence(ledger, target.topicId, target, batch);
        if (!evidence) {
          results.push({ ...pick(target), status: STATUS.uncertain, reason: 'E_NO_LEDGER_EVIDENCE' });
          continue;
        }
        results.push({ ...pick(target), status: STATUS.applied, reason: null });
        continue;
      }
      if (current !== Number(target.from)) { results.push({ ...pick(target), status: STATUS.conflict, reason: 'E_PRIORITY_CHANGED' }); continue; }
      const owned = ownedEvents.get(String(target.topicId).toLowerCase());
      if (!owned || !owned.eventId) {
        results.push({ ...pick(target), status: STATUS.blocked, reason: 'E_BOOST_EVENT_ID_REQUIRED' });
        continue;
      }
      if (Number.isInteger(owned.expectedRevision) && Number.isInteger(entry.revision) && entry.revision !== owned.expectedRevision) {
        results.push({ ...pick(target), status: STATUS.conflict, reason: 'E_REVISION_CHANGED' });
        continue;
      }
      // Resume MUST reuse the original event identity: a fresh event id would
      // make the ledger unable to prove this batch applied the write.
      const outcome = await runItem({
        topicId: target.topicId,
        path: target.path,
        priority: Number(target.to),
        expectedFrom: Number(target.from),
        revision: entry.revision,
        eventId: owned.eventId,
        expectedRevision: owned.expectedRevision,
      });
      results.push({ ...pick(target), status: classify(outcome), reason: outcome && outcome.reason });
    }
  } else {
    return { status: 'failed', reason: 'E_BATCH_KIND_UNKNOWN' };
  }

  const outcome = summarise({ plan: { batchId: batch.batchId, kind: batch.kind, today: batch.today, skipped: [] }, results });
  const record = {
    ...batch,
    status: outcome.status,
    results: outcome.results,
    summary: { resumedAt: new Date().toISOString(), counts: outcome.counts },
  };
  const saved = await store.saveBatch(record);
  if (!saved.ok) return { ...outcome, status: STATUS.uncertain, reason: 'E_BATCH_RESUME_RESULT_NOT_DURABLE', durable: false };
  return { ...outcome, durable: true, batch: record };
}

function pick(item) {
  return { topicId: item.topicId, path: item.path, basename: item.basename };
}

function classify(outcome) {
  if (!outcome) return STATUS.failed;
  if (outcome.status === 'applied' || outcome.status === 'duplicate') return STATUS.applied;
  if (outcome.status === 'no-op') return STATUS.noOp;
  if (outcome.status === 'conflict') return STATUS.conflict;
  if (outcome.status === 'uncertain' || outcome.status === 'requires-manual-recovery') return STATUS.uncertain;
  return STATUS.failed;
}

module.exports = { issueSyntheticBatchResumeAuthorization, hasBatchResumeAuthorization, resumeBatch };
