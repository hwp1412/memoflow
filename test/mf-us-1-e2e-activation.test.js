'use strict';

// P3-02B — E2E-only activation entry (compiled in only for --e2e builds).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

function setupPlugin() {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  app.__promptState.confirm = true;
  return { plugin, app };
}

test('the E2E commands are guarded by a build-time constant', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
  assert.match(build, /--e2e/);
  assert.match(build, /__MF_E2E_TEST_BUILD__/);
  const guarded = source.slice(source.indexOf('if (__MF_E2E_TEST_BUILD__ === true) {'));
  const commandBlock = guarded.slice(0, guarded.indexOf('this.app.workspace.onLayoutReady'));
  assert.match(commandBlock, /e2e-activate-unified/);
  assert.match(commandBlock, /e2e-revoke-unified/);
  assert.match(commandBlock, /e2e-status/);
  // The command ids must not appear anywhere outside the guarded block.
  const occurrences = source.split('e2e-activate-unified').length - 1;
  assert.equal(occurrences, 1);
});

test('production builds cannot use the E2E activation entry', async () => {
  const { plugin } = setupPlugin();
  delete globalThis.__MF_E2E_TEST_BUILD__;
  const result = await plugin.mfUs1E2EActivateUnified();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'E_E2E_NOT_TEST_BUILD');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
});

test('an E2E build can activate an empty vault through the real gates', async () => {
  const { plugin } = setupPlugin();
  globalThis.__MF_E2E_TEST_BUILD__ = true;
  try {
    const result = await plugin.mfUs1E2EActivateUnified();
    assert.equal(result.ok, true, JSON.stringify(result.blockers || []));
    const diagnostics = plugin.mfUs1ActivationDiagnostics();
    assert.equal(diagnostics.authorized, true);
    assert.equal(diagnostics.migrationNotRequired, true);
    assert.match(plugin.mfUs1E2EStatusText(), /E2E 构建：是/);
    // The approval arm is one-shot: a second activation cannot reuse it without
    // the command (which re-arms explicitly).
    assert.equal(plugin.__mfUs1E2EApprovalArmed, false);
  } finally {
    delete globalThis.__MF_E2E_TEST_BUILD__;
  }
});
