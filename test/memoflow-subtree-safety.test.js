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

test('cross-source moved subtree is excluded from original source boost', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const b = addSource(app, 'Sources/Source-B.md');
  const e1 = addExtract(app, 'Extracts/Moved-E1.md', { parent: 'Source-B', source: 'Source-A' });
  const e2 = addExtract(app, 'Extracts/Moved-E2.md', { parent: 'Moved-E1', source: 'Source-A' });
  fresh(plugin);

  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(a).priority, 45);
  assert.equal(app.vault.readFm(e1).priority, 50);
  assert.equal(app.vault.readFm(e2).priority, 50);
  assert.equal(writesTo(app, e1).length, 0);
  assert.equal(writesTo(app, e2).length, 0);

  await boost(plugin, app, b);
  assert.equal(app.vault.readFm(b).priority, 45);
  assert.equal(app.vault.readFm(e1).priority, 45);
  assert.equal(app.vault.readFm(e2).priority, 45);
});

test('cross-source moved subtree is excluded from original source postpone', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const b = addSource(app, 'Sources/Source-B.md');
  const e1 = addExtract(app, 'Extracts/Moved-P1.md', { parent: 'Source-B', source: 'Source-A' });
  const e2 = addExtract(app, 'Extracts/Moved-P2.md', { parent: 'Moved-P1', source: 'Source-A' });
  fresh(plugin);

  await postpone(plugin, app, a, 3);
  assert.equal(app.vault.readFm(e1).next_review, '2026-12-02');
  assert.equal(app.vault.readFm(e2).next_review, '2026-12-02');
  assert.equal(writesTo(app, e1).length, 0);
  assert.equal(writesTo(app, e2).length, 0);

  await postpone(plugin, app, b, 3);
  assert.equal(app.vault.readFm(e1).next_review, '2026-12-05');
  assert.equal(app.vault.readFm(e2).next_review, '2026-12-05');
});

test('legacy source fallback still works when there is no parent', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const e1 = addExtract(app, 'Extracts/Legacy-E1.md', { source: 'Source-A' });
  const e2 = addExtract(app, 'Extracts/Legacy-E2.md', { parent: 'Legacy-E1', source: 'Source-A' });
  fresh(plugin);
  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(e1).priority, 45);
  assert.equal(app.vault.readFm(e2).priority, 45);
});

test('path wikilinks, aliases and case-insensitive parents resolve', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const parent = addExtract(app, 'Extracts/Parent.md', { parent: 'Source-A', source: 'Source-A' });
  const child = addExtract(app, 'Extracts/Child.md', {
    parent: 'EXTRACTS/PARENT|alias',
    source: 'Source-A',
  });
  fresh(plugin);
  await boost(plugin, app, parent);
  assert.equal(app.vault.readFm(child).priority, 45);
  assert.equal(app.vault.readFm(a).priority, 50);
});

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

test('unrelated bad links in Source C do not block Source A boost', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  addSource(app, 'Sources/Source-C.md');
  addExtract(app, 'Extracts/C-Broken.md', { parent: 'Missing Parent', source: 'Source-C' });
  fresh(plugin);
  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(a).priority, 45);
  assert.ok(app.notices.some(message => message.includes('Boosted')));
});

test('invalid explicit parent that points at the active source refuses all writes', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const broken = addExtract(app, 'Extracts/A-Broken.md', { parent: 'Missing Parent', source: 'Source-A' });
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, a);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(a).priority, 50);
  assert.equal(app.vault.readFm(broken).priority, 50);
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
});

test('ambiguous duplicate parent under the active source refuses all writes', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  addExtract(app, 'Extracts/A/Dupe.md', { parent: 'Source-A', source: 'Source-A' });
  addExtract(app, 'Extracts/B/Dupe.md', { parent: 'Source-A', source: 'Source-A' });
  const child = addExtract(app, 'Extracts/Dupe-Child.md', { parent: 'Dupe', source: 'Source-A' });
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, a);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(a).priority, 50);
  assert.equal(app.vault.readFm(child).priority, 50);
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
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

test('non-cascade boost remains a single-node write despite unrelated bad links', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  addSource(app, 'Sources/Source-C.md');
  addExtract(app, 'Extracts/Unrelated-Broken.md', { parent: 'Missing Parent', source: 'Source-C' });
  fresh(plugin);
  await boost(plugin, app, a, false);
  assert.equal(app.vault.readFm(a).priority, 45);
  assert.ok(app.notices.some(message => message.includes('Boosted')));
});

test('cascade boost stops on a write failure and reports partial success', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const e1 = addExtract(app, 'Extracts/Fail-E1.md', { parent: 'Source-A', source: 'Source-A' });
  const e2 = addExtract(app, 'Extracts/Fail-E2.md', { parent: 'Fail-E1', source: 'Source-A' });
  fresh(plugin);
  const original = app.fileManager.processFrontMatter.bind(app.fileManager);
  app.fileManager.processFrontMatter = async (file, mutator) => {
    if (file.path === e2.path) throw new Error('simulated write failure');
    return original(file, mutator);
  };
  t.after(() => { app.fileManager.processFrontMatter = original; });
  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(a).priority, 45);
  assert.equal(app.vault.readFm(e1).priority, 45);
  assert.equal(app.vault.readFm(e2).priority, 50);
  assert.ok(app.notices.some(message => message.includes('Boost stopped at') && message.includes('no atomic rollback')));
});

test('subtree postpone stops on a write failure and reports partial success', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Postpone-A.md');
  const e1 = addExtract(app, 'Extracts/Postpone-E1.md', { parent: 'Postpone-A', source: 'Postpone-A' });
  const e2 = addExtract(app, 'Extracts/Postpone-E2.md', { parent: 'Postpone-E1', source: 'Postpone-A' });
  fresh(plugin);
  const original = app.fileManager.processFrontMatter.bind(app.fileManager);
  app.fileManager.processFrontMatter = async (file, mutator) => {
    if (file.path === e2.path) throw new Error('simulated postpone failure');
    return original(file, mutator);
  };
  t.after(() => { app.fileManager.processFrontMatter = original; });
  await postpone(plugin, app, a, 3);
  assert.equal(app.vault.readFm(a).next_review, '2026-12-05');
  assert.equal(app.vault.readFm(e1).next_review, '2026-12-05');
  assert.equal(app.vault.readFm(e2).next_review, '2026-12-02');
  assert.ok(app.notices.some(message => message.includes('Subtree postpone stopped at') && message.includes('no atomic rollback')));
});

test('cycle in the requested subtree refuses all writes', async (t) => {
  const { plugin, app } = setup(t);
  const e1 = addExtract(app, 'Extracts/Cycle-E1.md', { parent: 'Cycle-E2', source: 'Source-A' });
  const e2 = addExtract(app, 'Extracts/Cycle-E2.md', { parent: 'Cycle-E1', source: 'Source-A' });
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, e1);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(e1).priority, 50);
  assert.equal(app.vault.readFm(e2).priority, 50);
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
});

test('subtree postpone refuses before writing when an explicit parent is invalid', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Postpone-Broken.md');
  const broken = addExtract(app, 'Extracts/Postpone-Broken.md', { parent: 'Missing Parent', source: 'Postpone-Broken' });
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await postpone(plugin, app, a, 3);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(a).next_review, '2026-12-02');
  assert.equal(app.vault.readFm(broken).next_review, '2026-12-02');
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
});

test('cards remain traversal leaves and receive no boost writes', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Card-Source.md');
  const e1 = addExtract(app, 'Extracts/Card-E1.md', { parent: 'Card-Source', source: 'Card-Source' });
  const card = makeFile(app, 'Cards/Card-Child.md', {
    type: 'card',
    status: 'active',
    parent: '[[Card-E1]]',
    source: '[[Card-Source]]',
    ir_spaced_repetition: true,
    tags: ['flashcards/incremental-reading'],
  }, '# Card\n');
  const cardChild = addExtract(app, 'Extracts/Under-Card.md', { parent: 'Card-Child', source: 'Card-Source' });
  fresh(plugin);
  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(e1).priority, 45);
  assert.equal(app.vault.readFm(card).priority, undefined);
  assert.equal(writesTo(app, card).length, 0);
  assert.equal(app.vault.readFm(cardChild).priority, 50);
  assert.equal(writesTo(app, cardChild).length, 0);
  assert.deepEqual(app.vault.readFm(card).tags, ['flashcards/incremental-reading']);
});

test('path-qualified parent disambiguates duplicate basenames', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Source-A.md');
  const eA = addExtract(app, 'Extracts/A/Dupe.md', { parent: 'Source-A', source: 'Source-A' });
  addExtract(app, 'Extracts/B/Dupe.md', { parent: 'Source-A', source: 'Source-A' });
  const child = addExtract(app, 'Extracts/Child.md', { parent: 'Extracts/A/Dupe|alias', source: 'Source-A' });
  fresh(plugin);
  await boost(plugin, app, a);
  assert.equal(app.vault.readFm(eA).priority, 45);
  assert.equal(app.vault.readFm(child).priority, 45);
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

test('over-depth subtree relation refuses before writing', async (t) => {
  const { plugin, app } = setup(t);
  const root = addExtract(app, 'Extracts/Depth-00.md', { parent: 'Depth-Root', source: 'Source-A' });
  let previous = 'Depth-00';
  for (let i = 1; i <= 66; i++) {
    const name = `Depth-${String(i).padStart(2, '0')}`;
    addExtract(app, `Extracts/${name}.md`, { parent: previous, source: 'Source-A' });
    previous = name;
  }
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, root);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(root).priority, 50);
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
});

test('explicit empty parent refuses write and never falls back to source', async (t) => {
  const { plugin, app } = setup(t);
  const a = addSource(app, 'Sources/Empty-Parent.md');
  const broken = makeFile(app, 'Extracts/Empty-Parent-Child.md', {
    type: 'extract',
    status: 'active',
    parent: '',
    source: '[[Empty-Parent]]',
    priority: 50,
    next_review: '2026-12-02',
  }, '# Broken\n');
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, a);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(a).priority, 50);
  assert.equal(app.vault.readFm(broken).priority, 50);
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
});

test('direct self-parent is rejected before any write', async (t) => {
  const { plugin, app } = setup(t);
  const self = addExtract(app, 'Extracts/Self.md', { parent: 'Self', source: 'Source-A' });
  fresh(plugin);
  const before = app.fileManager.writes.length;
  await boost(plugin, app, self);
  assert.equal(app.fileManager.writes.length, before);
  assert.equal(app.vault.readFm(self).priority, 50);
  assert.ok(app.notices.some(message => message.includes('refused before any write')));
});
