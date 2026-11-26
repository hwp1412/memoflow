'use strict';

// HOST-CLOSURE — real Dashboard View refresh path (ui stubbed, model pipeline real).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const Module = require('node:module');
const dateCore = require('../date-core.js');
const TODAY = dateCore.formatDate(new Date(), 'YYYY-MM-DD');
const FUTURE = dateCore.formatDate(new Date(Date.now() + 33 * 86400000), 'YYYY-MM-DD');

// dashboard-view is the only module in this chain that requires 'obsidian'.
function loadViewClass() {
  const obsidianMock = {
    ItemView: class { constructor(leaf) { this.leaf = leaf; this.containerEl = {}; this.contentEl = {}; } },
    Notice: class { constructor() {} },
    Platform: { isMobile: false },
  };
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'obsidian') return obsidianMock;
    return original.apply(this, arguments);
  };
  try {
    const target = require.resolve('../src/views/dashboard-view.js');
    delete require.cache[target];
    return require(target).MemoFlowDashboardView;
  } finally {
    Module._load = original;
  }
}
const ViewClass = loadViewClass();

function topicFm(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 2,
    last_reviewed: '2026-10-01', next_review: '2026-01-01', date_added: '2026-09-01',
    mf_id: id, mf_revision: 1, mf_scheduler_version: 1,
    mf_ideal_due: TODAY, mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
    ...overrides,
  };
}

function makeView(plugin, app) {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const view = new ViewClass({}, plugin);
  view.app = app;
  view.ui = {
    updated: 0, lists: 0, error: null,
    setLoading() {}, setError(error) { this.error = error; },
    update(model) { this.model = model; this.updated += 1; },
    updateLists() { this.lists += 1; }, destroy() {},
  };
  return view;
}

test('the real dashboard view refresh uses the unified authoritative model', async () => {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'unified';
  const due = makeFile(app, 'Sources/Due.md', topicFm(uuid(1), { mf_ideal_due: TODAY, priority: 30 }), '# due\n');
  const later = makeFile(app, 'Sources/Later.md', topicFm(uuid(2), { mf_ideal_due: FUTURE, priority: 10 }), '# later\n');
  makeFile(app, 'Sources/Legacy.md', { type: 'source', status: 'active', priority: 50, next_review: '2026-01-01' }, '# legacy\n');

  const view = makeView(plugin, app);
  await view.refresh();

  assert.equal(view.ui.error, null);
  assert.equal(view.model.mode, 'unified');
  assert.ok(view.model.unified, 'the view model must expose unified metadata');
  const paths = view.model.queue.map(item => item.path);
  assert.deepEqual(paths, [due.path], 'only the authoritative due topic is shown');
  assert.ok(!paths.includes(later.path));
  assert.ok(!paths.includes('Sources/Legacy.md'));
  assert.ok(view.ui.updated >= 1);

  // Filter actions operate on the same in-memory model.
  await view.handleAction('filter', { filter: 'overdue' });
  assert.ok(view.ui.lists >= 1);
});

test('a confirmed priority change is reflected by the next dashboard refresh', async () => {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'unified';
  const first = makeFile(app, 'Sources/A.md', topicFm(uuid(3), { priority: 70 }), '# a\n');
  makeFile(app, 'Sources/B.md', topicFm(uuid(4), { priority: 40 }), '# b\n');
  const view = makeView(plugin, app);
  await view.refresh();
  assert.deepEqual(view.model.queue.map(item => item.path), ['Sources/B.md', 'Sources/A.md']);

  await app.vault.process(first, data => data.replace('priority: 70', 'priority: 5'));
  plugin._mfUs1RefreshRows();
  await view.refresh();
  assert.deepEqual(view.model.queue.map(item => item.path), ['Sources/A.md', 'Sources/B.md'], 'refresh follows the new priority');
});

test('legacy mode dashboard keeps the legacy queue', async () => {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'legacy';
  makeFile(app, 'Sources/Legacy.md', { type: 'source', status: 'active', priority: 50, next_review: '2026-01-01' }, '# legacy\n');
  const view = makeView(plugin, app);
  await view.refresh();
  assert.equal(view.model.mode, 'legacy');
  assert.equal(view.model.unified, null);
  assert.ok(view.model.queue.some(item => item.path === 'Sources/Legacy.md'));
});
