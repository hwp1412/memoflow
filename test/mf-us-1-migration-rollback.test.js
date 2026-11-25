'use strict';

// PR-08 — execution, failure recovery and rollback (SPEC A11).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  previewMigration,
  createMigrationBackup,
  executeMigration,
  previewRollback,
  rollbackMigration,
  reconcileMigrationBatch,
  MemoryStorage,
  MemoryBackupStore,
  mergeFrontmatter,
} = require('../src/scheduling/index.js');
const { uuid, note } = require('./helpers/migration-fixtures.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

function setup() {
  const first = note({ mfId: uuid(1), path: 'Sources/A.md', basename: 'A', body: 'A body', extra: { mf_revision: 1 } });
  const second = note({ mfId: uuid(2), path: 'Sources/B.md', basename: 'B', body: 'B body', extra: { mf_revision: 1 } });
  const plan = previewMigration([first.raw, second.raw], CONTEXT, { snapshotId: 'snap-1' });
  const storage = new MemoryStorage({
    'Sources/A.md': { content: first.content, revision: 1 },
    'Sources/B.md': { content: second.content, revision: 1 },
  });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'batch-1' });
  return { plan, storage, store, first, second };
}

const AUTH = { environment: 'memory', authorized: true, batchId: 'batch-1' };

test('execution writes only approved fields and keeps the rest byte-identical', () => {
  const { plan, storage, store } = setup();
  const before = storage.read('Sources/A.md');
  const result = executeMigration(plan, storage, AUTH, store);
  assert.equal(result.batch.status, 'applied');
  const after = storage.read('Sources/A.md');
  const body = before.split('---\n')[2];
  assert.equal(after.endsWith(body), true, 'body is preserved');
  assert.ok(after.includes('mf_ideal_due: 2026-11-24'));
  assert.equal(storage.getFile('Sources/A.md').revision, 2);
  assert.equal(result.writesPerformed, true);
});

test('an external edit after backup is a conflict and is not overwritten', () => {
  const { plan, storage, store } = setup();
  storage.setFile('Sources/A.md', `${storage.read('Sources/A.md')}\nedited`, 1);
  const result = executeMigration(plan, storage, AUTH, store);
  const entry = result.batch.entries.find(item => item.path === 'Sources/A.md');
  assert.equal(entry.status, 'conflict');
  assert.equal(entry.error.code, 'E_EXTERNAL_EDIT');
  assert.equal(storage.read('Sources/A.md').includes('edited'), true);
});

test('a revision change with identical content is still a conflict', () => {
  const { plan, storage, store } = setup();
  const content = storage.read('Sources/A.md');
  storage.setFile('Sources/A.md', content, 99);
  const result = executeMigration(plan, storage, AUTH, store);
  const entry = result.batch.entries.find(item => item.path === 'Sources/A.md');
  assert.equal(entry.status, 'conflict');
  assert.equal(entry.error.code, 'E_REVISION_MISMATCH');
});

test('a partial write failure is reported and the other file still applies', () => {
  const { plan, storage, store } = setup();
  storage.failNextWrite('Sources/A.md');
  const result = executeMigration(plan, storage, AUTH, store);
  assert.equal(result.batch.status, 'partially-applied');
  assert.equal(result.batch.entries[0].status, 'failed');
  assert.equal(result.batch.entries[0].error.code, 'E_STORAGE_WRITE_FAILED');
  assert.equal(result.batch.entries[1].status, 'applied');
});

test('rollback restores every applied file exactly and is idempotent', () => {
  const { plan, storage, store, first, second } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  const rolled = rollbackMigration(result.batch, storage, AUTH, store);
  assert.equal(rolled.batch.status, 'rolled-back');
  assert.deepEqual(rolled.batch.entries.map(entry => entry.status), ['rolled-back', 'rolled-back']);
  assert.equal(storage.read('Sources/A.md'), first.content);
  assert.equal(storage.read('Sources/B.md'), second.content);
  assert.equal(storage.getFile('Sources/A.md').revision, 1);

  const again = rollbackMigration(rolled.batch, storage, AUTH, store);
  assert.equal(again.batch.status, 'rolled-back');
  assert.equal(storage.read('Sources/A.md'), first.content);
});

test('rollback refuses to overwrite a post-migration user edit', () => {
  const { plan, storage, store } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  storage.setFile('Sources/A.md', `${storage.read('Sources/A.md')}\nuser note`, 2);
  const preview = previewRollback(result.batch, { 'Sources/A.md': storage.read('Sources/A.md') }, store);
  assert.equal(preview.results.find(item => item.path === 'Sources/A.md').status, 'conflict');

  const rolled = rollbackMigration(result.batch, storage, AUTH, store);
  assert.equal(rolled.batch.entries[0].status, 'conflict');
  assert.equal(rolled.batch.status, 'partially-rolled-back');
  assert.equal(storage.read('Sources/A.md').includes('user note'), true);
  assert.equal(storage.read('Sources/B.md').includes('mf_ideal_due'), false);
});

test('an interrupted batch can be reconciled from before/after hashes', () => {
  const { plan, storage, store } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  const interrupted = JSON.parse(JSON.stringify(result.batch));
  interrupted.entries.forEach(entry => { entry.status = 'pending'; });
  interrupted.status = 'running';
  const reconciled = reconcileMigrationBatch(interrupted, storage);
  assert.equal(reconciled.batch.status, 'applied');
  assert.deepEqual(reconciled.batch.entries.map(entry => entry.status), ['applied', 'applied']);
});

test('re-execution after completion is idempotent', () => {
  const { plan, storage, store } = setup();
  executeMigration(plan, storage, AUTH, store);
  const content = storage.read('Sources/A.md');
  const again = executeMigration(plan, storage, AUTH, store);
  assert.equal(again.batch.status, 'applied');
  assert.deepEqual(again.batch.entries.map(entry => entry.status), ['already-applied', 'already-applied']);
  assert.equal(storage.read('Sources/A.md'), content);
});

test('rollback write failures are reported without corrupting other files', () => {
  const { plan, storage, store, first } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  storage.failNextWrite('Sources/A.md');
  const rolled = rollbackMigration(result.batch, storage, AUTH, store);
  assert.equal(rolled.batch.entries[0].status, 'failed');
  assert.equal(rolled.batch.entries[1].status, 'rolled-back');
  assert.equal(storage.read('Sources/B.md').includes('mf_ideal_due'), false);
  assert.equal(storage.read('Sources/A.md').includes('mf_ideal_due'), true);
  assert.equal(first.content.includes('mf_ideal_due'), false);
});

test('execution requires an explicit memory authorization', () => {
  const { plan, storage, store } = setup();
  for (const authorization of [
    undefined,
    { environment: 'obsidian', authorized: true, batchId: 'batch-1' },
    { environment: 'memory', authorized: false, batchId: 'batch-1' },
    { environment: 'memory', authorized: true },
    { environment: 'memory', authorized: true, batchId: 'batch-1', mode: 'unified' },
  ]) {
    assert.throws(() => executeMigration(plan, storage, authorization, store), error => (
      error.code === 'E_MIGRATION_UNAUTHORIZED' || error.code === 'E_UNIFIED_NOT_AUTHORIZED'
    ));
  }
});

test('mergeFrontmatter preserves body, unknown keys and unrelated lines', () => {
  const content = '---\ntype: source\ncustom: keep\n---\nBody';
  const merged = mergeFrontmatter(content, { mf_ideal_due: '2026-11-24', custom: 'replaced' });
  assert.equal(merged.includes('custom: replaced'), true);
  assert.equal(merged.includes('type: source'), true);
  assert.equal(merged.endsWith('Body'), true);
});

// ---- crash window, formatting and audit counters (review fixes 2, 4, 6) --

test('a pending batch with intents is recognized as applied after a crash', () => {
  const { plan, storage, store, first, second } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  const pending = JSON.parse(JSON.stringify(result.batch));
  for (const entry of pending.entries) {
    entry.status = 'pending';
    entry.afterHash = null;
  }
  pending.status = 'running';

  const reconciled = reconcileMigrationBatch(pending, storage);
  assert.equal(reconciled.batch.status, 'applied');
  assert.deepEqual(reconciled.batch.entries.map(entry => entry.status), ['applied', 'applied']);

  const rolled = rollbackMigration(pending, storage, AUTH, store);
  assert.equal(rolled.batch.status, 'rolled-back');
  assert.equal(storage.read('Sources/A.md'), first.content);
  assert.equal(storage.read('Sources/B.md'), second.content);
});

test('a crash plus a user edit is a conflict, never overwritten', () => {
  const { plan, storage, store } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  const pending = JSON.parse(JSON.stringify(result.batch));
  for (const entry of pending.entries) {
    entry.status = 'pending';
    entry.afterHash = null;
  }
  storage.setFile('Sources/A.md', `${storage.read('Sources/A.md')}\nuser edit`, 9);

  const reconciled = reconcileMigrationBatch(pending, storage);
  assert.equal(reconciled.batch.entries[0].status, 'conflict');
  const rolled = rollbackMigration(pending, storage, AUTH, store);
  assert.equal(rolled.batch.entries[0].status, 'conflict');
  assert.equal(storage.read('Sources/A.md').includes('user edit'), true);
  assert.equal(storage.read('Sources/B.md').includes('mf_ideal_due'), false);
});

test('a write that cannot be read back is reported as uncertain, not success', () => {
  const { plan, storage, store } = setup();
  storage.failNextVerifyAfterWrite('Sources/A.md');
  const result = executeMigration(plan, storage, AUTH, store);
  const entry = result.batch.entries[0];
  assert.equal(entry.status, 'uncertain');
  assert.equal(result.writesPerformed, true, 'the second file did apply');
  assert.equal(result.writeOutcome, 'uncertain');
  assert.equal(result.batch.status, 'requires-manual-recovery');
  assert.equal(result.counts.uncertain, 1);

  // The file was actually written; reconciliation can prove it from the intent.
  const reconciled = reconcileMigrationBatch(result.batch, storage);
  assert.equal(reconciled.batch.entries[0].status, 'applied');
});

test('rollback verification failure is uncertain and the batch needs recovery', () => {
  const { plan, storage, store, first } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  storage.failNextVerifyAfterWrite('Sources/A.md');
  const rolled = rollbackMigration(result.batch, storage, AUTH, store);
  assert.equal(rolled.batch.entries[0].status, 'uncertain');
  assert.equal(rolled.writesPerformed, true, 'the second file was rolled back');
  assert.equal(rolled.writeOutcome, 'uncertain');
  assert.equal(rolled.batch.status, 'requires-manual-recovery');
  assert.equal(storage.read('Sources/A.md'), first.content, 'the original bytes were restored');
});

test('CRLF, BOM and body are preserved and restored exactly', () => {
  const crlf = '\uFEFF---\r\ntype: source\r\nstatus: active\r\npriority: 50\r\ninterval: 8\r\na_factor: 2.0\r\nreview_count: 0\r\nnext_review: 24-11-2026\r\nunknown: keep\r\n---\r\nBody [[link]]\r\nline2\r\n';
  const raw = {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 2.0,
    review_count: 0, next_review: '24-11-2026', path: 'Sources/CRLF.md', basename: 'CRLF',
    mf_id: uuid(3), content: crlf,
  };
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.entries[0].status, 'migratable');
  const storage = new MemoryStorage({ 'Sources/CRLF.md': crlf });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'crlf' });
  const result = executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'crlf' }, store);
  assert.equal(result.batch.status, 'applied');

  const migrated = storage.read('Sources/CRLF.md');
  assert.equal(migrated.startsWith('\uFEFF---\r\n'), true);
  assert.equal(migrated.replace(/\r\n/g, '').includes('\n'), false, 'no mixed newlines');
  assert.equal(migrated.includes('unknown: keep'), true);
  assert.equal(migrated.endsWith('Body [[link]]\r\nline2\r\n'), true);

  const rolled = rollbackMigration(result.batch, storage, { environment: 'memory', authorized: true, batchId: 'crlf' }, store);
  assert.equal(rolled.batch.status, 'rolled-back');
  assert.equal(storage.read('Sources/CRLF.md'), crlf);
});

test('missing and unclosed frontmatter are refused, not invented', () => {
  assert.throws(() => mergeFrontmatter('Body only', { mf_ideal_due: '2026-11-24' }),
    error => error.code === 'E_FRONTMATTER_MISSING');
  assert.throws(() => mergeFrontmatter('---\ntype: source\nBody', { mf_ideal_due: '2026-11-24' }),
    error => error.code === 'E_FRONTMATTER_UNCLOSED');
  assert.throws(() => mergeFrontmatter('---\na: \uFFFD\n---', {}),
    error => error.code === 'E_ENCODING_UNSUPPORTED');
});

test('comments, unknown keys and links survive a merge', () => {
  const content = '---\ntype: source\n# keep this comment\ncustom: keep\n---\nBody [[link]]';
  const merged = mergeFrontmatter(content, { mf_ideal_due: '2026-11-24' });
  assert.equal(merged.includes('# keep this comment'), true);
  assert.equal(merged.includes('custom: keep'), true);
  assert.equal(merged.includes('mf_ideal_due: 2026-11-24'), true);
  assert.equal(merged.endsWith('Body [[link]]'), true);
});

test('writesPerformed reflects real writes, not intent', () => {
  const { plan, storage, store } = setup();
  storage.setFile('Sources/A.md', 'changed A', 1);
  storage.setFile('Sources/B.md', 'changed B', 1);
  const allConflict = executeMigration(plan, storage, AUTH, store);
  assert.equal(allConflict.batch.status, 'failed');
  assert.equal(allConflict.writesPerformed, false);
  assert.equal(allConflict.writeOutcome, 'none');
  assert.equal(allConflict.counts.conflicts, 2);

  const { plan: plan2, storage: storage2, store: store2 } = setup();
  storage2.failNextWrite('Sources/A.md');
  const partial = executeMigration(plan2, storage2, AUTH, store2);
  assert.equal(partial.batch.status, 'partially-applied');
  assert.equal(partial.writesPerformed, true);
  assert.equal(partial.counts.succeeded, 1);
  assert.equal(partial.counts.failed, 1);

  const repeat = executeMigration(plan2, storage2, AUTH, store2);
  assert.equal(repeat.writesPerformed, true, 'the previously failed file is retried');
  assert.equal(repeat.counts.succeeded, 1);
  assert.equal(repeat.counts.alreadyApplied, 1);

  const secondRepeat = executeMigration(plan2, storage2, AUTH, store2);
  assert.equal(secondRepeat.writesPerformed, false);
  assert.equal(secondRepeat.writeOutcome, 'none');
  assert.equal(secondRepeat.counts.alreadyApplied, 2);

  const rolled = rollbackMigration(partial.batch, storage2, AUTH, store2);
  assert.equal(rolled.writesPerformed, true);
  const rolledAgain = rollbackMigration(rolled.batch, storage2, AUTH, store2);
  assert.equal(rolledAgain.writesPerformed, false);
});

test('execute, rollback and reconcile reject forged storage before any access', () => {
  const { plan, storage, store } = setup();
  const calls = { getFile: 0, write: 0 };
  const fake = {
    environment: 'memory',
    authorized: true,
    getFile() { calls.getFile += 1; return null; },
    write() { calls.write += 1; },
  };
  const auth = { environment: 'memory', authorized: true, batchId: 'batch-1' };

  assert.throws(() => executeMigration(plan, fake, auth, store), error => error.code === 'E_STORAGE_UNTRUSTED');
  assert.deepEqual(calls, { getFile: 0, write: 0 });

  const result = executeMigration(plan, storage, auth, store);
  assert.throws(() => rollbackMigration(result.batch, fake, auth, store), error => error.code === 'E_STORAGE_UNTRUSTED');
  assert.throws(() => reconcileMigrationBatch(result.batch, fake), error => error.code === 'E_STORAGE_UNTRUSTED');
  assert.deepEqual(calls, { getFile: 0, write: 0 });
});

// ---- rollback source verification (review fix 1) -------------------------

function executedSetup() {
  const context = setup();
  const result = executeMigration(context.plan, context.storage, AUTH, context.store);
  return { ...context, result, frozen: context.storage.snapshot() };
}

test('rollback refuses tampered original content before writing', () => {
  const { result, storage, store, frozen } = executedSetup();
  const tampered = JSON.parse(JSON.stringify(result.batch));
  tampered.entries[0].originalContent = 'tampered content';
  assert.throws(() => rollbackMigration(tampered, storage, AUTH, store), error => error.code === 'E_BATCH_TAMPERED');
  assert.deepEqual(storage.snapshot(), frozen);
});

test('rollback refuses a tampered beforeHash', () => {
  const { result, storage, store, frozen } = executedSetup();
  const tampered = JSON.parse(JSON.stringify(result.batch));
  tampered.entries[0].beforeHash = '0'.repeat(64);
  assert.throws(() => rollbackMigration(tampered, storage, AUTH, store), error => error.code === 'E_BACKUP_HASH_MISMATCH');
  assert.deepEqual(storage.snapshot(), frozen);
});

test('rollback refuses an authorization that names another batch', () => {
  const { result, storage, store, frozen } = executedSetup();
  assert.throws(
    () => rollbackMigration(result.batch, storage, { ...AUTH, batchId: 'other' }, store),
    error => error.code === 'E_BATCH_MISMATCH'
  );
  assert.deepEqual(storage.snapshot(), frozen);
});

test('rollback refuses replaced operation ids or paths', () => {
  const { result, storage, store, frozen } = executedSetup();

  const wrongOperation = JSON.parse(JSON.stringify(result.batch));
  wrongOperation.entries[0].operationId = 'forged:1';
  assert.throws(() => rollbackMigration(wrongOperation, storage, AUTH, store), error => error.code === 'E_BACKUP_ENTRY_MISSING');

  const wrongPath = JSON.parse(JSON.stringify(result.batch));
  wrongPath.entries[0].path = 'Sources/Forged.md';
  assert.throws(() => rollbackMigration(wrongPath, storage, AUTH, store), error => error.code === 'E_BACKUP_PATH_MISMATCH');

  assert.deepEqual(storage.snapshot(), frozen);
});

test('rollback refuses a missing or corrupted backup', () => {
  const { result, storage, store, frozen } = executedSetup();
  store.remove('batch-1');
  assert.throws(() => rollbackMigration(result.batch, storage, AUTH, store), error => error.code === 'E_BACKUP_MISSING');
  assert.deepEqual(storage.snapshot(), frozen);

  const second = setup();
  const secondResult = executeMigration(second.plan, second.storage, AUTH, second.store);
  second.store.corrupt('batch-1');
  assert.throws(() => rollbackMigration(secondResult.batch, second.storage, AUTH, second.store), error => error.code === 'E_BACKUP_CORRUPT');
});

test('rollback refuses a revision change even when the content is unchanged', () => {
  const { result, storage, store } = executedSetup();
  const migrated = storage.read('Sources/A.md');
  storage.setFile('Sources/A.md', migrated, 99); // content identical, revision not the expected +1
  const rolled = rollbackMigration(result.batch, storage, AUTH, store);
  assert.equal(rolled.batch.entries[0].status, 'conflict');
  assert.equal(rolled.batch.entries[0].error.code, 'E_REVISION_MISMATCH');
  assert.equal(storage.read('Sources/A.md'), migrated);
});

test('an LF+BOM file migrates and restores exactly', () => {
  const lf = '\uFEFF---\ntype: source\nstatus: active\npriority: 50\ninterval: 8\na_factor: 2.0\nreview_count: 0\nnext_review: 24-11-2026\n---\nBody [[link]]\n';
  const raw = {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 2.0,
    review_count: 0, next_review: '24-11-2026', path: 'Sources/LF.md', basename: 'LF',
    mf_id: uuid(4), content: lf,
  };
  const plan = previewMigration([raw], CONTEXT);
  const storage = new MemoryStorage({ 'Sources/LF.md': lf });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'lf' });
  const result = executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'lf' }, store);
  const migrated = storage.read('Sources/LF.md');
  assert.equal(migrated.startsWith('\uFEFF---\n'), true);
  assert.equal(migrated.includes('\r'), false);
  const rolled = rollbackMigration(result.batch, storage, { environment: 'memory', authorized: true, batchId: 'lf' }, store);
  assert.equal(rolled.batch.status, 'rolled-back');
  assert.equal(storage.read('Sources/LF.md'), lf);
});
