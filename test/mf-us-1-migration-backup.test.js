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

// ---- storage trust and snapshot evidence (review fixes 1, 3) -------------

test('a forged storage object is rejected before any read or write', () => {
  const calls = { getFile: 0, write: 0 };
  const fake = {
    environment: 'memory',
    authorized: true,
    getFile() { calls.getFile += 1; return null; },
    write() { calls.write += 1; },
  };
  const { raw } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  assert.throws(
    () => createMigrationBackup(plan, fake, new MemoryBackupStore(), { batchId: 'b' }),
    error => error.code === 'E_STORAGE_UNTRUSTED'
  );
  assert.deepEqual(calls, { getFile: 0, write: 0 });
});

test('a forged backup store is rejected before any lookup', () => {
  const calls = { get: 0, putBatch: 0 };
  const fakeStore = {
    environment: 'memory',
    get() { calls.get += 1; return null; },
    putBatch() { calls.putBatch += 1; },
  };
  const { raw, content } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const realStore = new MemoryBackupStore();
  createMigrationBackup(plan, storage, realStore, { batchId: 'b' });
  assert.throws(
    () => executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'b' }, fakeStore),
    error => error.code === 'E_BACKUP_STORE_UNTRUSTED'
  );
  assert.deepEqual(calls, { get: 0, putBatch: 0 });
});

test('a forgery cannot pass by copying the real method names', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  const real = new MemoryStorage({ 'Sources/A.md': content });
  const clone = {
    files: real.files,
    getFile: real.getFile.bind(real),
    write: real.write.bind(real),
    environment: 'memory',
    authorized: true,
  };
  assert.throws(() => createMigrationBackup(plan, clone, new MemoryBackupStore(), { batchId: 'b' }),
    error => error.code === 'E_STORAGE_UNTRUSTED');
});

test('a preview without an exact hash is refused at backup time', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  delete plan.entries[0].contentHash;
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const batch = createMigrationBackup(plan, storage, new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(batch.verified, false);
  assert.ok(batch.errors.some(error => error.code === 'E_PREVIEW_HASH_MISSING'));
});

test('a preview revision that storage cannot prove is rejected', () => {
  const { raw, content } = note({ mfId: uuid(1), extra: { mf_revision: 2 } });
  const plan = planFor(raw);
  const storage = new MemoryStorage({ 'Sources/A.md': content }); // no revision
  const batch = createMigrationBackup(plan, storage, new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(batch.verified, false);
  assert.ok(batch.errors.some(error => error.code === 'E_REVISION_UNAVAILABLE'));
});

test('an unmergeable frontmatter is rejected during backup', () => {
  const { raw } = note({ mfId: uuid(1) });
  const plan = planFor(raw);
  const broken = 'no frontmatter here';
  plan.entries[0].contentHash = sha256Hex(broken);
  const storage = new MemoryStorage({ 'Sources/A.md': broken });
  const batch = createMigrationBackup(plan, storage, new MemoryBackupStore(), { batchId: 'b' });
  assert.equal(batch.verified, false);
  assert.ok(batch.errors.some(error => error.code === 'E_FRONTMATTER_INVALID'));
});
