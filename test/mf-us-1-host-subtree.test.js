'use strict';

// P2-US1-HOST-SUBTREE-01 — multi-level subtree postpone through the host.
// Mock Obsidian, synthetic topics, isolated storage; no real vault.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PersistentEventLedger, MemoryLedgerStore, issueSyntheticUnifiedCapability, addCalendarDays } = require('../src/scheduling/index.js');
const { createAsyncHostRuntime } = require('../src/integration/host-async-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { openPluginDataLedger } = require('../src/integration/plugin-data-ledger-store.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const DATE_FORMAT = 'YYYY-MM-DD';
const CONDITIONS = {
  migrationComplete: true,
  pendingRecovery: false,
  singleWriterReady: true,
  backupVerified: true,
  userConfirmed: true,
  storageSupportsCas: true,
};

function topicFm(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.6,
    review_count: 3, last_reviewed: '2026-10-01', next_review: '2026-11-20',
    date_added: '2026-09-01',
    mf_id: id, mf_parent_id: 'null', mf_root_id: 'null',
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8,
    mf_last_event_id: 'null', mf_revision: 0, mf_scheduler_version: 1,
    ...overrides,
  };
}

function fmOf(app, file) {
  return frontmatterFromContent(app.vault.readContent(file)).frontmatter;
}

function addSource(app, name, id, overrides = {}) {
  return makeFile(app, `Sources/${name}.md`, topicFm(id, { type: 'source', ...overrides }), `# ${name}\n`);
}

function addExtract(app, name, id, parentName, overrides = {}) {
  return makeFile(app, `Extracts/${name}.md`, topicFm(id, {
    type: 'extract',
    source: `[[${parentName}]]`,
    ...overrides,
  }), `# ${name}\n`);
}

async function harness({ mode = 'unified', saveHook = null } = {}) {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  plugin.pluginData = createPluginDataCoordinator({ plugin, notice: () => {} });
  const opened = await openPluginDataLedger({ dataStore: plugin.pluginData.ledgerStore(), key: 'mfUs1Ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const storage = createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT });
  let saves = 0;
  const persist = async records => {
    saves += 1;
    if (typeof saveHook === 'function') {
      const decision = await saveHook(saves);
      if (decision) return decision;
    }
    opened.store.replace(records);
    return opened.flush();
  };
  const runtime = createAsyncHostRuntime({
    mode, conditions: CONDITIONS, authorization: issueSyntheticHostAuthorization(), storage, ledger,
    capability: issueSyntheticUnifiedCapability(), dateFormat: DATE_FORMAT, persist,
  });
  plugin.__mfUs1UnifiedTransport = request => runtime.execute(request);
  return { plugin, app, runtime, ledger, opened, saveCount: () => saves };
}

function tree(app) {
  const source = addSource(app, 'S', uuid(1));
  const first = addExtract(app, 'E1', uuid(2), 'S');
  const second = addExtract(app, 'E2', uuid(3), 'E1');
  const third = addExtract(app, 'E3', uuid(4), 'E2');
  return { source, first, second, third };
}

// ---- core behaviour ------------------------------------------------------

test('a multi-level subtree postpones every node and keeps learning fields', async () => {
  const { plugin, app } = await harness();
  const { source, first, second, third } = tree(app);
  const before = fmOf(app, third);
  const result = await plugin.postponeSubtreeHost(source, 3);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.counts, { applied: 4, duplicate: 0, noOp: 0, skipped: 0, blocked: 0, conflict: 0, failed: 0, uncertain: 0 });
  const today = plugin._todayKey();
  for (const file of [source, first, second, third]) {
    const fm = fmOf(app, file);
    assert.equal(fm.mf_not_before, addCalendarDays(today, 3), file.path);
    assert.equal(fm.mf_interval_days, 8);
    assert.equal(Number(fm.a_factor), 1.6);
    assert.equal(Number(fm.review_count), 3);
    assert.equal(fm.mf_ideal_due, '2026-11-20');
    assert.equal(fm.last_reviewed, before.last_reviewed);
  }
});

test('the result does not depend on file creation order', async () => {
  const { plugin, app } = await harness();
  const third = addExtract(app, 'E3', uuid(13), 'E2');
  const first = addExtract(app, 'E1', uuid(11), 'S');
  const source = addSource(app, 'S', uuid(10));
  const second = addExtract(app, 'E2', uuid(12), 'E1');
  const result = await plugin.postponeSubtreeHost(source, 1);
  assert.equal(result.status, 'applied');
  assert.equal(result.counts.applied, 4);
  const ids = result.results.map(item => item.topicId);
  // Parents are written last so a child's parent-hash precondition stays valid
  // (real-Obsidian E2E found root-first ordering caused E_SUBTREE_CHANGED).
  assert.equal(ids[ids.length - 1], uuid(10), 'root is written last');
  assert.deepEqual(ids.slice(0, 3).sort(), [uuid(11), uuid(12), uuid(13)].sort(), 'all descendants before root');
  for (const file of [source, first, second, third]) assert.ok(fmOf(app, file).mf_not_before);
});

test('an Extract root covers its descendants only, never the ancestor or a sibling', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(20));
  const first = addExtract(app, 'E1', uuid(21), 'S');
  const second = addExtract(app, 'E2', uuid(22), 'E1');
  const sibling = addExtract(app, 'E9', uuid(23), 'S');
  const result = await plugin.postponeSubtreeHost(first, 2);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.results.map(item => item.topicId).sort(), [uuid(21), uuid(22)].sort());
  assert.equal(fmOf(app, source).mf_not_before, null);
  assert.equal(fmOf(app, sibling).mf_not_before, null);
});

test('a root without a persistent mf_id refuses the whole batch', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(30));
  addExtract(app, 'E1', uuid(31), 'S');
  const bare = makeFile(app, 'Sources/Bare.md', { type: 'source', status: 'active', priority: 50 }, '# bare\n');
  const before = app.vault.readContent(source);
  const result = await plugin.postponeSubtreeHost(bare, 3);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'E_ROOT_ID_REQUIRED');
  assert.equal(app.vault.readContent(source), before);
});

test('a node without mf_id is blocked while safe nodes still apply', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(40));
  addExtract(app, 'E1', uuid(41), 'S');
  addExtract(app, 'Legacy', null, 'S', { mf_id: undefined });
  const result = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.counts.applied, 2);
  assert.equal(result.counts.blocked, 1);
  const blocked = result.results.find(item => item.status === 'blocked');
  assert.equal(blocked.reason, 'E_ID_NOT_PERSISTED');
});

test('a card inside the subtree is skipped and never written', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(50));
  addExtract(app, 'E1', uuid(51), 'S');
  const card = makeFile(app, 'Cards/C1.md', { type: 'card', status: 'active', mf_id: uuid(52), mf_revision: 0, source: '[[E1]]' }, '# card\n');
  const before = app.vault.readContent(card);
  const result = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(result.counts.applied, 2);
  assert.equal(result.counts.skipped, 1);
  assert.equal(app.vault.readContent(card), before);
});

test('done / dismissed nodes are skipped', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(60));
  addExtract(app, 'Done', uuid(61), 'S', { status: 'done' });
  addExtract(app, 'Gone', uuid(62), 'S', { status: 'dismissed' });
  const result = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(result.counts.applied, 1);
  assert.equal(result.counts.skipped, 2);
});

// ---- partial / uncertain / recovery -------------------------------------

test('one conflicting node makes the batch partial without touching that node', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(70));
  const second = addExtract(app, 'E2', uuid(71), 'S');
  const originalProcess = app.vault.process.bind(app.vault);
  let injected = false;
  app.vault.process = async (target, fn) => {
    if (!injected && target.path === second.path) {
      injected = true;
      const entry = app.vault.entries.get(target.path);
      entry.content = entry.content.replace('mf_revision: 0', 'mf_revision: 5');
      entry.frontmatter = { ...entry.frontmatter, mf_revision: 5 };
    }
    return originalProcess(target, fn);
  };
  const result = await plugin.postponeSubtreeHost(source, 3);
  app.vault.process = originalProcess;
  assert.equal(result.status, 'partial');
  assert.equal(result.counts.applied, 1);
  assert.equal(result.counts.conflict, 1);
  assert.equal(fmOf(app, second).mf_not_before, null, 'the conflicting node was not postponed');
});

test('an uncertain node is reported as uncertain and keeps the batch honest', async () => {
  const { plugin, app } = await harness({ saveHook: count => (count === 4 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const source = addSource(app, 'S', uuid(80));
  addExtract(app, 'E1', uuid(81), 'S');
  addExtract(app, 'E2', uuid(82), 'S');
  const result = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.counts.applied, 2);
  assert.equal(result.counts.uncertain, 1);
  const notices = getNotices(app).join('\n');
  assert.match(notices, /未确认 1/);
  assert.match(notices, /未确认 1|非原子批量操作/);
  assert.doesNotMatch(notices, /全部成功/);
});

test('re-running the same batch is a no-op for every node and does not bump revisions', async () => {
  const { plugin, app } = await harness();
  const { source } = tree(app);
  await plugin.postponeSubtreeHost(source, 3);
  const revisions = ['Sources/S.md', 'Extracts/E1.md', 'Extracts/E2.md', 'Extracts/E3.md']
    .map(p => Number(fmOf(app, app.vault.getAbstractFileByPath(p)).mf_revision));
  const dates = ['Sources/S.md', 'Extracts/E1.md', 'Extracts/E2.md', 'Extracts/E3.md']
    .map(p => fmOf(app, app.vault.getAbstractFileByPath(p)).mf_not_before);

  const again = await plugin.postponeSubtreeHost(source, 3);
  assert.equal(again.status, 'no-op');
  assert.equal(again.counts.noOp, 4);
  assert.equal(again.counts.failed, 0);
  const afterDates = ['Sources/S.md', 'Extracts/E1.md', 'Extracts/E2.md', 'Extracts/E3.md']
    .map(p => fmOf(app, app.vault.getAbstractFileByPath(p)).mf_not_before);
  assert.deepEqual(afterDates, dates);
  assert.deepEqual(['Sources/S.md', 'Extracts/E1.md', 'Extracts/E2.md', 'Extracts/E3.md']
    .map(p => Number(fmOf(app, app.vault.getAbstractFileByPath(p)).mf_revision)), revisions);
});

test('recovery resolves an uncertain node and a later re-run stays a no-op', async () => {
  const { plugin, app, runtime } = await harness({ saveHook: count => (count === 4 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const source = addSource(app, 'S', uuid(90));
  addExtract(app, 'E1', uuid(91), 'S');
  addExtract(app, 'E2', uuid(92), 'S');
  const first = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(first.status, 'uncertain');
  const recovery = await runtime.recover();
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recovered[0].status, 'applied');

  const again = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(again.status, 'no-op');
  assert.equal(again.counts.noOp, 3);
  assert.equal(again.counts.uncertain, 0);
});

// ---- safety / modes ------------------------------------------------------

test('an ambiguous root is refused before any write', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(100));
  addExtract(app, 'E1', uuid(101), 'S');
  // A second IR note with the same basename makes the subtree root ambiguous.
  makeFile(app, 'Extracts/S.md', topicFm(uuid(103), { type: 'extract', source: '[[S]]' }), '# duplicate basename\n');
  const before = app.vault.readContent(source);
  const result = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(result.status, 'refused');
  assert.equal(app.vault.readContent(source), before);
  assert.match(getNotices(app).join('\n'), /refused before any write/);
});

test('every node uses the same pinned today even if the clock crosses midnight', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(110));
  addExtract(app, 'E1', uuid(111), 'S');
  addExtract(app, 'E2', uuid(112), 'S');
  const days = ['2026-11-26', '2026-11-27', '2026-11-28'];
  plugin._todayKey = () => days[Math.min(plugin.__calls = (plugin.__calls || 0) + 1, days.length) - 1];
  await plugin.postponeSubtreeHost(source, 3);
  const firstDate = plugin._mfUs1IsoDate ? null : null;
  const stamps = ['Sources/S.md', 'Extracts/E1.md', 'Extracts/E2.md']
    .map(p => fmOf(app, app.vault.getAbstractFileByPath(p)).mf_not_before);
  assert.equal(new Set(stamps).size, 1, `all nodes must share one date, got ${stamps.join(',')}`);
  assert.equal(stamps[0], addCalendarDays('2026-11-26', 3));
});

test('an identity change between planning and execution blocks that node', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(120));
  const first = addExtract(app, 'E1', uuid(121), 'S');
  const second = addExtract(app, 'E2', uuid(122), 'E1');
  const originalProcess = app.vault.process.bind(app.vault);
  app.vault.process = async (target, fn) => {
    if (target.path === second.path) {
      // Another writer swaps the identity of a not-yet-processed node (E1) while
      // the deepest node (E2) is being written first.
      const entry = app.vault.entries.get(first.path);
      entry.content = entry.content.replace(`mf_id: ${uuid(121)}`, `mf_id: ${uuid(129)}`);
      entry.frontmatter = { ...entry.frontmatter, mf_id: uuid(129) };
    }
    return originalProcess(target, fn);
  };
  const result = await plugin.postponeSubtreeHost(source, 2);
  app.vault.process = originalProcess;
  assert.equal(result.counts.applied, 2, JSON.stringify(result.results));
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.results.find(item => item.status === 'blocked').reason, 'E_TOPIC_IDENTITY_CHANGED');
});


test('shadow mode writes legacy fields only and records no ledger event', async () => {
  const { plugin, app, opened } = await harness({ mode: 'shadow' });
  const { source } = tree(app);
  app.activeFile = source;
  app.__promptState.quality = 2;
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  await plugin.postponeSubtree();
  assert.equal(String(app.vault.readFm(source).mf_not_before), 'null');
  assert.equal(Object.keys(opened.store.dump()).length, 0);
});

// ---- static wiring -------------------------------------------------------

test('the subtree entry plans first and routes every node through postponeFile', () => {
  const root = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(mainSource, /async postponeSubtreeHost\(rootFile, days, rootFm = null\)/);
  assert.match(mainSource, /planSubtreePostpone\(\{ nodes, rootTopicId: fm\.mf_id, days, today \}\)/);
  assert.match(mainSource, /expectations: \{ relationKey: node\.relationKey \}/);
  assert.match(mainSource, /return this\.postponeFile\(file, days, \{[\s\S]{0,400}?quiet: true/);
  assert.match(mainSource, /_mfUs1VerifySubtreeNode/);
  assert.match(mainSource, /_postponeSubtreeLegacy\(root, choice\)/);
});

// ---- PR #37 evidence closure --------------------------------------------

test('two files sharing one stable id refuse the whole batch before any write', async () => {
  const { plugin, app } = await harness();
  const shared = uuid(130);
  const source = addSource(app, 'S', shared);
  makeFile(app, 'Extracts/Clone.md', topicFm(shared, { type: 'extract', source: '[[S]]' }), '# clone\n');
  const before = app.vault.readContent(source);
  const result = await plugin.postponeSubtreeHost(source, 2);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'E_DUPLICATE_SUBTREE_ID');
  assert.equal(app.vault.readContent(source), before, 'no node may be written');
  assert.match(getNotices(app).join('\n'), /refused before any write/);
});

test('a parent change with a stale MetadataCache blocks that node only', async () => {
  const { plugin, app } = await harness();
  const source = addSource(app, 'S', uuid(140));
  const first = addExtract(app, 'E1', uuid(141), 'S');
  const second = addExtract(app, 'E2', uuid(142), 'S');
  const third = addExtract(app, 'E3', uuid(143), 'E2');

  const realPostpone = plugin.postponeFile.bind(plugin);
  let mutated = false;
  plugin.postponeFile = async (file, days, options) => {
    if (!mutated) {
      mutated = true;
      // E3 leaves E2's subtree on disk; MetadataCache is left stale on purpose.
      const entry = app.vault.entries.get(third.path);
      entry.content = entry.content.replace('source: [[E2]]', 'source: [[S]]');
    }
    return realPostpone(file, days, options);
  };

  const result = await plugin.postponeSubtreeHost(source, 2);
  plugin.postponeFile = realPostpone;

  assert.equal(result.status, 'partial');
  const blocked = result.results.find(item => item.topicId === uuid(143));
  assert.ok(blocked, 'the moved node must be reported');
  assert.ok(['conflict', 'failed'].includes(blocked.status), blocked.status);
  assert.equal(blocked.reason, 'E_SUBTREE_CHANGED');
  assert.equal(fmOf(app, third).mf_not_before, null, 'the moved node must not be postponed');
  assert.ok(app.vault.readContent(third).includes('source: [[S]]'), 'the external relation change is preserved');
  for (const file of [source, first, second]) {
    assert.ok(fmOf(app, file).mf_not_before, `${file.path} should still be postponed`);
  }
});

test('parent/source convention: a mid-level Extract root stays inside its own subtree', async () => {
  const { plugin, app } = await harness();
  // Phase 1 convention: `source` always points at the original Source,
  // `parent` at the direct parent.
  const source = addSource(app, 'S', uuid(150));
  const first = addExtract(app, 'E1', uuid(151), 'S', { source: '[[S]]' });
  const second = addExtract(app, 'E2', uuid(152), 'E1', { parent: '[[E1]]', source: '[[S]]' });
  const third = addExtract(app, 'E3', uuid(153), 'E2', { parent: '[[E2]]', source: '[[S]]' });
  const sibling = addExtract(app, 'E9', uuid(154), 'E1', { parent: '[[E1]]', source: '[[S]]' });

  const result = await plugin.postponeSubtreeHost(second, 2);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.results.map(item => item.topicId).sort(), [uuid(152), uuid(153)].sort());
  assert.ok(fmOf(app, second).mf_not_before);
  assert.ok(fmOf(app, third).mf_not_before);
  assert.equal(fmOf(app, first).mf_not_before, null, 'the parent must not be touched');
  assert.equal(fmOf(app, source).mf_not_before, null, 'the source must not be touched');
  assert.equal(fmOf(app, sibling).mf_not_before, null, 'a sibling must not be touched');
});
