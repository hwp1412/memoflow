'use strict';

// UX simplification: Unified by default, persistent choice, no approval dialogs, GitHub update check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const SETTINGS_VIEW = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'settings-tab.js'), 'utf8');

function setup(mode = 'unified') {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800, open: () => {} };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  plugin.__mfUs1BackupVerified = true;
  return { plugin, app };
}

test('a fresh install defaults to Unified', () => {
  assert.match(SOURCE, /mf_us1_mode: 'unified'/);
  const { plugin } = setup();
  assert.equal(plugin._mfUs1EffectiveMode(), 'unified');
});

test('the real settings tab offers a simple algorithm selector and update check', () => {
  assert.match(SETTINGS_VIEW, /this\._schedulerMode\(containerEl\)/);
  assert.match(SETTINGS_VIEW, /this\._updateCheck\(containerEl\)/);
  assert.match(SETTINGS_VIEW, /MF-US-1（当前唯一算法）/);
  assert.equal(/addOption\('legacy'/.test(SETTINGS_VIEW), false, 'no legacy option in product selector');
  assert.match(SETTINGS_VIEW, /检查更新/);
  const modeSection = SETTINGS_VIEW.slice(SETTINGS_VIEW.indexOf('_schedulerMode(root)'), SETTINGS_VIEW.indexOf('_updateCheck(root)'));
  assert.equal(/授权|批准|approval|激活 Unified/.test(modeSection), false, 'no authorization jargon in the everyday selector');
});

test('startup auto-authorizes Unified without any dialog and persists across restart', async () => {
  const { plugin, app } = setup();
  const result = await plugin._mfUs1AutoStartRuntime();
  assert.equal(result.ok, true, JSON.stringify(result.blockers || []));
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, true);
  assert.equal(getNotices(app).length, 0, 'no user-facing authorization prompts on startup');

  // restart: settings persist, session does not; auto-start wires it back.
  const second = setup('unified');
  assert.equal(second.plugin.mfUs1ActivationDiagnostics().authorized, false);
  const restarted = await second.plugin._mfUs1AutoStartRuntime();
  assert.equal(restarted.ok, true);
  assert.equal(second.plugin.mfUs1ActivationDiagnostics().authorized, true);
});

test('legacy preferences are coerced to MF-US-1 instead of resurrecting old algorithms', async () => {
  const { plugin } = setup('legacy');
  assert.equal(plugin._mfUs1NormalizeMode(plugin.settings.mf_us1_mode), 'unified');
  const retired = await plugin.setSchedulerMode('legacy');
  assert.equal(retired.ok, false);
  assert.equal(retired.reason, 'E_ALGORITHM_RETIRED');
  assert.equal(plugin._mfUs1NormalizeMode(plugin.settings.mf_us1_mode), 'unified', 'old preference never comes back');
});

test('legacy data blocks Unified writes without silently switching algorithm', async () => {
  const { plugin, app } = setup();
  makeFile(app, 'Sources/Old.md', { type: 'source', status: 'active', priority: 50, interval: 8, next_review: '2026-11-20' }, '# old\n');
  const result = await plugin._mfUs1AutoStartRuntime();
  assert.equal(result.ok, false);
  assert.ok((result.blockers || []).includes('MIGRATION_INCOMPLETE'));
  assert.equal(plugin.settings.mf_us1_mode, 'unified', 'mode is kept, not switched to legacy');
  assert.equal(plugin.mfUs1ActivationDiagnostics().authorized, false);
  assert.match(getNotices(app).join('\n'), /当前无法启用 Unified 写入/);
});

test('update check handles release, no-release and failure states', async () => {
  const { plugin } = setup();
  plugin.manifest = { version: '0.1.0' };
  const latest = await plugin.checkForUpdates(async () => ({ status: 200, json: { tag_name: 'v0.2.0', body: 'notes', html_url: 'https://x' } }));
  assert.equal(latest.state, 'update');
  assert.equal(latest.latest, 'v0.2.0');
  const same = await plugin.checkForUpdates(async () => ({ status: 200, json: { tag_name: 'v0.1.0', body: '' } }));
  assert.equal(same.state, 'latest');
  const none = await plugin.checkForUpdates(async () => ({ status: 404 }));
  assert.equal(none.state, 'no-release');
  const failure = await plugin.checkForUpdates(async () => { throw new Error('offline'); });
  assert.equal(failure.state, 'error');
  assert.equal(plugin._compareVersions('0.10.0', '0.9.9'), 1);
});

test('a retired legacy switch never breaks Unified review', async () => {
  const { plugin, app } = setup();
  const file = makeFile(app, 'Sources/Cycle.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 1, next_review: '2026-11-10', last_reviewed: '2026-10-01', date_added: '2026-10-01',
    mf_id: uuid(901), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-10', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# Cycle\n');
  const first = await plugin.setSchedulerMode('unified');
  assert.equal(first.ok, true, JSON.stringify(first.blockers || []));
  const retired = await plugin.setSchedulerMode('legacy');
  assert.equal(retired.ok, false);
  app.activeFile = file;
  app.__promptState.quality = 3;
  app.__promptState.confirm = true;
  const review = await plugin.endSession();
  assert.ok(review, 'review still works while MF-US-1 is the only algorithm');
  const fm = (app.metadataCache.getFileCache(file) || {}).frontmatter || {};
  assert.equal(Number(fm.mf_revision), 1, 'Unified review write applied');
});

test('update check handles release, no-release and failure states', async () => {
  const { plugin } = setup();
  plugin.manifest = { version: '0.1.0' };
  const latest = await plugin.checkForUpdates(async () => ({ status: 200, json: { tag_name: 'v0.2.0', body: 'notes', html_url: 'https://x' } }));
  assert.equal(latest.state, 'update');
  assert.equal(latest.latest, 'v0.2.0');
  const same = await plugin.checkForUpdates(async () => ({ status: 200, json: { tag_name: 'v0.1.0', body: '' } }));
  assert.equal(same.state, 'latest');
  const none = await plugin.checkForUpdates(async () => ({ status: 404 }));
  assert.equal(none.state, 'no-release');
  const failure = await plugin.checkForUpdates(async () => { throw new Error('offline'); });
  assert.equal(failure.state, 'error');
  assert.equal(plugin._compareVersions('0.10.0', '0.9.9'), 1);
});

test('a retired legacy switch never breaks Unified review', async () => {
  const { plugin, app } = setup();
  const file = makeFile(app, 'Sources/Cycle.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 1, next_review: '2026-11-10', last_reviewed: '2026-10-01', date_added: '2026-10-01',
    mf_id: uuid(901), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-10', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# Cycle\n');
  const first = await plugin.setSchedulerMode('unified');
  assert.equal(first.ok, true, JSON.stringify(first.blockers || []));
  const retired = await plugin.setSchedulerMode('legacy');
  assert.equal(retired.ok, false);
  app.activeFile = file;
  app.__promptState.quality = 3;
  app.__promptState.confirm = true;
  const review = await plugin.endSession();
  assert.ok(review, 'review still works while MF-US-1 is the only algorithm');
  const fm = (app.metadataCache.getFileCache(file) || {}).frontmatter || {};
  assert.equal(Number(fm.mf_revision), 1, 'Unified review write applied');
});

