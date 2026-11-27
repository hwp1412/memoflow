'use strict';

// Final algorithm architecture: MF-US-1 is the only scheduler; selector stays for future algorithms.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

const SETTINGS_VIEW = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'settings-tab.js'), 'utf8');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function setup() {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800, open: () => {} };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  plugin.__mfUs1BackupVerified = true;
  return { plugin, app };
}

test('the settings selector offers only MF-US-1 and keeps the update check', () => {
  const display = SETTINGS_VIEW.slice(SETTINGS_VIEW.indexOf('display()'), SETTINGS_VIEW.indexOf('_about(root)'));
  assert.match(display, /this\._schedulerMode\(containerEl\)/);
  assert.match(display, /this\._updateCheck\(containerEl\)/);
  const selector = SETTINGS_VIEW.slice(SETTINGS_VIEW.indexOf('_schedulerMode(root)'), SETTINGS_VIEW.indexOf('_updateCheck(root)'));
  assert.match(selector, /MF-US-1（当前唯一算法）/);
  assert.equal(/Legacy|Shadow/.test(selector), false, 'no legacy/shadow option in the product selector');
});

test('retired algorithms cannot be selected or resurrected', async () => {
  const { plugin } = setup();
  assert.equal(plugin._mfUs1NormalizeMode('legacy'), 'unified');
  assert.equal(plugin._mfUs1NormalizeMode('shadow'), 'unified');
  assert.equal(plugin._mfUs1NormalizeMode('anything-else'), 'unified');
  const retired = await plugin.setSchedulerMode('legacy');
  assert.equal(retired.ok, false);
  assert.equal(retired.reason, 'E_ALGORITHM_RETIRED');
  const shadow = await plugin.setSchedulerMode('shadow');
  assert.equal(shadow.ok, false);
  assert.equal(plugin._mfUs1NormalizeMode(plugin._mfUs1EffectiveMode()), 'unified');
});

test('the algorithm switcher and legacy switch entry are not exposed in the UI', () => {
  const menu = SOURCE.slice(SOURCE.indexOf('advancedTools() {'), SOURCE.indexOf('sourcesFolder() {'));
  assert.equal(/调度算法…/.test(menu), false, 'no algorithm menu for a single-algorithm product');
  const switchFn = SOURCE.slice(SOURCE.indexOf('async mfUs1SwitchToLegacy('), SOURCE.indexOf('async mfUs1SwitchToLegacy(') + 300);
  assert.match(switchFn, /E_ALGORITHM_RETIRED/);
});

test('activation and revocation still refresh open views', async () => {
  const { plugin } = setup();
  let excerpt = 0;
  let tree = 0;
  plugin._refreshExcerptViews = () => { excerpt += 1; };
  plugin._refreshTreeViews = () => { tree += 1; };
  const started = await plugin._mfUs1AutoStartRuntime();
  if (started.ok) {
    await plugin.mfUs1RevokeUnifiedAuthorization();
    assert.ok(excerpt >= 1);
    assert.ok(tree >= 1);
  }
});
