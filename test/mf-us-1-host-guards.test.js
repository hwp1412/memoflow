'use strict';

// HOST-CLOSURE — residual direct writers are refused in Unified mode.
// Mock Obsidian only; no real vault.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

function setup(mode) {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  return { plugin, app };
}

function stopTimers(plugin) {
  if (plugin.sessionSaveTimer) {
    global.window.clearTimeout(plugin.sessionSaveTimer);
    plugin.sessionSaveTimer = null;
  }
}

function source(app, id = uuid(1)) {
  return makeFile(app, 'Sources/A.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 2, next_review: '2026-12-01', date_added: '2026-10-01',
    mf_id: id, mf_revision: 1, mf_scheduler_version: 1, mf_ideal_due: '2026-12-01',
    mf_not_before: 'null', mf_interval_days: 8,
  }, '# A\n');
}

function content(app, file) { return app.vault.readContent(file); }

test('unified mode blocks direct COMPLETE / RESET writes', async () => {
  const { plugin, app } = setup('unified');
  const file = source(app);
  const before = content(app, file);
  assert.equal(await plugin.markPathsDone([file.path], { confirm: false }), 0);
  assert.equal(await plugin.resetPaths([file.path], { confirm: false }), 0);
  assert.equal(content(app, file), before, 'no legacy field may be written in unified mode');
  assert.match(getNotices(app).join('\n'), /Unified 模式下暂不支持/);
});

test('unified mode blocks the legacy Mercy menu before any write', async () => {
  const { plugin, app } = setup('unified');
  const file = source(app);
  const before = content(app, file);
  app.__promptState.quality = 3;
  await plugin.mercy();
  assert.equal(content(app, file), before);
});

test('unified mode blocks the overload spread (dashboard and auto path)', async () => {
  const { plugin, app } = setup('unified');
  const file = source(app);
  const before = content(app, file);
  const result = await plugin.spreadOverdue([{ tfile: file, fm: { ...app.vault.readFm(file) } }], 7);
  assert.equal(result.status, 'blocked');
  assert.equal(content(app, file), before);

  app.__promptState.confirm = false;
  plugin.settings.misc.auto_overload = true;
  plugin.settings.misc.overload_threshold = 1;
  await plugin._maybeAutoOverload();
  assert.equal(content(app, file), before);
});

test('unified mode blocks direct extraction / split / import writers', async () => {
  const { plugin, app } = setup('unified');
  const file = source(app);
  const before = content(app, file);
  app.activeFile = file;
  await plugin.extractSelection();
  await plugin.importClipping();
  await plugin.splitArticle();
  await plugin.splitBook();
  assert.equal(content(app, file), before);
  assert.equal(app.vault.createCalls.length, 0, 'no new note may be created by blocked writers');
});

test('legacy mode keeps all of those writers working', async () => {
  const { plugin, app } = setup('legacy');
  const file = source(app);
  await plugin.markPathsDone([file.path], { confirm: false });
  assert.equal(String(app.vault.readFm(file).status), 'done', 'legacy writer still applies');
  stopTimers(plugin);
});

test('every residual writer that can write scheduling fields is guarded in source', () => {
  const sourceText = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const feature of [
    '移出队列（树）', '完成（直接写入）', '重置排期（直接写入）', '检查点',
    '父级 A-Factor 奖励', '导入剪藏', '拆分文章', '拆分书籍', '日期格式迁移',
    'Mercy（旧入口）', '划词摘录', '图片摘录',
  ]) {
    assert.ok(sourceText.includes(`_mfUs1GuardLegacyWrite('${feature}')`), `missing guard: ${feature}`);
  }
  const srcText = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(srcText, /_mfUs1GuardLegacyWrite\('Mercy（过载摊平）'\)/);
  assert.match(srcText, /Unified must never auto-run the legacy Mercy writer/);
});
