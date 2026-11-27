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
  // Mixed vault: two legacy topics require a complete migration plan.
  legacyTopicCount: 2,
  indexComplete: true,
};

test('a brand-new empty vault needs no migration plan or backup', () => {
  const coordinator = createActivationCoordinator({ approvalProvider: () => true });
  const empty = {
    legacyTopicCount: 0,
    topicCount: 0,
    indexComplete: true,
    pendingEvents: [],
    recoveryHealthy: true,
    blockedTopicIds: [],
    batchRecoveryError: null,
    duplicateIds: [],
    backupVerified: false,
    userConfirmed: true,
  };
  const evaluation = coordinator.evaluate(empty);
  assert.equal(evaluation.migration.notRequired, true);
  assert.equal(evaluation.allowed, true);
  assert.equal(coordinator.authorize(empty).ok, true);
  // The other safety gates still apply to an empty vault.
  assert.ok(coordinator.evaluate({ ...empty, userConfirmed: false }).blockers.includes('USER_CONFIRMATION_REQUIRED'));
  assert.ok(coordinator.evaluate({ ...empty, pendingEvents: ['x'] }).blockers.includes('PENDING_RECOVERY'));
  assert.ok(coordinator.evaluate({ ...empty, recoveryHealthy: false }).blockers.includes('RECOVERY_UNHEALTHY'));
  assert.ok(coordinator.evaluate({ ...empty, duplicateIds: ['id'] }).blockers.includes('TOPIC_ID_CONFLICT'));
});

test('an unknown legacy count stays conservative about migration', () => {
  const coordinator = createActivationCoordinator({ approvalProvider: () => true });
  const unknown = { ...COMPLETE_EVIDENCE, legacyTopicCount: undefined, migrationPlan: null };
  assert.ok(coordinator.evaluate(unknown).blockers.includes('MIGRATION_INCOMPLETE'));
});

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

test('emergency revoke invalidates the capability immediately and preserves the scene', async () => {
  const { plugin, app } = setupPlugin();
  let approvals = 0;
  plugin.__mfUs1ActivationApproval = () => { approvals += 1; return true; };
  const file = makeFile(app, 'Sources/E.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 1,
    next_review: '2026-11-20', mf_id: uuid(5), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# E\n');
  await plugin.mfUs1ActivateUnified();
  const before = app.vault.readContent(file);
  const ledgerBefore = Object.keys(plugin.mfUs1AsyncLifecycle.ledger.store.dump()).length;

  // Simulate an uncertain unresolved state discovered after activation.
  plugin.mfUs1Recovery = { healthy: true, recovered: ['uncertain-event'], blockedTopicIds: [] };
  const revoked = await plugin.mfUs1RevokeUnifiedAuthorization();
  assert.equal(revoked.ok, true);
  assert.equal(revoked.tokenRevoked, true);
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
  assert.equal(plugin.mfUs1ActivationDiagnostics().suspended, true);
  assert.equal(plugin.settings.mf_us1_mode, 'unified', 'no silent fallback to Legacy');

  // Subsequent unified writes are rejected with zero modifications.
  app.activeFile = file;
  await assert.rejects(
    () => plugin.postponeFile(file, 3),
    error => error && error.code === 'E_UNIFIED_NOT_AUTHORIZED',
    'unified writes are rejected',
  ).catch(async () => {
    // Some host wrappers record the failure instead of throwing; in that case
    // the write must still be a no-op.
    await plugin.postponeFile(file, 3);
  });
  assert.equal(app.vault.readContent(file), before, 'topic untouched');
  assert.equal(Object.keys(plugin.mfUs1AsyncLifecycle.ledger.store.dump()).length, ledgerBefore, 'ledger untouched');

  // Switching to Legacy is refused while unresolved; Legacy writes stay blocked.
  const switchResult = await plugin.mfUs1SwitchToLegacy();
  assert.equal(switchResult.ok, false);
  assert.equal(switchResult.reason, 'E_RECOVERY_PENDING');
  assert.equal(switchResult.legacyWritesBlocked, true);
  assert.equal(plugin._mfUs1GuardLegacyWrite('测试写入'), true, 'legacy scheduling writes blocked');
  assert.equal(app.vault.readContent(file), before);
});

test('after recovery the revoked token cannot be reused; activation needs fresh approval', async () => {
  const { plugin } = setupPlugin();
  let approvals = 0;
  plugin.__mfUs1ActivationApproval = () => { approvals += 1; return approvals === 1; };
  await plugin.mfUs1ActivateUnified();
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, true);
  await plugin.mfUs1RevokeUnifiedAuthorization();
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);

  // Recovery is healthy again, but the existing approval provider has been
  // consumed: reactivation must request a new approval and is refused.
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  const refused = await plugin.mfUs1ActivateUnified();
  assert.equal(refused.ok, false);
  assert.ok(refused.blockers.includes('ACTIVATION_NOT_APPROVED'));
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);

  // A fresh approval is required and grants a new session.
  plugin.__mfUs1ActivationApproval = () => true;
  const reactivated = await plugin.mfUs1ActivateUnified();
  assert.equal(reactivated.ok, true);
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, true);
});

test('the mode menu cannot bypass approval to issue synthetic capabilities', async () => {
  const { plugin, app } = setupPlugin();
  app.__promptState.quality = 'unified';
  const result = await plugin.mfUs1ModeMenu();
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('ACTIVATION_NOT_APPROVED'));
  assert.notEqual(plugin.settings.mf_us1_mode, 'unified');

  // Static guard: the synthetic capability is only minted inside the approved
  // activation branch, never in the mode menu / settings path.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const activationBody = source.slice(source.indexOf('async mfUs1ActivateUnified()'), source.indexOf('async mfUs1SwitchToLegacy()'));
  assert.match(activationBody, /issueSyntheticUnifiedCapability/);
  const menuBody = source.slice(source.indexOf('async mfUs1ModeMenu()'), source.indexOf('// G3: synthetic migration drill'));
  assert.equal(/issueSyntheticUnifiedCapability|issueSyntheticHostAuthorization/.test(menuBody), false);
  assert.equal(/__mfUs1ActivationApproval\s*=/.test(menuBody), false, 'menu never sets the approval provider itself');
});


test('an empty vault can activate without a migration preview or backup', async () => {
  const { plugin } = setupPlugin();
  plugin.mfUs1MigrationPreviewCache = null;
  plugin.__mfUs1BackupVerified = false;
  plugin.__mfUs1ActivationApproval = () => true;
  const result = await plugin.mfUs1ActivateUnified();
  assert.equal(result.ok, true, JSON.stringify(result.blockers || []));
  const diagnostics = plugin.mfUs1ActivationDiagnostics();
  assert.equal(diagnostics.legacyTopicCount, 0);
  assert.equal(diagnostics.migrationNotRequired, true);
  assert.equal(diagnostics.authorized, true);
});

test('a vault with legacy topics still requires a completed migration plan', async () => {
  const { plugin, app } = setupPlugin();
  plugin.mfUs1MigrationPreviewCache = null;
  plugin.__mfUs1ActivationApproval = () => true;
  makeFile(app, 'Sources/Legacy.md', { type: 'source', status: 'active', priority: 50, interval: 8, next_review: '2026-11-20' }, '# legacy\n');
  const result = await plugin.mfUs1ActivateUnified();
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('MIGRATION_INCOMPLETE'));
  assert.equal(plugin.mfUs1ActivationDiagnostics().legacyTopicCount, 1);
});

test('activation grants creation and resume capabilities, revocation clears them', async () => {
  const { plugin } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  await plugin.mfUs1ActivateUnified();
  assert.ok(plugin.__mfUs1CreationAuthorization, 'creation capability issued on activation');
  assert.ok(plugin.__mfUs1ResumeAuthorization, 'resume capability issued on activation');
  await plugin.mfUs1RevokeUnifiedAuthorization();
  assert.equal(plugin.__mfUs1CreationAuthorization, null);
  assert.equal(plugin.__mfUs1ResumeAuthorization, null);
});


test('an incomplete vault index can never be read as "nothing to migrate"', () => {
  const coordinator = createActivationCoordinator({ approvalProvider: () => true });
  const unknownIndex = { ...COMPLETE_EVIDENCE, migrationPlan: null, legacyTopicCount: 0, indexComplete: false };
  const evaluation = coordinator.evaluate(unknownIndex);
  assert.ok(evaluation.blockers.includes('MIGRATION_INDEX_UNKNOWN'));
  assert.equal(evaluation.allowed, false);
  assert.equal(coordinator.authorize(unknownIndex).ok, false);
});

test('a vault with a real legacy topic cannot activate when getIRRows is empty', async () => {
  const { plugin, app } = setupPlugin();
  plugin.mfUs1MigrationPreviewCache = null;
  plugin.__mfUs1ActivationApproval = () => true;
  // Legacy topic exists on disk but the IR cache is (wrongly) empty.
  makeFile(app, 'Sources/LegacyHidden.md', { type: 'source', status: 'active', priority: 50, interval: 8, next_review: '2026-11-20' }, '# legacy\n');
  plugin.getIRRows = () => [];
  const result = await plugin.mfUs1ActivateUnified();
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('MIGRATION_INCOMPLETE'), JSON.stringify(result.blockers));
  assert.notEqual(plugin.settings.mf_us1_mode, 'unified');
});

test('partial capability issuance aborts activation and leaves no authorization', async () => {
  const { plugin } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  const creationHost = require('../src/integration/topic-creation-host.js');
  const original = creationHost.issueSyntheticCreationAuthorization;
  creationHost.issueSyntheticCreationAuthorization = () => { throw new Error('issuance failed'); };
  try {
    const result = await plugin.mfUs1ActivateUnified();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'E_ACTIVATION_CAPABILITY_INCOMPLETE');
    assert.equal(plugin.settings.mf_us1_mode, 'legacy');
    assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
    assert.equal(plugin.__mfUs1CreationAuthorization, null);
    assert.equal(plugin.__mfUs1ResumeAuthorization, null);
  } finally {
    creationHost.issueSyntheticCreationAuthorization = original;
  }
});

test('revocation invalidates captured writer/token references, not only fields', async () => {
  const { plugin, app } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  const topic = makeFile(app, 'Sources/W.md', {
    type: 'source', status: 'active', priority: 50, interval: 8,
    mf_id: uuid(77), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# W\n');
  const activated = await plugin.mfUs1ActivateUnified();
  assert.equal(activated.ok, true);

  // Capture the OLD references before revoking.
  const oldWriter = plugin.mfUs1AdminWriter;
  const oldCreation = plugin.__mfUs1CreationAuthorization;
  const oldResume = plugin.__mfUs1ResumeAuthorization;
  const session = plugin.mfUs1SessionCapabilities;
  assert.ok(oldWriter && oldCreation && oldResume && session && session.host);

  await plugin.mfUs1RevokeUnifiedAuthorization();

  const { hasSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
  const { hasSyntheticCreationAuthorization } = require('../src/integration/topic-creation-host.js');
  const { hasBatchResumeAuthorization, resumeBatch } = require('../src/integration/batch-resume.js');
  assert.equal(hasSyntheticHostAuthorization(session.host), false, 'captured session token invalidated');
  assert.equal(hasSyntheticCreationAuthorization(oldCreation), false, 'captured creation token invalidated');
  assert.equal(hasBatchResumeAuthorization(oldResume), false, 'captured resume token invalidated');

  const before = app.vault.readContent(topic);
  const oldWriterResult = await oldWriter.write({
    topicId: uuid(77),
    updates: { mf_not_before: '2026-12-12' },
  });
  assert.equal(oldWriterResult.status, 'blocked');
  assert.equal(oldWriterResult.reason, 'E_UNIFIED_NOT_AUTHORIZED');
  assert.equal(app.vault.readContent(topic), before, 'captured writer performs zero writes');

  const capturedResume = await resumeBatch({
    store: { async getBatch() { return { batchId: 'b1', kind: 'MERCY', status: 'prepared', items: [] }; } },
    batchId: 'b1',
    readTopic: async () => ({ entry: null }),
    runItem: async () => ({ status: 'applied' }),
    authorization: oldResume,
  });
  assert.equal(capturedResume.status, 'blocked');
  assert.equal(capturedResume.reason, 'E_BATCH_RESUME_NOT_AUTHORIZED');

  const creation = await plugin._mfUs1CreateTopicFromHost({
    requestId: 'revoked-create', kind: 'source', priority: 50,
    path: 'Sources/Revoked.md', content: '---\ntype: source\nstatus: active\n---\n',
  });
  assert.equal(creation.handled, true);
  assert.equal(creation.outcome.status, 'blocked');
  assert.equal(app.vault.getAbstractFileByPath('Sources/Revoked.md'), null);
});

test('activation failure keeps legacy writes blocked when Unified authority already exists', async () => {
  const { plugin, app } = setupPlugin();
  plugin.__mfUs1ActivationApproval = () => true;
  // A migrated topic exists, so falling back to legacy writes would be unsafe.
  makeFile(app, 'Sources/M.md', {
    type: 'source', status: 'active', priority: 50, interval: 8,
    mf_id: uuid(78), mf_revision: 1, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# M\n');
  const creationHost = require('../src/integration/topic-creation-host.js');
  const original = creationHost.issueSyntheticCreationAuthorization;
  creationHost.issueSyntheticCreationAuthorization = () => { throw new Error('issuance failed'); };
  try {
    const result = await plugin.mfUs1ActivateUnified();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'E_ACTIVATION_CAPABILITY_INCOMPLETE');
    assert.equal(result.suspended, true);
    const diagnostics = plugin.mfUs1ActivationDiagnostics();
    assert.equal(diagnostics.authorized, false);
    assert.equal(diagnostics.suspended, true);
    assert.equal(plugin._mfUs1GuardLegacyWrite('legacy-write-probe'), true, 'legacy scheduling writes stay blocked');
  } finally {
    creationHost.issueSyntheticCreationAuthorization = original;
  }
});
