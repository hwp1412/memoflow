'use strict';

// Host layer for Boost batches (P2-US1-HOST-CLOSURE, Actions Agent).
//
// A Boost is host-level orchestration: it is NOT a new MF-US-1 event type
// (owner ruling Q3). Each target Topic is a normal A5.4 SET_PRIORITY intent with
// its own revision/ledger record, so idempotency must come from the feature
// protocol, not from a batch WAL:
//
//   plan    one stable batchId + a pinned `today` + the target list;
//   intent  `store.save(batchId, {status:'prepared', targets})` BEFORE any
//           write — a failed intent save means zero applyItem calls;
//   apply   read each node's CURRENT persisted priority and recompute
//           `to = max(1, current - delta)`, then apply only when the observed
//           value still equals the planned `from` (else conflict, never twice);
//   result  persist the outcome; a failed result save is `uncertain`, not
//           success (SPEC A11 / batch contract §6.3).
//
// Planning/ordering/aggregation/reporting are delegated to the shared
// batch-runner.js (planBatch / runBatch / describeBatch). This module never
// writes Frontmatter and never computes intervals.

const {
  planBatch,
  runBatch,
  describeBatch,
  emptyCounts,
  BatchContractError,
} = require('./batch-runner.js');
const { sha256Hex, stableStringify } = require('../scheduling/migration-hash.js');
const { isValidDateString } = require('../scheduling/dates.js');

const BOOST_MIN_DELTA = 1;
const BOOST_MAX_DELTA = 99;
const BOOST_MIN_PRIORITY = 1;
const BOOST_MAX_PRIORITY = 100;

const BOOST_STATUSES = Object.freeze({
  applied: 'applied',
  duplicate: 'duplicate',
  noOp: 'no-op',
  skipped: 'skipped',
  blocked: 'blocked',
  conflict: 'conflict',
  failed: 'failed',
  uncertain: 'uncertain',
});

function contractError(code, message, details = {}) {
  return new BatchContractError(code, message, details);
}

function isPriority(value) {
  return Number.isInteger(value) && value >= BOOST_MIN_PRIORITY && value <= BOOST_MAX_PRIORITY;
}

// Planning needs the priority observed when the queue was rendered. Synthetic
// rows carry it directly; projection-shaped rows may carry it under `fm`.
function observedPriority(row) {
  const raw = row && row.priority != null ? row.priority : (row && row.fm ? row.fm.priority : null);
  return isPriority(raw) ? raw : null;
}

function rowKey(row) {
  if (!row) return '';
  return String(row.topicId || row.path || row.basename || '');
}

// Plan one Boost batch. Whole-batch refusals throw a BatchContractError with a
// stable `code` (same convention as batch-runner.planBatch):
//   E_ROOT_ID_REQUIRED / E_BOOST_DELTA_INVALID / E_BOOST_MAX_PRIORITY_INVALID
//   E_TODAY_REQUIRED / E_BOOST_ROWS_REQUIRED / E_BATCH_DUPLICATE_ID
function planBoostBatch({ rows, rootTopicId, delta, today, maxPriority = 1 } = {}) {
  if (!Array.isArray(rows)) {
    throw contractError('E_BOOST_ROWS_REQUIRED', 'boost rows must be an array');
  }
  if (typeof rootTopicId !== 'string' || rootTopicId.trim() === '') {
    throw contractError('E_ROOT_ID_REQUIRED', 'the boost root topic needs a persistent id');
  }
  if (!Number.isInteger(delta) || delta < BOOST_MIN_DELTA || delta > BOOST_MAX_DELTA) {
    throw contractError(
      'E_BOOST_DELTA_INVALID',
      `delta must be an integer within ${BOOST_MIN_DELTA}..${BOOST_MAX_DELTA}`
    );
  }
  if (!isPriority(maxPriority)) {
    throw contractError(
      'E_BOOST_MAX_PRIORITY_INVALID',
      `maxPriority must be an integer within ${BOOST_MIN_PRIORITY}..${BOOST_MAX_PRIORITY}`
    );
  }
  if (!isValidDateString(today)) {
    throw contractError('E_TODAY_REQUIRED', 'today must be a fixed YYYY-MM-DD date for the whole batch');
  }

  // The batch id is a pure digest of the immutable plan (params + sorted node
  // keys), so a retry of the same batch reuses it and an edited batch cannot
  // masquerade as the previous one.
  const provisionalId = sha256Hex(stableStringify({
    kind: 'BOOST',
    rootTopicId,
    delta,
    today,
    maxPriority,
    keys: rows.map(rowKey).sort(),
  }));

  // Shared protocol: duplicate ids refuse the whole batch; cards and terminal
  // statuses (done / dismissed / container) are skipped before execution.
  const basePlan = planBatch({ kind: 'BOOST', batchId: provisionalId, today, items: rows });

  const runnable = [];
  const skipped = [...basePlan.skipped];
  for (const item of basePlan.items) {
    if (!item || typeof item !== 'object') continue;
    if (!item.topicId) {
      skipped.push({ ...item, status: BOOST_STATUSES.skipped, reason: 'ID_NOT_PERSISTED' });
      continue;
    }
    if (observedPriority(item) == null) {
      skipped.push({ ...item, status: BOOST_STATUSES.skipped, reason: 'PRIORITY_INVALID' });
      continue;
    }
    runnable.push(item);
  }

  const targets = runnable.map(item => {
    const from = observedPriority(item);
    const target = {
      topicId: item.topicId,
      path: item.path,
      basename: item.basename,
      from,
      to: Math.max(maxPriority, from - delta),
    };
    if (Number.isInteger(item.revision)) target.revision = item.revision;
    return target;
  });

  // The batch identity includes each node's from/to transition, so a different
  // absolute plan can never reuse (and overwrite) another batch record.
  const batchId = sha256Hex(stableStringify({
    kind: 'BOOST',
    rootTopicId,
    delta,
    today,
    maxPriority,
    targets: targets.map(target => ({ topicId: target.topicId, from: target.from, to: target.to })),
  }));

  // Event identities are deterministic and are persisted BEFORE any topic write,
  // so a crash still lets the ledger prove which events this batch produced.
  const events = targets.map(target => {
    if (!Number.isInteger(target.revision) || typeof target.topicId !== 'string') {
      return { topicId: target.topicId, eventId: null, expectedRevision: target.revision ?? null };
    }
    const digest = sha256Hex(JSON.stringify({
      action: 'SET_PRIORITY',
      topicId: target.topicId,
      expectedRevision: target.revision,
      today,
      payload: { priority: target.to },
    }));
    return {
      topicId: target.topicId,
      eventId: `00000000-0000-4000-8000-${digest.slice(0, 12)}`,
      expectedRevision: target.revision,
    };
  });

  const plan = { ...planBatch({ kind: 'BOOST', batchId, today, items: rows }), items: runnable, skipped };

  return { batchId, today, delta, plan, targets, events };
}

async function saveBatchRecord(save, batchId, record) {
  try {
    const result = await save(batchId, record);
    if (result && result.ok === false) {
      return { ok: false, code: result.code || 'E_BOOST_BATCH_NOT_DURABLE' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error && error.code) || 'E_BOOST_BATCH_NOT_DURABLE', message: error && error.message };
  }
}

function storeFailure(batch, skipped, { code, storeCode, message }) {
  const counts = emptyCounts();
  counts.skipped = skipped.length;
  return {
    batchId: batch ? batch.batchId : null,
    kind: 'BOOST',
    today: batch ? batch.today ?? null : null,
    delta: batch ? batch.delta ?? null : null,
    targets: batch ? batch.targets : [],
    results: [],
    skipped,
    counts,
    total: skipped.length,
    status: 'failed',
    reason: code,
    storeCode: storeCode || null,
    message: message || null,
    intentPersisted: false,
    resultPersisted: false,
    writesPerformed: false,
  };
}

async function runBoostNode(node, { targetById, delta, getPriority, applyItem }) {
  const target = targetById.get(node.topicId);
  if (!target) return { status: 'blocked', reason: 'E_BOOST_TARGET_MISSING' };

  let current;
  try {
    current = await getPriority(node);
  } catch (error) {
    return {
      status: 'failed',
      reason: (error && error.code) || 'E_PRIORITY_UNAVAILABLE',
      message: error && error.message,
    };
  }
  if (!isPriority(current)) return { status: 'failed', reason: 'E_PRIORITY_UNAVAILABLE' };

  const to = Math.max(1, current - delta);
  // Idempotent retry: the node already sits at the computed target (the floor,
  // or an earlier run of this very batch). Nothing to do, never an error.
  if (current === to) return { status: 'no-op', reason: 'ALREADY_AT_FLOOR' };
  // Never decrement twice: if the persisted priority moved away from the value
  // recorded at planning time, this batch no longer owns the transition.
  if (current !== target.from) {
    return { status: 'conflict', reason: 'E_PRIORITY_CHANGED' };
  }

  return applyItem(node, { priority: to, expectedFrom: current });
}

// Persist the intent, apply the batch through the shared runner, persist the
// outcome. Returns the batch outcome plus counts, honest about every failure.
async function applyBoostBatch({ batch, getPriority, applyItem, store } = {}) {
  if (!batch || typeof batch !== 'object' || !batch.plan || !Array.isArray(batch.targets) || typeof batch.batchId !== 'string') {
    throw contractError('E_BOOST_BATCH_REQUIRED', 'a planned boost batch is required');
  }
  if (!Number.isInteger(batch.delta)) {
    throw contractError('E_BOOST_BATCH_REQUIRED', 'the planned batch has no integer delta');
  }
  if (typeof getPriority !== 'function') {
    throw contractError('E_BOOST_GET_PRIORITY_REQUIRED', 'getPriority(node) is required');
  }
  if (typeof applyItem !== 'function') {
    throw contractError('E_BOOST_APPLY_REQUIRED', 'applyItem(node, change) is required');
  }
  const save = store && typeof store.save === 'function' ? store.save.bind(store) : null;
  if (!save) {
    throw contractError('E_BOOST_STORE_REQUIRED', 'a batch store with save(batchId, record) is required');
  }

  const skipped = batch.plan.skipped || [];

  // Durability first: no target may be written unless the prepared intent was
  // accepted by the store. A store failure is a definite zero-write failure.
  if (typeof store.getBatch === 'function') {
    const existing = await store.getBatch(batch.batchId);
    if (existing && JSON.stringify(existing.targets) !== JSON.stringify(batch.targets)) {
      return {
        batchId: batch.batchId,
        kind: 'BOOST',
        today: batch.today,
        status: 'failed',
        counts: emptyCounts(),
        results: [],
        skipped,
        total: batch.targets.length,
        durable: false,
        reason: 'E_BATCH_PLAN_CONFLICT',
        message: 'an existing batch record has different absolute targets',
        writesPerformed: false,
      };
    }
  }

  const intent = await saveBatchRecord(save, batch.batchId, {
    status: 'prepared',
    targets: batch.targets,
    // Written before any topic write: the crash-recovery ledger pointer.
    eventIds: Array.isArray(batch.events) ? batch.events : [],
  });
  if (!intent.ok) {
    return storeFailure(batch, skipped, {
      code: 'E_BOOST_INTENT_NOT_DURABLE',
      storeCode: intent.code,
      message: intent.message,
    });
  }

  const targetById = new Map(batch.targets.map(target => [target.topicId, target]));
  const outcome = await runBatch({
    plan: batch.plan,
    runItem: node => runBoostNode(node, { targetById, delta: batch.delta, getPriority, applyItem }),
  });

  const writesPerformed = outcome.counts.applied + outcome.counts.duplicate > 0;
  const finalRecord = {
    eventIds: Array.isArray(batch.events) ? batch.events : [],
    status: outcome.status,
    targets: batch.targets,
    results: outcome.results,
    counts: outcome.counts,
  };
  const persisted = await saveBatchRecord(save, batch.batchId, finalRecord);
  if (!persisted.ok) {
    // The writes may have happened but the result is not durable: uncertain is
    // the only honest status. It is never reported as applied.
    return {
      ...outcome,
      status: 'uncertain',
      reason: 'E_BOOST_RESULT_NOT_DURABLE',
      storeCode: persisted.code || null,
      targets: batch.targets,
      delta: batch.delta,
      intentPersisted: true,
      resultPersisted: false,
      writesPerformed,
    };
  }

  return {
    ...outcome,
    targets: batch.targets,
    delta: batch.delta,
    intentPersisted: true,
    resultPersisted: true,
    writesPerformed,
  };
}

// UI-facing report. Delegates to the shared batch reporter (non-atomic warning,
// per-node problems, skipped/uncertain counts) and never hides an uncertain
// outcome behind a success headline.
function describeBoostOutcome(outcome) {
  const report = describeBatch(outcome, { label: '批量提权', unit: '节点' });
  const counts = outcome && outcome.counts ? outcome.counts : emptyCounts();
  let message = report.message;
  if (outcome && outcome.reason && (outcome.status === 'failed' || outcome.status === 'uncertain')) {
    message += ` 原因：${outcome.reason}。`;
  }
  return {
    ...report,
    message,
    counts,
    status: outcome ? outcome.status : null,
    delta: outcome ? outcome.delta ?? null : null,
  };
}

module.exports = {
  BOOST_MIN_DELTA,
  BOOST_MAX_DELTA,
  BOOST_MIN_PRIORITY,
  BOOST_MAX_PRIORITY,
  BOOST_STATUSES,
  planBoostBatch,
  applyBoostBatch,
  describeBoostOutcome,
};
