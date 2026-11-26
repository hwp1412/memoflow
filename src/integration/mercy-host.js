'use strict';

// Mercy host orchestration (MF-US-1, SPEC A7).
//
// Mercy is an administrative load operation: it may only move `mf_not_before`
// and must never touch `mf_interval_days`, `a_factor`, `review_count`,
// `last_reviewed` or `mf_ideal_due`. Allocation itself is NOT reimplemented
// here: `buildMercyPreview` is a thin, read-only adapter over the accepted pure
// core (`src/scheduling/mercy.js#previewMercy`) and over the shared batch
// protocol (`src/integration/batch-runner.js`).
//
// The host protocol is preview -> confirm -> apply -> undo:
//
//   1. `buildMercyPreview` derives the immutable item set from `previewMercy`
//      and a deterministic `previewDigest`. No topic is mutated and no I/O is
//      performed.
//   2. `confirmMercyPreview` turns one exact preview into an unforgeable token
//      (module-private WeakSet). Plain objects that merely copy `batchId` /
//      `previewDigest` are rejected. The token binds batch id + digest only, so
//      a duplicate apply with the SAME confirmation is intentionally allowed;
//      per-item idempotency is delegated to `applyItem` (see below).
//   3. `applyMercyHost` re-verifies the preview (digest, token, day, plan),
//      persists a `prepared` intent through the injected `store` BEFORE the
//      first `applyItem`, runs every item sequentially through `runBatch`, then
//      persists the final batch status. A batch is never atomic: `partial` /
//      `uncertain` are reported honestly, and a failed final persist downgrades
//      the whole result to `uncertain` (never `applied`).
//   4. `undoMercyHost` restores only the items the batch recorded as `applied`,
//      using the same unforgeable confirmation. It never touches interval,
//      A-Factor or review count: it only passes the `mf_not_before` intent.
//
// Design decisions recorded for the integrator:
//   * `items` contains only the items `previewMercy` marked `assigned` (i.e.
//     the ones whose `mf_not_before` actually changes). Pinned and unchanged
//     candidates are reported through `summary`, never applied: a Mercy batch
//     can therefore never pull an existing postponement earlier or write a
//     no-op revision bump.
//   * `previewDigest` covers `{kind, batchId, today, windowDays, items}` (the
//     items are canonicalised by topicId/path, so input order does not matter).
//     Covering the day metadata is deliberate: it makes a forged `preview.today`
//     an integrity failure in addition to the explicit staleness rejection.
//   * Duplicate apply (same confirmation, same preview) re-runs the batch.
//     `applyItem` is expected to be idempotent (its CAS returns `duplicate` /
//     `no-op` when the value is already in place), and the batch runner counts
//     `duplicate` as applied. The host keeps no hidden "already applied" state,
//     so the batch store is the only durable record.
//   * Undo has no durable memory of its own: call it with the ORIGINAL apply
//     outcome. A second undo re-invokes `undoItem` and relies on its CAS to
//     report `conflict` instead of writing twice.

const { fail } = require('../scheduling/errors.js');
const { assertDateString } = require('../scheduling/dates.js');
const { isPlainObject } = require('../scheduling/schema.js');
const { resolveStableId } = require('../scheduling/queue.js');
const { previewMercy } = require('../scheduling/mercy.js');
const { sha256Hex, stableStringify } = require('../scheduling/migration-hash.js');
const {
  STATUS,
  emptyCounts,
  planBatch,
  runBatch,
  describeBatch,
} = require('./batch-runner.js');

const MERCY_KIND = 'MERCY';

// The only per-item statuses an undo may report. `requires-manual-recovery` is
// accepted from `undoItem` because the batch runner maps it to `uncertain`.
const UNDO_STATUSES = Object.freeze(new Set([
  STATUS.applied,
  STATUS.blocked,
  STATUS.conflict,
  STATUS.failed,
  STATUS.uncertain,
]));

const CONFIRMATIONS = new WeakSet();

// ---------------------------------------------------------------------------
// Deterministic digest
// ---------------------------------------------------------------------------

function basenameOf(path) {
  if (typeof path !== 'string' || !path) return null;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.endsWith('.md') ? last.slice(0, -'.md'.length) : last;
}

function itemKey(item) {
  return `${String(item.topicId == null ? '' : item.topicId)}\u0000${String(item.path == null ? '' : item.path)}`;
}

function compareItemKeys(left, right) {
  const leftKey = itemKey(left);
  const rightKey = itemKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function normalizeItem(item) {
  return {
    topicId: item && item.topicId != null ? item.topicId : null,
    path: item && item.path != null ? item.path : null,
    basename: item && item.basename != null ? item.basename : null,
    notBefore: item && item.notBefore != null ? item.notBefore : null,
    currentNotBefore: item && item.currentNotBefore != null ? item.currentNotBefore : null,
  };
}

// Canonical item set: order-independent, five public fields only. Additional
// fields never enter the digest (the preview contract exposes exactly five).
function digestOfPreview({ batchId, today, windowDays, items }) {
  const normalized = items.map(normalizeItem).sort(compareItemKeys);
  return sha256Hex(stableStringify({
    kind: MERCY_KIND,
    batchId,
    today,
    windowDays,
    items: normalized,
  }));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function deriveBatchId({ topics, today, windowDays, budgetPerDay }) {
  const ids = [];
  for (const topic of topics) {
    if (!isPlainObject(topic)) {
      ids.push('?');
      continue;
    }
    try {
      ids.push(resolveStableId(topic));
    } catch {
      ids.push('?');
    }
  }
  ids.sort();
  const hash = sha256Hex(stableStringify({
    today,
    windowDays: windowDays == null ? null : windowDays,
    budgetPerDay: budgetPerDay == null ? null : budgetPerDay,
    ids,
  }));
  return `mercy-${hash.slice(0, 24)}`;
}

function resolveMercyConfig({ topics, today, windowDays, budgetPerDay, config }) {
  if (config != null && !isPlainObject(config)) {
    fail('E_MERCY_CONFIG_INVALID', 'config must be a plain object', { field: 'config' });
  }
  const merged = { ...(config || {}) };
  if (windowDays !== undefined) merged.windowDays = windowDays;
  if (budgetPerDay !== undefined) merged.dailyBudgetMinutes = budgetPerDay;
  if (merged.batchId === undefined || merged.batchId === null) {
    merged.batchId = deriveBatchId({
      topics,
      today,
      windowDays: merged.windowDays,
      budgetPerDay: merged.dailyBudgetMinutes,
    });
  }
  return merged;
}

// Topics carry the presentation fields (path/basename) that the pure core does
// not need. Duplicate ids are already rejected by `previewMercy`, so the first
// readable occurrence is enough for reporting.
function indexTopicPresentation(topics) {
  const byId = new Map();
  for (const topic of topics) {
    if (!isPlainObject(topic)) continue;
    let stableId;
    try {
      stableId = resolveStableId(topic);
    } catch {
      continue;
    }
    if (byId.has(stableId)) continue;
    const path = typeof topic.path === 'string' && topic.path ? topic.path : null;
    const basename = typeof topic.basename === 'string' && topic.basename
      ? topic.basename
      : basenameOf(path);
    byId.set(stableId, { path, basename });
  }
  return byId;
}

function toPreviewItem(allocationItem, presentation) {
  const found = presentation.get(allocationItem.stableId) || { path: null, basename: null };
  return {
    topicId: allocationItem.stableId,
    path: found.path,
    basename: found.basename,
    notBefore: allocationItem.notBeforeAfter,
    currentNotBefore: allocationItem.notBeforeBefore == null ? null : allocationItem.notBeforeBefore,
  };
}

// SPEC A7.2/A7.3 — read-only preview. The allocation is verbatim `previewMercy`;
// this adapter only adds identity/presentation fields, a deterministic digest
// and the shared batch plan.
function buildMercyPreview({ topics, today, windowDays, budgetPerDay, config } = {}) {
  if (!Array.isArray(topics)) {
    fail('E_MERCY_PREVIEW_INVALID', 'buildMercyPreview expects an array of topics', { field: 'topics' });
  }
  assertDateString(today, 'today');

  const mercyConfig = resolveMercyConfig({ topics, today, windowDays, budgetPerDay, config });
  const allocation = previewMercy(topics, mercyConfig, today);
  const presentation = indexTopicPresentation(topics);

  const items = allocation.assigned
    .map(item => toPreviewItem(item, presentation))
    .sort(compareItemKeys);

  const previewDigest = digestOfPreview({
    batchId: allocation.batchId,
    today: allocation.today,
    windowDays: allocation.windowDays,
    items,
  });

  const plan = planBatch({
    kind: MERCY_KIND,
    batchId: allocation.batchId,
    today: allocation.today,
    items: items.map(item => ({ ...item })),
  });

  return {
    batchId: allocation.batchId,
    previewDigest,
    today: allocation.today,
    windowDays: allocation.windowDays,
    items,
    summary: {
      ...allocation.summary,
      itemCount: items.length,
    },
    plan,
    // Read-only extras for the A7.3 preview dialog (per-day load, overloaded
    // days, explain text). They never take part in the digest or in apply.
    slots: allocation.slots,
    explain: allocation.explain,
    algorithmVersion: allocation.algorithmVersion,
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

function assertPreviewStructure(preview) {
  if (!isPlainObject(preview)) {
    fail('E_MERCY_PREVIEW_REQUIRED', 'a Mercy preview object is required', { field: 'preview' });
  }
  if (typeof preview.batchId !== 'string' || !preview.batchId) {
    fail('E_MERCY_PREVIEW_INVALID', 'preview.batchId is required', { field: 'batchId' });
  }
  if (!Array.isArray(preview.items)) {
    fail('E_MERCY_PREVIEW_INVALID', 'preview.items must be an array', { field: 'items' });
  }
  if (typeof preview.previewDigest !== 'string' || !preview.previewDigest) {
    fail('E_MERCY_PREVIEW_INVALID', 'preview.previewDigest is required', { field: 'previewDigest' });
  }
  assertDateString(preview.today, 'preview.today');
  if (!Number.isInteger(preview.windowDays)) {
    fail('E_MERCY_PREVIEW_INVALID', 'preview.windowDays must be an integer', { field: 'windowDays' });
  }
}

function assertPreviewIntegrity(preview) {
  const recomputed = digestOfPreview({
    batchId: preview.batchId,
    today: preview.today,
    windowDays: preview.windowDays,
    items: preview.items,
  });
  if (recomputed !== preview.previewDigest) {
    fail('E_PREVIEW_INTEGRITY', 'the preview does not match its digest; preview again', {
      batchId: preview.batchId,
    });
  }
  return recomputed;
}

function assertMercyConfirmation(confirmation, batchId, previewDigest) {
  if (!confirmation || typeof confirmation !== 'object' || !CONFIRMATIONS.has(confirmation)) {
    fail('E_MERCY_CONFIRMATION_REQUIRED', 'a trusted preview confirmation is required', { batchId });
  }
  if (confirmation.batchId !== batchId || confirmation.previewDigest !== previewDigest) {
    fail('E_MERCY_CONFIRMATION_MISMATCH', 'the confirmation does not belong to this exact preview', { batchId });
  }
  return confirmation;
}

// Turns one exact preview into an unforgeable token. The token itself is only
// recognised while it is the same object (module-private WeakSet); copying its
// fields into a plain object does not produce a confirmation.
function confirmMercyPreview(preview) {
  assertPreviewStructure(preview);
  assertPreviewIntegrity(preview);
  const confirmation = Object.freeze({
    kind: 'mercy-preview-confirmation',
    batchId: preview.batchId,
    previewDigest: preview.previewDigest,
  });
  CONFIRMATIONS.add(confirmation);
  return confirmation;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function intentNotDurable({ preview, today, items = [], cause = null }) {
  return {
    batchId: preview.batchId,
    kind: MERCY_KIND,
    today,
    previewDigest: preview.previewDigest,
    windowDays: preview.windowDays,
    // The planned item set is returned read-only so the caller can show what was
    // blocked; no result exists and nothing was applied.
    items,
    results: [],
    skipped: [],
    counts: emptyCounts(),
    total: 0,
    status: STATUS.failed,
    reason: 'E_MERCY_INTENT_NOT_DURABLE',
    durable: false,
    writesPossible: false,
    cause: cause ? { code: (cause && cause.code) || 'E_STORE_WRITE', message: cause && cause.message } : null,
  };
}

function markResultNotDurable(applied, cause = null) {
  // The per-item results stay honest (writes may well have happened); only the
  // aggregate status is downgraded, because the batch record is not durable.
  return {
    ...applied,
    status: STATUS.uncertain,
    reason: 'E_MERCY_RESULT_NOT_DURABLE',
    durable: false,
    cause: cause ? { code: (cause && cause.code) || 'E_STORE_WRITE', message: cause && cause.message } : null,
  };
}

// Validates the preview/token/day fields shared by apply (and useful to keep in
// one place). Returns the freshly rebuilt plan: the plan is re-derived from the
// digest-covered item set, so a tampered `preview.plan` can never drive writes.
function assertFreshPreview({ preview, confirmation, today }) {
  assertPreviewStructure(preview);
  assertPreviewIntegrity(preview);
  assertMercyConfirmation(confirmation, preview.batchId, preview.previewDigest);
  if (preview.today !== today) {
    fail('E_MERCY_PLAN_STALE', 'this Mercy preview was generated for a different day; preview again', {
      plannedOn: preview.today,
      today,
    });
  }

  const items = preview.items.map(item => normalizeItem(item));
  const plan = planBatch({ kind: MERCY_KIND, batchId: preview.batchId, today, items });

  if (!isPlainObject(preview.plan) || stableStringify(preview.plan) !== stableStringify(plan)) {
    fail('E_MERCY_PLAN_INVALID', 'the stored plan does not match the confirmed item set; preview again', {
      batchId: preview.batchId,
    });
  }
  return { plan, items: plan.items };
}

// SPEC A7.2/A7.3 — preview -> confirm -> apply. Returns the batch-runner
// outcome plus the batch identity the caller needs for a later undo.
async function applyMercyHost({ preview, confirmation, today, applyItem, store = null } = {}) {
  assertDateString(today, 'today');
  if (typeof applyItem !== 'function') {
    fail('E_MERCY_APPLY_ITEM_REQUIRED', 'applyMercyHost requires an applyItem function', { field: 'applyItem' });
  }
  const hasStore = store != null;
  if (hasStore && typeof store.save !== 'function') {
    fail('E_MERCY_STORE_INVALID', 'the injected Mercy store must expose save(record)', { field: 'store' });
  }

  const { plan, items } = assertFreshPreview({ preview, confirmation, today });

  // Intent first: nothing may be written unless the prepared batch record is
  // durable. Both a throw and an explicit `{ok:false}` mean "not durable".
  if (hasStore) {
    let saved;
    try {
      saved = await store.save({
        batchId: preview.batchId,
        status: 'prepared',
        items,
      });
    } catch (error) {
      return intentNotDurable({ preview, today, items, cause: error });
    }
    if (saved && saved.ok === false) {
      return intentNotDurable({ preview, today, items });
    }
  }

  const outcome = await runBatch({
    plan,
    runItem: item => applyItem(item),
  });

  const applied = {
    ...outcome,
    batchId: preview.batchId,
    kind: MERCY_KIND,
    today,
    previewDigest: preview.previewDigest,
    windowDays: preview.windowDays,
    items,
    durable: hasStore,
  };

  if (!hasStore) return applied;

  let saved;
  try {
    saved = await store.save({
      batchId: preview.batchId,
      status: applied.status,
      today,
      previewDigest: preview.previewDigest,
      windowDays: preview.windowDays,
      items,
      results: applied.results,
      skipped: applied.skipped,
      counts: applied.counts,
      total: applied.total,
    });
  } catch (error) {
    return markResultNotDurable(applied, error);
  }
  if (saved && saved.ok === false) {
    return markResultNotDurable(applied);
  }
  return { ...applied, durable: true };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function assertBatchRecord(batch) {
  if (!isPlainObject(batch)) {
    fail('E_MERCY_BATCH_INVALID', 'a Mercy apply outcome is required for undo', { field: 'batch' });
  }
  if (typeof batch.batchId !== 'string' || !batch.batchId) {
    fail('E_MERCY_BATCH_INVALID', 'batch.batchId is required', { field: 'batchId' });
  }
  if (typeof batch.previewDigest !== 'string' || !batch.previewDigest) {
    fail('E_MERCY_BATCH_INVALID', 'batch.previewDigest is required', { field: 'previewDigest' });
  }
  assertDateString(batch.today, 'batch.today');
  if (!Array.isArray(batch.items)) {
    fail('E_MERCY_BATCH_INVALID', 'batch.items must be the confirmed item set', { field: 'items' });
  }
  if (!Array.isArray(batch.results)) {
    fail('E_MERCY_BATCH_INVALID', 'batch.results must be the recorded apply results', { field: 'results' });
  }
}

// Restores only the items the batch recorded as `applied`. Everything the host
// passes to `undoItem` is a five-field `mf_not_before` intent: interval,
// A-Factor and review count are structurally absent from this path.
async function undoMercyHost({ batch, confirmation, undoItem } = {}) {
  assertBatchRecord(batch);
  assertMercyConfirmation(confirmation, batch.batchId, batch.previewDigest);
  if (typeof undoItem !== 'function') {
    fail('E_MERCY_UNDO_ITEM_REQUIRED', 'undoMercyHost requires an undoItem function', { field: 'undoItem' });
  }

  const itemsById = new Map();
  for (const item of batch.items) {
    if (!isPlainObject(item) || item.topicId == null) continue;
    const key = String(item.topicId).toLowerCase();
    if (!itemsById.has(key)) itemsById.set(key, item);
  }

  const undoItems = [];
  for (const result of batch.results) {
    if (!result || result.status !== STATUS.applied) continue;
    const key = result.topicId == null ? null : String(result.topicId).toLowerCase();
    const item = key == null ? null : itemsById.get(key);
    if (!item) {
      // Recorded as applied but no longer in the confirmed item set: report it
      // as blocked instead of guessing a restore target.
      undoItems.push({
        undoTargetMissing: true,
        topicId: result.topicId == null ? null : result.topicId,
        path: result.path == null ? null : result.path,
        basename: result.basename == null ? null : result.basename,
        notBefore: null,
        currentNotBefore: null,
      });
      continue;
    }
    undoItems.push(normalizeItem(item));
  }

  const plan = planBatch({
    kind: MERCY_KIND,
    batchId: batch.batchId,
    today: batch.today,
    items: undoItems.map(item => ({ ...item })),
  });

  const outcome = await runBatch({
    plan,
    runItem: async item => {
      if (item.undoTargetMissing) {
        return { status: STATUS.blocked, reason: 'E_MERCY_UNDO_TARGET_MISSING' };
      }
      const result = await undoItem(item);
      if (!result || typeof result.status !== 'string') return result; // runner -> failed
      if (result.status === 'requires-manual-recovery') return result; // runner -> uncertain
      if (!UNDO_STATUSES.has(result.status)) {
        return { status: STATUS.failed, reason: 'E_MERCY_UNDO_STATUS_INVALID' };
      }
      return result;
    },
  });

  return {
    ...outcome,
    batchId: batch.batchId,
    kind: MERCY_KIND,
    today: batch.today,
    previewDigest: batch.previewDigest,
    items: plan.items,
    operation: 'undo',
    restoredCount: outcome.counts.applied,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// Honest batch report (always non-atomic wording) with the two durability
// failure modes spelled out, because `describeBatch` only sees per-item counts.
function describeMercyOutcome(outcome) {
  const report = describeBatch(outcome, { label: 'Mercy' });
  const problems = report.problems.slice();
  let message = report.message;
  let nonAtomic = report.nonAtomic;

  if (outcome && outcome.reason === 'E_MERCY_INTENT_NOT_DURABLE') {
    problems.push('意图未持久化，未执行任何写入');
    nonAtomic = true;
    message += ' 批次意图未能持久化：未执行任何写入。';
  } else if (outcome && outcome.reason === 'E_MERCY_RESULT_NOT_DURABLE') {
    problems.push('批次结果未持久化，写入结果未确认');
    nonAtomic = true;
    message += ' 批次结果未能持久化：写入结果未确认，请核对后再决定是否重试。';
  }

  return { message, problems, nonAtomic };
}

module.exports = {
  buildMercyPreview,
  confirmMercyPreview,
  applyMercyHost,
  undoMercyHost,
  describeMercyOutcome,
};
