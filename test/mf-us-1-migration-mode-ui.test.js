'use strict';

// HOST-CLOSURE — read-only migration preview and gated mode switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

function setup(mode = 'legacy') {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  return { plugin, app };
}

test('migration preview is read-only and reports the legacy diff', async () => {
  const { plugin, app } = setup();
  const legacy = makeFile(app, 'Sources/A.md', { type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 1, next_review: '2026-11-20' }, '# A\n');
  makeFile(app, 'Extracts/B.md', { type: 'extract', status: 'active', priority: 50, interval: 4, next_review: '2026-11-21', source: '[[A]]' }, '# B\n');
  const before = app.vault.readContent(legacy);
  const plan = await plugin.mfUs1MigrationPreview();
  assert.ok(plan);
  assert.equal(plan.writesPerformed, false);
  assert.equal(plan.summary.total, 2);
  assert.equal(app.vault.readContent(legacy), before, 'preview must not touch the topic');
  assert.equal(app.vault.createCalls.length, 0);
  assert.match(getNotices(app).join('\n'), /迁移预检（只读，未写入）/);
});

test('mode switch can select shadow but never activates unified', async () => {
  const { plugin, app } = setup();
  app.__promptState.quality = 'shadow';
  const switched = await plugin.mfUs1ModeMenu();
  assert.equal(switched.ok, true);
  assert.equal(plugin.settings.mf_us1_mode, 'shadow');

  const before = plugin.settings.mf_us1_mode;
  app.__promptState.quality = 'unified';
  const refused = await plugin.mfUs1ModeMenu();
  assert.equal(refused.ok, false);
  assert.ok(refused.blockers.length > 0);
  assert.equal(plugin.settings.mf_us1_mode, before, 'mode must not change when activation is blocked');
  assert.match(getNotices(app).join('\n'), /Unified 不可激活/);
});

test('diagnostics exposes shadow and migration state', () => {
  const { plugin } = setup('shadow');
  const text = String(plugin.mfUs1Diagnostics());
  assert.match(text, /Shadow 最近差异/);
  assert.match(text, /迁移预检/);
});
