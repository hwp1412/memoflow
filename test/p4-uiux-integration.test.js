'use strict';

// Phase 4 — UI/UX integration: one canonical Unified entry, settings surface, live refresh.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function slice(startNeedle, endNeedle) {
  const start = SOURCE.indexOf(startNeedle);
  assert.ok(start >= 0, `missing ${startNeedle}`);
  const end = SOURCE.indexOf(endNeedle, start);
  assert.ok(end > start, `missing end ${endNeedle}`);
  return SOURCE.slice(start, end);
}

function setup() {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  plugin.__mfUs1BackupVerified = true;
  app.__promptState.confirm = true;
  return { plugin, app };
}

test('settings expose the Unified scheduler status and the only activation buttons', () => {
  const display = slice('  display() {', '  _about(root) {');
  assert.match(display, /this\._unifiedScheduler\(containerEl\)/);
  const section = slice('  _unifiedScheduler(root) {', '  _numberSetting(');
  assert.match(section, /Unified Scheduler \(MF-US-1\)/);
  assert.match(section, /mfUs1ActivationDiagnostics\(\)/);
  assert.match(section, /activationBlockers/);
  assert.match(section, /mfUs1ProductionActivate\(\)/);
  assert.match(section, /mfUs1ProductionRevoke\(\)/);
  assert.match(section, /重启后必须重新确认/);
  assert.match(section, /旧库迁移暂不支持/);
});

test('advanced tools keep one Unified entry instead of duplicating activation', () => {
  const menu = slice('  advancedTools() {', '  sourcesFolder()');
  assert.match(menu, /MF-US-1 模式切换/);
  assert.equal((menu.match(/mfUs1ProductionActivate/g) || []).length, 0, 'settings owns activation; menu must not duplicate it');
  assert.equal((menu.match(/mfUs1ProductionRevoke/g) || []).length, 0, 'settings owns revocation; menu must not duplicate it');
  assert.match(menu, /MF-US-1 diagnostics/);
});

test('activation and revocation refresh open views so status is not stale', async () => {
  const { plugin } = setup();
  let excerpt = 0;
  let tree = 0;
  plugin._refreshExcerptViews = () => { excerpt += 1; };
  plugin._refreshTreeViews = () => { tree += 1; };
  const activated = await plugin.mfUs1ProductionActivate();
  assert.equal(activated.ok, true);
  assert.ok(excerpt >= 1, 'queue/dashboard refreshed after activation');
  assert.ok(tree >= 1, 'tree refreshed after activation');
  const revoked = await plugin.mfUs1ProductionRevoke();
  assert.equal(revoked.ok, true);
  assert.ok(excerpt >= 2, 'views refreshed after revocation');
  assert.ok(tree >= 2, 'tree refreshed after revocation');
});

test('the mode menu labels Unified as requiring confirmation', () => {
  assert.match(SOURCE, /Unified（需确认激活）/);
  const menu = slice('  advancedTools() {', '  sourcesFolder()');
  assert.match(menu, /Unified 需在设置中确认激活/);
});
