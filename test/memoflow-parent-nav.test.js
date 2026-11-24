'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlugin,
  makeFile,
  makeSettings,
  withFrozenDate,
} = require('./helpers/obsidian-mock.js');

function setup(t) {
  const date = withFrozenDate(t);
  const today = new Date(date).toISOString().slice(0, 10);
  const { plugin, app } = createPlugin({ settings: makeSettings({}, today), today });
  return { plugin, app };
}

function add(app, path, fm, body = '# Note\n') {
  return makeFile(app, path, fm, body);
}

function writeSnapshot(app) {
  return JSON.stringify({
    writes: app.fileManager.writes.length,
    process: app.vault.processCalls.length,
    append: app.vault.appendCalls.length,
    create: app.vault.createCalls.length,
  });
}

async function open(plugin, app, active) {
  app.activeFile = active;
  app.openedFiles.length = 0;
  app.notices.length = 0;
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  const before = writeSnapshot(app);
  await plugin.openParent();
  assert.equal(writeSnapshot(app), before, 'openParent must not write');
  return { opened: app.openedFiles.slice(), notices: app.notices.slice() };
}

function extract(app, path, fm) {
  return add(app, path, { type: 'extract', status: 'active', ...fm });
}

test('E2 opens its direct parent E1', async (t) => {
  const { plugin, app } = setup(t);
  const e1 = extract(app, 'Extracts/E1.md', { source: '[[Source]]' });
  const e2 = extract(app, 'Extracts/E2.md', { parent: '[[E1]]', source: '[[Source]]' });
  const result = await open(plugin, app, e2);
  assert.deepEqual(result.opened, [e1.path]);
});

test('E3 opens its direct parent E2', async (t) => {
  const { plugin, app } = setup(t);
  const e1 = extract(app, 'Extracts/E1.md', { source: '[[Source]]' });
  const e2 = extract(app, 'Extracts/E2.md', { parent: '[[E1]]', source: '[[Source]]' });
  const e3 = extract(app, 'Extracts/E3.md', { parent: '[[E2]]', source: '[[Source]]' });
  const result = await open(plugin, app, e3);
  assert.deepEqual(result.opened, [e2.path]);
  assert.equal(e1.path.endsWith('E1.md'), true);
});

test('first-level Extract without parent falls back to source', async (t) => {
  const { plugin, app } = setup(t);
  const source = add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const e1 = extract(app, 'Extracts/E1.md', { source: '[[Source]]' });
  const result = await open(plugin, app, e1);
  assert.deepEqual(result.opened, [source.path]);
});

test('explicit empty parent does not fall back to source', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const e1 = extract(app, 'Extracts/Empty.md', { parent: '', source: '[[Source]]' });
  const result = await open(plugin, app, e1);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('not falling back')));
});

test('explicit null parent does not fall back to source', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const e1 = extract(app, 'Extracts/Null.md', { parent: null, source: '[[Source]]' });
  const result = await open(plugin, app, e1);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('not falling back')));
});

test('deleted parent does not fall back to source', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const parent = extract(app, 'Extracts/Gone.md', { source: '[[Source]]' });
  const child = extract(app, 'Extracts/Child.md', { parent: '[[Gone]]', source: '[[Source]]' });
  app.vault.entries.delete(parent.path);
  const result = await open(plugin, app, child);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('not falling back')));
});

test('ambiguous duplicate parent does not pick a file', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  add(app, 'Extracts/A/Parent.md', { type: 'extract', source: '[[Source]]' });
  add(app, 'Extracts/B/Parent.md', { type: 'extract', source: '[[Source]]' });
  const child = extract(app, 'Extracts/Child.md', { parent: '[[Parent]]', source: '[[Source]]' });
  const result = await open(plugin, app, child);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('ambiguous')));
});

test('path-qualified parent resolves by path', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const parent = extract(app, 'Extracts/Sub/Parent.md', { source: '[[Source]]' });
  const child = extract(app, 'Extracts/Child.md', { parent: '[[Extracts/Sub/Parent|alias]]', source: '[[Source]]' });
  const result = await open(plugin, app, child);
  assert.deepEqual(result.opened, [parent.path]);
});

test('path links are case-insensitive', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const parent = extract(app, 'Extracts/Sub/Parent.md', { source: '[[Source]]' });
  const child = extract(app, 'Extracts/Child.md', { parent: '[[EXTRACTS/SUB/PARENT]]', source: '[[Source]]' });
  const result = await open(plugin, app, child);
  assert.deepEqual(result.opened, [parent.path]);
});

test('tree_root Extract does not navigate through source', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const root = extract(app, 'Extracts/Root.md', { tree_root: true, source: '[[Source]]' });
  const result = await open(plugin, app, root);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('Tree root')));
});

test('Card keeps source navigation', async (t) => {
  const { plugin, app } = setup(t);
  const parent = add(app, 'Sources/Card Parent.md', { type: 'source', status: 'active' });
  const card = add(app, 'Cards/Card.md', { type: 'card', source: '[[Card Parent]]' });
  const result = await open(plugin, app, card);
  assert.deepEqual(result.opened, [parent.path]);
});

test('Source keeps parent navigation', async (t) => {
  const { plugin, app } = setup(t);
  const category = add(app, 'Categories/Category.md', { type: 'category' });
  const source = add(app, 'Sources/Source.md', { type: 'source', parent: '[[Category]]' });
  const result = await open(plugin, app, source);
  assert.deepEqual(result.opened, [category.path]);
});

test('self parent is rejected', async (t) => {
  const { plugin, app } = setup(t);
  const self = extract(app, 'Extracts/Self.md', { parent: '[[Self]]', source: '[[Source]]' });
  const result = await open(plugin, app, self);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('current note')));
});

test('failed navigation never opens a wrong file and never writes', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const missing = extract(app, 'Extracts/Missing.md', { parent: '[[No Such Note]]', source: '[[Source]]' });
  const result = await open(plugin, app, missing);
  assert.deepEqual(result.opened, []);
  assert.equal(app.fileManager.writes.length, 0);
  assert.equal(app.vault.processCalls.length, 0);
  assert.equal(app.vault.appendCalls.length, 0);
  assert.equal(app.vault.createCalls.length, 0);
});

test('explicit non-link parent value does not fall back to source', async (t) => {
  const { plugin, app } = setup(t);
  add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const broken = extract(app, 'Extracts/Invalid.md', { parent: 42, source: '[[Source]]' });
  const result = await open(plugin, app, broken);
  assert.deepEqual(result.opened, []);
  assert.ok(result.notices.some(message => message.includes('not falling back')));
});

test('plain basename parent remains a legacy-compatible format', async (t) => {
  const { plugin, app } = setup(t);
  await add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const parent = extract(app, 'Extracts/Plain Parent.md', { source: '[[Source]]' });
  const child = extract(app, 'Extracts/Plain Child.md', { parent: 'Plain Parent', source: '[[Source]]' });
  const result = await open(plugin, app, child);
  assert.deepEqual(result.opened, [parent.path]);
});

test('legacy one-element YAML list parent is normalized by the existing parser', async (t) => {
  const { plugin, app } = setup(t);
  await add(app, 'Sources/Source.md', { type: 'source', status: 'active' });
  const parent = extract(app, 'Extracts/List Parent.md', { source: '[[Source]]' });
  const child = extract(app, 'Extracts/List Child.md', { parent: [['List Parent']], source: '[[Source]]' });
  const result = await open(plugin, app, child);
  assert.deepEqual(result.opened, [parent.path]);
});
