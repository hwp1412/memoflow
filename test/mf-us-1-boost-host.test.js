'use strict';

// P2-US1-HOST-CLOSURE / Actions Agent — Boost batch planning + application
// through src/integration/boost-batch-host.js.
//
// Pure synthetic rows only: no Vault, no Obsidian, no real runtime I/O. The
// injected getPriority / applyItem / store stand in for the queue projection,
// the Unified host entry and the plugin-data batch store.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BOOST_MAX_DELTA,
  planBoostBatch,
  applyBoostBatch,
  describeBoostOutcome,
} = require('../src/integration/boost-batch-host.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-27';
const ROOT_ID = uuid(900);

function row(seq, overrides = {}) {
  return {
    path: `Sources/B${seq}.md`,
    basename: `B${seq}`,
    topicId: uuid(seq),
    type: 'source',
    status: 'active',
    priority: 50,
    ...overrides,
  };
}

function recordingStore({ failOn = null, throwOn = null } = {}) {
  const saves = [];
  const records = new Map();
  return {
    saves,
    records,
    async save(batchId, record) {
      saves.push({ batchId, record });
      const index = saves.length;
      if (typeof throwOn === 'function' && throwOn(index)) {
        throw Object.assign(new Error('store boom'), { code: 'E_STORE_IO' });
      }
      if (typeof failOn === 'function' && failOn(index)) {
        return { ok: false, code: 'E_DATA_SAVE_FAILED' };
      }
      records.set(batchId, record);
      return { ok: true };
    },
  };
}

function priorityTable(rows) {
  const values = new Map(rows.map(item => [item.topicId, item.priority]));
  return {
    values,
    get: async node => values.get(node.topicId),
    set: (topicId, value) => values.set(topicId, value),
    write: (node, change) => values.set(node.topicId, change.priority),
  };
}

// ---- planning ------------------------------------------------------------

test('plan skips cards and terminal topics and targets only active source/extract', () => {
  const rows = [
    row(1, { priority: 50 }),
    row(2, { type: 'extract', priority: 30 }),
    row(3, { type: 'card', priority: 20 }),
    row(4, { status: 'done', priority: 20 }),
    row(5, { status: 'dismissed', priority: 20 }),
    row(6, { status: 'container', priority: 20 }),
  ];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  assert.equal(batch.today, TODAY);
  assert.equal(batch.delta, 10);
  assert.deepEqual(batch.plan.items.map(item => item.topicId), [uuid(1), uuid(2)]);
  assert.equal(batch.plan.skipped.length, 4);
  assert.deepEqual(
    batch.targets.map(target => [target.topicId, target.from, target.to]),
    [[uuid(1), 50, 40], [uuid(2), 30, 20]],
  );
});

test('a duplicate stable id refuses the whole batch before any target is built', () => {
  const rows = [
    row(1),
    row(1, { path: 'Extracts/B1-copy.md', basename: 'B1-copy' }),
  ];
  assert.throws(
    () => planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 5, today: TODAY }),
    error => error && error.code === 'E_BATCH_DUPLICATE_ID',
  );
});

test('a missing root id refuses the batch', () => {
  for (const rootTopicId of [undefined, null, '', '   ']) {
    assert.throws(
      () => planBoostBatch({ rows: [row(1)], rootTopicId, delta: 5, today: TODAY }),
      error => error && error.code === 'E_ROOT_ID_REQUIRED',
    );
  }
});

test('delta must be an integer within 1..99 and the batch pins today', () => {
  for (const delta of [0, 1.5, -3, BOOST_MAX_DELTA + 1, '5', null, undefined]) {
    assert.throws(
      () => planBoostBatch({ rows: [row(1)], rootTopicId: ROOT_ID, delta, today: TODAY }),
      error => error && error.code === 'E_BOOST_DELTA_INVALID',
    );
  }
  const max = planBoostBatch({ rows: [row(1)], rootTopicId: ROOT_ID, delta: BOOST_MAX_DELTA, today: TODAY });
  assert.equal(max.targets[0].to, 1, 'a very large delta clamps at priority 1');

  assert.throws(
    () => planBoostBatch({ rows: [row(1)], rootTopicId: ROOT_ID, delta: 5, today: '26-11-2026' }),
    error => error && error.code === 'E_TODAY_REQUIRED',
  );
});

test('the batch id is a pure digest: order-independent and batch-specific', () => {
  const first = planBoostBatch({ rows: [row(1), row(2)], rootTopicId: ROOT_ID, delta: 5, today: TODAY });
  const reordered = planBoostBatch({ rows: [row(2), row(1)], rootTopicId: ROOT_ID, delta: 5, today: TODAY });
  assert.equal(first.batchId, reordered.batchId);
  assert.equal(first.batchId.length, 64);

  const smaller = planBoostBatch({ rows: [row(1)], rootTopicId: ROOT_ID, delta: 5, today: TODAY });
  const biggerDelta = planBoostBatch({ rows: [row(1), row(2)], rootTopicId: ROOT_ID, delta: 6, today: TODAY });
  assert.notEqual(first.batchId, smaller.batchId);
  assert.notEqual(first.batchId, biggerDelta.batchId);
});

test('rows without a persisted id or a readable priority are skipped, not targeted', () => {
  const rows = [
    row(1),
    { path: 'Sources/NoId.md', basename: 'NoId', topicId: null, type: 'source', status: 'active', priority: 50 },
    row(3, { priority: '50' }),
  ];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 5, today: TODAY });
  assert.deepEqual(batch.plan.items.map(item => item.topicId), [uuid(1)]);
  assert.deepEqual(
    batch.plan.skipped.map(item => item.reason).sort(),
    ['ID_NOT_PERSISTED', 'PRIORITY_INVALID'],
  );
  assert.equal(batch.targets.length, 1);
});

test('maxPriority is a floor that is never undercut', () => {
  const batch = planBoostBatch({ rows: [row(1, { priority: 4 })], rootTopicId: ROOT_ID, delta: 10, today: TODAY, maxPriority: 7 });
  assert.equal(batch.targets[0].to, 7, 'target = max(maxPriority, from - delta)');
});

// ---- application ---------------------------------------------------------

test('the prepared intent is durable before the first write', async () => {
  const rows = [row(1), row(2)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const priorities = priorityTable(rows);
  const store = recordingStore();
  let intentAtFirstWrite = null;
  await applyBoostBatch({
    batch,
    getPriority: priorities.get,
    applyItem: async (node, change) => {
      if (intentAtFirstWrite == null) intentAtFirstWrite = store.saves[0].record;
      priorities.write(node, change);
      return { status: 'applied' };
    },
    store,
  });
  assert.equal(intentAtFirstWrite.status, 'prepared');
  assert.deepEqual(intentAtFirstWrite.targets, batch.targets);
  assert.equal(store.saves.length, 2);
  assert.equal(store.records.get(batch.batchId).status, 'applied');
});

test('an externally changed priority is a conflict and is never decremented twice', async () => {
  const rows = [row(1), row(2), row(3)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const priorities = priorityTable(rows);
  priorities.set(uuid(2), 35); // external edit between planning and applying
  const store = recordingStore();
  const writes = [];

  const outcome = await applyBoostBatch({
    batch,
    getPriority: priorities.get,
    applyItem: async (node, change) => {
      writes.push({ topicId: node.topicId, ...change });
      priorities.write(node, change);
      return { status: 'applied', writesPerformed: true };
    },
    store,
  });

  assert.equal(outcome.status, 'partial');
  assert.deepEqual(outcome.counts, {
    applied: 2, duplicate: 0, noOp: 0, skipped: 0,
    blocked: 0, conflict: 1, failed: 0, uncertain: 0,
  });
  assert.deepEqual(
    writes.map(entry => [entry.topicId, entry.priority, entry.expectedFrom]),
    [[uuid(1), 40, 50], [uuid(3), 40, 50]],
  );
  assert.equal(priorities.values.get(uuid(2)), 35, 'the externally changed node keeps its value');
  assert.equal(store.records.get(batch.batchId).status, 'partial');

  const report = describeBoostOutcome(outcome);
  assert.match(report.message, /非原子/);
  assert.match(report.message, /E_PRIORITY_CHANGED/);
});

test('retrying a successful boost at the priority floor is all no-op', async () => {
  const rows = [row(1, { priority: 5 }), row(2, { priority: 4 })];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const priorities = priorityTable(rows);
  const store = recordingStore();
  let writes = 0;
  const applyItem = async (node, change) => {
    writes += 1;
    priorities.write(node, change);
    return { status: 'applied', writesPerformed: true };
  };

  const first = await applyBoostBatch({ batch, getPriority: priorities.get, applyItem, store });
  assert.equal(first.status, 'applied');
  assert.deepEqual([...priorities.values.values()], [1, 1]);
  assert.equal(writes, 2);

  const retry = await applyBoostBatch({ batch, getPriority: priorities.get, applyItem, store });
  assert.equal(retry.status, 'no-op');
  assert.equal(retry.counts.noOp, 2);
  assert.equal(writes, 2, 'a retry must not write again');
  assert.deepEqual([...priorities.values.values()], [1, 1]);
});

test('a failed intent save performs zero writes', async () => {
  const rows = [row(1), row(2)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const store = recordingStore({ failOn: index => index === 1 });
  let writes = 0;

  const outcome = await applyBoostBatch({
    batch,
    getPriority: async () => 50,
    applyItem: async () => { writes += 1; return { status: 'applied' }; },
    store,
  });

  assert.equal(writes, 0);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'E_BOOST_INTENT_NOT_DURABLE');
  assert.equal(outcome.intentPersisted, false);
  assert.equal(outcome.resultPersisted, false);
  assert.equal(outcome.counts.applied, 0);
  assert.equal(store.saves.length, 1);
  assert.equal(store.records.size, 0);
  assert.match(describeBoostOutcome(outcome).message, /E_BOOST_INTENT_NOT_DURABLE/);
});

test('a throwing intent save is also a durable failure with zero writes', async () => {
  const rows = [row(1)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const store = recordingStore({ throwOn: index => index === 1 });
  let writes = 0;
  const outcome = await applyBoostBatch({
    batch,
    getPriority: async () => 50,
    applyItem: async () => { writes += 1; return { status: 'applied' }; },
    store,
  });
  assert.equal(writes, 0);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'E_BOOST_INTENT_NOT_DURABLE');
});

test('a failed result save is uncertain, never applied', async () => {
  const rows = [row(1), row(2)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const store = recordingStore({ failOn: index => index === 2 });
  let writes = 0;

  const outcome = await applyBoostBatch({
    batch,
    getPriority: async () => 50,
    applyItem: async () => { writes += 1; return { status: 'applied', writesPerformed: true }; },
    store,
  });

  assert.equal(writes, 2);
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.reason, 'E_BOOST_RESULT_NOT_DURABLE');
  assert.equal(outcome.resultPersisted, false);
  assert.equal(outcome.counts.applied, 2);

  const report = describeBoostOutcome(outcome);
  assert.equal(report.status, 'uncertain');
  assert.match(report.message, /E_BOOST_RESULT_NOT_DURABLE/);
  assert.match(report.message, /非原子/);
});

test('an uncertain node makes the batch uncertain and the report says so', async () => {
  const rows = [row(1), row(2)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const store = recordingStore();

  const outcome = await applyBoostBatch({
    batch,
    getPriority: async () => 50,
    applyItem: async node => (node.topicId === uuid(2)
      ? { status: 'uncertain', reason: 'E_WRITE_UNVERIFIED' }
      : { status: 'applied', writesPerformed: true }),
    store,
  });

  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.counts.uncertain, 1);
  assert.equal(outcome.counts.applied, 1);

  const report = describeBoostOutcome(outcome);
  assert.equal(report.status, 'uncertain');
  assert.match(report.message, /未确认 1/);
  assert.doesNotMatch(report.message, /没有需要变更/);
  assert.equal(store.records.get(batch.batchId).status, 'uncertain');
});

test('an unreadable current priority fails that node without writing', async () => {
  const rows = [row(1), row(2)];
  const batch = planBoostBatch({ rows, rootTopicId: ROOT_ID, delta: 10, today: TODAY });
  const store = recordingStore();
  const writes = [];

  const outcome = await applyBoostBatch({
    batch,
    getPriority: async node => (node.topicId === uuid(2) ? '50' : 50),
    applyItem: async (node, change) => {
      writes.push(node.topicId);
      return { status: 'applied', writesPerformed: true };
    },
    store,
  });

  assert.deepEqual(writes, [uuid(1)]);
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.counts.failed, 1);
  assert.equal(
    outcome.results.find(entry => entry.topicId === uuid(2)).reason,
    'E_PRIORITY_UNAVAILABLE',
  );
});

test('apply refuses an unplanned batch or missing injectables', async () => {
  const batch = planBoostBatch({ rows: [row(1)], rootTopicId: ROOT_ID, delta: 5, today: TODAY });
  await assert.rejects(
    () => applyBoostBatch({ batch: null, getPriority: async () => 50, applyItem: async () => ({ status: 'applied' }), store: recordingStore() }),
    error => error.code === 'E_BOOST_BATCH_REQUIRED',
  );
  await assert.rejects(
    () => applyBoostBatch({ batch, applyItem: async () => ({ status: 'applied' }), store: recordingStore() }),
    error => error.code === 'E_BOOST_GET_PRIORITY_REQUIRED',
  );
  await assert.rejects(
    () => applyBoostBatch({ batch, getPriority: async () => 50, store: recordingStore() }),
    error => error.code === 'E_BOOST_APPLY_REQUIRED',
  );
  await assert.rejects(
    () => applyBoostBatch({ batch, getPriority: async () => 50, applyItem: async () => ({ status: 'applied' }) }),
    error => error.code === 'E_BOOST_STORE_REQUIRED',
  );
});

test('describeBoostOutcome reports an empty/failed batch without path leakage', () => {
  const batch = planBoostBatch({ rows: [row(1)], rootTopicId: ROOT_ID, delta: 5, today: TODAY });
  const store = recordingStore({ failOn: () => true });
  return applyBoostBatch({
    batch,
    getPriority: async () => 50,
    applyItem: async () => ({ status: 'applied' }),
    store,
  }).then(outcome => {
    const report = describeBoostOutcome(outcome);
    assert.equal(report.status, 'failed');
    assert.doesNotMatch(report.message, /\/Users\//);
    assert.doesNotMatch(report.message, /Sources\/B1\.md/);
  });
});
