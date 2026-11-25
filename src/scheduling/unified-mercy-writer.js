'use strict';

// Persistent Mercy batch coordination for the Unified writer (PR-09).
//
// Allocation stays in the accepted PR-04 Mercy core. This module binds a
// confirmation to the exact immutable preview, persists every write intent
// BEFORE a CAS, never redefines a persisted intent on retry, and refuses undo
// unless a trusted applied batch (with intents) exists in the batch store.

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { isValidDateString } = require('./dates.js');
const { effectiveDueFromDates } = require('./due.js');
const { isPersistentUuid } = require('./legacy-identity.js');
const { resolveSchedulerMode } = require('./mode.js');
const { sha256Hex, stableStringify } = require('./migration-hash.js');
const { SUPPORTED_DATE_FORMATS, formatLegacyDate } = require('./unified-writer.js');
const {
  renderContent,
  assertTrustedTopicStorage,
  assertTrustedBatchStore,
  assertSyntheticUnifiedCapability,
  assertSyntheticMercyConfirmation,
} = require('./unified-store-contract.js');

const MERCY_BATCH_KIND = 'mf-us-1-unified-mercy-batch';

function digestOf(batch) {
  return sha256Hex(stableStringify({
    batchId: batch.batchId,
    today: batch.today,
    algorithmVersion: batch.algorithmVersion,
    dateFormat: batch.dateFormat,
    entries: batch.entries.map(entry => ({
      operationId: entry.operationId,
      topicId: entry.topicId,
      notBeforeBefore: entry.notBeforeBefore,
      notBeforeAfter: entry.notBeforeAfter,
      revisionBefore: entry.revisionBefore,
      revisionAfter: entry.revisionAfter,
    })),
  }));
}

function assertPreviewIntegrity(batch) {
  if (typeof batch.previewDigest !== 'string' || batch.previewDigest !== digestOf(batch)) {
    fail('E_PREVIEW_INTEGRITY', 'the batch does not match its confirmed preview digest', { batchId: batch.batchId });
  }
}

function validateBatch(batch) {
  if (!batch || batch.kind !== MERCY_BATCH_KIND) fail('E_BATCH_INVALID', 'a Mercy batch is required');
  if (typeof batch.batchId !== 'string' || !batch.batchId) fail('E_BATCH_ID_REQUIRED', 'a batch id is required');
  if (!isValidDateString(batch.today)) fail('E_BATCH_TODAY_INVALID', 'batch today must be a calendar date');
  if (batch.algorithmVersion !== ALGORITHM_VERSION) fail('E_BATCH_VERSION_INVALID', 'unsupported algorithm version');
  if (!SUPPORTED_DATE_FORMATS.includes(batch.dateFormat)) {
    fail('E_DATE_FORMAT_UNSUPPORTED', 'unsupported Vault date format; no silent fallback', { dateFormat: batch.dateFormat });
  }
  if (!Array.isArray(batch.entries)) fail('E_BATCH_INVALID', 'batch entries must be an array');

  const topics = new Set();
  const operations = new Set();
  for (const entry of batch.entries) {
    if (!isPersistentUuid(entry.topicId)) fail('E_TOPIC_ID_INVALID', 'mercy target must be a persistent UUID');
    if (topics.has(entry.topicId)) fail('E_BATCH_DUPLICATE_TOPIC', 'the same topic appears twice in one batch');
    topics.add(entry.topicId);
    if (typeof entry.operationId !== 'string' || operations.has(entry.operationId)) {
      fail('E_BATCH_DUPLICATE_OPERATION', 'duplicate or missing operation id');
    }
    operations.add(entry.operationId);
    if (entry.operationId !== `${batch.batchId}:${entry.topicId}`) fail('E_BATCH_OPERATION_MISMATCH', 'operation id does not bind its topic');
    if (!Number.isInteger(entry.revisionBefore) || entry.revisionBefore < 0) fail('E_REVISION_NOT_PERSISTED', 'missing revision');
    if (entry.revisionAfter !== entry.revisionBefore + 1) fail('E_BATCH_REVISION_INVALID', 'revisionAfter must be revisionBefore + 1');
    if (entry.notBeforeAfter === entry.notBeforeBefore) fail('E_BATCH_NOOP_INVALID', 'a batch entry must change not_before');
    if (entry.notBeforeAfter != null && !isValidDateString(entry.notBeforeAfter)) fail('E_DATE_INVALID', 'invalid not_before');
    if (entry.notBeforeBefore != null && !isValidDateString(entry.notBeforeBefore)) fail('E_DATE_INVALID', 'invalid preview not_before');
  }
  assertPreviewIntegrity(batch);
  return batch;
}

function resolveDeps(dependencies) {
  const resolved = resolveSchedulerMode(dependencies.mode);
  if (resolved.mode !== 'unified') fail('E_MODE_NOT_UNIFIED', 'mercy batch writing requires unified mode');
  assertSyntheticUnifiedCapability(dependencies.capability);
  assertTrustedTopicStorage(dependencies.storage);
  assertTrustedBatchStore(dependencies.batchStore);
  return resolved;
}

function topicError(entry) {
  const frontmatter = entry.frontmatter || {};
  if (frontmatter.mf_id !== entry.mfId) return 'E_INDEX_ID_MISMATCH';
  if (frontmatter.type !== 'source' && frontmatter.type !== 'extract') return 'E_TOPIC_TYPE';
  if (frontmatter.status !== 'active') return 'E_TOPIC_NOT_ACTIVE';
  if (frontmatter.mf_scheduler_version !== ALGORITHM_VERSION) return 'E_VERSION_NOT_PERSISTED';
  if (!Number.isInteger(frontmatter.mf_revision)) return 'E_REVISION_NOT_PERSISTED';
  return null;
}

function locate(storage, topicId) {
  const located = storage.findByTopicId(topicId);
  if (located.duplicates.length > 0) return { error: 'E_DUPLICATE_TOPIC_ID' };
  if (!located.entry) return { error: 'E_TOPIC_NOT_FOUND' };
  const error = topicError(located.entry);
  if (error) return { error };
  return { current: located.entry };
}

function intentIsValid(entry) {
  const intent = entry.intent;
  return Boolean(
    intent
    && intent.topicId === entry.topicId
    && intent.beforeNotBefore === entry.notBeforeBefore
    && intent.afterNotBefore === entry.notBeforeAfter
    && intent.beforeRevision === entry.revisionBefore
    && intent.afterRevision === entry.revisionAfter
    && typeof intent.beforeHash === 'string'
    && typeof intent.expectedAfterHash === 'string'
  );
}

function projectedNextReview(frontmatter, notBefore, dateFormat) {
  return formatLegacyDate(effectiveDueFromDates(frontmatter.mf_ideal_due, notBefore), dateFormat);
}

function buildIntent(entry, current, dateFormat) {
  const frontmatter = current.frontmatter;
  return {
    topicId: entry.topicId,
    path: current.path,
    beforeHash: sha256Hex(current.content),
    expectedAfterHash: sha256Hex(renderContent({
      ...frontmatter,
      mf_not_before: entry.notBeforeAfter,
      mf_revision: entry.revisionAfter,
      mf_scheduler_version: ALGORITHM_VERSION,
      next_review: projectedNextReview(frontmatter, entry.notBeforeAfter, dateFormat),
    }, current.body)),
    beforeNotBefore: entry.notBeforeBefore,
    afterNotBefore: entry.notBeforeAfter,
    beforeRevision: entry.revisionBefore,
    afterRevision: entry.revisionAfter,
  };
}

function prepareUnifiedMercyBatch(plan, options = {}) {
  if (!plan || !Array.isArray(plan.items)) fail('E_PLAN_INVALID', 'a Mercy preview result is required');
  const batchId = options.batchId || plan.batchId;
  const entries = plan.items
    .filter(item => item.status === 'assigned' && item.changed)
    .map(item => ({
      operationId: `${batchId}:${item.stableId}`,
      topicId: item.stableId,
      notBeforeBefore: item.notBeforeBefore,
      notBeforeAfter: item.notBeforeAfter,
      revisionBefore: item.revisionBefore,
      revisionAfter: item.revisionAfter,
      status: 'pending',
      error: null,
      intent: null,
    }));
  const dateFormat = options.dateFormat || plan.dateFormat;
  if (!SUPPORTED_DATE_FORMATS.includes(dateFormat)) {
    fail('E_DATE_FORMAT_UNSUPPORTED', 'a supported Vault date format must be provided explicitly', { dateFormat });
  }
  const batch = {
    kind: MERCY_BATCH_KIND,
    batchId,
    today: plan.today,
    algorithmVersion: ALGORITHM_VERSION,
    dateFormat,
    entries,
    status: entries.length ? 'planned' : 'noop',
    writesPerformed: false,
    counts: { attempted: 0, succeeded: 0, failed: 0, conflicts: 0, alreadyApplied: 0 },
  };
  batch.previewDigest = digestOf(batch);
  validateBatch(batch);
  return batch;
}

function applyUnifiedMercyBatch(batch, dependencies = {}) {
  resolveDeps(dependencies);
  validateBatch(batch);
  const persisted = dependencies.batchStore.get(batch.batchId);
  if (persisted && persisted.previewDigest !== batch.previewDigest) {
    fail('E_BATCH_ID_CONFLICT', 'the batch id is already used by a different confirmed batch', { batchId: batch.batchId });
  }
  const working = persisted || batch;
  validateBatch(working);
  assertSyntheticMercyConfirmation(dependencies.confirmation, working.batchId, working.previewDigest);
  if (working.status === 'rolled-back' || working.status === 'partially-rolled-back') {
    fail('E_BATCH_ALREADY_ROLLED_BACK', 'a rolled-back batch cannot be applied again');
  }

  // Prepare intents only once. A persisted intent is never regenerated.
  for (const entry of working.entries) {
    if (entry.status === 'applied' || entry.status === 'already-applied') continue;
    if (entry.intent) {
      if (!intentIsValid(entry)) {
        entry.status = 'requires-manual-recovery';
        entry.error = { code: 'E_INTENT_INVALID' };
      } else if (entry.status === 'failed') {
        // A transient write failure is retryable, but only with the original intent.
        entry.status = 'pending';
      }
      continue;
    }
    if (entry.status === 'conflict') continue;
    const target = locate(dependencies.storage, entry.topicId);
    if (target.error) {
      entry.status = 'failed';
      entry.error = { code: target.error };
      continue;
    }
    const frontmatter = target.current.frontmatter;
    if (frontmatter.mf_not_before === entry.notBeforeAfter && frontmatter.mf_revision === entry.revisionAfter) {
      // A file already at After without a persisted intent is not trusted.
      entry.status = 'requires-manual-recovery';
      entry.error = { code: 'E_INTENT_MISSING' };
      continue;
    }
    if (frontmatter.mf_not_before !== entry.notBeforeBefore || frontmatter.mf_revision !== entry.revisionBefore) {
      entry.status = 'conflict';
      entry.error = { code: 'E_PREVIEW_STALE' };
      continue;
    }
    entry.intent = buildIntent(entry, target.current, working.dateFormat);
    entry.status = 'pending';
    entry.error = null;
  }
  working.status = 'applying';
  dependencies.batchStore.put(working.batchId, working);

  const counts = { attempted: 0, succeeded: 0, failed: 0, conflicts: 0, alreadyApplied: 0, uncertain: 0 };
  for (const entry of working.entries) {
    if (entry.status === 'requires-manual-recovery') continue;
    if (entry.status === 'failed' || entry.status === 'conflict') {
      if (entry.status === 'conflict') counts.conflicts += 1;
      else counts.failed += 1;
      continue;
    }
    if (!entry.intent || !intentIsValid(entry)) {
      entry.status = 'requires-manual-recovery';
      entry.error = { code: 'E_INTENT_INVALID' };
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }

    const target = locate(dependencies.storage, entry.topicId);
    if (target.error) {
      entry.status = 'failed';
      entry.error = { code: target.error };
      counts.failed += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    const current = target.current;
    const hash = sha256Hex(current.content);
    const frontmatter = current.frontmatter;
    const isAfter = hash === entry.intent.expectedAfterHash
      && frontmatter.mf_not_before === entry.notBeforeAfter
      && frontmatter.mf_revision === entry.revisionAfter;
    const isBefore = hash === entry.intent.beforeHash
      && frontmatter.mf_not_before === entry.notBeforeBefore
      && frontmatter.mf_revision === entry.revisionBefore;

    if (entry.status === 'applied' || entry.status === 'already-applied') {
      if (isAfter) {
        counts.alreadyApplied += 1;
      } else {
        entry.status = 'conflict';
        entry.error = { code: 'E_EXTERNAL_EDIT' };
        counts.conflicts += 1;
      }
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (isAfter) {
      entry.status = 'applied';
      entry.error = null;
      counts.alreadyApplied += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (!isBefore) {
      entry.status = 'conflict';
      entry.error = { code: 'E_EXTERNAL_EDIT' };
      counts.conflicts += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }

    counts.attempted += 1;
    const cas = dependencies.storage.compareAndSwap(current.path, {
      expectedHash: entry.intent.beforeHash,
      expectedRevision: entry.revisionBefore,
      nextFrontmatter: {
        ...frontmatter,
        mf_not_before: entry.notBeforeAfter,
        mf_revision: entry.revisionAfter,
        mf_scheduler_version: ALGORITHM_VERSION,
        next_review: projectedNextReview(frontmatter, entry.notBeforeAfter, working.dateFormat),
      },
      nextBody: current.body,
      nextRevision: entry.revisionAfter,
    });
    if (!cas.ok) {
      const retryable = cas.code === 'E_STORAGE_WRITE_FAILED';
      entry.status = retryable ? 'failed' : 'conflict';
      entry.error = { code: cas.code };
      if (retryable) counts.failed += 1;
      else counts.conflicts += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    let readback = null;
    try {
      readback = dependencies.storage.read(current.path);
    } catch (error) {
      entry.status = 'uncertain';
      entry.error = { code: 'E_WRITE_UNVERIFIED' };
      counts.uncertain += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (!readback
      || sha256Hex(readback.content) !== entry.intent.expectedAfterHash
      || readback.frontmatter.mf_not_before !== entry.notBeforeAfter
      || readback.frontmatter.mf_revision !== entry.revisionAfter) {
      entry.status = 'uncertain';
      entry.error = { code: 'E_WRITE_UNVERIFIED' };
      counts.uncertain += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    entry.status = 'applied';
    entry.error = null;
    counts.succeeded += 1;
    dependencies.batchStore.put(working.batchId, working);
  }

  const statuses = working.entries.map(entry => entry.status);
  if (counts.conflicts > 0 || counts.uncertain > 0 || statuses.includes('requires-manual-recovery')) {
    working.status = 'requires-manual-recovery';
  } else if (statuses.every(status => status === 'applied' || status === 'already-applied')) {
    working.status = 'applied';
  } else if (statuses.some(status => status === 'applied' || status === 'already-applied')) {
    working.status = 'partially-applied';
  } else if (statuses.every(status => status === 'failed')) {
    working.status = 'failed';
  } else {
    working.status = 'requires-manual-recovery';
  }
  working.counts = counts;
  working.writesPerformed = counts.succeeded > 0;
  dependencies.batchStore.put(working.batchId, working);
  return { batch: working, counts, writesPerformed: working.writesPerformed };
}

function undoUnifiedMercyBatch(batch, dependencies = {}) {
  resolveDeps(dependencies);
  validateBatch(batch);
  const persisted = dependencies.batchStore.get(batch.batchId);
  if (!persisted) fail('E_BATCH_NOT_PERSISTED', 'undo requires a trusted applied batch in the batch store');
  if (persisted.previewDigest !== batch.previewDigest) {
    fail('E_BATCH_ID_CONFLICT', 'the batch id is already used by a different confirmed batch', { batchId: batch.batchId });
  }
  if (!['applied', 'partially-applied', 'partially-rolled-back', 'requires-manual-recovery', 'rolled-back'].includes(persisted.status)) {
    fail('E_BATCH_NOT_APPLIED', 'only an applied batch can be undone', { status: persisted.status });
  }
  assertSyntheticMercyConfirmation(dependencies.confirmation, persisted.batchId, persisted.previewDigest);
  const working = persisted;

  if (working.status === 'rolled-back') {
    return {
      batch: working,
      counts: { rolledBack: 0, alreadyRolledBack: working.entries.length, conflicts: 0, failed: 0, uncertain: 0 },
      writesPerformed: false,
    };
  }

  const counts = { rolledBack: 0, alreadyRolledBack: 0, conflicts: 0, failed: 0, uncertain: 0 };
  for (const entry of working.entries) {
    if (entry.status === 'conflict') {
      counts.conflicts += 1;
      continue;
    }
    if (entry.status === 'pending') continue;
    if (!entry.intent || !intentIsValid(entry)) {
      entry.status = 'requires-manual-recovery';
      entry.error = { code: 'E_INTENT_INVALID' };
      counts.failed += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    const target = locate(dependencies.storage, entry.topicId);
    if (target.error) {
      entry.status = 'requires-manual-recovery';
      entry.error = { code: target.error };
      counts.failed += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    const current = target.current;
    const hash = sha256Hex(current.content);
    const frontmatter = current.frontmatter;

    if (frontmatter.mf_not_before === entry.notBeforeBefore) {
      // Only a persisted undo intent can prove this was our restore.
      if (entry.undoIntent
        && hash === entry.undoIntent.expectedRestoredHash
        && frontmatter.mf_revision === entry.revisionAfter + 1) {
        entry.status = 'rolled-back';
        entry.error = null;
        counts.alreadyRolledBack += 1;
      } else {
        entry.status = 'conflict';
        entry.error = { code: 'E_UNDO_EVIDENCE_MISSING' };
        counts.conflicts += 1;
      }
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (hash !== entry.intent.expectedAfterHash
      || frontmatter.mf_not_before !== entry.notBeforeAfter
      || frontmatter.mf_revision !== entry.revisionAfter) {
      entry.status = 'conflict';
      entry.error = { code: 'E_EXTERNAL_EDIT' };
      counts.conflicts += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }

    if (!entry.undoIntent) {
      entry.undoIntent = {
        beforeHash: hash,
        expectedRestoredHash: sha256Hex(renderContent({
          ...frontmatter,
          mf_not_before: entry.notBeforeBefore,
          mf_revision: entry.revisionAfter + 1,
          next_review: projectedNextReview(frontmatter, entry.notBeforeBefore, working.dateFormat),
        }, current.body)),
      };
    }
    dependencies.batchStore.put(working.batchId, working);
    const cas = dependencies.storage.compareAndSwap(current.path, {
      expectedHash: hash,
      expectedRevision: entry.revisionAfter,
      nextFrontmatter: {
        ...frontmatter,
        mf_not_before: entry.notBeforeBefore,
        mf_revision: entry.revisionAfter + 1,
        next_review: projectedNextReview(frontmatter, entry.notBeforeBefore, working.dateFormat),
      },
      nextBody: current.body,
      nextRevision: entry.revisionAfter + 1,
    });
    if (!cas.ok) {
      const retryable = cas.code === 'E_STORAGE_WRITE_FAILED';
      entry.status = retryable ? 'failed' : 'conflict';
      entry.error = { code: cas.code };
      if (retryable) counts.failed += 1;
      else counts.conflicts += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    let readback = null;
    try {
      readback = dependencies.storage.read(current.path);
    } catch (error) {
      entry.status = 'uncertain';
      entry.error = { code: 'E_WRITE_UNVERIFIED' };
      counts.uncertain += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (!readback
      || sha256Hex(readback.content) !== entry.undoIntent.expectedRestoredHash
      || readback.frontmatter.mf_not_before !== entry.notBeforeBefore) {
      entry.status = 'uncertain';
      entry.error = { code: 'E_WRITE_UNVERIFIED' };
      counts.uncertain += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    entry.status = 'rolled-back';
    entry.error = null;
    counts.rolledBack += 1;
    dependencies.batchStore.put(working.batchId, working);
  }

  const statuses = working.entries.map(entry => entry.status);
  if (counts.conflicts > 0 || counts.uncertain > 0) working.status = 'requires-manual-recovery';
  else if (statuses.every(status => status === 'rolled-back' || status === 'pending')) working.status = 'rolled-back';
  else if (statuses.some(status => status === 'rolled-back')) working.status = 'partially-rolled-back';
  else working.status = 'requires-manual-recovery';
  working.counts = counts;
  working.writesPerformed = counts.rolledBack > 0;
  dependencies.batchStore.put(working.batchId, working);
  return { batch: working, counts, writesPerformed: working.writesPerformed };
}

module.exports = {
  MERCY_BATCH_KIND,
  mercyBatchDigest: digestOf,
  prepareUnifiedMercyBatch,
  applyUnifiedMercyBatch,
  undoUnifiedMercyBatch,
};
