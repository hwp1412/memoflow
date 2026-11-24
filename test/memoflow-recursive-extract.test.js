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

test('Source -> first Extract keeps the 0.1 output byte-for-byte', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  app.activeFile = source;
  const created = await plugin.createTimestampExtract({
    sourceFile: source,
    text: 'first',
    page: 5,
    open: false,
  });
  assert.ok(created);
  const text = content(app, created);
  assert.match(text, /^---\ntype: extract\nsource: "\[\[Source\]\]"\nstatus: pending\n/);
  assert.equal(text.includes('\nparent:'), false);
  assert.match(text, /page: 5/);
  assert.match(text, /\*\*来源\*\*：\[\[Source#page=5\|Source · p\.5\]\]/);
  assert.equal(app.vault.createCalls.length, 1);
});

test('five-level extraction keeps parent=direct and source=original root', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  app.activeFile = source;
  let parent = source;
  const chain = [source];
  for (let level = 1; level <= 5; level++) {
    const created = await createChild(plugin, app, parent, `level ${level}`, level);
    const fm = app.vault.readFm(created);
    assert.equal(fm.type, 'extract');
    assert.equal(fm.source, '[[Source]]');
    if (level === 1) assert.equal(fm.parent, undefined);
    else assert.equal(fm.parent, `[[${parent.basename}]]`);
    chain.push(created);
    parent = created;
  }
  const index = treeCore.buildTreeIndex(rows(plugin));
  assert.equal(index.byName.get('source').basename, 'Source');
  let cursor = 'Source';
  for (let level = 1; level <= 5; level++) {
    const child = index.childrenOf.get(cursor.toLowerCase()) || [];
    assert.equal(child.length, 1);
    assert.equal(child[0].basename, chain[level].basename);
    cursor = child[0].basename;
  }
  assert.equal(index.roots.length, 1);
});

test('old source->parent and source-only data stays readable and is not rewritten', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  const e1 = addExtract(app, 'Extracts/Old-E1.md', { source: '[[Source]]' });
  const e2 = addExtract(app, 'Extracts/Old-E2.md', { source: '[[Old-E1]]' });
  const beforeE1 = JSON.parse(JSON.stringify(app.vault.readFm(e1)));
  const beforeE2 = JSON.parse(JSON.stringify(app.vault.readFm(e2)));
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const created = await createChild(plugin, app, e2, 'new child');
  const fm = app.vault.readFm(created);
  assert.equal(fm.parent, '[[Old-E2]]');
  assert.equal(fm.source, '[[Source]]');
  assert.deepEqual(app.vault.readFm(e1), beforeE1);
  assert.deepEqual(app.vault.readFm(e2), beforeE2);
  const index = treeCore.buildTreeIndex(rows(plugin));
  assert.equal(index.childrenOf.get('source')[0].basename, 'Old-E1');
  assert.equal(index.childrenOf.get('old-e1')[0].basename, 'Old-E2');
  assert.equal(index.childrenOf.get('old-e2')[0].basename, created.basename);
});

test('missing root refuses creation without writes', async (t) => {
  const { plugin, app } = setup(t);
  const orphan = addExtract(app, 'Extracts/Orphan.md', { source: '[[Missing Root]]' });
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const beforeWrites = app.fileManager.writes.length;
  const beforeCreates = app.vault.createCalls.length;
  const created = await plugin.createTimestampExtract({ text: 'must fail', open: false });
  assert.equal(created, null);
  assert.equal(app.fileManager.writes.length, beforeWrites);
  assert.equal(app.vault.createCalls.length, beforeCreates);
  assert.ok(app.notices.some(message => message.includes('请先打开')));
});

test('cycle refuses creation without writes', async (t) => {
  const { plugin, app } = setup(t);
  addExtract(app, 'Extracts/Cycle-A.md', { source: '[[Cycle-B]]' });
  addExtract(app, 'Extracts/Cycle-B.md', { source: '[[Cycle-A]]' });
  app.activeFile = app.vault.getAbstractFileByPath('Extracts/Cycle-A.md');
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const beforeWrites = app.fileManager.writes.length;
  const beforeCreates = app.vault.createCalls.length;
  const created = await plugin.createTimestampExtract({ text: 'must fail', open: false });
  assert.equal(created, null);
  assert.equal(app.fileManager.writes.length, beforeWrites);
  assert.equal(app.vault.createCalls.length, beforeCreates);
});

test('duplicate parent basename refuses creation without writes', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  const a = addExtract(app, 'Extracts/A/Parent.md', { source: '[[Source]]' });
  addExtract(app, 'Extracts/B/Parent.md', { source: '[[Source]]' });
  app.activeFile = a;
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const beforeWrites = app.fileManager.writes.length;
  const beforeCreates = app.vault.createCalls.length;
  const created = await plugin.createTimestampExtract({ text: 'must fail', open: false });
  assert.equal(created, null);
  assert.equal(app.fileManager.writes.length, beforeWrites);
  assert.equal(app.vault.createCalls.length, beforeCreates);
  assert.equal(source.basename, 'Source');
});

test('new timestamp filename avoids another IR basename', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  addExtract(app, 'Extracts/2026-11-24 12-00-00.md', { source: '[[Source]]' });
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  app.activeFile = source;
  const created = await plugin.createTimestampExtract({ text: 'collision', open: false });
  assert.ok(created);
  assert.equal(created.basename, '2026-11-24 12-00-00 2');
});

test('parent bump failure keeps the created note and reports partial success', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  app.activeFile = source;
  const original = app.fileManager.processFrontMatter.bind(app.fileManager);
  app.fileManager.processFrontMatter = async (file, mutator) => {
    if (file.path === source.path) throw new Error('bump failed');
    return original(file, mutator);
  };
  t.after(() => { app.fileManager.processFrontMatter = original; });
  const created = await plugin.createTimestampExtract({ text: 'created despite bump', page: 2, open: false });
  assert.ok(created);
  assert.match(content(app, created), /created despite bump/);
  assert.equal(app.vault.readFm(source).priority, 50);
  assert.ok(app.notices.some(message => message.includes('父级 priority/A-Factor 更新失败')));
  assert.ok(app.notices.some(message => message.includes('笔记已保留')));
});

test('clipboardExtract uses the active Extract as direct parent', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  const e1 = await createChild(plugin, app, source, 'E1');
  app.activeFile = e1;
  plugin._promptOpenExtract = () => {};
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { readText: async () => 'clipboard body' } },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });
  const created = await plugin.clipboardExtract(e1);
  assert.ok(created);
  const fm = app.vault.readFm(created);
  assert.equal(fm.parent, `[[${e1.basename}]]`);
  assert.equal(fm.source, '[[Source]]');
  assert.match(content(app, created), /clipboard body/);
});

test('openParent from a child Extract opens its direct parent', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  const e1 = await createChild(plugin, app, source, 'E1');
  const e2 = await createChild(plugin, app, e1, 'E2');
  app.activeFile = e2;
  app.openedFiles.length = 0;
  await plugin.openParent();
  assert.deepEqual(app.openedFiles, [e1.path]);
  assert.equal(app.openedFiles.includes(source.path), false);
});

test('subtree boost from an Extract does not touch a sibling', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  const e1 = addExtract(app, 'Extracts/Boost-E1.md', { source: '[[Source]]' });
  const e2 = addExtract(app, 'Extracts/Boost-E2.md', { parent: 'Boost-E1', source: '[[Source]]' });
  const sibling = addExtract(app, 'Extracts/Boost-Sibling.md', { parent: 'Source', source: '[[Source]]' });
  app.activeFile = e1;
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  app.__promptState.quality = 5;
  app.__promptState.confirm = true;
  await plugin.boost();
  assert.equal(app.vault.readFm(e1).priority, 45);
  assert.equal(app.vault.readFm(e2).priority, 45);
  assert.equal(app.vault.readFm(sibling).priority, 50);
});

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

test('completing an Extract does not cascade to its child', async (t) => {
  const { plugin, app, today } = setup(t);
  const source = addSource(app);
  const e1 = await createChild(plugin, app, source, 'E1');
  const e2 = await createChild(plugin, app, e1, 'E2');
  await plugin.markPathsDone([e1.path], { confirm: false });
  assert.equal(app.vault.readFm(e1).status, 'done');
  assert.equal(app.vault.readFm(e2).status, 'pending');
  assert.equal(app.vault.readFm(e2).source, '[[Source]]');
  const index = treeCore.buildTreeIndex(rows(plugin));
  const visible = treeCore.flattenedVisibleChildren(index, index.byName.get(e1.basename.toLowerCase()), null, new Set([e1.path]));
  assert.equal(visible.some(page => page.basename === e2.basename), true);
  assert.equal(today, '2026-11-24');
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

test('duplicate original-root basename refuses creation without writes', async (t) => {
  const { plugin, app } = setup(t);
  addSource(app, 'Sources/A/Source.md');
  addSource(app, 'Sources/B/Source.md');
  const child = addExtract(app, 'Extracts/Duplicate-Root.md', { source: '[[Source]]' });
  app.activeFile = child;
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const beforeWrites = app.fileManager.writes.length;
  const beforeCreates = app.vault.createCalls.length;
  const created = await plugin.createTimestampExtract({ text: 'must fail', open: false });
  assert.equal(created, null);
  assert.equal(app.fileManager.writes.length, beforeWrites);
  assert.equal(app.vault.createCalls.length, beforeCreates);
});

test('over-depth root chain refuses creation without writes', async (t) => {
  const { plugin, app } = setup(t);
  const source = addSource(app);
  let previous = 'Source';
  for (let i = 0; i <= 65; i++) {
    const path = `Extracts/Deep-${String(i).padStart(2, '0')}.md`;
    addExtract(app, path, { source: `[[${previous}]]` });
    previous = path.split('/').pop().replace(/\.md$/, '');
  }
  app.activeFile = app.vault.getAbstractFileByPath('Extracts/Deep-65.md');
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const beforeWrites = app.fileManager.writes.length;
  const beforeCreates = app.vault.createCalls.length;
  const created = await plugin.createTimestampExtract({ text: 'must fail', open: false });
  assert.equal(created, null);
  assert.equal(app.fileManager.writes.length, beforeWrites);
  assert.equal(app.vault.createCalls.length, beforeCreates);
  assert.equal(source.basename, 'Source');
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
