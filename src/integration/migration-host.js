'use strict';

// P3-02A — migration host wiring for synthetic environments ONLY.
//
// The underlying modules accept only module-trusted MemoryStorage/MemoryBackupStore,
// so this host cannot touch a real Obsidian vault even if called with one. The
// entry point refuses unless a memory-environment authorization is provided by
// the caller. Production has no such authorization.

const { previewMigration } = require('../scheduling/migration-plan.js');
const {
  createMigrationBackup,
  verifyMigrationBackup,
  verifyPlanBackupCorrespondence,
} = require('../scheduling/migration-backup.js');
const {
  executeMigration,
  reconcileMigrationBatch,
  previewRollback,
  rollbackMigration,
} = require('../scheduling/migration-execute.js');
const { MemoryStorage, MemoryBackupStore } = require('../scheduling/migration-storage.js');

function memoryAuthorization(batchId) {
  if (typeof batchId !== 'string' || !batchId) {
    throw Object.assign(new Error('a migration batch id is required'), { code: 'E_MIGRATION_UNAUTHORIZED' });
  }
  return { environment: 'memory', authorized: true, batchId };
}

function storageFromSnapshots(snapshots) {
  const files = {};
  for (const snapshot of snapshots) {
    files[snapshot.path] = {
      content: String(snapshot.content ?? ''),
      revision: Number.isInteger(snapshot.revision) ? snapshot.revision : null,
    };
  }
  return new MemoryStorage(files);
}

// Preview → Backup → Verify → Apply → Readback/Reconcile.
// Returns every artifact so the caller can persist/inspect evidence. Throws on
// integrity failures; never writes outside the in-memory storage.
function previewAndBackup({ snapshots, context = {}, batchId, uuidAllocator = null }) {
  const plan = previewMigration(snapshots, context, uuidAllocator ? { uuidAllocator } : {});
  const storage = storageFromSnapshots(snapshots);
  const backupStore = new MemoryBackupStore();
  const backup = createMigrationBackup(plan, storage, backupStore, { batchId });
  const verification = verifyMigrationBackup(backup);
  const correspondence = verifyPlanBackupCorrespondence(plan, backup);
  return { plan, storage, backupStore, backup, verification, correspondence };
}

async function applyMigration({ plan, storage, backupStore, batchId = null, backup = null }) {
  const effectiveBatchId = batchId || (backup && backup.batchId) || null;
  const authorization = memoryAuthorization(effectiveBatchId);
  const executed = executeMigration(plan, storage, authorization, backupStore);
  const batch = executed.batch;
  const reconcile = reconcileMigrationBatch(batch, storage);
  return { batch, counts: executed.counts, reconcile, authorization, writeOutcome: executed.writeOutcome };
}

async function rollbackMigrationBatch({ batch, storage, backupStore }) {
  const authorization = memoryAuthorization(batch.batchId);
  const currentSnapshots = storage.snapshot();
  const preview = previewRollback(batch, currentSnapshots, backupStore);
  const result = rollbackMigration(batch, storage, authorization, backupStore);
  return { preview, result };
}

// One-shot synthetic drill. Requires an explicit batchId; returns the full
// evidence trail for assertions.
async function runSyntheticMigration({ snapshots, context = {}, batchId = 'synthetic-batch', uuidAllocator = null }) {
  const prepared = previewAndBackup({ snapshots, context, batchId, uuidAllocator });
  if (!prepared.verification.verified) {
    return { ...prepared, ok: false, reason: 'E_BACKUP_NOT_VERIFIED' };
  }
  if (!prepared.correspondence.valid) {
    return { ...prepared, ok: false, reason: 'E_BACKUP_PLAN_MISMATCH' };
  }
  const { batch, reconcile } = await applyMigration({ ...prepared, batchId });
  const rolled = await rollbackMigrationBatch({ batch, storage: prepared.storage, backupStore: prepared.backupStore });
  return {
    ...prepared,
    ok: batch.status !== 'failed',
    batch,
    reconcile,
    rollback: rolled,
    finalSnapshot: prepared.storage.snapshot(),
  };
}

module.exports = {
  memoryAuthorization,
  storageFromSnapshots,
  previewAndBackup,
  applyMigration,
  rollbackMigrationBatch,
  runSyntheticMigration,
};
