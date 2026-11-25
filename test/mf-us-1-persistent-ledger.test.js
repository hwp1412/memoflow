'use strict';

// PR-09 — persistent event ledger data model and restart semantics.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PersistentEventLedger,
  MemoryLedgerStore,
  requestFingerprint,
  executeUnifiedEvent,
  uuid,
  setup,
  makeRequest,
} = (() => {
  const core = require('../src/scheduling/index.js');
  const fixtures = require('./helpers/unified-fixtures.js');
  return { ...core, ...fixtures };
})();

test('an applied record is serializable and contains no note content or path', () => {
  const context = setup();
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'applied');
  const record = context.ledger.get(result.record.eventId);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('Body text'), false);
  assert.equal(serialized.includes('Sources/'), false);
  assert.equal(record.eventId, result.record.eventId);
  assert.equal(record.topicId, context.topic.mfId);
  assert.equal(record.status, 'applied');
  assert.equal(record.audit.expectedRevision, 1);
  assert.equal(record.audit.actualRevision, 2);
  assert.equal(record.audit.writesPerformed, true);
});

test('fingerprint changes when the request content changes', () => {
  const base = { eventId: uuid(1), topicId: uuid(2), type: 'ADVANCED', payload: undefined, expectedRevision: 1, algorithmVersion: 1, today: '2026-11-24' };
  const other = { ...base, type: 'HOLD' };
  assert.notEqual(requestFingerprint(base), requestFingerprint(other));
  assert.equal(requestFingerprint(base), requestFingerprint({ ...base }));
});

test('a recreated ledger instance still reports a duplicate', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);

  const reloadedStore = new MemoryLedgerStore(context.store.dump());
  const reloadedLedger = new PersistentEventLedger(reloadedStore);
  const duplicate = executeUnifiedEvent(request, { ...context.deps, ledger: reloadedLedger });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.writesPerformed, false);
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('the same event id with different content is a conflict', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);
  assert.throws(
    () => executeUnifiedEvent({ ...request, type: 'HOLD' }, context.deps),
    error => error.code === 'E_EVENT_ID_CONFLICT'
  );
});

test('listPending reports every non-applied record', () => {
  const context = setup();
  const ledger = context.ledger;
  ledger.prepare(makeRequest(context.topic), {
    beforeHash: 'a'.repeat(64), expectedAfterHash: 'b'.repeat(64), fields: {}, before: {}, after: {},
  });
  assert.equal(ledger.listPending().length, 1);
  assert.equal(ledger.listPending()[0].status, 'prepared');
});

test('a plain object cannot be used as a ledger store', () => {
  assert.throws(() => new PersistentEventLedger({ get() {}, put() {}, dump() {} }),
    error => error.code === 'E_LEDGER_STORE_UNTRUSTED');
});

test('a corrupted ledger record blocks automatic execution', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);
  context.store.corrupt(request.eventId);
  const result = executeUnifiedEvent(request, context.deps);
  assert.equal(result.status, 'requires-manual-recovery');
  assert.equal(result.reason, 'E_LEDGER_CORRUPT');
});
