'use strict';

// P2-US1-ENTRY-CLOSURE — idempotent creation and onload lifecycle wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { initializeTopic, selectDailyQueue, validateTopic } = require('../src/scheduling/index.js');
const { allocateStableUuid, createTopic, createTopicOnce } = require('../src/integration/topic-creation.js');
const { initializeHostLifecycle } = require('../src/integration/host-lifecycle.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';

test('stable uuid allocation is deterministic, valid and request-scoped', () => {
  const first = allocateStableUuid('source-request-1');
  const again = allocateStableUuid('source-request-1');
  const other = allocateStableUuid('source-request-2');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('Source and multi-level Extract creation initializes scheduling and relations', () => {
  const source = createTopic({ kind: 'source', priority: 50, mfId: uuid(1), today: TODAY }).topic;
  const extract = createTopic({
    kind: 'extract', priority: 30, mfId: uuid(2), parentId: uuid(1), rootId: uuid(1), today: TODAY,
  }).topic;
  const child = createTopic({
    kind: 'extract', priority: 20, mfId: uuid(3), parentId: uuid(2), rootId: uuid(1), today: TODAY,
  }).topic;
  assert.equal(source.mf_parent_id, null);
  assert.equal(extract.mf_parent_id, uuid(1));
  assert.equal(extract.mf_root_id, uuid(1));
  assert.equal(child.mf_parent_id, uuid(2));
  assert.equal(child.mf_root_id, uuid(1));
  assert.equal(extract.review_count, 0);
  assert.equal(extract.mf_revision, 0);
  assert.ok(extract.mf_interval_days > 0);
  validateTopic(child);
});

test('creation is idempotent per request id and never mutates the parent', () => {
  const registry = new Map();
  const parent = initializeTopic({ type: 'source', priority: 50, mfId: uuid(10) }, undefined, TODAY).topic;
  const snapshot = JSON.stringify(parent);
  const first = createTopicOnce({
    requestId: 'extract-1', registry, kind: 'extract', priority: 30,
    parentId: uuid(10), rootId: uuid(10), today: TODAY,
  });
  const retry = createTopicOnce({
    requestId: 'extract-1', registry, kind: 'extract', priority: 30,
    parentId: uuid(10), rootId: uuid(10), today: TODAY,
  });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.topic.mf_id, first.topic.mf_id);
  assert.equal(registry.size, 1);
  assert.equal(JSON.stringify(parent), snapshot);
});

test('an extract without a persistent parent fails closed', () => {
  assert.throws(() => createTopic({ kind: 'extract', priority: 30, mfId: uuid(11), today: TODAY }),
    error => error.code === 'E_PARENT_REQUIRED');
});

test('a created topic enters the MF-US-1 queue projection', () => {
  const topic = createTopic({ kind: 'source', priority: 90, mfId: uuid(12), today: '2026-10-01' }).topic;
  const queue = selectDailyQueue([topic], undefined, TODAY);
  assert.equal(queue.selected.length, 1);
  assert.equal(queue.selected[0].stableId, uuid(12));
});

test('onload initializes the locked lifecycle and never enables unified', async () => {
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(hostSource, /initializeHostLifecycle\(/);
  assert.match(hostSource, /this\.mfUs1Lifecycle = await initializeHostLifecycle/);

  const pluginData = { settings: { keep: true }, mfUs1Ledger: { version: 1, records: {} } };
  const plugin = {
    async loadData() { return JSON.parse(JSON.stringify(pluginData)); },
    async saveData(data) { Object.assign(pluginData, JSON.parse(JSON.stringify(data))); },
  };
  const lifecycle = await initializeHostLifecycle({ plugin, mode: 'unified', conditions: {} });
  assert.equal(lifecycle.view.writeEnabled, false);
  assert.ok(lifecycle.view.blockers.includes('PRODUCTION_WRITE_UNAUTHORIZED'));
  assert.equal(pluginData.settings.keep, true);
});

test('a damaged ledger keeps the lifecycle healthy=false', async () => {
  const plugin = {
    async loadData() { return { mfUs1Ledger: { version: 1, records: { broken: { eventId: 'broken' } } } }; },
    async saveData() {},
  };
  const lifecycle = await initializeHostLifecycle({ plugin });
  assert.equal(lifecycle.healthy, false);
  assert.ok(lifecycle.diagnostics.length > 0);
  assert.equal(lifecycle.view.writeEnabled, false);
});
