'use strict';

// PR-09 — single-topic Unified writer semantics.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeUnifiedEvent,
  SyntheticUnifiedStorage,
  MemoryLedgerStore,
  PersistentEventLedger,
  issueSyntheticUnifiedCapability,
} = require('../src/scheduling/index.js');
const { setup, makeRequest, makeTopic, uuid } = require('./helpers/unified-fixtures.js');

function read(context) {
  return context.storage.read(context.topic.path);
}

test('ADVANCED applies the accepted formula and projects legacy next_review', () => {
  const context = setup();
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'applied');
  assert.equal(result.writesPerformed, true);
  const entry = read(context);
  assert.equal(entry.frontmatter.mf_revision, 2);
  assert.equal(entry.frontmatter.review_count, 4);
  assert.equal(entry.frontmatter.mf_interval_days, 16);
  assert.equal(entry.frontmatter.mf_ideal_due, '2026-12-10');
  assert.equal(entry.frontmatter.last_reviewed, '2026-11-24');
  assert.equal(entry.frontmatter.mf_last_event_id, makeRequest(context.topic).eventId);
  assert.equal(entry.frontmatter.next_review, '10-12-2026');
  assert.equal(entry.body, 'Body text\nsecond line');
});

test('HOLD keeps the interval, SOON shortens it, both count a review', () => {
  const holdContext = setup();
  const hold = executeUnifiedEvent(makeRequest(holdContext.topic, { type: 'HOLD' }), holdContext.deps);
  assert.equal(hold.status, 'applied');
  assert.equal(read(holdContext).frontmatter.mf_interval_days, 8);
  assert.equal(read(holdContext).frontmatter.mf_ideal_due, '2026-12-02');
  assert.equal(read(holdContext).frontmatter.review_count, 4);

  const soonContext = setup();
  executeUnifiedEvent(makeRequest(soonContext.topic, { type: 'SOON' }), soonContext.deps);
  assert.equal(read(soonContext).frontmatter.mf_interval_days, 2);
  assert.equal(read(soonContext).frontmatter.mf_ideal_due, '2026-11-26');
  assert.equal(read(soonContext).frontmatter.review_count, 4);
});

test('SKIP writes no scheduling state and is idempotent', () => {
  const context = setup();
  const request = makeRequest(context.topic, { type: 'SKIP' });
  const before = read(context);
  const result = executeUnifiedEvent(request, context.deps);
  assert.equal(result.status, 'no-op');
  assert.equal(result.writesPerformed, false);
  const after = read(context);
  assert.deepEqual(after.frontmatter, before.frontmatter);
  assert.equal(after.revision, before.revision);
  assert.equal(result.record.writesPerformed, false);

  const duplicate = executeUnifiedEvent(request, context.deps);
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(read(context).frontmatter, before.frontmatter);
});

test('POSTPONE only moves not_before and never counts a review', () => {
  const context = setup();
  const result = executeUnifiedEvent(makeRequest(context.topic, { type: 'POSTPONE', payload: { days: 7 } }), context.deps);
  assert.equal(result.status, 'applied');
  const entry = read(context);
  assert.equal(entry.frontmatter.mf_not_before, '2026-12-01');
  assert.equal(entry.frontmatter.mf_ideal_due, '2026-11-24');
  assert.equal(entry.frontmatter.review_count, 3);
  assert.equal(entry.frontmatter.last_reviewed, '2026-11-01');
});

test('SET_PRIORITY never reorders ideal due', () => {
  const context = setup();
  executeUnifiedEvent(makeRequest(context.topic, { type: 'SET_PRIORITY', payload: { priority: 10 } }), context.deps);
  const entry = read(context);
  assert.equal(entry.frontmatter.priority, 10);
  assert.equal(entry.frontmatter.mf_ideal_due, '2026-11-24');
  assert.equal(entry.frontmatter.review_count, 3);
});

test('MANUAL_SCHEDULE changes the due date without a review', () => {
  const context = setup();
  executeUnifiedEvent(makeRequest(context.topic, {
    type: 'MANUAL_SCHEDULE', payload: { idealDue: '2026-12-20', reason: 'travel' },
  }), context.deps);
  const entry = read(context);
  assert.equal(entry.frontmatter.mf_ideal_due, '2026-12-20');
  assert.equal(entry.frontmatter.mf_not_before, null);
  assert.equal(entry.frontmatter.review_count, 3);
});

test('COMPLETE then REACTIVATE keeps history and uses the explicit date', () => {
  const context = setup();
  const complete = executeUnifiedEvent(makeRequest(context.topic, { type: 'COMPLETE', eventId: uuid(1010) }), context.deps);
  assert.equal(complete.status, 'applied');
  assert.equal(read(context).frontmatter.status, 'done');

  const reactivate = executeUnifiedEvent(makeRequest(context.topic, {
    type: 'REACTIVATE', eventId: uuid(1011), expectedRevision: 2, payload: { idealDue: '2026-12-01' },
  }), context.deps);
  assert.equal(reactivate.status, 'applied');
  const entry = read(context);
  assert.equal(entry.frontmatter.status, 'active');
  assert.equal(entry.frontmatter.mf_ideal_due, '2026-12-01');
  assert.equal(entry.frontmatter.review_count, 3);
  assert.equal(entry.frontmatter.mf_revision, 3);
});

test('DISMISS is allowed and keeps scheduling history', () => {
  const context = setup();
  const result = executeUnifiedEvent(makeRequest(context.topic, { type: 'DISMISS' }), context.deps);
  assert.equal(result.status, 'applied');
  const entry = read(context);
  assert.equal(entry.frontmatter.status, 'dismissed');
  assert.equal(entry.frontmatter.mf_interval_days, 8);
  assert.equal(entry.frontmatter.review_count, 3);
});

test('E1 -> E2 -> E1 never recounts the first event', () => {
  const context = setup();
  const e1 = makeRequest(context.topic, { eventId: uuid(1001) });
  const e2 = makeRequest(context.topic, { eventId: uuid(1002), expectedRevision: 2, today: '2026-11-25' });
  executeUnifiedEvent(e1, context.deps);
  executeUnifiedEvent(e2, context.deps);
  assert.equal(read(context).frontmatter.review_count, 5);

  const replay = executeUnifiedEvent({ ...e1, expectedRevision: 1 }, context.deps);
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.writesPerformed, false);
  assert.equal(read(context).frontmatter.review_count, 5);
});

test('a recreated writer and ledger still refuse a replayed event', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);

  const { PersistentEventLedger, MemoryLedgerStore } = require('../src/scheduling/index.js');
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(context.store.dump()));
  const replay = executeUnifiedEvent(request, { ...context.deps, ledger });
  assert.equal(replay.status, 'duplicate');
  assert.equal(read(context).frontmatter.review_count, 4);
});

test('non-scheduling frontmatter and body are preserved', () => {
  const context = setup({ frontmatter: { custom: 'keep', tags: '[a,b]' } });
  executeUnifiedEvent(makeRequest(context.topic), context.deps);
  const entry = read(context);
  assert.equal(entry.frontmatter.custom, 'keep');
  assert.equal(entry.frontmatter.tags, '[a,b]');
  assert.equal(entry.body, 'Body text\nsecond line');
});

test('a topic without persisted revision is refused', () => {
  const context = setup({ revision: null, frontmatter: { mf_revision: undefined, mf_scheduler_version: undefined } });
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.writesPerformed, false);
});

test('unsupported scheduler version is refused', () => {
  const context = setup({ frontmatter: { mf_scheduler_version: 2 } });
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_VERSION_NOT_PERSISTED');
});

test('an unsupported request algorithm version throws before any write', () => {
  const context = setup();
  assert.throws(() => executeUnifiedEvent(makeRequest(context.topic, { algorithmVersion: 2 }), context.deps),
    error => error.code === 'E_VERSION_UNSUPPORTED');
});

test('a card is not an MF-US-1 topic', () => {
  const context = setup({ frontmatter: { type: 'card' } });
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_TOPIC_TYPE');
});

// ---- persisted Frontmatter identity and revision (review fix 1) ----------

function storageWith(frontmatter, options = {}) {
  const base = setup();
  const storage = new SyntheticUnifiedStorage({
    [base.topic.path]: {
      mfId: options.mfId ?? base.topic.mfId,
      revision: options.revision ?? 1,
      frontmatter,
      body: 'Body text',
    },
  });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore());
  const deps = {
    mode: { mode: 'unified' },
    storage,
    ledger,
    capability: issueSyntheticUnifiedCapability(),
  };
  return { base, storage, ledger, deps };
}

test('an index id without a persisted frontmatter id is refused', () => {
  const { base, storage, deps } = storageWith({
    ...makeTopic({ seq: 1 }).entry.frontmatter,
    mf_id: undefined,
  });
  const result = executeUnifiedEvent(makeRequest(base.topic), deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_ID_NOT_PERSISTED');
  assert.equal(storage.read(base.topic.path).frontmatter.mf_revision, 1);
});

test('an index revision without a persisted frontmatter revision is refused', () => {
  const { base, deps } = storageWith({
    ...makeTopic({ seq: 1 }).entry.frontmatter,
    mf_revision: undefined,
  });
  const result = executeUnifiedEvent(makeRequest(base.topic), deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_REVISION_NOT_PERSISTED');
});

test('conflicting index and frontmatter revisions are refused', () => {
  const { base, deps } = storageWith({
    ...makeTopic({ seq: 1 }).entry.frontmatter,
    mf_revision: 1,
  }, { revision: 2 });
  const result = executeUnifiedEvent(makeRequest(base.topic, { expectedRevision: 2 }), deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_REVISION_FRONTMATTER_MISMATCH');
});

test('a frontmatter id that differs from the requested id is refused', () => {
  const base = setup();
  const { storage, ledger, deps } = storageWith({
    ...base.topic.entry.frontmatter,
    mf_id: uuid(999),
  }, { mfId: base.topic.mfId });
  const request = makeRequest(base.topic);
  const result = executeUnifiedEvent(request, deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_TOPIC_ID_MISMATCH');
});
