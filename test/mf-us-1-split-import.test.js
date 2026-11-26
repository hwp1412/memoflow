'use strict';

// HOST-CLOSURE — split flows through the creation gateway; import is migration.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { issueSyntheticCreationAuthorization } = require('../src/integration/topic-creation-host.js');

const LEGACY_FM = { type: 'source', source_type: 'article', status: 'active', priority: 40, interval: 8, next_review: '2026-11-20' };
const MIGRATED_FM = {
  ...LEGACY_FM,
  mf_id: uuid(1), mf_revision: 2, mf_scheduler_version: 1,
  mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8,
};
const BODY = '## Intro\n\nintro body\n\n## Body\n\nbody text\n';

function setup(mode = 'unified') {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  const file = makeFile(app, 'Sources/Article.md', mode === 'unified' ? MIGRATED_FM : LEGACY_FM, BODY);
  file.parent = { path: 'Sources' };
  app.activeFile = file;
  app.__promptState.longTexts = ['Intro\nBody'];
  return { plugin, app, file };
}

test('unified split without creation authorization writes nothing', async () => {
  const { plugin, app, file } = setup('unified');
  const before = app.vault.readContent(file);
  const result = await plugin.splitArticle();
  assert.equal(app.vault.createCalls.length, 0, 'no half-created unified topic');
  assert.equal(app.vault.readContent(file), before);
  assert.ok(result && result.failed === 2, JSON.stringify(result));
  assert.match(getNotices(app).join('\n'), /部分失败/);
});

test('unified split creates children through the gateway with persistent identity', async () => {
  const { plugin, app, file } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  const result = await plugin.splitArticle();
  assert.equal(result.failed, 0, JSON.stringify(result));
  const created = app.vault.createCalls;
  assert.equal(created.length, 2);
  for (const call of created) {
    const fm = app.vault.readFm(call.file);
    assert.ok(fm.mf_id, 'child has a persistent mf_id');
    assert.equal(fm.mf_root_id, fm.mf_id);
    assert.equal(Number(fm.mf_revision), 0);
    assert.equal(fm.status, 'active');
    assert.equal(fm.type, 'source');
    assert.ok(fm.mf_scheduler_version);
  }
  const parent = app.vault.readFm(file);
  assert.equal(parent.status, 'active', 'parent state is not rewritten directly in unified');
  assert.match(getNotices(app).join('\n'), /父来源状态未直接改写/);
});

test('running the split twice does not duplicate topics', async () => {
  const { plugin, app } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  await plugin.splitArticle();
  const creates = app.vault.createCalls.length;
  app.__promptState.longTexts = ['Intro\nBody'];
  await plugin.splitArticle();
  assert.equal(app.vault.createCalls.length, creates, 'existing children are skipped by path');
});

test('legacy split keeps its previous behaviour', async () => {
  const { plugin, app, file } = setup('legacy');
  // Legacy source without any mf_* identity.
  const legacy = makeFile(app, 'Sources/Legacy.md', LEGACY_FM, BODY);
  legacy.parent = { path: 'Sources' };
  app.activeFile = legacy;
  await plugin.splitArticle();
  assert.equal(app.vault.createCalls.length, 2);
  const parentFm = app.vault.readFm(legacy);
  assert.equal(parentFm.status, 'container');
});

test('importClipping in unified refuses to take over an existing note', async () => {
  const { plugin, app } = setup('unified');
  const clipping = makeFile(app, 'Inbox/Clipping.md', { title: 'Clipping' }, '', '# Paper\n\ntext\n');
  app.activeFile = clipping;
  const before = app.vault.readContent(clipping);
  const result = await plugin.importClipping();
  assert.equal(result.status, 'blocked');
  assert.equal(app.vault.readContent(clipping), before, 'no implicit identity migration');
  assert.match(getNotices(app).join('\n'), /迁移/);
});

test('unified book split keeps stable identity and root relations', async () => {
  const { plugin, app } = setup('unified');
  const book = makeFile(app, 'Sources/Book.md', {
    ...MIGRATED_FM,
    source_type: 'book',
    total_pages: 4,
  }, '# Book\n');
  book.parent = { path: 'Sources' };
  app.activeFile = book;
  app.__promptState.longTexts = ['1-2: Intro\n3-4: Body'];
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  const result = await plugin.splitBook();
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(app.vault.createCalls.length, 2);
  for (const call of app.vault.createCalls) {
    const fm = app.vault.readFm(call.file);
    assert.ok(fm.mf_id);
    assert.equal(fm.mf_root_id, fm.mf_id);
    assert.equal(fm.type, 'source');
    assert.equal(fm.status, 'active');
    assert.match(String(fm.read_point), /^\d+$/);
  }
  assert.equal(app.vault.readFm(book).status, 'active', 'parent not rewritten in unified');
});

test('an unrelated same-named file is an identity conflict, not a duplicate', async () => {
  const { plugin, app } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  // Same path the split would pick, but with no Unified identity.
  makeFile(app, 'Sources/Article - Intro.md', { type: 'note' }, '# unrelated\n');
  const result = await plugin.splitArticle();
  assert.ok(result.failed >= 1, JSON.stringify(result));
  assert.ok(result.failures.join(' ').includes('E_IDENTITY_CONFLICT'));
  assert.equal(app.vault.createCalls.length, 1, 'only the genuinely new child is created');
  const parentText = app.vault.readContent(app.vault.getAbstractFileByPath('Sources/Article.md'));
  assert.ok(!parentText.includes('[[Article - Intro]]'), 'conflicting file is not linked as a child');
});

test('a previously created child is a legitimate duplicate on re-run', async () => {
  const { plugin, app } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  makeFile(app, 'Sources/Article - Intro.md', {
    type: 'source',
    status: 'active',
    parent: '[[Article]]',
    mf_id: uuid(21),
    mf_revision: 0,
  }, '\n<!-- mf-split:split-article:Sources/Article.md:Intro -->\n');
  const result = await plugin.splitArticle();
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(app.vault.createCalls.length, 1, 'only Body is newly created');
});

test('book split treats a same-named unrelated chapter as an identity conflict', async () => {
  const { plugin, app } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  const book = makeFile(app, 'Sources/Book.md', { ...MIGRATED_FM, source_type: 'book', total_pages: 4 }, '# Book\n');
  book.parent = { path: 'Sources' };
  app.activeFile = book;
  app.__promptState.longTexts = ['1-2: Intro\n3-4: Body'];
  makeFile(app, 'Sources/Book - Ch01 Intro.md', { type: 'note' }, '# not ours\n');
  const result = await plugin.splitBook();
  assert.ok(result.failed >= 1, JSON.stringify(result));
  assert.ok(result.failures.join(' ').includes('E_IDENTITY_CONFLICT'));
  assert.equal(app.vault.createCalls.length, 1, 'only the genuinely new chapter is created');
});


test('a child of another parent is not a duplicate of this split', async () => {
  const { plugin, app } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  makeFile(app, 'Sources/Article - Intro.md', {
    type: 'source', status: 'active', parent: '[[Other Article]]', mf_id: uuid(22), mf_revision: 0,
  }, '\n<!-- mf-split:split-article:Sources/Article.md:Intro -->\n');
  const result = await plugin.splitArticle();
  assert.ok(result.failed >= 1, JSON.stringify(result));
  assert.ok(result.failures.join(' ').includes('E_IDENTITY_CONFLICT'));
  assert.equal(app.vault.createCalls.length, 1);
});

test('same parent and mf_id without the creation marker is still a conflict', async () => {
  const { plugin, app } = setup('unified');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  makeFile(app, 'Sources/Article - Intro.md', {
    type: 'source', status: 'active', parent: '[[Article]]', mf_id: uuid(23), mf_revision: 0,
  }, '# unrelated content, no creation marker\n');
  const result = await plugin.splitArticle();
  assert.ok(result.failed >= 1, JSON.stringify(result));
  assert.ok(result.failures.join(' ').includes('E_IDENTITY_CONFLICT'));
});
