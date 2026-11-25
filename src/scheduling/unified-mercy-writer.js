'use strict';

// Persistent Mercy batch coordination for the Unified writer (PR-09).
// Allocation stays in the accepted PR-04 Mercy core; this module only persists a
// batch, commits each topic through the synthetic CAS storage and supports
// partial retry/undo.

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { resolveSchedulerMode } = require('./mode.js');
const { renderContent } = require('./unified-store-contract.js');
const {
  assertTrustedTopicStorage,
  assertTrustedBatchStore,
  assertSyntheticUnifiedCapability,
} = require('./unified-store-contract.js');

const MERCY_BATCH_KIND = 'mf-us-1-unified-mercy-batch';

function assertUnifiedDeps(mode, capability, storage, batchStore) {
  const resolved = resolveSchedulerMode(mode);
  if (resolved.mode !== 'unified') fail('E_MODE_NOT_UNIFIED', 'mercy batch writing requires unified mode', {});
  assertSyntheticUnifiedCapability(capability);
  assertTrustedTopicStorage(storage);
  assertTrustedBatchStore(batchStore);
  return resolved;
}

function prepareUnifiedMercyBatch(plan, options = {}) {
  if (!plan || !Array.isArray(plan.items)) {
    fail('E_PLAN_INVALID', 'a Mercy preview result is required');
  }
  const batchId = options.batchId || plan.batchId;
  if (typeof batchId !== 'string' || !batchId) fail('E_BATCH_ID_REQUIRED', 'a batch id is required');
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
    }));
  return {
    kind: MERCY_BATCH_KIND,
    batchId,
    today: plan.today,
    algorithmVersion: ALGORITHM_VERSION,
    entries,
    status: entries.length ? 'planned' : 'noop',
    writesPerformed: false,
    counts: { attempted: 0, succeeded: 0, failed: 0, conflicts: 0, alreadyApplied: 0 },
  };
}

function applyUnifiedMercyBatch(batch, dependencies = {}) {
  assertUnifiedDeps(dependencies.mode, dependencies.capability, dependencies.storage, dependencies.batchStore);
  if (!batch || batch.kind !== MERCY_BATCH_KIND) fail('E_BATCH_INVALID', 'a Mercy batch is required');
  const persisted = dependencies.batchStore.get(batch.batchId);
  const working = persisted || JSON.parse(JSON.stringify(batch));
  const counts = { attempted: 0, succeeded: 0, failed: 0, conflicts: 0, alreadyApplied: 0 };

  for (const entry of working.entries) {
    if (entry.status === 'applied') {
      counts.alreadyApplied += 1;
      continue;
    }
    const located = dependencies.storage.findByTopicId(entry.topicId);
    if (located.duplicates.length > 0 || !located.entry) {
      entry.status = 'failed';
      entry.error = { code: located.duplicates.length ? 'E_DUPLICATE_TOPIC_ID' : 'E_TOPIC_NOT_FOUND' };
      counts.failed += 1;
      continue;
    }
    const current = located.entry;
    if (current.frontmatter.mf_not_before === entry.notBeforeAfter
      && current.revision === entry.revisionAfter) {
      entry.status = 'already-applied';
      counts.alreadyApplied += 1;
      continue;
    }
    if (current.revision !== entry.revisionBefore) {
      entry.status = 'conflict';
      entry.error = { code: 'E_REVISION_MISMATCH' };
      counts.conflicts += 1;
      continue;
    }

    const nextFrontmatter = {
      ...current.frontmatter,
      mf_not_before: entry.notBeforeAfter,
      mf_revision: entry.revisionAfter,
      mf_scheduler_version: ALGORITHM_VERSION,
    };
    counts.attempted += 1;
    const cas = dependencies.storage.compareAndSwap(current.path, {
      expectedHash: sha256(current.content),
      expectedRevision: current.revision,
      nextFrontmatter,
      nextBody: current.body,
      nextRevision: entry.revisionAfter,
    });
    if (!cas.ok) {
      entry.status = 'conflict';
      entry.error = { code: cas.code };
      counts.conflicts += 1;
      continue;
    }
    const readback = dependencies.storage.read(current.path);
    if (!readback || readback.frontmatter.mf_not_before !== entry.notBeforeAfter) {
      entry.status = 'uncertain';
      entry.error = { code: 'E_WRITE_UNVERIFIED' };
      counts.failed += 1;
      continue;
    }
    entry.status = 'applied';
    entry.error = null;
    counts.succeeded += 1;
  }

  const statuses = working.entries.map(entry => entry.status);
  if (counts.conflicts > 0) working.status = 'requires-manual-recovery';
  else if (statuses.every(status => status === 'applied' || status === 'already-applied')) working.status = 'applied';
  else if (statuses.some(status => status === 'applied' || status === 'already-applied')) working.status = 'partially-applied';
  else if (statuses.every(status => status === 'failed')) working.status = 'failed';
  else working.status = 'requires-manual-recovery';
  working.counts = counts;
  working.writesPerformed = counts.succeeded > 0;
  dependencies.batchStore.put(working.batchId, working);
  return { batch: working, counts, writesPerformed: working.writesPerformed };
}

function undoUnifiedMercyBatch(batch, dependencies = {}) {
  assertUnifiedDeps(dependencies.mode, dependencies.capability, dependencies.storage, dependencies.batchStore);
  if (!batch || batch.kind !== MERCY_BATCH_KIND) fail('E_BATCH_INVALID', 'a Mercy batch is required');
  const persisted = dependencies.batchStore.get(batch.batchId);
  const working = persisted || JSON.parse(JSON.stringify(batch));
  const counts = { rolledBack: 0, alreadyRolledBack: 0, conflicts: 0, failed: 0 };

  for (const entry of working.entries) {
    const located = dependencies.storage.findByTopicId(entry.topicId);
    if (located.duplicates.length > 0 || !located.entry) {
      entry.status = 'requires-manual-recovery';
      entry.error = { code: 'E_TOPIC_NOT_FOUND' };
      counts.failed += 1;
      continue;
    }
    const current = located.entry;
    if (current.frontmatter.mf_not_before === entry.notBeforeBefore) {
      entry.status = 'rolled-back';
      entry.error = null;
      counts.alreadyRolledBack += 1;
      continue;
    }
    if (current.revision !== entry.revisionAfter || current.frontmatter.mf_not_before !== entry.notBeforeAfter) {
      entry.status = 'conflict';
      entry.error = { code: 'E_EXTERNAL_EDIT' };
      counts.conflicts += 1;
      continue;
    }
    const nextRevision = entry.revisionAfter + 1;
    const nextFrontmatter = { ...current.frontmatter, mf_not_before: entry.notBeforeBefore, mf_revision: nextRevision };
    const cas = dependencies.storage.compareAndSwap(current.path, {
      expectedHash: sha256(current.content),
      expectedRevision: current.revision,
      nextFrontmatter,
      nextBody: current.body,
      nextRevision,
    });
    if (!cas.ok) {
      entry.status = 'failed';
      entry.error = { code: cas.code };
      counts.failed += 1;
      continue;
    }
    entry.status = 'rolled-back';
    entry.error = null;
    counts.rolledBack += 1;
  }

  const statuses = working.entries.map(entry => entry.status);
  if (counts.conflicts > 0) working.status = 'requires-manual-recovery';
  else if (statuses.every(status => status === 'rolled-back')) working.status = 'rolled-back';
  else if (statuses.some(status => status === 'rolled-back')) working.status = 'partially-rolled-back';
  else working.status = 'requires-manual-recovery';
  working.counts = counts;
  working.writesPerformed = counts.rolledBack > 0;
  dependencies.batchStore.put(working.batchId, working);
  return { batch: working, counts, writesPerformed: working.writesPerformed };
}

function sha256(content) {
  // Local import kept at the bottom to avoid a cycle-prone top import order.
  return require('./migration-hash.js').sha256Hex(content);
}

module.exports = {
  MERCY_BATCH_KIND,
  prepareUnifiedMercyBatch,
  applyUnifiedMercyBatch,
  undoUnifiedMercyBatch,
};
