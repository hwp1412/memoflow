'use strict';

// PR-08 — exact-content backup and integrity checks (SPEC A11).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  previewMigration,
  createMigrationBackup,
  verifyMigrationBackup,
  executeMigration,
  sha256Hex,
  MemoryStorage,
  MemoryBackupStore,
} = require('../src/scheduling/index.js');
const { uuid, note } = require('./helpers/migration-fixtures.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

function planFor(raw) {
  return previewMigration([raw], CONTEXT, { snapshotId: 'snap-1' });
}

test('the local SHA-256 matches Node crypto', () => {
  for (const text of ['', 'abc', '中文内容', 'a'.repeat(1000), '---\ntype: source\n---\nBody']) {
    assert.equal(sha256Hex(text), crypto.createHash('sha256').update(text).digest('hex'));
  }
});

test('backup stores the exact original bytes and hash', () => {
  const { raw, content } = note({ mfId: uuid(1), body: 'Body with 中文 and trailing spaces  \nline2' });
  const plan = planFor(raw);
  const storage = new MemoryStorage({ 'Sources/A.md': { content, revision: 3 } });
  const store = new MemoryBackupStore();
  const batch = createMigrationBackup(plan, storage, store, { batchId: 'batch-1' });
  assert.equal(batch.verified, true);
  assert.equal(batch.entries.length, 1);
  assert.equal(batch.entries[0].content, content);
  assert.equal(batch.entries[0].contentHash, sha256Hex(content));
  assert.equal(batch.entries[0].revision, 3);
  assert.equal(batch.planId, plan.planId);
  assert.equal(batch.writesPerformed, false);
  assert.equal(verifyMigrationBackup(batch).verified, true);
});

test('unknown frontmatter and body survive the backup', () => {
  const { raw, content } = note({
    mfId: uuid(1),
    extra: { tags: '[a, b]', custom_flag: 'true' },
    body: '# Heading\n\nParagraph with [[link]]',
  });
  const plan = planFor(raw);
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const batch = createMigrationBackup(plan, storage, new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(batch.entries[0].content, content);
  assert.equal(batch.entries[0].content.includes('custom_flag: true'), true);
  assert.equal(batch.entries[0].content.includes('Paragraph with [[link]]'), true);
});

test('a changed file is rejected before backup is accepted', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  const storage = new MemoryStorage({ 'Sources/A.md': `${content}\nexternal edit` });
  const batch = createMigrationBackup(plan, storage, new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(batch.verified, false);
  assert.ok(batch.errors.some(error => error.code === 'E_PREVIEW_STALE'));
});

test('missing files and revision drift are reported', () => {
  const { raw, content } = note({ mfId: uuid(1), extra: { mf_revision: 2 } });
  const plan = previewMigration([raw], CONTEXT);
  const missing = createMigrationBackup(plan, new MemoryStorage({}), new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(missing.verified, false);
  assert.ok(missing.errors.some(error => error.code === 'E_FILE_MISSING'));

  const storage = new MemoryStorage({ 'Sources/A.md': { content, revision: 5 } });
  const drift = createMigrationBackup(plan, storage, new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(drift.verified, false);
  assert.ok(drift.errors.some(error => error.code === 'E_REVISION_STALE'));
});

test('a corrupted or missing backup blocks execution', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'b' });
  const auth = { environment: 'memory', authorized: true, batchId: 'b' };

  assert.throws(() => executeMigration(plan, storage, { ...auth, batchId: 'other' }, store),
    error => error.code === 'E_BACKUP_MISSING');

  store.corrupt('b');
  assert.throws(() => executeMigration(plan, storage, auth, store),
    error => error.code === 'E_BACKUP_CORRUPT');
});

test('a backup from another plan and a tampered plan are rejected', () => {
  const { raw: first, content: contentA } = note({ mfId: uuid(1), path: 'Sources/A.md', basename: 'A' });
  const { raw: second, content: contentB } = note({ mfId: uuid(2), path: 'Sources/B.md', basename: 'B' });
  const plan = previewMigration([first, second], CONTEXT);
  const storage = new MemoryStorage({ 'Sources/A.md': contentA, 'Sources/B.md': contentB });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'b' });
  const auth = { environment: 'memory', authorized: true, batchId: 'b' };

  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.entries[0].fieldsToAdd.mf_ideal_due = '2030-01-01';
  assert.throws(() => executeMigration(tampered, storage, auth, store),
    error => error.code === 'E_PLAN_TAMPERED');

  const otherPlan = previewMigration([second], CONTEXT);
  assert.throws(() => executeMigration(otherPlan, storage, auth, store),
    error => error.code === 'E_BACKUP_PLAN_MISMATCH');
});
