'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dateCore = require('../date-core.js');
const {
  createPlugin,
  makeFile,
  makeSettings,
  withFrozenDate,
} = require('./helpers/obsidian-mock.js');

function setup(t) {
  const date = withFrozenDate(t);
  const today = dateCore.formatDate(date, 'YYYY-MM-DD');
  const { plugin, app } = createPlugin({ settings: makeSettings({}, today), today });
  return { plugin, app, today };
}

function addSource(app, path, overrides = {}) {
  return makeFile(app, path, {
    type: 'source',
    status: 'active',
    priority: 50,
    a_factor: 1.5,
    next_review: '2026-12-02',
    ...overrides,
  }, '# Source\n');
}

function addExtract(app, path, { parent = null, source = '[[Source A]]', priority = 50 } = {}) {
  return makeFile(app, path, {
    type: 'extract',
    status: 'active',
    priority,
    interval: 8,
    review_count: 1,
    a_factor: 2,
    next_review: '2026-12-02',
    ...(parent ? { parent: `[[${parent}]]` } : {}),
    ...(source ? { source: `[[${source.replace(/^\[\[|\]\]$/g, '')}]]` } : {}),
  }, '# Extract\n');
}

function fresh(plugin) {
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
}

function writesTo(app, file) {
  return app.fileManager.writes.filter(write => write.file.path === file.path);
}

async function boost(plugin, app, file, cascade = true) {
  app.activeFile = file;
  app.__promptState.quality = 5;
  app.__promptState.confirm = cascade;
  fresh(plugin);
  await plugin.boost();
}

async function postpone(plugin, app, file, days = 3) {
  app.activeFile = file;
  app.__promptState.quality = days;
  fresh(plugin);
  await plugin.postponeSubtree();
}





test('tree_root=true is not reattached through source', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const detached = addExtract(app, 'Extracts/Detached.md', { source: 'Source-A' });
  await app.fileManager.processFrontMatter(detached, fm => { fm.tree_root = true; });
  fresh(plugin);
  const before = writesTo(app, detached).length;
  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(detached).priority, 50);
  assert.equal(writesTo(app, detached).length, before);
});




test('duplicate root basename refuses strict subtree preflight', async (t) => {
  const { plugin, app } = setup(t);
  const a1 = addSource(app, 'Sources/A/Source.md');
  addSource(app, 'Sources/B/Source.md');
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, a1);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(a1).priority, 50);
});








test('subset review excludes ambiguous relations and writes nothing', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Subset-A.md');
  const broken = addExtract(app, 'Extracts/Subset-Broken.md', { parent: 'Missing Parent', source: 'Subset-A' });
  fresh(plugin);
  app.activeFile = a;
  app.__promptState.quality = 'all';
  const before = app.fileManager.writes.length;
  await plugin.subsetReview();
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(broken).priority, 50);
  assert.ok(app.notices.some(message => message.includes('excluded 1')));
});



