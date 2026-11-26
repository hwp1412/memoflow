'use strict';

// HOST-CLOSURE — explicit authorized batch resume (Mercy / Boost).

const test = require('node:test');
const assert = require('node:assert/strict');
const { resumeBatch, issueSyntheticBatchResumeAuthorization } = require('../src/integration/batch-resume.js');

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function storeWith(batch) {
  const data = JSON.parse(JSON.stringify(batch));
  return {
    saved: [],
    async getBatch() { return JSON.parse(JSON.stringify(data)); },
    async saveBatch(record) { data.status = record.status; data.results = record.results; this.saved.push(record); return { ok: true }; },
  };
}

function reader(map) {
  return async topicId => {
    const fm = map[String(topicId).toLowerCase()];
    return fm ? { entry: { frontmatter: fm, revision: fm.mf_revision } } : { entry: null };
  };
}

const mercyBatch = {
  batchId: 'mercy-1', kind: 'MERCY', status: 'partial', today: '2026-11-27', windowDays: 3,
  items: [
    { topicId: ID1, path: 'A', basename: 'A', notBefore: '2026-11-28', currentNotBefore: null },
    { topicId: ID2, path: 'B', basename: 'B', notBefore: '2026-11-29', currentNotBefore: null },
  ],
};

test('resume refuses without an explicit authorization token', async () => {
  const store = storeWith(mercyBatch);
  let calls = 0;
  const result = await resumeBatch({
    store, batchId: 'mercy-1',
    readTopic: reader({ [ID1]: { mf_not_before: null }, [ID2]: { mf_not_before: null } }),
    runItem: async () => { calls += 1; return { status: 'applied' }; },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'E_BATCH_RESUME_NOT_AUTHORIZED');
  assert.equal(calls, 0);
});

test('mercy resume finishes pending items only and records results', async () => {
  const store = storeWith({ ...mercyBatch, results: [{ topicId: ID1, status: 'applied' }] });
  const writes = [];
  const result = await resumeBatch({
    store, batchId: 'mercy-1', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { mf_not_before: '2026-11-28' }, [ID2]: { mf_not_before: null } }),
    runItem: async item => { writes.push(item); return { status: 'applied' }; },
  });
  assert.equal(writes.length, 1, 'the already-applied item is not written again');
  assert.equal(writes[0].topicId, ID2);
  assert.equal(result.status, 'applied');
  assert.equal(store.saved.length, 1);
});

test('boost resume uses the persisted absolute target, never a new delta', async () => {
  const batch = {
    batchId: 'boost-1', kind: 'BOOST', status: 'partial', today: '2026-11-27', delta: 5,
    targets: [{ topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 }],
    eventIds: [{ topicId: ID1, eventId: '00000000-0000-4000-8000-0000000000c1', expectedRevision: 0 }],
  };
  const store = storeWith(batch);
  const writes = [];
  const result = await resumeBatch({
    store, batchId: 'boost-1', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 50 } }),
    runItem: async item => { writes.push(item); return { status: 'applied' }; },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].priority, 45, 'absolute target, not current-5 re-derived');
  assert.equal(result.status, 'applied');

  const settled = await resumeBatch({
    store: storeWith({ ...batch, results: [{ topicId: ID1, status: 'applied' }] }), batchId: 'boost-1', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 45 } }),
    runItem: async () => { throw new Error('must not write'); },
  });
  assert.equal(settled.status, 'applied');
});

test('a changed current value is a conflict, not a silent re-application', async () => {
  const batch = {
    batchId: 'boost-2', kind: 'BOOST', status: 'prepared', today: '2026-11-27', delta: 5,
    targets: [{ topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 }],
  };
  const result = await resumeBatch({
    store: storeWith(batch), batchId: 'boost-2', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 44 } }),
    runItem: async () => { throw new Error('must not write'); },
  });
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.status, 'failed');
});

test('a failed final batch save downgrades the resume to uncertain', async () => {
  const batch = {
    batchId: 'boost-3', kind: 'BOOST', status: 'prepared', today: '2026-11-27', delta: 5,
    targets: [{ topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 }],
  };
  const store = { async getBatch() { return JSON.parse(JSON.stringify(batch)); }, async saveBatch() { return { ok: false, code: 'E_SAVE' }; } };
  const result = await resumeBatch({
    store, batchId: 'boost-3', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 50 } }),
    runItem: async () => ({ status: 'applied' }),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'E_BATCH_RESUME_RESULT_NOT_DURABLE');
});

test('a value equal to the target without evidence is not applied by resume', async () => {
  const store = storeWith({
    ...mercyBatch,
    status: 'prepared',
    items: [{ topicId: ID1, path: 'A', basename: 'A', notBefore: '2026-11-28', currentNotBefore: null }],
    results: [],
  });
  let writes = 0;
  const result = await resumeBatch({
    store, batchId: 'mercy-1', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { mf_not_before: '2026-11-28', mf_revision: 3 } }),
    runItem: async () => { writes += 1; return { status: 'applied' }; },
  });
  assert.equal(writes, 0, 'no write based on value equality alone');
  assert.notEqual(result.status, 'applied');
  assert.equal(result.counts.uncertain, 1);
  assert.equal(store.saved.length, 1);
  assert.notEqual(store.saved[0].status, 'applied', 'must not persist a false success');
});

test('boost resume requires batch-owned ledger evidence for an already-equal priority', async () => {
  const { PersistentEventLedger, MemoryLedgerStore } = require('../src/scheduling/index.js');
  const batch = {
    batchId: 'boost-9', kind: 'BOOST', status: 'prepared', today: '2026-11-27', delta: 5,
    targets: [{ topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 }],
    eventIds: [{ topicId: ID1, eventId: '00000000-0000-4000-8000-0000000000aa' }],
  };
  const ledger = new PersistentEventLedger(new MemoryLedgerStore({
    '00000000-0000-4000-8000-0000000000aa': {
      eventId: '00000000-0000-4000-8000-0000000000aa', topicId: ID1, status: 'applied',
      audit: { before: { priority: 50 }, after: { priority: 45 } }, type: 'SET_PRIORITY',
    },
  }));
  let writes = 0;
  const settled = await resumeBatch({
    store: storeWith(batch), batchId: 'boost-9', authorization: issueSyntheticBatchResumeAuthorization(),
    ledger, readTopic: reader({ [ID1]: { priority: 45, mf_revision: 2 } }),
    runItem: async () => { writes += 1; return { status: 'applied' }; },
  });
  assert.equal(writes, 0);
  assert.equal(settled.status, 'applied', 'owned ledger evidence proves the batch applied');

  const none = await resumeBatch({
    store: storeWith({ ...batch, eventIds: [] }), batchId: 'boost-9', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 45, mf_revision: 2 } }),
    runItem: async () => { writes += 1; return { status: 'applied' }; },
  });
  assert.notEqual(none.status, 'applied');
  assert.equal(writes, 0);
});


test('boost resume reuses the persisted event identity and refuses without it', async () => {
  const planned = '00000000-0000-4000-8000-0000000000cc';
  const batch = {
    batchId: 'boost-r1', kind: 'BOOST', status: 'prepared', today: '2026-11-27', delta: 5,
    targets: [{ topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 }],
    eventIds: [{ topicId: ID1, eventId: planned, expectedRevision: 2 }],
  };
  const seen = [];
  const result = await resumeBatch({
    store: storeWith(batch), batchId: 'boost-r1', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 50, mf_revision: 2 } }),
    runItem: async item => { seen.push(item); return { status: 'applied' }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].eventId, planned, 'original identity reused');
  assert.equal(seen[0].expectedRevision, 2);
  assert.equal(result.status, 'applied');

  let writes = 0;
  const noIdentity = await resumeBatch({
    store: storeWith({ ...batch, eventIds: [] }), batchId: 'boost-r1', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 50, mf_revision: 2 } }),
    runItem: async () => { writes += 1; return { status: 'applied' }; },
  });
  assert.equal(writes, 0);
  assert.equal(noIdentity.counts.blocked, 1);
});

test('boost resume refuses when the topic revision moved past the plan', async () => {
  const batch = {
    batchId: 'boost-r2', kind: 'BOOST', status: 'prepared', today: '2026-11-27', delta: 5,
    targets: [{ topicId: ID1, path: 'A', basename: 'A', from: 50, to: 45 }],
    eventIds: [{ topicId: ID1, eventId: '00000000-0000-4000-8000-0000000000dd', expectedRevision: 2 }],
  };
  let writes = 0;
  const result = await resumeBatch({
    store: storeWith(batch), batchId: 'boost-r2', authorization: issueSyntheticBatchResumeAuthorization(),
    readTopic: reader({ [ID1]: { priority: 50, mf_revision: 4 } }),
    runItem: async () => { writes += 1; return { status: 'applied' }; },
  });
  assert.equal(writes, 0);
  assert.equal(result.counts.conflict, 1);
});
