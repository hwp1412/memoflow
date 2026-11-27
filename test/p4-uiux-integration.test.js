'use strict';

// Integrated Phase 4 UI/UX: one simple algorithm selector, update check, live refresh.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const SETTINGS_VIEW = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'settings-tab.js'), 'utf8');

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

test('the everyday settings surface is the algorithm selector plus update check', () => {
  const display = SETTINGS_VIEW.slice(SETTINGS_VIEW.indexOf('display()'), SETTINGS_VIEW.indexOf('_about(root)'));
  assert.match(display, /this\._schedulerMode\(containerEl\)/);
  assert.match(display, /this\._updateCheck\(containerEl\)/);
  const selector = SETTINGS_VIEW.slice(SETTINGS_VIEW.indexOf('_schedulerMode(root)'), SETTINGS_VIEW.indexOf('_updateCheck(root)'));
  assert.match(selector, /新版 Unified（推荐）/);
  assert.match(selector, /旧版 Legacy/);
  assert.match(selector, /Shadow（高级诊断）/);
  assert.equal(/激活 Unified|授权|批准/.test(selector), false, 'no authorization workflow in everyday UI');
});

test('advanced tools expose a single algorithm entry', () => {
  const menu = SOURCE.slice(SOURCE.indexOf('advancedTools() {'), SOURCE.indexOf('sourcesFolder() {'));
  assert.match(menu, /调度算法…（Unified \/ Legacy \/ Shadow）/);
  assert.equal((menu.match(/mfUs1ProductionActivate|mfUs1ProductionRevoke/g) || []).length, 0);
});

test('activation and revocation refresh open views', async () => {
  const { plugin } = setup();
  let excerpt = 0;
  let tree = 0;
  plugin._refreshExcerptViews = () => { excerpt += 1; };
  plugin._refreshTreeViews = () => { tree += 1; };
  await plugin.setSchedulerMode('unified');
  assert.ok(excerpt >= 1);
  assert.ok(tree >= 1);
  await plugin.mfUs1RevokeUnifiedAuthorization();
  assert.ok(excerpt >= 2);
  assert.ok(tree >= 2);
});
