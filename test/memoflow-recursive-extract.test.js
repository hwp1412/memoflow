'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const treeCore = require('../tree-core.js');
const dateCore = require('../date-core.js');
const {
  createPlugin,
  makeFile,
  makeSettings,
  withFrozenDate,
  flushAsync,
} = require('./helpers/obsidian-mock.js');

function setup(t) {
  const date = withFrozenDate(t);
  const today = dateCore.formatDate(date, 'YYYY-MM-DD');
  const { plugin, app } = createPlugin({ settings: makeSettings({}, today), today });
  return { plugin, app, today };
}

function addSource(app, path = 'Sources/Source.md', overrides = {}) {
  return makeFile(app, path, {
    type: 'source',
    status: 'active',
    priority: 50,
    a_factor: 1.5,
    read_point: 10,
    total_pages: 100,
    ...overrides,
  }, '# Source\n');
}

function addExtract(app, path, { parent = null, source = '[[Source]]', priority = 50 } = {}) {
  return makeFile(app, path, {
    type: 'extract',
    status: 'pending',
    source,
    ...(parent ? { parent: `[[${parent}]]` } : {}),
    priority,
    interval: 8,
    review_count: 0,
    a_factor: 2,
    next_review: '2026-12-02',
  }, '# Extract\n');
}

function content(app, file) {
  return app.vault.readContent(file);
}

function rows(plugin) {
  return plugin.getIRRows().map(row => ({
    path: row.tfile.path,
    basename: row.tfile.basename,
    fm: row.fm,
  }));
}

async function createChild(plugin, app, parent, text, page) {
  app.activeFile = parent;
  const created = await plugin.createTimestampExtract({ text, page, open: false });
  assert.ok(created, `expected child extract for ${text}`);
  return created;
}












test('P1 safety: cross-source boost from the original source does not touch moved extracts', async (t) => {
  const { plugin, app } = setup(t);
  const sourceA = addSource(app, 'Sources/Source-A.md');
  const sourceB = addSource(app, 'Sources/Source-B.md');
  const e1 = addExtract(app, 'Extracts/Moved-E1.md', { parent: 'Source-A', source: '[[Source-A]]' });
  const e2 = addExtract(app, 'Extracts/Moved-E2.md', { parent: 'Moved-E1', source: '[[Source-A]]' });
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  app.activeFile = e1;
  await plugin.reparent(e1.path, 'Source-B');
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const index = treeCore.buildTreeIndex(rows(plugin));
  assert.equal(index.childrenOf.get('source-b').some(page => page.basename === 'Moved-E1'), true);
  assert.equal(app.vault.readFm(e1).parent, '[[Source-B]]');
  assert.equal(app.vault.readFm(e1).source, '[[Source-A]]');
  const e1WritesBefore = app.fileManager.writes.filter(write => write.file.path === e1.path).length;
  const e2WritesBefore = app.fileManager.writes.filter(write => write.file.path === e2.path).length;
  app.activeFile = sourceA;
  app.__promptState.quality = 5;
  app.__promptState.confirm = true;
  await plugin.boost();
  // P1-SAFETY-1: source is fallback only when parent is absent. A moved
  // Extract is no longer a child of its original source.
  assert.equal(app.vault.readFm(e1).priority, 50);
  assert.equal(app.vault.readFm(e2).priority, 50);
  assert.equal(app.fileManager.writes.filter(write => write.file.path === e1.path).length, e1WritesBefore);
  assert.equal(app.fileManager.writes.filter(write => write.file.path === e2.path).length, e2WritesBefore);
  assert.notEqual(index.childrenOf.get('source-a')?.some(page => page.basename === 'Moved-E1'), true);
  assert.equal(sourceA.basename, 'Source-A');
  assert.equal(sourceB.basename, 'Source-B');
});


test('deleting a parent leaves the child in the tree as a root', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  const e1 = addExtract(app, 'Extracts/Delete-E1.md', { parent: 'Source', source: '[[Source]]' });
  const e2 = addExtract(app, 'Extracts/Delete-E2.md', { parent: 'Delete-E1', source: '[[Source]]' });
  app.vault.entries.delete(e1.path);
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const index = treeCore.buildTreeIndex(rows(plugin));
  assert.equal(index.roots.some(page => page.basename === 'Delete-E2'), true);
  assert.equal(app.vault.getAbstractFileByPath(e2.path)?.path, e2.path);
  assert.equal(app.vault.readFm(e2).parent, '[[Delete-E1]]');
  assert.equal(app.vault.readFm(e2).source, '[[Source]]');
});



test('P1 safety: cross-source postpone from the original source does not touch moved extracts', async (t) => {
  const { plugin, app } = setup(t);
  const sourceA = addSource(app, 'Sources/Postpone-A.md');
  const sourceB = addSource(app, 'Sources/Postpone-B.md');
  const e1 = addExtract(app, 'Extracts/Postpone-E1.md', { parent: 'Postpone-A', source: '[[Postpone-A]]' });
  const e2 = addExtract(app, 'Extracts/Postpone-E2.md', { parent: 'Postpone-E1', source: '[[Postpone-A]]' });
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  app.activeFile = e1;
  await plugin.reparent(e1.path, 'Postpone-B');
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const e1WritesBefore = app.fileManager.writes.filter(write => write.file.path === e1.path).length;
  const e2WritesBefore = app.fileManager.writes.filter(write => write.file.path === e2.path).length;
  app.activeFile = sourceA;
  app.__promptState.quality = 3;
  const before = app.vault.readFm(e1).next_review;
  await plugin.postponeSubtree();
  assert.equal(app.vault.readFm(e1).next_review, before);
  assert.equal(app.fileManager.writes.filter(write => write.file.path === e1.path).length, e1WritesBefore);
  assert.equal(app.fileManager.writes.filter(write => write.file.path === e2.path).length, e2WritesBefore);
  assert.equal(sourceB.basename, 'Postpone-B');
});
