'use strict';

// PR-08 — stable UUID initialization and batch identity (SPEC A2.2, A10.2).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  previewMigration,
  createMigrationBackup,
  executeMigration,
  isPersistentUuid,
  MemoryStorage,
  MemoryBackupStore,
} = require('../src/scheduling/index.js');
const { uuid, note, allocator } = require('./helpers/migration-fixtures.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

function setup(plan, files) {
  const storage = new MemoryStorage(files);
  const store = new MemoryBackupStore();
  return { storage, store };
}

test('a temporary identity receives one fixed UUID, never a hash', () => {
  const { raw } = note({ path: 'Sources/Temp.md', basename: 'Temp' });
  const plan = previewMigration([raw], CONTEXT, { uuidAllocator: allocator() });
  const entry = plan.entries[0];
  assert.equal(entry.status, 'migratable');
  assert.equal(entry.requiresUuid, true);
  assert.equal(entry.identity.kind, 'temporary');
  assert.equal(entry.identity.id.startsWith('temp-'), true);
  assert.equal(isPersistentUuid(entry.assignedUuid), true);
  assert.equal(entry.fieldsToAdd.mf_id, entry.assignedUuid);
  assert.equal(entry.identity.id === entry.fieldsToAdd.mf_id, false);
  assert.equal('mf_id' in raw, false);
});

test('an allocated UUID colliding with an existing id is rejected', () => {
  const { raw: existing } = note({ path: 'Sources/A.md', basename: 'A', mfId: uuid(1).toUpperCase() });
  const { raw: temporary } = note({ path: 'Sources/B.md', basename: 'B' });
  const plan = previewMigration([existing, temporary], CONTEXT, {
    uuidAllocator: () => uuid(1).toLowerCase(),
  });
  const entry = plan.entries[1];
  assert.equal(entry.status, 'manual-review');
  assert.ok(entry.reasons.some(reason => reason.code === 'UUID_CONFLICT'));
  assert.equal(entry.assignedUuid, null);
  assert.equal(plan.executable, 1, 'only the already persistent note is executable');
});

test('two allocations in one batch can never share a UUID', () => {
  const { raw: first } = note({ path: 'Sources/A.md', basename: 'A' });
  const { raw: second } = note({ path: 'Sources/B.md', basename: 'B' });
  let calls = 0;
  const plan = previewMigration([first, second], CONTEXT, {
    uuidAllocator: () => {
      calls += 1;
      return uuid(9); // deliberately repeats
    },
  });
  assert.equal(calls, 2);
  assert.equal(plan.entries[0].assignedUuid, uuid(9));
  assert.equal(plan.entries[1].assignedUuid, null);
  assert.ok(plan.entries[1].reasons.some(reason => reason.code === 'UUID_CONFLICT'));
});

test('an invalid or failing allocator blocks instead of inventing an id', () => {
  const { raw } = note({ path: 'Sources/A.md', basename: 'A' });
  const invalid = previewMigration([raw], CONTEXT, { uuidAllocator: () => 'not-a-uuid' });
  assert.equal(invalid.entries[0].status, 'blocked');
  assert.ok(invalid.entries[0].reasons.some(reason => reason.code === 'UUID_INVALID'));

  const thrown = previewMigration([raw], CONTEXT, { uuidAllocator: () => { throw new Error('boom'); } });
  assert.equal(thrown.entries[0].status, 'blocked');
  assert.ok(thrown.entries[0].reasons.some(reason => reason.code === 'UUID_ALLOCATOR_FAILED'));
});

test('a five-level temporary chain maps every parent and root to its allocated UUID', () => {
  const topics = [];
  for (let level = 0; level <= 4; level += 1) {
    const name = level === 0 ? 'Root' : `L${level}`;
    const parent = level === 0 ? null : (level === 1 ? 'Root' : `L${level - 1}`);
    const { raw } = note({
      path: level === 0 ? 'Sources/Root.md' : `Extracts/${name}.md`,
      basename: name,
      type: level === 0 ? 'source' : 'extract',
      extra: level === 0 ? {} : { parent: `[[${parent}]]`, source: '[[Root]]' },
    });
    topics.push(raw);
  }
  const plan = previewMigration(topics, CONTEXT, { uuidAllocator: allocator() });
  assert.equal(plan.summary.migratable, 5);
  const ids = plan.entries.map(entry => entry.assignedUuid);
  assert.equal(ids.every(isPersistentUuid), true);
  assert.equal(new Set(ids.map(id => id.toLowerCase())).size, 5);
  assert.equal(plan.entries[0].fieldsToAdd.mf_root_id, ids[0]);
  assert.equal(plan.entries[1].fieldsToAdd.mf_parent_id, ids[0]);
  assert.equal(plan.entries[4].fieldsToAdd.mf_parent_id, ids[3]);
  assert.equal(plan.entries[4].fieldsToAdd.mf_root_id, ids[0]);
});

test('re-executing the same plan reuses the fixed UUID and is idempotent', () => {
  const { raw, content } = note({ path: 'Sources/Temp.md', basename: 'Temp', body: 'Keep me' });
  const plan = previewMigration([raw], CONTEXT, { uuidAllocator: allocator('22222222-2222-4222-8222-') });
  const assigned = plan.entries[0].assignedUuid;
  const { storage, store } = setup(plan, { 'Sources/Temp.md': { content, revision: 1 } });
  const backup = createMigrationBackup(plan, storage, store, { batchId: 'batch-1' });
  assert.equal(backup.verified, true);

  const first = executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'batch-1' }, store);
  assert.equal(first.batch.status, 'applied');
  const migrated = storage.read('Sources/Temp.md');
  assert.ok(migrated.includes(`mf_id: ${assigned}`));
  assert.equal((migrated.match(new RegExp(`mf_id: ${assigned}`, 'g')) || []).length, 1);
  assert.ok(migrated.includes(`mf_root_id: ${assigned}`));

  const second = executeMigration(plan, storage, { environment: 'memory', authorized: true, batchId: 'batch-1' }, store);
  assert.equal(second.batch.entries[0].status, 'already-applied');
  assert.equal(storage.read('Sources/Temp.md'), migrated);
  assert.equal(second.batch.status, 'applied');
});

test('a different allocation produces a different plan hash', () => {
  const { raw } = note({ path: 'Sources/Temp.md', basename: 'Temp' });
  const first = previewMigration([raw], CONTEXT, { uuidAllocator: () => uuid(1) });
  const second = previewMigration([raw], CONTEXT, { uuidAllocator: () => uuid(2) });
  assert.notEqual(first.planId, second.planId);
});
