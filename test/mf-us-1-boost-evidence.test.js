'use strict';

// PR#38 final review — durable Boost event identities and crash recovery.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planBoostBatch, applyBoostBatch } = require('../src/integration/boost-batch-host.js');
const { reconcileBatches, ITEM_STATE } = require('../src/integration/batch-recovery.js');
const { PersistentEventLedger, MemoryLedgerStore } = require('../src/scheduling/index.js');

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-11-27';

function row(topicId, priority, revision = 0) {
  return { topicId, path: `${topicId}.md`, basename: topicId, type: 'source', status: 'active', priority, revision };
}

function storeWithMap() {
  const records = new Map();
  return {
    records,
    saves: [],
    async getBatch(batchId) { return records.get(batchId) || null; },
    async listBatches({ unfinishedOnly = false } = {}) {
      return [...records.values()]
        .filter(record => (unfinishedOnly ? ['prepared', 'uncertain', 'partial', 'requires-manual-recovery'].includes(record.status) : true))
        .map(record => JSON.parse(JSON.stringify(record)));
    },
    async saveBatch(record) {
      this.saves.push(JSON.parse(JSON.stringify(record)));
      records.set(record.batchId, JSON.parse(JSON.stringify(record)));
      return { ok: true };
    },
  };
}

test('a different absolute plan gets a different batch identity', () => {
  const first = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  const again = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  const changed = planBoostBatch({ rows: [row(ID1, 60)], rootTopicId: ID1, delta: 5, today: TODAY });
  assert.equal(first.batchId, again.batchId);
  assert.notEqual(first.batchId, changed.batchId);
  assert.deepEqual(first.targets.map(target => [target.from, target.to]), [[50, 45]]);
});

test('event identities are persisted before any topic write', async () => {
  const store = storeWithMap();
  const batch = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  assert.equal(batch.events.length, 1);
  assert.ok(batch.events[0].eventId);
  let observed;
  await applyBoostBatch({
    batch,
    getPriority: async () => 50,
    applyItem: async (node, change) => {
      observed = { savedBeforeWrite: store.saves.length, eventIds: store.saves[0].eventIds };
      return { status: 'applied', priority: change.priority };
    },
    store: { getBatch: id => store.getBatch(id), save: (id, record) => store.saveBatch({ batchId: id, ...record }) },
  });
  assert.equal(observed.savedBeforeWrite, 1, 'intent was saved before the write');
  assert.equal(observed.eventIds.length, 1);
  assert.equal(observed.eventIds[0].eventId, batch.events[0].eventId);
});

test('after a final-save crash, the persisted event id proves ownership', async () => {
  const store = storeWithMap();
  const batch = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  let saves = 0;
  const flaky = {
    async getBatch(id) { return store.getBatch(id); },
    async saveBatch(record) {
      saves += 1;
      if (saves >= 2) return { ok: false, code: 'E_BOOT_SAVE' };
      return store.saveBatch(record);
    },
  };
  const outcome = await applyBoostBatch({
    batch, getPriority: async () => 50,
    applyItem: async () => ({ status: 'applied' }),
    store: { getBatch: id => flaky.getBatch(id), save: (id, record) => flaky.saveBatch({ batchId: id, kind: 'BOOST', ...record }) },
  });
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.reason, 'E_BOOST_RESULT_NOT_DURABLE');
  assert.equal(outcome.resultPersisted, false);
  const intent = store.records.get(batch.batchId);
  assert.ok(intent && Array.isArray(intent.eventIds) && intent.eventIds.length === 1);

  const storage = { async readTopic() { return { entry: { frontmatter: { priority: 45 } } }; } };
  const ledger = new PersistentEventLedger(new MemoryLedgerStore({
    [intent.eventIds[0].eventId]: {
      eventId: intent.eventIds[0].eventId, topicId: ID1, status: 'applied',
      audit: { before: { priority: 50 }, after: { priority: 45 } }, type: 'SET_PRIORITY',
    },
  }));
  const recovered = await reconcileBatches({ store, storage, ledger });
  assert.equal(recovered.batches[0].items[0].state, ITEM_STATE.applied);

  const noEvidence = await reconcileBatches({ store, storage, ledger: null, batches: [JSON.parse(JSON.stringify(intent))] });
  assert.equal(noEvidence.batches[0].items[0].state, ITEM_STATE.unknown);
});

test('two plans with different targets keep separate records', async () => {
  const store = storeWithMap();
  const first = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  const second = planBoostBatch({ rows: [row(ID1, 60)], rootTopicId: ID1, delta: 5, today: TODAY });
  for (const batch of [first, second]) {
    await applyBoostBatch({
      batch, getPriority: async () => batch.targets[0].from,
      applyItem: async () => ({ status: 'applied' }),
      store: { getBatch: id => store.getBatch(id), save: (id, record) => store.saveBatch({ batchId: id, kind: 'BOOST', ...record }) },
    });
  }
  assert.equal(store.records.size, 2);
  assert.deepEqual([...store.records.values()].map(record => record.targets[0].to).sort(), [45, 55]);
});

test('an existing record with different targets is a plan conflict with zero writes', async () => {
  const batch = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  let applies = 0;
  const store = {
    async getBatch() { return { batchId: batch.batchId, targets: [{ topicId: ID1, from: 90, to: 85 }] }; },
    async saveBatch() { return { ok: true }; },
  };
  const outcome = await applyBoostBatch({
    batch, getPriority: async () => 50,
    applyItem: async () => { applies += 1; return { status: 'applied' }; },
    store: { getBatch: id => store.getBatch(id), save: (id, record) => store.saveBatch(id, record) },
  });
  assert.equal(outcome.reason, 'E_BATCH_PLAN_CONFLICT');
  assert.equal(applies, 0);
  assert.equal(outcome.writesPerformed, false);
});


test('a recorded applied batch is never re-executed or overwritten', async () => {
  const store = storeWithMap();
  const batch = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  let applies = 0;
  let currentPriority = 50;
  const deps = {
    batch,
    getPriority: async () => currentPriority,
    applyItem: async () => { applies += 1; currentPriority = 45; return { status: 'applied' }; },
    store: { getBatch: id => store.getBatch(id), save: (id, record) => store.saveBatch({ batchId: id, kind: 'BOOST', ...record }) },
  };
  const first = await applyBoostBatch(deps);
  assert.equal(first.status, 'applied');
  const snapshot = JSON.parse(JSON.stringify(store.records.get(batch.batchId)));
  const second = await applyBoostBatch({ ...deps, getPriority: async () => 50 });
  assert.equal(applies, 1, 'no second write');
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.status, 'applied');
  assert.deepEqual(store.records.get(batch.batchId), snapshot, 'the applied record is unchanged');
});

test('an unsettled recorded batch is preserved for the recovery protocol', async () => {
  const store = storeWithMap();
  const batch = planBoostBatch({ rows: [row(ID1, 50)], rootTopicId: ID1, delta: 5, today: TODAY });
  await store.saveBatch({
    batchId: batch.batchId, kind: 'BOOST', status: 'prepared', today: TODAY,
    targets: batch.targets, eventIds: batch.events,
  });
  const before = JSON.parse(JSON.stringify(store.records.get(batch.batchId)));
  let applies = 0;
  const outcome = await applyBoostBatch({
    batch, getPriority: async () => 50,
    applyItem: async () => { applies += 1; return { status: 'applied' }; },
    store: { getBatch: id => store.getBatch(id), save: (id, record) => store.saveBatch({ batchId: id, kind: 'BOOST', ...record }) },
  });
  assert.equal(applies, 0, 'pending batch must not be silently re-executed');
  assert.equal(outcome.alreadyRecorded, true);
  assert.deepEqual(store.records.get(batch.batchId), before, 'audit record is preserved');
});
