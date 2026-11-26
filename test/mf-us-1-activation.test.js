'use strict';

// P3-02A — G1/G2/G4 activation coordinator and host wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivationCoordinator } = require('../src/integration/activation-coordinator.js');
const { createPlugin, makeFile, makeSettings } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

const COMPLETE_PLAN = { planId: 'plan-1', summary: { total: 2, migratable: 0, manualReview: 0, conflict: 0, blocked: 0 } };
const COMPLETE_EVIDENCE = {
  migrationPlan: COMPLETE_PLAN,
  pendingEvents: [],
  recoveryHealthy: true,
  blockedTopicIds: [],
  batchRecoveryError: null,
  duplicateIds: [],
  backupVerified: true,
  userConfirmed: true,
};

test('activation is denied without every evidence condition', () => {
  const coordinator = createActivationCoordinator({ approvalProvider: () => true });
  const noMigration = coordinator.evaluate({ ...COMPLETE_EVIDENCE, migrationPlan: null });
  assert.ok(noMigration.blockers.includes('MIGRATION_INCOMPLETE'));
  const pending = coordinator.evaluate({ ...COMPLETE_EVIDENCE, pendingEvents: ['e1'] });
  assert.ok(pending.blockers.includes('PENDING_RECOVERY'));
  const blocked = coordinator.evaluate({ ...COMPLETE_EVIDENCE, blockedTopicIds: ['id'] });
  assert.ok(blocked.blockers.includes('BLOCKED_TOPICS'));
  const dup = coordinator.evaluate({ ...COMPLETE_EVIDENCE, duplicateIds: ['id'] });
  assert.ok(dup.blockers.includes('TOPIC_ID_CONFLICT'));
  const unhealthy = coordinator.evaluate({ ...COMPLETE_EVIDENCE, recoveryHealthy: false });
  assert.ok(unhealthy.blockers.includes('RECOVERY_UNHEALTHY'));
  const noBackup = coordinator.evaluate({ ...COMPLETE_EVIDENCE, backupVerified: false });
  assert.ok(noBackup.blockers.includes('BACKUP_NOT_VERIFIED'));
  const noConfirm = coordinator.evaluate({ ...COMPLETE_EVIDENCE, userConfirmed: false });
  assert.ok(noConfirm.blockers.includes('USER_CONFIRMATION_REQUIRED'));
  assert.equal(coordinator.evaluate(COMPLETE_EVIDENCE).allowed, true);
});

test('a production coordinator (no approval provider) can never mint a token', () => {
  const coordinator = createActivationCoordinator({ approvalProvider: null });
  const result = coordinator.authorize(COMPLETE_EVIDENCE);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('ACTIVATION_NOT_APPROVED'));
  assert.equal(coordinator.isAuthorized(), false);
});

test('an approved session token can be revoked and is never reused', () => {
  const coordinator = createActivationCoordinator({ approvalProvider: () => true });
  const first = coordinator.authorize(COMPLETE_EVIDENCE);
  assert.equal(first.ok, true);
  assert.equal(coordinator.isAuthorized(), true);
  assert.deepEqual(coordinator.revoke(), { revoked: true });
  assert.equal(coordinator.isAuthorized(), false);
  assert.equal(coordinator.currentSession(), null);
});

function setupPlugin() {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  plugin.mfUs1MigrationPreviewCache = COMPLETE_PLAN;
  plugin.__mfUs1ActivationConfirmed = true;
  plugin.__mfUs1BackupVerified = true;
  return { plugin, app };
}

test('the host refuses activation without an injected approval', async () => {
  const { plugin } = setupPlugin();
  const result = await plugin.mfUs1ActivateUnified();
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('ACTIVATION_NOT_APPROVED'));
  assert.notEqual(plugin.settings.mf_us1_mode, 'unified');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
});

test('approved activation rebuilds an authorized runtime and a unified event applies', async () => {
  const { plugin, app } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  const file = makeFile(app, 'Sources/A.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 1,
    next_review: '2026-11-20', date_added: '2026-10-01',
    mf_id: uuid(1), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# A\n');
  const activated = await plugin.mfUs1ActivateUnified();
  assert.equal(activated.ok, true);
  assert.equal(plugin.settings.mf_us1_mode, 'unified');
  const diagnostics = plugin.mfUs1ActivationDiagnostics();
  assert.equal(diagnostics.authorized, true);
  assert.equal(diagnostics.runtime.present, true);
  assert.equal(diagnostics.runtime.writeEnabled, true);

  app.activeFile = file;
  await plugin.postponeFile(file, 3);
  const fm = app.vault.readFm(file);
  assert.ok(fm.mf_not_before && fm.mf_not_before !== 'null', 'unified event wrote mf_not_before');
  assert.equal(Number(fm.mf_revision), 1, 'revision bumped by the event');
  const ledger = plugin.mfUs1AsyncLifecycle.ledger.store.dump();
  assert.equal(Object.values(ledger).length, 1, 'one confirmed ledger record');
});

test('revocation restores legacy only after recovery checks pass', async () => {
  const { plugin, app } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  makeFile(app, 'Sources/A.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 1,
    next_review: '2026-11-20', mf_id: uuid(2), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# A\n');
  await plugin.mfUs1ActivateUnified();
  const revoked = await plugin.mfUs1RevokeActivation();
  assert.equal(revoked.ok, true);
  assert.equal(plugin.settings.mf_us1_mode, 'legacy');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
});

test('revocation is refused while unresolved recovery exists', async () => {
  const { plugin } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  await plugin.mfUs1ActivateUnified();
  plugin.mfUs1Recovery = { healthy: true, recovered: ['pending-event'], blockedTopicIds: [] };
  const revoked = await plugin.mfUs1RevokeActivation();
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'E_RECOVERY_PENDING');
  assert.equal(plugin.settings.mf_us1_mode, 'unified', 'no silent fallback to Legacy');
});

test('diagnostics distinguish transport absence from runtime authorization', async () => {
  const { plugin } = setupPlugin();
  plugin.mfUs1AsyncLifecycle = null;
  let diagnostics = plugin.mfUs1ActivationDiagnostics();
  assert.equal(diagnostics.transportAvailable, false);
  assert.equal(diagnostics.runtime.present, false);

  plugin.mfUs1AsyncLifecycle = {
    runtime: {
      execute: async () => ({ status: 'failed' }),
      view: () => ({ mode: 'unified', allowed: false, writeEnabled: false, blockers: [{ code: 'RUNTIME_AUTHORIZATION_REQUIRED' }] }),
    },
  };
  diagnostics = plugin.mfUs1ActivationDiagnostics();
  assert.equal(diagnostics.transportAvailable, true);
  assert.equal(diagnostics.runtime.present, true);
  assert.equal(diagnostics.runtime.writeEnabled, false);
  assert.ok(diagnostics.runtime.blockers.includes('RUNTIME_AUTHORIZATION_REQUIRED'));
});
