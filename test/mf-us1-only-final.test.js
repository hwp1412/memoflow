'use strict';

// Final architecture: MF-US-1 is the only scheduler; old preferences are converted and never executed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlugin, makeFile, makeSettings } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function setup(mode = 'legacy') {
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

test('the effective scheduler is always MF-US-1, even with old legacy/shadow preferences', () => {
  for (const old of ['legacy', 'shadow', 'unified', 'weird']) {
    const { plugin } = setup(old);
    assert.equal(plugin._mfUs1EffectiveMode(), 'unified');
    assert.equal(plugin._mfUs1NormalizeMode(old), 'unified');
  }
});

test('old legacy preference is converted and saved on load, not resurrected', () => {
  assert.match(SOURCE, /const convertedMode = this\._mfUs1NormalizeMode\(this\.settings\.mf_us1_mode\)/);
  assert.match(SOURCE, /this\.settings\.mf_us1_mode = convertedMode/);
});

test('no runtime is ever built in legacy or shadow mode', () => {
  assert.equal(/mode: 'legacy'/.test(SOURCE), false, 'no legacy runtime construction');
  assert.equal(/mode: 'shadow'/.test(SOURCE), false, 'no shadow runtime construction');
  assert.equal(/shadowObserver/.test(SOURCE), false, 'shadow observer wiring is gone');
});

test('startup auto-wires MF-US-1; a real review writes Revision and Ledger', async () => {
  const { plugin, app } = setup('legacy');
  const auto = await plugin._mfUs1AutoStartRuntime();
  assert.equal(auto.ok, true, JSON.stringify(auto.blockers || []));
  assert.equal(plugin._mfUs1EffectiveMode(), 'unified');
  const file = makeFile(app, 'Sources/Final.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 1, next_review: '2026-11-10', last_reviewed: '2026-10-01', date_added: '2026-10-01',
    mf_id: uuid(950), mf_revision: 0, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-10', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
  }, '# Final\n');
  app.activeFile = file;
  app.__promptState.quality = 3;
  app.__promptState.confirm = true;
  const review = await plugin.endSession();
  assert.ok(review && review.status === 'applied', JSON.stringify(review));
  const fm = (app.metadataCache.getFileCache(file) || {}).frontmatter || {};
  assert.equal(Number(fm.mf_revision), 1);
  assert.ok(fm.mf_last_event_id && fm.mf_last_event_id !== 'null');
});

test('retired algorithm selection is refused and never executed', async () => {
  const { plugin } = setup('unified');
  for (const retired of ['legacy', 'shadow']) {
    const result = await plugin.setSchedulerMode(retired);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'E_ALGORITHM_RETIRED');
  }
  assert.equal(plugin._mfUs1EffectiveMode(), 'unified');
});
