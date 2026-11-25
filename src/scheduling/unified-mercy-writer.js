'use strict';

// Persistent Mercy batch coordination for the Unified writer (PR-09).
// Allocation stays in the accepted PR-04 Mercy core; this module validates the
// confirmed preview, persists write intents before CAS, and supports partial
// retry/undo. Every write targets a persisted Source/Extract UUID only.

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { isValidDateString } = require('./dates.js');
const { isPersistentUuid } = require('./legacy-identity.js');
const { resolveSchedulerMode } = require('./mode.js');
const { sha256Hex, stableStringify } = require('./migration-hash.js');
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

function validateBatch(batch) {
  if (!batch || batch.kind !== MERCY_BATCH_KIND) fail('E_BATCH_INVALID', 'a Mercy batch is required');
  if (typeof batch.batchId !== 'string' || !batch.batchId) fail('E_BATCH_ID_REQUIRED', 'a batch id is required');
  if (!isValidDateString(batch.today)) fail('E_BATCH_TODAY_INVALID', 'batch today must be a calendar date');
  if (batch.algorithmVersion !== ALGORITHM_VERSION) fail('E_BATCH_VERSION_INVALID', 'unsupported algorithm version');
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

function assertTopic(entry) {
  const frontmatter = entry.frontmatter || {};
  if (frontmatter.mf_id !== entry.mfId) return 'E_INDEX_ID_MISMATCH';
  if (frontmatter.type !== 'source' && frontmatter.type !== 'extract') return 'E_TOPIC_TYPE';
  if (frontmatter.status !== 'active') return 'E_TOPIC_NOT_ACTIVE';
  if (frontmatter.mf_scheduler_version !== ALGORITHM_VERSION) return 'E_VERSION_NOT_PERSISTED';
  if (!Number.isInteger(frontmatter.mf_revision)) return 'E_REVISION_NOT_PERSISTED';
  return null;
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
  const batch = {
    kind: MERCY_BATCH_KIND,
    batchId,
    today: plan.today,
    algorithmVersion: ALGORITHM_VERSION,
    entries,
    status: entries.length ? 'planned' : 'noop',
    writesPerformed: false,
    counts: { attempted: 0, succeeded: 0, failed: 0, conflicts: 0, alreadyApplied: 0 },
  };
  batch.previewDigest = digestOf(batch);
  validateBatch(batch);
  return batch;
}

function loadPersistedBatch(batch, batchStore) {
  const persisted = batchStore.get(batch.batchId);
  if (!persisted) return { working: batch, persisted: false };
  if (persisted.previewDigest !== digestOf(batch) || digestOf(persisted) !== digestOf(batch)) {
    fail('E_BATCH_ID_CONFLICT', 'the batch id is already used by a different confirmed batch', { batchId: batch.batchId });
  }
  return { working: persisted, persisted: true };
}

function targetEntry(batch, entry, storage) {
  const located = storage.findByTopicId(entry.topicId);
  if (located.duplicates.length > 0) return { error: 'E_DUPLICATE_TOPIC_ID' };
  if (!located.entry) return { error: 'E_TOPIC_NOT_FOUND' };
  const topicError = assertTopic(located.entry);
  if (topicError) return { error: topicError };
  return { current: located.entry };
}

function applyUnifiedMercyBatch(batch, dependencies = {}) {
  resolveDeps(dependencies);
  validateBatch(batch);
  assertSyntheticMercyConfirmation(dependencies.confirmation, batch.batchId);
  const { working } = loadPersistedBatch(batch, dependencies.batchStore);
  if (working.status === 'rolled-back' || working.status === 'partially-rolled-back') {
    fail('E_BATCH_ALREADY_ROLLED_BACK', 'a rolled-back batch cannot be applied again');
  }

  // Persist the confirmed batch and per-entry intents BEFORE any write.
  for (const entry of working.entries) {
    if (entry.status === 'applied' || entry.status === 'already-applied') continue;
    if (entry.status === 'conflict' && entry.intent) continue;
    const target = targetEntry(working, entry, dependencies.storage);
    if (target.error) {
      entry.status = 'failed';
      entry.error = { code: target.error };
      entry.intent = null;
      continue;
    }
    const current = target.current;
    const frontmatter = current.frontmatter;
    entry.intent = {
      topicId: entry.topicId,
      path: current.path,
      beforeHash: sha256Hex(current.content),
      expectedAfterHash: sha256Hex(renderContent({
        ...frontmatter,
        mf_not_before: entry.notBeforeAfter,
        mf_revision: entry.revisionAfter,
        mf_scheduler_version: ALGORITHM_VERSION,
      }, current.body)),
      beforeNotBefore: entry.notBeforeBefore,
      afterNotBefore: entry.notBeforeAfter,
      beforeRevision: entry.revisionBefore,
      afterRevision: entry.revisionAfter,
    };
    entry.status = 'pending';
    entry.error = null;
  }
  working.status = 'applying';
  dependencies.batchStore.put(working.batchId, working);

  const counts = { attempted: 0, succeeded: 0, failed: 0, conflicts: 0, alreadyApplied: 0, uncertain: 0 };
  for (const entry of working.entries) {
    if (entry.status === 'applied' || entry.status === 'already-applied') {
      const located = dependencies.storage.findByTopicId(entry.topicId);
      if (located.duplicates.length > 0 || !located.entry) {
        entry.status = 'failed';
        entry.error = { code: 'E_TOPIC_NOT_FOUND' };
        counts.failed += 1;
        dependencies.batchStore.put(working.batchId, working);
        continue;
      }
      if (located.entry.frontmatter.mf_not_before !== entry.notBeforeAfter
        || located.entry.frontmatter.mf_revision !== entry.revisionAfter) {
        entry.status = 'conflict';
        entry.error = { code: 'E_EXTERNAL_EDIT' };
        counts.conflicts += 1;
        dependencies.batchStore.put(working.batchId, working);
        continue;
      }
      counts.alreadyApplied += 1;
      continue;
    }
    if (entry.status === 'failed' || entry.status === 'conflict') {
      if (entry.status === 'conflict') counts.conflicts += 1;
      else counts.failed += 1;
      continue;
    }
    if (!entry.intent) {
      entry.status = 'failed';
      entry.error = { code: 'E_INTENT_MISSING' };
      counts.failed += 1;
      continue;
    }

    const located = dependencies.storage.findByTopicId(entry.topicId);
    if (located.duplicates.length > 0 || !located.entry) {
      entry.status = 'failed';
      entry.error = { code: located.duplicates.length ? 'E_DUPLICATE_TOPIC_ID' : 'E_TOPIC_NOT_FOUND' };
      counts.failed += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    const current = located.entry;
    const hash = sha256Hex(current.content);
    const frontmatter = current.frontmatter;

    if (hash === entry.intent.expectedAfterHash
      && frontmatter.mf_not_before === entry.notBeforeAfter
      && frontmatter.mf_revision === entry.revisionAfter) {
      entry.status = 'applied';
      entry.error = null;
      counts.alreadyApplied += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (hash !== entry.intent.beforeHash
      || frontmatter.mf_not_before !== entry.notBeforeBefore
      || frontmatter.mf_revision !== entry.revisionBefore) {
      entry.status = 'conflict';
      entry.error = { code: 'E_PREVIEW_STALE' };
      counts.conflicts += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }

    counts.attempted += 1;
    const cas = dependencies.storage.compareAndSwap(current.path, {
      expectedHash: hash,
      expectedRevision: entry.revisionBefore,
      nextFrontmatter: {
        ...frontmatter,
        mf_not_before: entry.notBeforeAfter,
        mf_revision: entry.revisionAfter,
        mf_scheduler_version: ALGORITHM_VERSION,
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
  assertSyntheticMercyConfirmation(dependencies.confirmation, batch.batchId);
  const { working } = loadPersistedBatch(batch, dependencies.batchStore);
  if (working.status === 'rolled-back') {
    return {
      batch: working,
      counts: { rolledBack: 0, alreadyRolledBack: working.entries.length, conflicts: 0, failed: 0, uncertain: 0 },
      writesPerformed: false,
    };
  }
  if (!['applied', 'partially-applied', 'partially-rolled-back', 'requires-manual-recovery'].includes(working.status)) {
    fail('E_BATCH_NOT_APPLIED', 'only an applied batch can be undone');
  }

  const counts = { rolledBack: 0, alreadyRolledBack: 0, conflicts: 0, failed: 0, uncertain: 0 };
  for (const entry of working.entries) {
    if (!['applied', 'already-applied', 'rolled-back', 'conflict', 'uncertain', 'failed'].includes(entry.status)) continue;
    if (entry.status === 'rolled-back') {
      counts.alreadyRolledBack += 1;
      continue;
    }
    if (entry.status === 'conflict') {
      counts.conflicts += 1;
      continue;
    }
    const located = dependencies.storage.findByTopicId(entry.topicId);
    if (located.duplicates.length > 0 || !located.entry) {
      entry.status = 'requires-manual-recovery';
      entry.error = { code: 'E_TOPIC_NOT_FOUND' };
      counts.failed += 1;
      continue;
    }
    const current = located.entry;
    const frontmatter = current.frontmatter;
    if (frontmatter.mf_not_before === entry.notBeforeBefore) {
      entry.status = 'rolled-back';
      entry.error = null;
      counts.alreadyRolledBack += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }
    if (frontmatter.mf_not_before !== entry.notBeforeAfter || frontmatter.mf_revision !== entry.revisionAfter) {
      entry.status = 'conflict';
      entry.error = { code: 'E_EXTERNAL_EDIT' };
      counts.conflicts += 1;
      dependencies.batchStore.put(working.batchId, working);
      continue;
    }

    entry.undoIntent = {
      beforeHash: sha256Hex(current.content),
      expectedRestoredHash: sha256Hex(renderContent({
        ...frontmatter,
        mf_not_before: entry.notBeforeBefore,
        mf_revision: entry.revisionAfter + 1,
      }, current.body)),
    };
    dependencies.batchStore.put(working.batchId, working);
    const cas = dependencies.storage.compareAndSwap(current.path, {
      expectedHash: entry.undoIntent.beforeHash,
      expectedRevision: entry.revisionAfter,
      nextFrontmatter: {
        ...frontmatter,
        mf_not_before: entry.notBeforeBefore,
        mf_revision: entry.revisionAfter + 1,
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
    if (!readback || readback.frontmatter.mf_not_before !== entry.notBeforeBefore) {
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
  else if (statuses.every(status => status === 'rolled-back')) working.status = 'rolled-back';
  else if (statuses.some(status => status === 'rolled-back')) working.status = 'partially-rolled-back';
  else working.status = 'requires-manual-recovery';
  working.counts = counts;
  working.writesPerformed = counts.rolledBack > 0;
  dependencies.batchStore.put(working.batchId, working);
  return { batch: working, counts, writesPerformed: working.writesPerformed };
}

module.exports = {
  MERCY_BATCH_KIND,
  prepareUnifiedMercyBatch,
  applyUnifiedMercyBatch,
  undoUnifiedMercyBatch,
};
