'use strict';

// Migration execution, reconciliation and rollback on the module-registered
// MemoryStorage only (PR-08). A plain object with getFile/write cannot pass:
// the trust registry is a module-private WeakSet. Real Obsidian storage needs a
// separately reviewed adapter in a later PR.

const { fail, isSchedulingError } = require('./errors.js');
const { sha256Hex } = require('./migration-hash.js');
const { PLAN_KIND, planHashOf } = require('./migration-plan.js');
const { verifyMigrationBackup } = require('./migration-backup.js');
const { mergeFrontmatter } = require('./migration-frontmatter.js');
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
      const intent = planEntry
        ? makeIntent(entry.path, planEntry.fieldsToAdd, entry.content)
        : null;
      return {
        operationId: entry.operationId,
        index: entry.index,
        path: entry.path,
        beforeHash: entry.contentHash,
        afterHash: null,
        revision: entry.revision,
        status: 'pending',
        error: null,
        originalContent: entry.content,
        fields: { ...entry.fields },
        intent,
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

  const batch = createBatch(plan, backup);
  if (typeof backupStore.putBatch === 'function') backupStore.putBatch(batch);

  const planByPath = new Map(plan.entries.map(entry => [entry.path, entry]));
  const counts = { attempted: 0, succeeded: 0, failed: 0, alreadyApplied: 0, conflicts: 0, uncertain: 0 };

  for (const entry of batch.entries) {
    const planEntry = planByPath.get(entry.path);
    if (!planEntry || !intentIsValid(entry)) {
      entry.status = 'failed';
      entry.error = { code: 'E_INTENT_INVALID', message: 'the batch write intent is missing or inconsistent' };
      counts.failed += 1;
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

    // Recovery window: a pending entry may already hold the expected result.
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
        // The write may have landed; this is not reported as success or failure.
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
      if (item && typeof item.path === 'string' && typeof item.content === 'string') map.set(item.path, item.content);
    }
  } else if (currentSnapshots && typeof currentSnapshots === 'object') {
    for (const [path, value] of Object.entries(currentSnapshots)) {
      if (typeof value === 'string') map.set(path, value);
    }
  }
  return map;
}

function previewRollback(batch, currentSnapshots) {
  if (!batch || batch.kind !== BATCH_KIND) fail('E_BATCH_INVALID', 'a migration batch is required');
  const contents = contentMap(currentSnapshots);
  const results = batch.entries.map(entry => {
    const content = contents.get(entry.path);
    if (typeof content !== 'string') {
      return { path: entry.path, status: 'requires-manual-recovery', reason: 'CURRENT_FILE_MISSING' };
    }
    if (!intentIsValid(entry) && !entry.afterHash) {
      return { path: entry.path, status: 'requires-manual-recovery', reason: 'INTENT_INVALID' };
    }
    const hash = sha256Hex(content);
    const expectedAfterHash = expectedAfterHashOf(entry) || entry.afterHash;
    if (expectedAfterHash && hash === expectedAfterHash) return { path: entry.path, status: 'rollback-ready' };
    if (hash === entry.beforeHash) return { path: entry.path, status: 'already-rolled-back' };
    return { path: entry.path, status: 'conflict', reason: 'EXTERNAL_EDIT' };
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

function rollbackMigration(batch, storage, authorization) {
  if (!batch || batch.kind !== BATCH_KIND) fail('E_BATCH_INVALID', 'a migration batch is required');
  assertTrustedStorage(storage);
  assertMemoryAuthorization(authorization);

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
    const expectedAfterHash = expectedAfterHashOf(entry) || entry.afterHash;
    if (!expectedAfterHash || hash !== expectedAfterHash) {
      next.status = 'conflict';
      next.error = { code: 'E_EXTERNAL_EDIT', message: 'the file changed after migration; rollback refused' };
      counts.conflicts += 1;
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
