'use strict';

// Exact-content backup creation and verification (PR-08, SPEC A11).
//
// Only the module-registered MemoryStorage / MemoryBackupStore are accepted.
// The backup stores complete original bytes; no verified backup means no write.

const { fail } = require('./errors.js');
const { sha256Hex } = require('./migration-hash.js');
const { PLAN_KIND, executableEntries } = require('./migration-plan.js');
const { mergeFrontmatter } = require('./migration-frontmatter.js');
const { assertTrustedStorage, assertTrustedBackupStore } = require('./migration-storage.js');

const BACKUP_KIND = 'mf-us-1-migration-backup';

function verifyMigrationBackup(batch) {
  const errors = [];
  if (!batch || batch.kind !== BACKUP_KIND) {
    return { verified: false, errors: [{ code: 'E_BACKUP_INVALID', message: 'not a migration backup' }] };
  }
  for (const entry of batch.entries) {
    if (typeof entry.content !== 'string') {
      errors.push({ code: 'E_BACKUP_CONTENT_MISSING', path: entry.path });
      continue;
    }
    const hash = sha256Hex(entry.content);
    if (hash !== entry.contentHash) {
      errors.push({ code: 'E_BACKUP_HASH_MISMATCH', path: entry.path, expected: entry.contentHash, actual: hash });
    }
  }
  return { verified: errors.length === 0, errors };
}

function createMigrationBackup(plan, storage, backupStore, options = {}) {
  if (!plan || plan.kind !== PLAN_KIND) {
    fail('E_PLAN_INVALID', 'createMigrationBackup expects a migration plan', { field: 'plan' });
  }
  assertTrustedStorage(storage);
  if (backupStore != null) assertTrustedBackupStore(backupStore);

  const batchId = options.batchId || `batch-${plan.planId.slice(0, 16)}`;
  const entries = [];
  const errors = [];

  for (const entry of executableEntries(plan)) {
    const file = storage.getFile(entry.path);
    if (!file) {
      errors.push({ code: 'E_FILE_MISSING', path: entry.path });
      continue;
    }
    // The preview's exact hash is the only accepted evidence; the backup must
    // not substitute its own freshly computed hash for it.
    if (typeof entry.contentHash !== 'string') {
      errors.push({ code: 'E_PREVIEW_HASH_MISSING', path: entry.path });
      continue;
    }
    const hash = sha256Hex(file.content);
    if (hash !== entry.contentHash) {
      errors.push({ code: 'E_PREVIEW_STALE', path: entry.path, expected: entry.contentHash, actual: hash });
      continue;
    }
    if (entry.revision != null) {
      if (file.revision == null) {
        errors.push({ code: 'E_REVISION_UNAVAILABLE', path: entry.path, expected: entry.revision });
        continue;
      }
      if (entry.revision !== file.revision) {
        errors.push({ code: 'E_REVISION_STALE', path: entry.path, expected: entry.revision, actual: file.revision });
        continue;
      }
    }
    try {
      mergeFrontmatter(file.content, entry.fieldsToAdd);
    } catch (error) {
      errors.push({ code: 'E_FRONTMATTER_INVALID', path: entry.path, detail: error.code || 'E_FRONTMATTER_INVALID' });
      continue;
    }
    entries.push({
      operationId: `${batchId}:${entry.index}`,
      index: entry.index,
      path: entry.path,
      content: file.content,
      contentHash: hash,
      revision: file.revision,
      planRevision: entry.revision,
      fields: { ...entry.fieldsToAdd },
    });
  }

  if (errors.length > 0) {
    return {
      kind: BACKUP_KIND,
      batchId,
      planId: plan.planId,
      verified: false,
      entries: [],
      errors,
      writesPerformed: false,
    };
  }

  const batch = {
    kind: BACKUP_KIND,
    batchId,
    planId: plan.planId,
    createdAt: options.createdAt ?? null,
    entries,
    verified: true,
    errors: [],
    writesPerformed: false,
  };
  const verification = verifyMigrationBackup(batch);
  batch.verified = verification.verified;
  batch.errors = verification.errors;
  if (backupStore) backupStore.put(batch);
  return batch;
}

module.exports = { BACKUP_KIND, verifyMigrationBackup, createMigrationBackup };
