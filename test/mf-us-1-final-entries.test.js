'use strict';

// HOST-CLOSURE final entries — R3 checkpoint metadata, SKIP pointer, Shadow.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

function fmBase(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 2,
    last_reviewed: '2026-10-01', next_review: '2026-11-20', date_added: '2026-09-01',
    mf_id: id, mf_revision: 1, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
    ...overrides,
  };
}

function setup(mode, overrides = {}) {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  const file = makeFile(app, 'Sources/A.md', fmBase(uuid(1), overrides), '# body\n\ntext\n');
  app.activeFile = file;
  return { plugin, app, file };
}

test('unified checkpoint saves reading metadata only', async () => {
  const { plugin, app, file } = setup('unified');
  const result = await plugin.addCheckpoint('reached section 2');
  assert.equal(result.ok, true);
  const fm = app.vault.readFm(file);
  assert.equal(Array.isArray(fm.checkpoints), true);
  assert.equal(fm.checkpoints[0].note, 'reached section 2');
  assert.equal(Number(fm.mf_revision), 1, 'revision unchanged');
  assert.equal(String(fm.mf_not_before), 'null');
  assert.equal(Number(fm.interval), 8, 'interval unchanged');
  assert.equal(Number(fm.priority), 50);
  assert.match(getNotices(app).join('\n'), /仅阅读元数据/);
});

test('unified checkpoint refuses an interval override instead of rewriting scheduling', async () => {
  const { plugin, app, file } = setup('unified');
  const before = app.vault.readContent(file);
  await plugin.addCheckpoint('7d::push out');
  assert.equal(app.vault.readContent(file), before);
  assert.match(getNotices(app).join('\n'), /不能修改学习间隔/);
});



test('skip only moves the session pointer and never writes scheduling fields', async () => {
  const { plugin, app, file } = setup('unified');
  const before = app.vault.readContent(file);
  const calls = { consumed: 0, advanced: 0 };
  plugin._activateReadingFile = async () => {};
  plugin._nextSessionTarget = () => null;
  plugin.consumeSessionItem = async () => { calls.consumed += 1; };
  plugin._openNextSessionTarget = async () => { calls.advanced += 1; };
  await plugin._runReadingAction('skip', file);
  assert.equal(calls.consumed, 1);
  assert.equal(calls.advanced, 1);
  assert.equal(app.vault.readContent(file), before, 'SKIP is session-only');
});
