'use strict';

// HOST-CLOSURE — real dashboard model reads the authoritative projection in
// Unified mode and keeps legacy behaviour otherwise. Mock Obsidian only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeFile, makeSettings } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { buildModel } = require('../src/data/model.js');

const TODAY = '2026-11-27';

function fmBase(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.5,
    review_count: 2, last_reviewed: '2026-10-01', next_review: '2026-11-01', date_added: '2026-09-01',
    mf_id: id, mf_revision: 1, mf_scheduler_version: 1,
    mf_ideal_due: TODAY, mf_not_before: 'null', mf_interval_days: 8, mf_last_event_id: 'null',
    ...overrides,
  };
}

test('unified dashboard uses mf_ideal_due and excludes legacy-only notes', async () => {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'unified';
  // Due under MF-US-1 (ideal due = today) although next_review is in the past.
  const due = makeFile(app, 'Sources/Due.md', fmBase(uuid(1)), '# due\n');
  // Not due under MF-US-1 (ideal due far future) although next_review is long past.
  makeFile(app, 'Sources/Later.md', fmBase(uuid(2), { mf_ideal_due: '2026-12-30', next_review: '2026-01-01' }), '# later\n');
  // Legacy-only note: must be excluded from the unified dashboard queue.
  makeFile(app, 'Sources/Legacy.md', { type: 'source', status: 'active', priority: 50, next_review: '2026-11-01' }, '# legacy\n');

  const model = await buildModel({ plugin });
  assert.equal(model.mode, 'unified');
  assert.ok(model.unified, 'unified metadata must be exposed');
  const paths = model.queue.map(item => item.path);
  assert.ok(paths.includes(due.path), 'the authoritative due topic is queued');
  assert.ok(!paths.includes('Sources/Later.md'), 'next_review alone must not select it');
  assert.ok(!paths.includes('Sources/Legacy.md'), 'unmigrated notes are excluded');
  assert.ok(model.unified.diagnostics.some(item => item.path === 'Sources/Legacy.md'), 'exclusion is diagnosed');
  assert.equal(model.counts.due, model.queue.length);
  assert.equal(model.unified.authority, 'mf');
});

test('a not_before later than today keeps the topic out of the unified queue', async () => {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'unified';
  makeFile(app, 'Sources/Delayed.md', fmBase(uuid(3), { mf_not_before: '2026-12-10' }), '# delayed\n');
  const model = await buildModel({ plugin });
  assert.deepEqual(model.queue.map(item => item.path), []);
});

test('legacy mode keeps the legacy selector queue and does not expose unified metadata', async () => {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = 'legacy';
  const legacy = makeFile(app, 'Sources/Legacy.md', { type: 'source', status: 'active', priority: 50, next_review: '2026-11-01' }, '# legacy\n');
  const model = await buildModel({ plugin });
  assert.equal(model.mode, 'legacy');
  assert.equal(model.unified, null);
  assert.ok(model.queue.some(item => item.path === legacy.path));
});
