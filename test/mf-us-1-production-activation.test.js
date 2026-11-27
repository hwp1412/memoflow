'use strict';

// P3-03 — formal user-facing activation entry (confirmation dialog, no test hooks).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

function setup() {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  plugin.mfUs1MigrationPreviewCache = null;
  plugin.__mfUs1BackupVerified = true;
  return { plugin, app };
}

test('the formal entry activates only after the user confirms', async () => {
  const { plugin, app } = setup();
  app.__promptState.confirm = false;
  const cancelled = await plugin.mfUs1ProductionActivate();
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.reason, 'E_CANCELLED');
  assert.notEqual(plugin.settings.mf_us1_mode, 'unified');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);

  app.__promptState.confirm = true;
  const activated = await plugin.mfUs1ProductionActivate();
  assert.equal(activated.ok, true, JSON.stringify(activated.blockers || []));
  assert.equal(plugin.settings.mf_us1_mode, 'unified');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, true);
  assert.equal(plugin.mfUs1ProductionApproval, false, 'one-shot approval flag is reset');
});

test('legacy topics block the formal entry and no authorization is issued', async () => {
  const { plugin, app } = setup();
  makeFile(app, 'Sources/Old.md', { type: 'source', status: 'active', priority: 50, interval: 8, next_review: '2026-11-20' }, '# old\n');
  app.__promptState.confirm = true;
  const result = await plugin.mfUs1ProductionActivate();
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('MIGRATION_INCOMPLETE'), JSON.stringify(result.blockers));
  assert.notEqual(plugin.settings.mf_us1_mode, 'unified');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
});

test('activation does not survive a restart and must be confirmed again', async () => {
  const first = setup();
  first.app.__promptState.confirm = true;
  const activated = await first.plugin.mfUs1ProductionActivate();
  assert.equal(activated.ok, true);

  // Simulate a reload: settings persist, tokens/session do not.
  const second = setup();
  second.plugin.settings = { ...first.plugin.settings };
  second.plugin.mfUs1Activation = null;
  second.plugin.mfUs1SessionCapabilities = null;
  assert.equal(second.plugin.mfUs1ActivationDiagnostics().authorized, false, 'no write authorization after restart');
  second.app.__promptState.confirm = false;
  const retry = await second.plugin.mfUs1ProductionActivate();
  assert.equal(retry.ok, false, 'a new explicit confirmation is required');
});

test('the formal revoke entry needs confirmation and then blocks writes', async () => {
  const { plugin, app } = setup();
  app.__promptState.confirm = true;
  await plugin.mfUs1ProductionActivate();
  const oldWriter = plugin.mfUs1AdminWriter;
  app.__promptState.confirm = false;
  const cancelled = await plugin.mfUs1ProductionRevoke();
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.reason, 'E_CANCELLED');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, true, 'cancel keeps the session');

  app.__promptState.confirm = true;
  const revoked = await plugin.mfUs1ProductionRevoke();
  assert.equal(revoked.ok, true);
  const diagnostics = plugin.mfUs1ActivationDiagnostics();
  assert.equal(diagnostics.authorized, false);
  assert.equal(diagnostics.suspended, true);
  const topic = app.vault.getAbstractFileByPath('Sources/RevokedProbe.md');
  assert.equal(topic, null);
  const write = await oldWriter.write({ topicId: uuid(999), updates: { mf_not_before: '2026-12-12' } });
  assert.equal(write.status, 'blocked');
});
