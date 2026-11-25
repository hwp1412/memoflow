'use strict';

// Migration execution, reconciliation and rollback on the module-registered
// MemoryStorage only (PR-08). A plain object with getFile/write cannot pass:
// the trust registry is a module-private WeakSet.

const { fail, isSchedulingError } = require('./errors.js');
const { sha256Hex, stableStringify } = require('./migration-hash.js');
const { PLAN_KIND, planHashOf } = require('./migration-plan.js');
const {
  BACKUP_KIND,
  verifyMigrationBackup,
  verifyPlanBackupCorrespondence,
} = require('./migration-backup.js');
const { mergeFrontmatter, assertAddOnly } = require('./migration-frontmatter.js');
const { assertTrustedStorage, assertTrustedBackupStore } = require('./migration-storage.js');

const BATCH_KIND = 'mf-us-1-migration-batch';

function assertMemoryAuthorization(authorization) {
  if (!authorization || authorization.environment !== 'memory' || authorization.authorized !== true) {
    fail('E_MIGRATION_UNAUTHORIZED', 'migration requires an explicit memory-environment authorization', {
      environment: authorization ? authorization.environment : null,
    });
  }
  if (authorization.mode === 'unified') {
    fail('E_UNIFIED_NOT_AUTHORIZED', 'unified writes are not enabled by the migration executor');
  }
  return authorization;
}

function assertPlanIntegrity(plan) {
  if (!plan || plan.kind !== PLAN_KIND || typeof plan.planId !== 'string') {
    fail('E_PLAN_INVALID', 'a valid migration plan is required', { field: 'plan' });
  }
  if (planHashOf(plan) !== plan.planId) {
    fail('E_PLAN_TAMPERED', 'the migration plan does not match its plan hash');
  }
  return plan;
}

function bumpRevision(revision) {
  return Number.isInteger(revision) ? revision + 1 : revision ?? null;
}

function makeIntent(path, fields, originalContent) {
  // Migration is add-only: refuse to overwrite a field that already exists.
  assertAddOnly(originalContent, fields);
  const expectedContent = mergeFrontmatter(originalContent, fields);
  return {
    path,
    fields: { ...fields },
    expectedContent,
    expectedAfterHash: sha256Hex(expectedContent),
  };
}

function intentIsValid(entry) {
  const intent = entry && entry.intent;
  return Boolean(
    intent
    && intent.path === entry.path
    && typeof intent.expectedContent === 'string'
    && typeof intent.expectedAfterHash === 'string'
    && sha256Hex(intent.expectedContent) === intent.expectedAfterHash
  );
}

function expectedAfterHashOf(entry) {
  return intentIsValid(entry) ? entry.intent.expectedAfterHash : null;
}

function createBatch(plan, backup) {
  return {
    kind: BATCH_KIND,
    batchId: backup.batchId,
    planId: plan.planId,
    status: 'pending',
    environment: 'memory',
    entries: backup.entries.map(entry => {
      const planEntry = plan.entries.find(candidate => candidate.path === entry.path);
      let intent = null;
      let intentError = null;
      if (planEntry) {
        try {
          intent = makeIntent(entry.path, planEntry.fieldsToAdd, entry.content);
        } catch (error) {
          intentError = { code: error.code || 'E_INTENT_INVALID', message: error.message || 'intent failed' };
        }
      }
      return {
        operationId: entry.operationId,
        index: entry.index,
        path: entry.path,
        beforeHash: entry.contentHash,
        afterHash: null,
        revision: entry.revision,
        status: 'pending',
        error: null,
        intent,
        intentError,
        originalContent: entry.content,
        fields: { ...entry.fields },
      };
    }),
    writesPerformed: false,
    writeOutcome: 'none',
    counts: null,
  };
}

function summaryOfBatch(batch) {
  const statuses = batch.entries.map(entry => entry.status);
  const uncertain = statuses.filter(status => status === 'uncertain').length;
  if (uncertain > 0) return 'requires-manual-recovery';
  if (statuses.every(status => status === 'applied' || status === 'already-applied')) return 'applied';
  if (statuses.some(status => status === 'applied' || status === 'already-applied')) return 'partially-applied';
  return 'failed';
}

function expectedRevisionAfter(beforeRevision) {
  return Number.isInteger(beforeRevision) ? beforeRevision + 1 : null;
}

function executeMigration(plan, storage, authorization, backupStore) {
  assertPlanIntegrity(plan);
  assertTrustedStorage(storage);
  assertTrustedBackupStore(backupStore);
  assertMemoryAuthorization(authorization);

  const batchId = authorization.batchId;
  if (!batchId) fail('E_MIGRATION_UNAUTHORIZED', 'authorization must name the migration batch');
  const backup = backupStore.get(batchId);
  if (!backup) fail('E_BACKUP_MISSING', `no backup found for batch ${batchId}`);
  if (backup.planId !== plan.planId) fail('E_BACKUP_PLAN_MISMATCH', 'the backup belongs to another plan');
  const verification = verifyMigrationBackup(backup);
  if (!verification.verified) {
    fail('E_BACKUP_CORRUPT', 'the backup failed its integrity check', { errors: verification.errors });
  }
  const correspondence = verifyPlanBackupCorrespondence(plan, backup);
  if (!correspondence.valid) {
    fail('E_BACKUP_PLAN_MISMATCH', 'the backup does not correspond to the executable plan', { errors: correspondence.errors });
  }

  const batch = createBatch(plan, backup);
  if (typeof backupStore.putBatch === 'function') backupStore.putBatch(batch);

  const planByPath = new Map(plan.entries.map(entry => [entry.path, entry]));
  const counts = { attempted: 0, succeeded: 0, failed: 0, alreadyApplied: 0, conflicts: 0, uncertain: 0 };

  for (const entry of batch.entries) {
    const planEntry = planByPath.get(entry.path);
    if (!planEntry || !intentIsValid(entry)) {
      if (entry.intentError && entry.intentError.code === 'E_FIELD_ALREADY_PRESENT') {
        entry.status = 'conflict';
        counts.conflicts += 1;
      } else {
        entry.status = 'failed';
        counts.failed += 1;
      }
      entry.error = entry.intentError || { code: 'E_INTENT_INVALID', message: 'the batch write intent is missing or inconsistent' };
      continue;
    }

    const current = storage.getFile(entry.path);
    if (!current) {
      entry.status = 'failed';
      entry.error = { code: 'E_FILE_MISSING', message: 'the file disappeared before migration' };
      counts.failed += 1;
      continue;
    }

    const currentHash = sha256Hex(current.content);
    const expectedAfterHash = entry.intent.expectedAfterHash;

    if (currentHash === expectedAfterHash) {
      entry.status = 'already-applied';
      entry.afterHash = expectedAfterHash;
      counts.alreadyApplied += 1;
      continue;
    }
    if (currentHash !== entry.beforeHash) {
      entry.status = 'conflict';
      entry.error = { code: 'E_EXTERNAL_EDIT', message: 'the file changed after the backup was taken' };
      counts.conflicts += 1;
      continue;
    }
    if (planEntry.revision != null) {
      if (current.revision == null) {
        entry.status = 'conflict';
        entry.error = { code: 'E_REVISION_UNAVAILABLE', message: 'the storage cannot prove the preview revision' };
        counts.conflicts += 1;
        continue;
      }
      if (current.revision !== planEntry.revision) {
        entry.status = 'conflict';
        entry.error = { code: 'E_REVISION_MISMATCH', message: 'the persisted revision changed after preview' };
        counts.conflicts += 1;
        continue;
      }
    }

    counts.attempted += 1;
    try {
      storage.write(entry.path, entry.intent.expectedContent, bumpRevision(current.revision));
      const written = storage.getFile(entry.path);
      if (!written || written.content !== entry.intent.expectedContent) {
        throw new Error('written content did not verify');
      }
      entry.status = 'applied';
      entry.afterHash = expectedAfterHash;
      counts.succeeded += 1;
    } catch (error) {
      const code = isSchedulingError(error) ? error.code : 'E_WRITE_UNVERIFIED';
      if (code === 'E_STORAGE_WRITE_FAILED') {
        entry.status = 'failed';
        counts.failed += 1;
      } else {
        entry.status = 'uncertain';
        counts.uncertain += 1;
      }
      entry.error = { code, message: error && error.message ? error.message : 'write outcome is unknown' };
    }
  }

  batch.status = summaryOfBatch(batch);
  batch.counts = counts;
  batch.writesPerformed = counts.succeeded > 0;
  batch.writeOutcome = counts.uncertain > 0 ? 'uncertain' : (counts.succeeded > 0 ? 'committed' : 'none');
  if (typeof backupStore.putBatch === 'function') backupStore.putBatch(batch);

  return {
    batch,
    counts,
    environment: 'memory',
    verified: true,
    writesPerformed: batch.writesPerformed,
    writeOutcome: batch.writeOutcome,
  };
}

function contentMap(currentSnapshots) {
  const map = new Map();
  if (Array.isArray(currentSnapshots)) {
    for (const item of currentSnapshots) {
      if (!item || typeof item.path !== 'string') continue;
      if (typeof item.content === 'string') map.set(item.path, { content: item.content, revision: item.revision ?? null });
    }
  } else if (currentSnapshots && typeof currentSnapshots === 'object') {
    for (const [path, value] of Object.entries(currentSnapshots)) {
      if (typeof value === 'string') map.set(path, { content: value, revision: null });
      else if (value && typeof value.content === 'string') map.set(path, { content: value.content, revision: value.revision ?? null });
    }
  }
  return map;
}

// A rollback may only use a batch whose entries still match a verified backup.
function validateRollbackSource(batch, backup, authorization) {
  if (!backup || backup.kind !== BACKUP_KIND) fail('E_BACKUP_INVALID', 'a verified backup is required for rollback');
  if (authorization && authorization.batchId && batch.batchId !== authorization.batchId) {
    fail('E_BATCH_MISMATCH', 'authorization names another batch');
  }
  if (backup.batchId !== batch.batchId) fail('E_BATCH_MISMATCH', 'the backup belongs to another batch');
  if (backup.planId !== batch.planId) fail('E_BACKUP_PLAN_MISMATCH', 'the backup belongs to another plan');
  const verification = verifyMigrationBackup(backup);
  if (!verification.verified) fail('E_BACKUP_CORRUPT', 'the backup failed its integrity check', { errors: verification.errors });
  if (backup.entries.length !== batch.entries.length) {
    fail('E_BACKUP_MISMATCH', 'the batch does not cover the same entries as the backup');
  }

  const byOperation = new Map();
  for (const entry of backup.entries) {
    if (byOperation.has(entry.operationId)) fail('E_BACKUP_DUPLICATE_OPERATION', 'duplicate operation id in backup');
    byOperation.set(entry.operationId, entry);
  }

  const seenOperations = new Set();
  const seenPaths = new Set();
  for (const entry of batch.entries) {
    if (seenOperations.has(entry.operationId)) fail('E_BATCH_DUPLICATE_OPERATION', 'duplicate operation id in batch');
    seenOperations.add(entry.operationId);
    if (seenPaths.has(entry.path)) fail('E_BATCH_DUPLICATE_PATH', 'duplicate path in batch');
    seenPaths.add(entry.path);

    const source = byOperation.get(entry.operationId);
    if (!source) fail('E_BACKUP_ENTRY_MISSING', 'batch entry has no backup source');
    if (source.path !== entry.path) fail('E_BACKUP_PATH_MISMATCH', 'batch path does not match the backup');
    if (source.contentHash !== entry.beforeHash) fail('E_BACKUP_HASH_MISMATCH', 'batch beforeHash does not match the backup');
    if (sha256Hex(source.content) !== source.contentHash) fail('E_BACKUP_CORRUPT', 'backup content hash mismatch');
    if (source.content !== entry.originalContent) fail('E_BATCH_TAMPERED', 'batch original content does not match the backup');
    if (stableStringify(source.fields) !== stableStringify(entry.fields)) fail('E_BACKUP_FIELDS_MISMATCH', 'batch fields do not match the backup');
    if (sha256Hex(entry.originalContent) !== entry.beforeHash) fail('E_BATCH_TAMPERED', 'batch original content fails its own hash');

    // The intent must be derivable from the trusted backup, not merely
    // self-consistent: recompute it from the backup content and fields.
    let recomputed;
    try {
      recomputed = makeIntent(entry.path, source.fields, source.content);
    } catch (error) {
      fail('E_INTENT_INVALID', 'the stored intent cannot be recomputed from the backup', { reason: error.code || null });
    }
    if (!entry.intent || entry.intent.path !== entry.path) fail('E_INTENT_INVALID', 'intent path is missing or wrong');
    if (stableStringify(entry.intent.fields) !== stableStringify(source.fields)) {
      fail('E_INTENT_FIELDS_MISMATCH', 'intent fields do not match the approved backup fields');
    }
    if (entry.intent.expectedContent !== recomputed.expectedContent) {
      fail('E_INTENT_CONTENT_MISMATCH', 'intent content does not match the trusted backup-derived content');
    }
    if (entry.intent.expectedAfterHash !== recomputed.expectedAfterHash) {
      fail('E_INTENT_HASH_MISMATCH', 'intent hash does not match the trusted backup-derived hash');
    }
  }

  for (const operationId of byOperation.keys()) {
    if (!seenOperations.has(operationId)) fail('E_BACKUP_ENTRY_UNUSED', 'a backup entry is not covered by the batch');
  }
  return backup;
}

function revisionAllowsRollback(entry, snapshot) {
  if (entry.revision == null) return { ok: true };
  if (snapshot.revision == null) return { ok: false, status: 'requires-manual-recovery', reason: 'E_REVISION_UNAVAILABLE' };
  if (snapshot.revision !== expectedRevisionAfter(entry.revision)) {
    return { ok: false, status: 'conflict', reason: 'E_REVISION_MISMATCH' };
  }
  return { ok: true };
}

function previewRollback(batch, currentSnapshots, backupStore) {
  if (!batch || batch.kind !== BATCH_KIND) fail('E_BATCH_INVALID', 'a migration batch is required');
  assertTrustedBackupStore(backupStore);
  const backup = backupStore.get(batch.batchId);
  if (!backup) fail('E_BACKUP_MISSING', `no backup found for batch ${batch.batchId}`);
  validateRollbackSource(batch, backup, { batchId: batch.batchId });

  const contents = contentMap(currentSnapshots);
  const results = batch.entries.map(entry => {
    const snapshot = contents.get(entry.path);
    if (!snapshot) {
      return { path: entry.path, status: 'requires-manual-recovery', reason: 'CURRENT_FILE_MISSING' };
    }
    const hash = sha256Hex(snapshot.content);
    if (hash === entry.beforeHash) return { path: entry.path, status: 'already-rolled-back' };
    const expectedAfter = expectedAfterHashOf(entry) || entry.afterHash;
    if (!expectedAfter || hash !== expectedAfter) return { path: entry.path, status: 'conflict', reason: 'EXTERNAL_EDIT' };
    const revision = revisionAllowsRollback(entry, snapshot);
    if (!revision.ok) return { path: entry.path, status: revision.status, reason: revision.reason };
    return { path: entry.path, status: 'rollback-ready' };
  });

  const summary = {
    total: results.length,
    rollbackReady: results.filter(result => result.status === 'rollback-ready').length,
    alreadyRolledBack: results.filter(result => result.status === 'already-rolled-back').length,
    conflict: results.filter(result => result.status === 'conflict').length,
    requiresManualRecovery: results.filter(result => result.status === 'requires-manual-recovery').length,
  };
  return { batchId: batch.batchId, planId: batch.planId, results, summary, writesPerformed: false };
}

function rollbackMigration(batch, storage, authorization, backupStore) {
  if (!batch || batch.kind !== BATCH_KIND) fail('E_BATCH_INVALID', 'a migration batch is required');
  assertTrustedStorage(storage);
  assertMemoryAuthorization(authorization);
  assertTrustedBackupStore(backupStore);
  if (authorization.batchId !== batch.batchId) fail('E_BATCH_MISMATCH', 'authorization names another batch');
  const backup = backupStore.get(batch.batchId);
  if (!backup) fail('E_BACKUP_MISSING', `no backup found for batch ${batch.batchId}`);
  validateRollbackSource(batch, backup, authorization);

  const counts = { attempted: 0, succeeded: 0, alreadyRolledBack: 0, conflicts: 0, failed: 0, uncertain: 0 };
  const entries = batch.entries.map(entry => {
    const next = { ...entry };
    const current = storage.getFile(entry.path);
    if (!current) {
      next.status = 'requires-manual-recovery';
      next.error = { code: 'E_FILE_MISSING', message: 'the file is missing during rollback' };
      return next;
    }
    const hash = sha256Hex(current.content);
    if (hash === entry.beforeHash) {
      next.status = 'rolled-back';
      next.error = null;
      counts.alreadyRolledBack += 1;
      return next;
    }
    const expectedAfter = expectedAfterHashOf(entry) || entry.afterHash;
    if (!expectedAfter || hash !== expectedAfter) {
      next.status = 'conflict';
      next.error = { code: 'E_EXTERNAL_EDIT', message: 'the file changed after migration; rollback refused' };
      counts.conflicts += 1;
      return next;
    }
    const revision = revisionAllowsRollback(entry, { content: current.content, revision: current.revision });
    if (!revision.ok) {
      next.status = revision.status;
      next.error = { code: revision.reason, message: 'the post-migration revision cannot be confirmed' };
      if (revision.status === 'conflict') counts.conflicts += 1;
      return next;
    }
    if (sha256Hex(entry.originalContent) !== entry.beforeHash) {
      next.status = 'requires-manual-recovery';
      next.error = { code: 'E_BATCH_TAMPERED', message: 'the stored original content fails its own hash' };
      return next;
    }

    counts.attempted += 1;
    try {
      storage.write(entry.path, entry.originalContent, entry.revision ?? null);
      const restored = storage.getFile(entry.path);
      if (!restored || sha256Hex(restored.content) !== entry.beforeHash) {
        throw new Error('restored content did not verify');
      }
      next.status = 'rolled-back';
      next.error = null;
      counts.succeeded += 1;
    } catch (error) {
      const code = isSchedulingError(error) ? error.code : 'E_WRITE_UNVERIFIED';
      if (code === 'E_STORAGE_WRITE_FAILED') {
        next.status = 'failed';
        counts.failed += 1;
      } else {
        next.status = 'uncertain';
        counts.uncertain += 1;
      }
      next.error = { code, message: error && error.message ? error.message : 'rollback outcome is unknown' };
    }
    return next;
  });

  const statuses = entries.map(entry => entry.status);
  let status;
  if (counts.uncertain > 0) status = 'requires-manual-recovery';
  else if (statuses.every(value => value === 'rolled-back')) status = 'rolled-back';
  else if (statuses.some(value => value === 'rolled-back')) status = 'partially-rolled-back';
  else status = 'requires-manual-recovery';

  const writesPerformed = counts.succeeded > 0;
  return {
    batch: {
      ...batch,
      entries,
      status,
      writesPerformed,
      writeOutcome: counts.uncertain > 0 ? 'uncertain' : (writesPerformed ? 'committed' : 'none'),
      counts,
    },
    environment: 'memory',
    writesPerformed,
    writeOutcome: counts.uncertain > 0 ? 'uncertain' : (writesPerformed ? 'committed' : 'none'),
    summary: {
      total: entries.length,
      rolledBack: statuses.filter(value => value === 'rolled-back').length,
      conflict: counts.conflicts,
      failed: counts.failed,
      uncertain: counts.uncertain,
      requiresManualRecovery: statuses.filter(value => value === 'requires-manual-recovery').length,
    },
    counts,
  };
}

function reconcileMigrationBatch(batch, storage) {
  if (!batch || batch.kind !== BATCH_KIND) fail('E_BATCH_INVALID', 'a migration batch is required');
  assertTrustedStorage(storage);

  const entries = batch.entries.map(entry => {
    if (!intentIsValid(entry)) {
      return {
        ...entry,
        status: 'requires-manual-recovery',
        error: { code: 'E_INTENT_INVALID', message: 'the stored write intent is inconsistent with this batch' },
      };
    }
    const current = storage.getFile(entry.path);
    if (!current) {
      return { ...entry, status: 'requires-manual-recovery', error: { code: 'E_FILE_MISSING', message: 'file missing during reconciliation' } };
    }
    const hash = sha256Hex(current.content);
    if (hash === entry.intent.expectedAfterHash) return { ...entry, status: 'applied', afterHash: entry.intent.expectedAfterHash, error: null };
    if (hash === entry.beforeHash) {
      const status = entry.status === 'rolled-back' ? 'rolled-back' : 'pending';
      return { ...entry, status, error: null };
    }
    return { ...entry, status: 'conflict', error: { code: 'E_EXTERNAL_EDIT', message: 'content matches neither before nor after state' } };
  });

  const statuses = entries.map(entry => entry.status);
  let status;
  if (statuses.some(value => value === 'requires-manual-recovery')) status = 'requires-manual-recovery';
  else if (statuses.every(value => value === 'applied')) status = 'applied';
  else if (statuses.some(value => value === 'applied')) status = 'partially-applied';
  else if (statuses.every(value => value === 'rolled-back')) status = 'rolled-back';
  else if (statuses.some(value => value === 'rolled-back')) status = 'partially-rolled-back';
  else if (statuses.some(value => value === 'conflict')) status = 'requires-manual-recovery';
  else status = 'pending';

  return {
    batch: { ...batch, entries, status },
    summary: {
      applied: statuses.filter(value => value === 'applied').length,
      pending: statuses.filter(value => value === 'pending').length,
      rolledBack: statuses.filter(value => value === 'rolled-back').length,
      conflict: statuses.filter(value => value === 'conflict').length,
      requiresManualRecovery: statuses.filter(value => value === 'requires-manual-recovery').length,
    },
  };
}

module.exports = {
  BATCH_KIND,
  executeMigration,
  previewRollback,
  rollbackMigration,
  reconcileMigrationBatch,
};
