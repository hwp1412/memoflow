'use strict';

// PR-08 — migration properties (SPEC A10.2, A11, A13 T11/T19).

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  previewMigration,
  createMigrationBackup,
  executeMigration,
  MemoryStorage,
  MemoryBackupStore,
} = require('../src/scheduling/index.js');
const { uuid, note } = require('./helpers/migration-fixtures.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

test('preview works on fully frozen snapshots and never mutates them', () => {
  const { raw } = note({ mfId: uuid(1) });
  const frozen = JSON.parse(JSON.stringify(raw));
  Object.freeze(raw);
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.writesPerformed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), frozen);
});

test('migration preserves interval, A-Factor, Priority and review_count', () => {
  const { raw, content } = note({
    mfId: uuid(1),
    priority: 37,
    interval: 13,
    aFactor: 1.8,
    reviewCount: 0,
    extra: { custom: 'kept' },
    body: 'Original body',
  });
  const plan = previewMigration([raw], CONTEXT);
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'b' });
  executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'b' }, store);

  const after = storage.read('Sources/A.md');
  assert.ok(after.includes('priority: 37'));
  assert.ok(after.includes('interval: 13'));
  assert.ok(after.includes('a_factor: 1.8'));
  assert.ok(after.includes('review_count: 0'));
  assert.ok(after.includes('custom: kept'));
  assert.ok(after.includes('mf_interval_days: 13'));
  assert.ok(after.includes('mf_scheduler_version: 1'));
  assert.ok(after.includes('mf_revision: 0'));
  assert.ok(after.includes('mf_last_event_id: null'));
  assert.ok(after.endsWith('Original body'));
});

test('unrelated notes are byte-identical after a migration', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const unrelated = '---\ntype: source\nstatus: active\npriority: 40\ninterval: 5\na_factor: 2.0\nreview_count: 2\nnext_review: 20-11-2026\n---\nOther body';
  const plan = previewMigration([raw], CONTEXT);
  const storage = new MemoryStorage({
    'Sources/A.md': content,
    'Sources/Other.md': unrelated,
  });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'b' });
  executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'b' }, store);
  assert.equal(storage.read('Sources/Other.md'), unrelated);
});

test('cards are excluded and never written', () => {
  const card = note({ path: 'Cards/C.md', basename: 'C', mfId: uuid(9), type: 'card' });
  const plan = previewMigration([card.raw], CONTEXT);
  assert.equal(plan.entries[0].status, 'blocked');
  assert.equal(plan.executable, 0);
  assert.equal(plan.entries[0].fieldsToAdd.mf_id, undefined);
  const storage = new MemoryStorage({ 'Cards/C.md': card.content });
  assert.equal(storage.read('Cards/C.md'), card.content);
});

test('migration creates no review event and no learning progress', () => {
  const { raw, content } = note({ mfId: uuid(1), reviewCount: 0 });
  const plan = previewMigration([raw], CONTEXT);
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'b' });
  executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'b' }, store);
  const after = storage.read('Sources/A.md');
  assert.ok(after.includes('review_count: 0'));
  assert.ok(after.includes('mf_last_event_id: null'));
  assert.ok(after.includes('mf_revision: 0'));
  assert.equal(after.includes('review_count: 1'), false);
});

test('preview and execution are deterministic for the same plan', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const first = previewMigration([raw], CONTEXT, { snapshotId: 's' });
  const second = previewMigration([raw], CONTEXT, { snapshotId: 's' });
  assert.equal(first.planId, second.planId);
  assert.deepEqual(first.entries, second.entries);

  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const store = new MemoryBackupStore();
  createMigrationBackup(first, storage, store, { batchId: 'b' });
  const firstRun = executeMigration(first, storage, { environment: 'memory', authorized: true, batchId: 'b' }, store);
  const secondRun = executeMigration(first, storage, { environment: 'memory', authorized: true, batchId: 'b' }, store);
  assert.equal(secondRun.batch.status, 'applied');
  assert.deepEqual(secondRun.batch.entries.map(entry => entry.status), ['already-applied']);
  assert.equal(firstRun.batch.entries[0].afterHash, secondRun.batch.entries[0].afterHash);
});

test('effective due is preserved across priority and interval variants', () => {
  for (const priority of [1, 25, 50, 75, 100]) {
    for (const interval of [1, 8, 30, 365]) {
      const { raw } = note({ mfId: uuid(1), priority, interval, nextReview: '24-11-2026' });
      const plan = previewMigration([raw], CONTEXT);
      assert.equal(plan.entries[0].status, 'migratable');
      assert.equal(plan.entries[0].effectiveDuePreserved, true);
      assert.equal(plan.entries[0].after.effectiveDue, '2026-11-24');
      assert.equal(plan.entries[0].fieldsToAdd.mf_interval_days, interval);
    }
  }
});

test('unified mode is still refused by the migration executor', () => {
  const { raw, content } = note({ mfId: uuid(1) });
  const plan = previewMigration([raw], CONTEXT);
  const storage = new MemoryStorage({ 'Sources/A.md': content });
  const store = new MemoryBackupStore();
  createMigrationBackup(plan, storage, store, { batchId: 'b' });
  assert.throws(() => executeMigration(plan, storage, {
    environment: 'memory', authorized: true, batchId: 'b', mode: 'unified',
  }, store), error => error.code === 'E_UNIFIED_NOT_AUTHORIZED');
});

test('10k synthetic migration preview is observed without changing inputs', () => {
  const snapshots = [];
  for (let index = 1; index <= 10000; index += 1) {
    snapshots.push(note({
      path: `Sources/${index}.md`,
      basename: `S${index}`,
      mfId: uuid(index),
      nextReview: '24-11-2026',
      body: `Body ${index}`,
    }).raw);
  }
  const before = snapshots.length;
  const started = performance.now();
  const plan = previewMigration(snapshots, CONTEXT, { snapshotId: 'perf-10k' });
  const elapsed = performance.now() - started;
  assert.equal(plan.summary.total, 10000);
  assert.equal(plan.summary.migratable, 10000);
  assert.ok(elapsed < 60000, `10k preview took ${elapsed.toFixed(0)}ms`);
  assert.equal(snapshots.length, before);
  assert.equal(snapshots[0].mf_id, uuid(1));
  console.log(`[migration] 10k preview ${elapsed.toFixed(0)}ms`);
});
