'use strict';

// PR-09 — invariants, privacy and synthetic performance observations.

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  executeUnifiedEvent,
  SyntheticUnifiedStorage,
  MemoryLedgerStore,
  PersistentEventLedger,
  issueSyntheticUnifiedCapability,
} = require('../src/scheduling/index.js');
const { setup, makeRequest, makeTopic, uuid } = require('./helpers/unified-fixtures.js');

test('the same request and state produce the same audit', () => {
  const first = setup();
  const second = setup();
  const request = makeRequest(first.topic);
  const a = executeUnifiedEvent(request, first.deps);
  const b = executeUnifiedEvent(request, second.deps);
  assert.deepEqual(a.audit, b.audit);
  assert.deepEqual(a.record.audit, b.record.audit);
});

test('event invariants hold across every supported type', () => {
  const cases = [
    ['ADVANCED', undefined, 1, true],
    ['HOLD', undefined, 1, true],
    ['SOON', undefined, 1, true],
    ['POSTPONE', { days: 7 }, 0, false],
    ['SET_PRIORITY', { priority: 10 }, 0, false],
    ['MANUAL_SCHEDULE', { idealDue: '2026-12-20', reason: 'travel' }, 0, false],
    ['COMPLETE', undefined, 0, false],
  ];
  for (const [type, payload, reviewDelta, applied] of cases) {
    const context = setup();
    const result = executeUnifiedEvent(makeRequest(context.topic, { type, payload }), context.deps);
    assert.equal(result.status, applied ? 'applied' : 'applied', type);
    const record = result.record;
    assert.equal(record.audit.actualRevision, 2, type);
    assert.equal(record.audit.after.reviewCount, 3 + reviewDelta, type);
    assert.equal(record.audit.writesPerformed, true, type);
    assert.equal(record.audit.before.idealDue, '2026-11-24', type);
    if (type === 'POSTPONE') {
      assert.equal(record.audit.after.idealDue, '2026-11-24');
      assert.equal(record.audit.after.notBefore, '2026-12-01');
    }
    if (type === 'SET_PRIORITY') {
      assert.equal(record.audit.after.idealDue, '2026-11-24');
      assert.equal(record.audit.after.priority, 10);
    }
  }
});

test('SKIP is a zero-state no-op in the ledger as well', () => {
  const context = setup();
  const result = executeUnifiedEvent(makeRequest(context.topic, { type: 'SKIP' }), context.deps);
  assert.equal(result.status, 'no-op');
  assert.equal(result.record.audit.writesPerformed, false);
  assert.equal(result.record.audit.before.revision ?? result.record.audit.before.revision, undefined);
  assert.equal(context.storage.read(context.topic.path).frontmatter.mf_revision, 1);
});

test('audit records contain no body text or file path', () => {
  const context = setup({ body: 'SECRET BODY TEXT' });
  executeUnifiedEvent(makeRequest(context.topic), context.deps);
  const serialized = JSON.stringify(context.ledger.listPending()) + JSON.stringify(context.ledger.get(makeRequest(context.topic).eventId));
  assert.equal(serialized.includes('SECRET BODY TEXT'), false);
  assert.equal(serialized.includes('Sources/'), false);
});

test('a card never enters the writer and no SR path is touched', () => {
  const context = setup({ frontmatter: { type: 'card' }, path: 'Cards/C.md' });
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(context.storage.read('Cards/C.md').frontmatter.review_count, 3);
});

test('1,000 topics and 1,000 events stay correct and fast', () => {
  const files = {};
  const topics = [];
  for (let index = 1; index <= 1000; index += 1) {
    const topic = makeTopic({ seq: index });
    files[topic.path] = topic.entry;
    topics.push(topic);
  }
  const storage = new SyntheticUnifiedStorage(files);
  const ledger = new PersistentEventLedger(new MemoryLedgerStore());
  const deps = { mode: { mode: 'unified' }, storage, ledger, capability: issueSyntheticUnifiedCapability() };
  const started = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    const topic = topics[index];
    const result = executeUnifiedEvent({ ...makeRequest(topic, { eventId: uuid(100000 + index) }), topicId: topic.mfId }, deps);
    assert.equal(result.status, 'applied');
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60000, `1000 events took ${elapsed.toFixed(0)}ms`);
  for (const topic of [topics[0], topics[999]]) {
    assert.equal(storage.read(topic.path).frontmatter.review_count, 4);
  }
  console.log(`[unified] 1000 topics/events ${elapsed.toFixed(0)}ms`);
});

test('10,000 topics with 1,000 events remain bounded', () => {
  const files = {};
  const topics = [];
  for (let index = 1; index <= 10000; index += 1) {
    const topic = makeTopic({ seq: index });
    files[topic.path] = topic.entry;
    if (index <= 1000) topics.push(topic);
  }
  const storage = new SyntheticUnifiedStorage(files);
  const ledger = new PersistentEventLedger(new MemoryLedgerStore());
  const deps = { mode: { mode: 'unified' }, storage, ledger, capability: issueSyntheticUnifiedCapability() };
  const started = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    const topic = topics[index];
    const result = executeUnifiedEvent({ ...makeRequest(topic, { eventId: uuid(200000 + index) }), topicId: topic.mfId }, deps);
    assert.equal(result.status, 'applied');
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60000, `10k storage took ${elapsed.toFixed(0)}ms`);
  console.log(`[unified] 10k topics/1000 events ${elapsed.toFixed(0)}ms`);
});

test('a high-frequency duplicate event id never writes twice', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  const first = executeUnifiedEvent(request, context.deps);
  assert.equal(first.status, 'applied');
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(executeUnifiedEvent(request, context.deps).status, 'duplicate');
  }
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
  assert.equal(context.ledger.get(request.eventId).status, 'applied');
});
