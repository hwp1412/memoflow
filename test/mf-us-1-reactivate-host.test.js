'use strict';

// HOST-CLOSURE — REACTIVATE finally has a host entry. Mock Obsidian only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

function setup(mode, status = 'done') {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  const file = makeFile(app, 'Sources/Done.md', {
    type: 'source', status, priority: 50, interval: 8, a_factor: 1.5,
    review_count: 3, next_review: '2026-11-01', date_added: '2026-10-01',
    date_done: '2026-11-20',
    mf_id: uuid(1), mf_revision: 4, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-01', mf_not_before: '2026-11-30', mf_interval_days: 8,
  }, '# Done\n');
  app.activeFile = file;
  return { plugin, app, file };
}


test('reactivate cancels without an event or a write', async () => {
  const { plugin, app, file } = setup('legacy');
  const before = app.vault.readContent(file);
  app.__promptState.texts = [''];
  const result = await plugin.reactivateCurrent();
  assert.equal(result, null);
  assert.equal(app.vault.readContent(file), before);
});

test('reactivate refuses an active topic and a card', async () => {
  const { plugin, app } = setup('legacy', 'active');
  const active = await plugin.reactivateCurrent();
  assert.equal(active, null);
  assert.match(getNotices(app).join('\n'), /不是已完成/);

  const card = makeFile(app, 'Cards/C1.md', { type: 'card', status: 'done', mf_id: uuid(2), mf_revision: 0 }, '# card\n');
  app.activeFile = card;
  const cardResult = await plugin.reactivateCurrent();
  assert.equal(cardResult, null);
  assert.match(getNotices(app).join('\n'), /卡片/);
});

test('reactivate in unified mode fails closed without a transport', async () => {
  const { plugin, app, file } = setup('unified');
  const before = app.vault.readContent(file);
  app.__promptState.texts = ['2026-12-20'];
  const result = await plugin.reactivateCurrent();
  assert.ok(['failed', 'conflict', 'uncertain', 'requires-manual-recovery'].includes(result.status), result.status);
  assert.equal(app.vault.readContent(file), before, 'no legacy fallback in unified mode');
});
