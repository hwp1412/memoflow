'use strict';

// Exact-content backup creation and verification (PR-08, SPEC A11).
//
// The backup stores the complete original file bytes, so unknown frontmatter,
// body text, reading history and formatting survive a rollback. No backup means
// no migration write.

const { fail } = require('./errors.js');
const { sha256Hex } = require('./migration-hash.js');
const { PLAN_KIND, executableEntries } = require('./migration-plan.js');

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
  if (!storage || typeof storage.getFile !== 'function') {
    fail('E_STORAGE_INVALID', 'backup requires an injected storage', { field: 'storage' });
  }

  const batchId = options.batchId || `batch-${plan.planId.slice(0, 16)}`;
  const entries = [];
  const errors = [];

  for (const entry of executableEntries(plan)) {
    const file = storage.getFile(entry.path);
    if (!file) {
      errors.push({ code: 'E_FILE_MISSING', path: entry.path });
      continue;
    }
    const hash = sha256Hex(file.content);
    if (entry.contentHash && entry.contentHash !== hash) {
      errors.push({ code: 'E_PREVIEW_STALE', path: entry.path, expected: entry.contentHash, actual: hash });
      continue;
    }
    if (entry.revision != null && file.revision != null && entry.revision !== file.revision) {
      errors.push({ code: 'E_REVISION_STALE', path: entry.path, expected: entry.revision, actual: file.revision });
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
  if (backupStore && typeof backupStore.put === 'function') backupStore.put(batch);
  return batch;
}

module.exports = { BACKUP_KIND, verifyMigrationBackup, createMigrationBackup };
