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
  const rolled = rollbackMigration(result.batch, storage, AUTH);
  assert.equal(rolled.batch.status, 'rolled-back');
  assert.deepEqual(rolled.batch.entries.map(entry => entry.status), ['rolled-back', 'rolled-back']);
  assert.equal(storage.read('Sources/A.md'), first.content);
  assert.equal(storage.read('Sources/B.md'), second.content);
  assert.equal(storage.getFile('Sources/A.md').revision, 1);

  const again = rollbackMigration(rolled.batch, storage, AUTH);
  assert.equal(again.batch.status, 'rolled-back');
  assert.equal(storage.read('Sources/A.md'), first.content);
});

test('rollback refuses to overwrite a post-migration user edit', () => {
  const { plan, storage, store } = setup();
  const result = executeMigration(plan, storage, AUTH, store);
  storage.setFile('Sources/A.md', `${storage.read('Sources/A.md')}\nuser note`, 2);
  const preview = previewRollback(result.batch, { 'Sources/A.md': storage.read('Sources/A.md') });
  assert.equal(preview.results.find(item => item.path === 'Sources/A.md').status, 'conflict');

  const rolled = rollbackMigration(result.batch, storage, AUTH);
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
  const rolled = rollbackMigration(result.batch, storage, AUTH);
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
