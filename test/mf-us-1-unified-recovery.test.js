'use strict';

// PR-09 — crash windows, restart reconciliation and retry safety.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeUnifiedEvent,
  reconcileUnifiedEvent,
  sha256Hex,
  stableStringify,
  MemoryLedgerStore,
  PersistentEventLedger,
  SPEC_CONFIG,
} = require('../src/scheduling/index.js');
const { setup, makeRequest } = require('./helpers/unified-fixtures.js');

function contentHash(context) {
  return sha256Hex(context.storage.read(context.topic.path).content);
}

test('a prepared record without a write is safely retried', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  const ledgerRequest = { ...request, dateFormat: 'DD-MM-YYYY', configDigest: sha256Hex(stableStringify(null)) };
  context.ledger.prepare(ledgerRequest, {
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

// ---- ledger history and request binding (review fix 4) -------------------

test('a historical success survives E2 and reconcile(E1)', () => {
  const context = setup();
  const e1 = makeRequest(context.topic, { eventId: '00000000-0000-4000-8000-000000009001' });
  const e2 = makeRequest(context.topic, {
    eventId: '00000000-0000-4000-8000-000000009002',
    expectedRevision: 2,
    today: '2026-11-25',
    calendarDate: '2026-11-25',
  });
  executeUnifiedEvent(e1, context.deps);
  executeUnifiedEvent(e2, context.deps);

  const reconciled = reconcileUnifiedEvent(e1.eventId, context.deps);
  assert.equal(reconciled.status, 'applied');
  assert.equal(reconciled.writesPerformed, false);
  assert.equal(context.ledger.get(e1.eventId).status, 'applied');

  const replay = executeUnifiedEvent({ ...e1, expectedRevision: 1 }, context.deps);
  assert.equal(replay.status, 'duplicate');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 5);
});

test('a hash match with an inconsistent revision is not treated as applied', () => {
  const context = setup();
  const request = makeRequest(context.topic, { eventId: '00000000-0000-4000-8000-000000009003' });
  executeUnifiedEvent(request, context.deps);
  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'prepared', afterHash: null, expectedRevision: 42 });

  const result = executeUnifiedEvent(request, context.deps);
  assert.equal(result.status, 'requires-manual-recovery');
  assert.equal(result.reason, 'E_RECOVERY_STATE_MISMATCH');
});

test('the same event id with a different date format is a conflict', () => {
  const context = setup();
  const request = makeRequest(context.topic, { eventId: '00000000-0000-4000-8000-000000009004' });
  executeUnifiedEvent(request, context.deps);
  assert.throws(
    () => executeUnifiedEvent(request, { ...context.deps, dateFormat: 'MM-DD-YYYY' }),
    error => error.code === 'E_EVENT_ID_CONFLICT'
  );
});

test('the same event id with a different algorithm config is a conflict', () => {
  const context = setup();
  const request = makeRequest(context.topic, { eventId: '00000000-0000-4000-8000-000000009005' });
  executeUnifiedEvent(request, context.deps);
  assert.throws(
    () => executeUnifiedEvent(request, { ...context.deps, config: SPEC_CONFIG }),
    error => error.code === 'E_EVENT_ID_CONFLICT'
  );
});

test('a prepared event cannot be retried under a different config', () => {
  const context = setup();
  const request = makeRequest(context.topic, { eventId: '00000000-0000-4000-8000-000000009006' });
  executeUnifiedEvent(request, context.deps);
  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'prepared', afterHash: null });
  assert.throws(
    () => executeUnifiedEvent(request, { ...context.deps, config: SPEC_CONFIG }),
    error => error.code === 'E_EVENT_ID_CONFLICT'
  );
});

test('a no-op SKIP record can be recovered without a revision bump', () => {
  const context = setup();
  const request = makeRequest(context.topic, { type: 'SKIP', eventId: '00000000-0000-4000-8000-000000009007' });
  executeUnifiedEvent(request, context.deps);
  const record = context.ledger.get(request.eventId);
  context.store.put(request.eventId, { ...record, status: 'prepared', afterHash: null });

  const recovered = executeUnifiedEvent(request, context.deps);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.recovered, true);
  assert.equal(context.storage.read(context.topic.path).frontmatter.mf_revision, 1);
});

test('the occurrence date is distinct from the business today', () => {
  const context = setup();
  const request = makeRequest(context.topic, {
    eventId: '00000000-0000-4000-8000-000000009008',
    today: '2026-11-24',
    calendarDate: '2026-11-18',
  });
  const result = executeUnifiedEvent(request, context.deps);
  assert.equal(result.status, 'applied');
  const record = context.ledger.get(request.eventId);
  assert.equal(record.today, '2026-11-24');
  assert.equal(record.eventDate, '2026-11-18');
  assert.equal(context.storage.read(context.topic.path).frontmatter.last_reviewed, '2026-11-24');
});

test('missing or illegal occurrence dates and unsupported formats are refused', () => {
  const context = setup();
  const missing = makeRequest(context.topic, { calendarDate: undefined });
  assert.throws(() => executeUnifiedEvent(missing, context.deps), error => error.code === 'E_EVENT_DATE_REQUIRED');

  const invalid = makeRequest(context.topic, { calendarDate: '2026-02-30' });
  assert.throws(() => executeUnifiedEvent(invalid, context.deps), error => error.code === 'E_EVENT_DATE_INVALID');

  const request = makeRequest(context.topic);
  assert.throws(
    () => executeUnifiedEvent(request, { ...context.deps, dateFormat: 'DD.MM.YYYY' }),
    error => error.code === 'E_DATE_FORMAT_UNSUPPORTED'
  );
});
