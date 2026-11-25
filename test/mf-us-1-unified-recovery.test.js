'use strict';

// PR-09 — crash windows, restart reconciliation and retry safety.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeUnifiedEvent,
  reconcileUnifiedEvent,
  sha256Hex,
  MemoryLedgerStore,
  PersistentEventLedger,
} = require('../src/scheduling/index.js');
const { setup, makeRequest } = require('./helpers/unified-fixtures.js');

function contentHash(context) {
  return sha256Hex(context.storage.read(context.topic.path).content);
}

test('a prepared record without a write is safely retried', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  context.ledger.prepare(request, {
    beforeHash: contentHash(context),
    expectedAfterHash: 'pending',
    fields: {},
    before: {},
    after: {},
  });
  const result = executeUnifiedEvent(request, context.deps);
  assert.equal(result.status, 'applied');
  assert.equal(result.writesPerformed, true);
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('a write that was persisted but not recorded is recovered without rewriting', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);

  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'prepared', afterHash: null, actualRevision: null });
  const before = context.storage.read(context.topic.path);

  const recovered = executeUnifiedEvent(request, context.deps);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.writesPerformed, false);
  assert.deepEqual(context.storage.read(context.topic.path), before);
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('reconcile recognises an applied file from the persisted intent', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);
  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'uncertain', afterHash: null });

  const reconciled = reconcileUnifiedEvent(request.eventId, context.deps);
  assert.equal(reconciled.status, 'applied');
  assert.equal(reconciled.recovered, true);
  assert.equal(reconciled.writesPerformed, false);
  assert.equal(context.ledger.get(request.eventId).status, 'applied');
});

test('a read-back failure is uncertain and recoverable, never success', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  context.storage.failNextReadAfterWrite(context.topic.path);
  const result = executeUnifiedEvent(request, context.deps);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, false);
  assert.equal(context.ledger.get(request.eventId).status, 'uncertain');

  const reconciled = reconcileUnifiedEvent(request.eventId, context.deps);
  assert.equal(reconciled.status, 'applied');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('a user edit after an unrecorded write requires manual recovery', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);
  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'prepared', afterHash: null });
  context.storage.corrupt(context.topic.path, `${context.storage.read(context.topic.path).content}\nuser edit`);

  const reconciled = reconcileUnifiedEvent(request.eventId, context.deps);
  assert.equal(reconciled.status, 'requires-manual-recovery');
  assert.equal(reconciled.reason, 'E_EXTERNAL_EDIT');
});

test('a transient CAS failure is retried safely and counts one review', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  context.storage.failNextCas(context.topic.path);
  const failed = executeUnifiedEvent(request, context.deps);
  assert.equal(failed.status, 'failed');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 3);

  const retried = executeUnifiedEvent(request, context.deps);
  assert.equal(retried.status, 'applied');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('a lost ledger cannot re-apply an already changed topic', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);

  const emptyStore = new MemoryLedgerStore();
  const lost = executeUnifiedEvent(request, {
    ...context.deps,
    ledger: new PersistentEventLedger(emptyStore),
  });
  assert.equal(lost.status, 'conflict');
  assert.equal(lost.reason, 'E_REVISION_MISMATCH');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('repeated reconciliation is idempotent', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  executeUnifiedEvent(request, context.deps);
  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'prepared', afterHash: null });

  assert.equal(reconcileUnifiedEvent(request.eventId, context.deps).status, 'applied');
  assert.equal(reconcileUnifiedEvent(request.eventId, context.deps).status, 'applied');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});
