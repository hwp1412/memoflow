'use strict';

// Migration execution, rollback and reconciliation on INJECTED memory storage
// only (PR-08). There is no real-vault path here: a caller cannot unlock a real
// environment with authorized=true, and Unified writes stay refused.

const { fail, isSchedulingError } = require('./errors.js');
const { sha256Hex } = require('./migration-hash.js');
const { PLAN_KIND, planHashOf } = require('./migration-plan.js');
const { verifyMigrationBackup } = require('./migration-backup.js');

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

function assertStorage(storage) {
  if (!storage || typeof storage.getFile !== 'function' || typeof storage.write !== 'function') {
    fail('E_STORAGE_INVALID', 'migration requires an injected storage with getFile/write');
  }
  return storage;
}

function serializeValue(value) {
  if (value === null) return 'null';
  return String(value);
}

// Update only the approved frontmatter keys; every other line and the body are
// preserved byte for byte.
function mergeFrontmatter(content, fields) {
  const text = String(content);
  const lines = text.split('\n');
  const rendered = new Map(Object.entries(fields).map(([key, value]) => [key, `${key}: ${serializeValue(value)}`]));

  if (lines[0] === '---') {
    let end = -1;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index] === '---') {
        end = index;
        break;
      }
    }
    if (end > 0) {
      const frontmatter = lines.slice(1, end);
      const applied = new Set();
      const next = frontmatter.map(line => {
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
        if (!match || !rendered.has(match[1])) return line;
        applied.add(match[1]);
        return rendered.get(match[1]);
      });
      for (const [key, line] of rendered) {
        if (!applied.has(key)) next.push(line);
      }
      return [lines[0], ...next, ...lines.slice(end)].join('\n');
    }
  }

  return ['---', ...rendered.values(), '---', ...lines].join('\n');
}

function bumpRevision(revision) {
  return Number.isInteger(revision) ? revision + 1 : revision ?? null;
}

function createBatch(plan, backup) {
  return {
    kind: BATCH_KIND,
    batchId: backup.batchId,
    planId: plan.planId,
    status: 'pending',
    environment: 'memory',
    entries: backup.entries.map(entry => ({
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
    })),
    writesPerformed: false,
  };
}

function executeMigration(plan, storage, authorization, backupStore) {
  assertPlanIntegrity(plan);
  assertStorage(storage);
  assertMemoryAuthorization(authorization);
  if (!backupStore || typeof backupStore.get !== 'function') {
    fail('E_BACKUP_STORE_REQUIRED', 'migration requires a backup store');
  }
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
  const planByPath = new Map(plan.entries.map(entry => [entry.path, entry]));

  for (const entry of batch.entries) {
    const planEntry = planByPath.get(entry.path);
    const current = storage.getFile(entry.path);
    if (!planEntry) {
      entry.status = 'failed';
      entry.error = { code: 'E_PLAN_ENTRY_MISSING', message: 'plan entry missing for backup entry' };
      continue;
    }
    if (!current) {
      entry.status = 'failed';
      entry.error = { code: 'E_FILE_MISSING', message: 'the file disappeared before migration' };
      continue;
    }

    const currentHash = sha256Hex(current.content);
    const expectedContent = mergeFrontmatter(entry.originalContent, planEntry.fieldsToAdd);
    const expectedHash = sha256Hex(expectedContent);

    if (currentHash === expectedHash) {
      entry.status = 'already-applied';
      entry.afterHash = expectedHash;
      continue;
    }
    if (currentHash !== entry.beforeHash) {
      entry.status = 'conflict';
      entry.error = { code: 'E_EXTERNAL_EDIT', message: 'the file changed after the backup was taken' };
      continue;
    }
    if (planEntry.revision != null && current.revision != null && current.revision !== planEntry.revision) {
      entry.status = 'conflict';
      entry.error = { code: 'E_REVISION_MISMATCH', message: 'the persisted revision changed after preview' };
      continue;
    }

    try {
      storage.write(entry.path, expectedContent, bumpRevision(current.revision));
      const written = storage.getFile(entry.path);
      if (!written || written.content !== expectedContent) {
        throw new Error('written content did not verify');
      }
      entry.status = 'applied';
      entry.afterHash = sha256Hex(written.content);
    } catch (error) {
      entry.status = 'failed';
      entry.error = {
        code: isSchedulingError(error) ? error.code : 'E_WRITE_FAILED',
        message: error && error.message ? error.message : 'write failed',
      };
    }
  }

  const statuses = batch.entries.map(entry => entry.status);
  if (statuses.every(status => status === 'applied' || status === 'already-applied')) batch.status = 'applied';
  else if (statuses.some(status => status === 'applied' || status === 'already-applied')) batch.status = 'partially-applied';
  else batch.status = 'failed';

  return { batch, environment: 'memory', writesPerformed: true, verified: true };
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
    const hash = sha256Hex(content);
    if (entry.afterHash && hash === entry.afterHash) return { path: entry.path, status: 'rollback-ready' };
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
  assertStorage(storage);
  assertMemoryAuthorization(authorization);

  const entries = batch.entries.map(entry => {
    const current = storage.getFile(entry.path);
    const next = { ...entry };
    if (!current) {
      next.status = 'requires-manual-recovery';
      next.error = { code: 'E_FILE_MISSING', message: 'the file is missing during rollback' };
      return next;
    }
    const hash = sha256Hex(current.content);
    if (hash === entry.beforeHash) {
      next.status = 'rolled-back';
      return next;
    }
    if (!entry.afterHash || hash !== entry.afterHash) {
      next.status = 'conflict';
      next.error = { code: 'E_EXTERNAL_EDIT', message: 'the file changed after migration; rollback refused' };
      return next;
    }
    try {
      storage.write(entry.path, entry.originalContent, entry.revision ?? null);
      const restored = storage.getFile(entry.path);
      if (!restored || sha256Hex(restored.content) !== entry.beforeHash) {
        throw new Error('restored content did not verify');
      }
      next.status = 'rolled-back';
      next.error = null;
    } catch (error) {
      next.status = 'failed';
      next.error = {
        code: isSchedulingError(error) ? error.code : 'E_WRITE_FAILED',
        message: error && error.message ? error.message : 'rollback write failed',
      };
    }
    return next;
  });

  const statuses = entries.map(entry => entry.status);
  let status;
  if (statuses.every(value => value === 'rolled-back')) status = 'rolled-back';
  else if (statuses.some(value => value === 'rolled-back')) status = 'partially-rolled-back';
  else status = 'requires-manual-recovery';

  return {
    batch: { ...batch, entries, status },
    environment: 'memory',
    writesPerformed: true,
    summary: {
      total: entries.length,
      rolledBack: statuses.filter(value => value === 'rolled-back').length,
      conflict: statuses.filter(value => value === 'conflict').length,
      failed: statuses.filter(value => value === 'failed').length,
      requiresManualRecovery: statuses.filter(value => value === 'requires-manual-recovery').length,
    },
  };
}

function reconcileMigrationBatch(batch, storage) {
  if (!batch || batch.kind !== BATCH_KIND) fail('E_BATCH_INVALID', 'a migration batch is required');
  assertStorage(storage);
  const entries = batch.entries.map(entry => {
    const current = storage.getFile(entry.path);
    if (!current) return { ...entry, status: 'requires-manual-recovery', error: { code: 'E_FILE_MISSING', message: 'file missing during reconciliation' } };
    const hash = sha256Hex(current.content);
    if (entry.afterHash && hash === entry.afterHash) return { ...entry, status: 'applied', error: null };
    if (hash === entry.beforeHash) return { ...entry, status: entry.status === 'rolled-back' ? 'rolled-back' : 'pending', error: null };
    return { ...entry, status: 'conflict', error: { code: 'E_EXTERNAL_EDIT', message: 'content matches neither before nor after state' } };
  });
  const statuses = entries.map(entry => entry.status);
  let status;
  if (statuses.every(value => value === 'applied')) status = 'applied';
  else if (statuses.some(value => value === 'applied')) status = 'partially-applied';
  else if (statuses.every(value => value === 'rolled-back')) status = 'rolled-back';
  else if (statuses.some(value => value === 'rolled-back')) status = 'partially-rolled-back';
  else status = 'requires-manual-recovery';
  return { batch: { ...batch, entries, status }, summary: { applied: statuses.filter(v => v === 'applied').length, conflict: statuses.filter(v => v === 'conflict').length } };
}

module.exports = {
  BATCH_KIND,
  mergeFrontmatter,
  executeMigration,
  previewRollback,
  rollbackMigration,
  reconcileMigrationBatch,
};
