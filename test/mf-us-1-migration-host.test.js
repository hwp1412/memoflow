'use strict';

// P3-02A — G3 synthetic migration host wiring (memory storage only).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runSyntheticMigration,
  previewAndBackup,
  applyMigration,
  rollbackMigrationBatch,
} = require('../src/integration/migration-host.js');
const { note, allocator } = require('./helpers/migration-fixtures.js');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

function snapshot(overrides = {}) {
  const { raw, content, revision } = note(overrides);
  return { ...raw, content, revision };
}

test('synthetic migration runs preview → backup → verify → apply → reconcile → rollback', async () => {
  const files = [snapshot()];
  const prepared = previewAndBackup({ snapshots: files, context: CONTEXT, batchId: 'b-happy', uuidAllocator: allocator() });
  assert.ok(prepared.plan && typeof prepared.plan.planId === 'string');
  assert.equal(prepared.verification.verified, true);
  assert.equal(prepared.correspondence.valid, true);
  assert.equal(prepared.plan.summary.total, 1);
  assert.equal(prepared.plan.summary.migratable, 1);

  const applied = await applyMigration({ ...prepared, batchId: 'b-happy' });
  assert.equal(applied.batch.entries.filter(entry => entry.status === 'applied').length, 1,
    JSON.stringify(applied.batch.entries.map(entry => entry.status)));
  assert.match(prepared.storage.getFile(files[0].path).content, /mf_id:/);
  assert.ok(applied.reconcile, 'reconcile artifact produced');

  const rolled = await rollbackMigrationBatch({ batch: applied.batch, storage: prepared.storage, backupStore: prepared.backupStore });
  assert.ok(rolled.result, 'rollback executed');
  assert.equal(prepared.storage.getFile(files[0].path).content, files[0].content, 'rollback restored original bytes');
  assert.equal(rolled.preview.dryRun !== false, true);
});

test('a second apply on the same storage cannot create a second identity', async () => {
  const files = [snapshot()];
  const prepared = previewAndBackup({ snapshots: files, context: CONTEXT, batchId: 'b-twice', uuidAllocator: allocator() });
  const first = await applyMigration(prepared);
  const firstContent = prepared.storage.getFile(files[0].path).content;
  assert.equal((firstContent.match(/mf_id:/g) || []).length, 1);
  const second = await applyMigration(prepared);
  const secondContent = prepared.storage.getFile(files[0].path).content;
  assert.equal((secondContent.match(/mf_id:/g) || []).length, 1, 'still exactly one identity');
  assert.ok(second.batch.entries.every(entry => entry.status !== 'applied'), 'nothing re-applied');
});

test('an injected write failure makes the batch fail instead of reporting success', async () => {
  const files = [snapshot()];
  const prepared = previewAndBackup({ snapshots: files, context: CONTEXT, batchId: 'b-fail', uuidAllocator: allocator() });
  prepared.storage.failNextWrite(files[0].path);
  let outcome;
  try {
    outcome = await applyMigration(prepared);
  } catch (error) {
    // A storage failure during migration is a hard stop: nothing is reported
    // as a successful migration.
    assert.ok(error.code, 'failure carries a code');
    return;
  }
  const failed = outcome.batch.entries.filter(entry => entry.status !== 'applied');
  assert.ok(failed.length > 0, 'no silent success after a failed write');
});

test('rollback is refused without the memory authorization', async () => {
  const files = [snapshot()];
  const prepared = previewAndBackup({ snapshots: files, context: CONTEXT, batchId: 'b-auth', uuidAllocator: allocator() });
  const { batch } = await applyMigration(prepared);
  await assert.rejects(
    () => rollbackMigrationBatch({ batch: { ...batch, batchId: '' }, storage: prepared.storage, backupStore: prepared.backupStore }),
    error => error.code === 'E_MIGRATION_UNAUTHORIZED',
  );
});

test('the host entry refuses migration without the synthetic capability', async () => {
  const { plugin } = createPlugin({ settings: makeSettings() });
  const blocked = await plugin.mfUs1SyntheticMigrationDrill({ snapshots: [snapshot()] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'E_MIGRATION_NOT_OPEN');

  plugin.__mfUs1MigrationAuthorization = { environment: 'memory', authorized: true, batchId: 'b-host' };
  const missingSnapshots = await plugin.mfUs1SyntheticMigrationDrill({ snapshots: [] });
  assert.equal(missingSnapshots.reason, 'E_SNAPSHOTS_REQUIRED');

  const result = await plugin.mfUs1SyntheticMigrationDrill({ snapshots: [snapshot()], batchId: 'b-host', uuidAllocator: allocator() });
  assert.equal(result.ok, true);
  assert.ok(result.plan.planId);
});
