'use strict';

// HOST-CLOSURE — startup reconcile for durable batches.
// Pure orchestration with fake store/storage; no writes to topics.

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileBatches, ITEM_STATE } = require('../src/integration/batch-recovery.js');

function fakeStore(batches) {
  const records = new Map(batches.map(batch => [batch.batchId, JSON.parse(JSON.stringify(batch))]));
  return {
    saved: [],
    async listBatches({ unfinishedOnly = false } = {}) {
      return [...records.values()]
        .filter(record => (unfinishedOnly ? ['prepared', 'uncertain', 'partial', 'requires-manual-recovery'].includes(record.status) : true))
        .map(record => JSON.parse(JSON.stringify(record)));
    },
    async saveBatch(record) {
      records.set(record.batchId, JSON.parse(JSON.stringify(record)));
      this.saved.push(record.batchId);
      return { ok: true };
    },
    get(batchId) { return records.get(batchId); },
  };
}

function fakeStorage(topics) {
  const byId = new Map(Object.entries(topics).map(([id, entry]) => [id.toLowerCase(), entry]));
  return {
    reads: 0,
    async readTopic(topicId) {
      this.reads += 1;
      const entry = byId.get(String(topicId).toLowerCase());
      return entry ? { entry, duplicates: [] } : { entry: null, duplicates: [], code: 'E_TOPIC_NOT_FOUND' };
    },
    // Deliberately no compareAndSwap: reconcile must never write a topic.
  };
}

function topicEntry(frontmatter) {
  return { path: 'Sources/A.md', frontmatter, revision: frontmatter.mf_revision ?? 0, mfId: frontmatter.mf_id };
}

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function mercyBatch(overrides = {}) {
  return {
    batchId: 'mercy-1', kind: 'MERCY', status: 'prepared', today: '2026-11-27', windowDays: 3,
    previewDigest: 'digest',
    items: [
      { topicId: ID1, path: 'Sources/A.md', basename: 'A', notBefore: '2026-11-28', currentNotBefore: null },
      { topicId: ID2, path: 'Sources/B.md', basename: 'B', notBefore: '2026-11-29', currentNotBefore: null },
    ],
    ...overrides,
  };
}

test('mercy reconcile marks already-applied items and leaves the rest pending', async () => {
  const store = fakeStore([mercyBatch()]);
  const storage = fakeStorage({
    [ID1]: topicEntry({ mf_id: ID1, mf_not_before: '2026-11-28' }),
    [ID2]: topicEntry({ mf_id: ID2, mf_not_before: null }),
  });
  const result = await reconcileBatches({ store, storage });
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].status, 'partial');
  assert.deepEqual(result.batches[0].items.map(item => item.state), [ITEM_STATE.applied, ITEM_STATE.pending]);
  assert.equal(store.saved.length, 1);
  assert.equal(store.get('mercy-1').status, 'partial');
  assert.equal(result.blockedTopicIds.length, 0, 'a pending item is not a conflict');
});

test('mercy reconcile detects an external change and blocks that topic', async () => {
  const store = fakeStore([mercyBatch()]);
  const storage = fakeStorage({
    [ID1]: topicEntry({ mf_id: ID1, mf_not_before: '2026-12-24' }),
    [ID2]: topicEntry({ mf_id: ID2, mf_not_before: null }),
  });
  const result = await reconcileBatches({ store, storage });
  assert.equal(result.batches[0].items[0].state, ITEM_STATE.conflict);
  assert.equal(result.batches[0].status, 'requires-manual-recovery');
  assert.deepEqual(result.blockedTopicIds, [ID1.toLowerCase()]);
  assert.equal(store.get('mercy-1').status, 'requires-manual-recovery');
});

test('boost reconcile uses the persisted absolute target and never a new delta', async () => {
  const targets = [
    { topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 },
    { topicId: ID2, path: 'B', basename: 'B', from: 30, to: 25 },
  ];
  const store = fakeStore([{ batchId: 'boost-1', kind: 'BOOST', status: 'prepared', targets }]);

  const appliedStorage = fakeStorage({
    [ID1]: topicEntry({ mf_id: ID1, priority: 45 }),
    [ID2]: topicEntry({ mf_id: ID2, priority: 30 }),
  });
  const first = await reconcileBatches({ store, storage: appliedStorage });
  assert.deepEqual(first.batches[0].items.map(item => item.state), [ITEM_STATE.applied, ITEM_STATE.pending]);
  assert.equal(first.batches[0].status, 'partial');

  const changedStorage = fakeStorage({
    [ID1]: topicEntry({ mf_id: ID1, priority: 44 }),
    [ID2]: topicEntry({ mf_id: ID2, priority: 25 }),
  });
  const second = await reconcileBatches({ store, storage: changedStorage });
  assert.equal(second.batches[0].items[0].state, ITEM_STATE.conflict);
  assert.equal(second.batches[0].items[0].reason, 'E_PRIORITY_CHANGED');
  assert.ok(second.blockedTopicIds.includes(ID1.toLowerCase()));
});

test('a second reconcile does not advance state again', async () => {
  const store = fakeStore([mercyBatch()]);
  const storage = fakeStorage({
    [ID1]: topicEntry({ mf_id: ID1, mf_not_before: '2026-11-28' }),
    [ID2]: topicEntry({ mf_id: ID2, mf_not_before: '2026-11-29' }),
  });
  const first = await reconcileBatches({ store, storage });
  assert.equal(first.batches[0].status, 'applied');
  const savedAfterFirst = store.saved.length;
  const second = await reconcileBatches({ store, storage });
  assert.equal(second.batches.length, 0, 'a settled batch is not re-checked');
  assert.equal(store.saved.length, savedAfterFirst, 'a settled batch is not rewritten');
});

test('corrupt or incomplete records become manual recovery without throwing', async () => {
  const store = fakeStore([{ batchId: 'broken', kind: 'MERCY', status: 'prepared' }]);
  const storage = fakeStorage({});
  const result = await reconcileBatches({ store, storage });
  assert.equal(result.batches[0].status, 'requires-manual-recovery');
  assert.equal(result.batches[0].reason, 'E_BATCH_RECORD_INCOMPLETE');
  assert.equal(result.summary.manual, 1);
});

test('a missing topic is unknown, blocked, and never written', async () => {
  const store = fakeStore([mercyBatch()]);
  const storage = fakeStorage({});
  const result = await reconcileBatches({ store, storage });
  assert.equal(result.batches[0].items[0].state, ITEM_STATE.unknown);
  assert.equal(result.blockedTopicIds.length, 2);
  assert.equal(storage.reads, 2);
  assert.equal(typeof storage.compareAndSwap, 'undefined', 'reconcile must not need a CAS channel');
});

test('reconcile refuses to run without store or storage', async () => {
  assert.equal((await reconcileBatches({})).summary.error, 'E_BATCH_STORE_REQUIRED');
  assert.equal((await reconcileBatches({ store: fakeStore([]) })).summary.error, 'E_STORAGE_REQUIRED');
});
