'use strict';

// PR-02 — event idempotency and revision coordination (SPEC A8, A13 T13,
// A13.1 "idempotent across retries"). In-memory ledger only: nothing is
// persisted, so this proves the pure model, not durable idempotency (Q14).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  SPEC_CONFIG,
  LEDGER_VERSION,
  initializeTopic,
  createEventLedger,
  applyEventWithLedger,
  lookupEvent,
  eventFingerprint,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TODAY = '2026-11-24';

function eventId(n) {
  return `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeTopic(overrides = {}) {
  const created = initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, TODAY).topic;
  return { ...created, ...overrides };
}

function ev(n, type, options = {}) {
  return {
    eventId: eventId(n),
    topicId: options.topicId ?? UUID,
    type,
    expectedRevision: options.revision ?? 0,
    algorithmVersion: 1,
    calendarDate: options.calendarDate ?? TODAY,
    payload: options.payload ?? null,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError);
    assert.equal(error.code, code);
    return true;
  });
}

test('replaying the same event returns the stored result without applying it', () => {
  const topic = makeTopic();
  const event = ev(1, 'ADVANCED');
  const first = applyEventWithLedger(createEventLedger(), topic, event, SPEC_CONFIG, TODAY);
  assert.equal(first.duplicate, false);
  assert.equal(first.topic.review_count, 1);

  const second = applyEventWithLedger(first.ledger, first.topic, event, SPEC_CONFIG, TODAY);
  assert.equal(second.duplicate, true);
  assert.equal(second.result.applied, false);
  assert.equal(second.result.needsWrite, false);
  assert.equal(second.result.reviewApplied, false);
  assert.equal(second.result.topic.review_count, 1);
  assert.equal(second.result.topic.mf_revision, 1);
  assert.equal(second.ledger, first.ledger, 'duplicate returns the same ledger reference');
});

test('E1 success -> E2 success -> E1 retry never counts the review twice', () => {
  const topic = makeTopic();
  const e1 = ev(1, 'ADVANCED');
  const e2 = ev(2, 'ADVANCED', { revision: 1 });

  const r1 = applyEventWithLedger(createEventLedger(), topic, e1, SPEC_CONFIG, TODAY);
  const r2 = applyEventWithLedger(r1.ledger, r1.topic, e2, SPEC_CONFIG, TODAY);
  assert.equal(r2.topic.review_count, 2);
  assert.equal(r2.topic.mf_revision, 2);

  // The retry still carries its original (now stale) expectedRevision.
  const retry = applyEventWithLedger(r2.ledger, r2.topic, e1, SPEC_CONFIG, TODAY);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.result.topic.review_count, 2);
  assert.equal(retry.result.topic.mf_revision, 2);
  assert.equal(retry.result.topic.mf_last_event_id, e2.eventId);
  assert.equal(retry.result.explain.data.originalRevisionAfter, 1);
});

test('a duplicate is recognised before the revision check', () => {
  const topic = makeTopic();
  const event = ev(1, 'ADVANCED', { revision: 0 });
  const first = applyEventWithLedger(createEventLedger(), topic, event, SPEC_CONFIG, TODAY);
  assert.equal(first.topic.mf_revision, 1);
  // The retry's expectedRevision (0) no longer matches the topic (1); without
  // the ledger-first ordering this would be misreported as a conflict.
  const retry = applyEventWithLedger(first.ledger, first.topic, event, SPEC_CONFIG, TODAY);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.result.reason, 'DUPLICATE');
});

test('the same eventId with different content is a conflict, not a duplicate', () => {
  const topic = makeTopic();
  const E1 = ev(1, 'ADVANCED');
  const first = applyEventWithLedger(createEventLedger(), topic, E1, SPEC_CONFIG, TODAY);

  const changedPayload = { ...E1, payload: { note: 'different' } };
  expectCode(
    () => applyEventWithLedger(first.ledger, first.topic, changedPayload, SPEC_CONFIG, TODAY),
    'E_EVENT_ID_CONFLICT'
  );

  const changedType = { ...E1, type: 'HOLD' };
  expectCode(
    () => applyEventWithLedger(first.ledger, first.topic, changedType, SPEC_CONFIG, TODAY),
    'E_EVENT_ID_CONFLICT'
  );

  try {
    applyEventWithLedger(first.ledger, first.topic, changedType, SPEC_CONFIG, TODAY);
    assert.fail('expected a conflict');
  } catch (error) {
    assert.equal(error.code, 'E_EVENT_ID_CONFLICT');
    assert.equal(error.details.storedType, 'ADVANCED');
    assert.equal(error.details.incomingType, 'HOLD');
    assert.equal(error.details.eventId, E1.eventId);
  }
});

test('a new eventId with a stale revision is a revision conflict', () => {
  const topic = makeTopic({ mf_revision: 3 });
  expectCode(
    () => applyEventWithLedger(createEventLedger(), topic, ev(1, 'ADVANCED', { revision: 2 }), SPEC_CONFIG, TODAY),
    'E_REVISION_CONFLICT'
  );
});

test('no-op events are recorded so a replay stays a no-op', () => {
  const topic = makeTopic({ mf_ideal_due: '2026-12-20' });
  const postpone = ev(1, 'POSTPONE', { payload: { days: 7 } });
  const first = applyEventWithLedger(createEventLedger(), topic, postpone, SPEC_CONFIG, TODAY);
  assert.equal(first.result.applied, false);
  assert.equal(first.result.reason, 'NO_LATER_THAN_IDEAL');
  assert.equal(first.ledger.entries[postpone.eventId].status, 'noop');

  const second = applyEventWithLedger(first.ledger, first.topic, postpone, SPEC_CONFIG, TODAY);
  assert.equal(second.duplicate, true);
  assert.equal(second.result.reason, 'DUPLICATE');
});

test('failed events are not recorded, so a corrected retry can apply', () => {
  const topic = makeTopic({ mf_revision: 2 });
  const stale = ev(1, 'ADVANCED', { revision: 1 });
  const ledger = createEventLedger();
  expectCode(() => applyEventWithLedger(ledger, topic, stale, SPEC_CONFIG, TODAY), 'E_REVISION_CONFLICT');
  assert.equal(lookupEvent(ledger, stale.eventId), null);

  const corrected = { ...stale, expectedRevision: 2 };
  const applied = applyEventWithLedger(ledger, topic, corrected, SPEC_CONFIG, TODAY);
  assert.equal(applied.duplicate, false);
  assert.equal(applied.topic.review_count, 1);
});

test('the ledger is immutable and never mutated in place', () => {
  const ledger = createEventLedger();
  const topic = makeTopic();
  assert.equal(Object.isFrozen(ledger), true);
  const result = applyEventWithLedger(ledger, topic, ev(1, 'ADVANCED'), SPEC_CONFIG, TODAY);
  assert.deepEqual(ledger.entries, {});
  assert.equal(Object.keys(result.ledger.entries).length, 1);
  assert.equal(Object.isFrozen(result.ledger), true);
  assert.equal(Object.isFrozen(result.ledger.entries[eventId(1)]), true);
});

test('malformed ledgers are rejected', () => {
  const topic = makeTopic();
  expectCode(() => applyEventWithLedger(null, topic, ev(1, 'ADVANCED'), SPEC_CONFIG, TODAY), 'E_OBJECT_REQUIRED');
  expectCode(
    () => applyEventWithLedger({ version: 2, entries: {} }, topic, ev(1, 'ADVANCED'), SPEC_CONFIG, TODAY),
    'E_LEDGER_INVALID'
  );
  expectCode(
    () => applyEventWithLedger({ version: LEDGER_VERSION, entries: null }, topic, ev(1, 'ADVANCED'), SPEC_CONFIG, TODAY),
    'E_OBJECT_REQUIRED'
  );
});

test('losing the ledger degrades to a revision conflict, never a silent duplicate', () => {
  const topic = makeTopic();
  const event = ev(1, 'ADVANCED');
  const first = applyEventWithLedger(createEventLedger(), topic, event, SPEC_CONFIG, TODAY);
  // Simulate data.json loss: the topic advanced, the ledger is gone.
  const emptyLedger = createEventLedger();
  expectCode(
    () => applyEventWithLedger(emptyLedger, first.topic, event, SPEC_CONFIG, TODAY),
    'E_REVISION_CONFLICT'
  );
});

test('a crash between the topic write and the ledger record is detected', () => {
  const topic = makeTopic();
  const event = ev(1, 'ADVANCED');
  const first = applyEventWithLedger(createEventLedger(), topic, event, SPEC_CONFIG, TODAY);
  // The topic write happened (first.topic) but the new ledger was not persisted.
  expectCode(
    () => applyEventWithLedger(createEventLedger(), first.topic, event, SPEC_CONFIG, TODAY),
    'E_REVISION_CONFLICT'
  );
});

test('two events created against the same revision: the second conflicts', () => {
  const topic = makeTopic();
  const e1 = ev(1, 'SET_PRIORITY', { payload: { priority: 10 } });
  const e2 = ev(2, 'SET_PRIORITY', { payload: { priority: 20 } });
  const r1 = applyEventWithLedger(createEventLedger(), topic, e1, SPEC_CONFIG, TODAY);
  assert.equal(r1.topic.priority, 10);
  expectCode(() => applyEventWithLedger(r1.ledger, r1.topic, e2, SPEC_CONFIG, TODAY), 'E_REVISION_CONFLICT');
  assert.equal(r1.topic.priority, 10, 'the conflicting event never overwrites state');
});

test('replaying an identical event stream reproduces the same state deterministically', () => {
  const events = [
    ev(1, 'ADVANCED'),
    ev(2, 'ADVANCED', { revision: 1 }),
    ev(3, 'POSTPONE', { revision: 2, payload: { days: 30 } }),
    ev(4, 'SET_PRIORITY', { revision: 3, payload: { priority: 10 } }),
    ev(5, 'SKIP', { revision: 4 }),
  ];

  function replay() {
    let ledger = createEventLedger();
    let topic = makeTopic();
    const results = [];
    for (const event of events) {
      const step = applyEventWithLedger(ledger, topic, event, SPEC_CONFIG, TODAY);
      ledger = step.ledger;
      topic = step.topic;
      results.push(step.result.applied);
    }
    return { topic, ledger, results };
  }

  const first = replay();
  const second = replay();
  assert.deepEqual(first, second);
  assert.deepEqual(first.results, [true, true, true, true, false]);
  assert.equal(first.topic.review_count, 2);
  assert.equal(first.topic.mf_revision, 4);
});

test('fingerprints are stable and include payload content', () => {
  const a = ev(1, 'POSTPONE', { payload: { days: 7 } });
  const b = ev(1, 'POSTPONE', { payload: { days: 7 } });
  const c = ev(1, 'POSTPONE', { payload: { days: 8 } });
  assert.equal(eventFingerprint(a), eventFingerprint(b));
  assert.notEqual(eventFingerprint(a), eventFingerprint(c));
  assert.equal(eventFingerprint({ ...a, payload: { b: 1, a: 2 } }), eventFingerprint({ ...a, payload: { a: 2, b: 1 } }));
});

test('property: replaying any prefix twice never doubles a review', () => {
  let ledger = createEventLedger();
  let topic = makeTopic();
  const events = [
    ev(1, 'ADVANCED'),
    ev(2, 'HOLD', { revision: 1 }),
    ev(3, 'SOON', { revision: 2 }),
  ];
  let expected = 0;
  for (const event of events) {
    const step = applyEventWithLedger(ledger, topic, event, SPEC_CONFIG, TODAY);
    ledger = step.ledger;
    topic = step.topic;
    expected += 1;
    const replayStep = applyEventWithLedger(ledger, topic, event, SPEC_CONFIG, TODAY);
    assert.equal(replayStep.duplicate, true);
    assert.equal(replayStep.topic.review_count, expected);
    assert.equal(replayStep.topic.mf_revision, expected);
  }
});

// ---- topic identity on duplicate (owner review fix 2) ---------------------

test('a duplicate event can never be replayed against a different topic', () => {
  const OTHER_TOPIC = '9b2f4c1e-0000-4000-8000-000000000002';
  const topicA = makeTopic();
  const e1 = ev(1, 'ADVANCED');
  const first = applyEventWithLedger(createEventLedger(), topicA, e1, SPEC_CONFIG, TODAY);
  assert.equal(first.topic.review_count, 1);

  const topicB = { ...makeTopic(), mf_id: OTHER_TOPIC };
  assert.throws(
    () => applyEventWithLedger(first.ledger, topicB, e1, SPEC_CONFIG, TODAY),
    error => {
      assert.equal(error.code, 'E_EVENT_TOPIC_CONFLICT');
      assert.equal(error.details.eventId, e1.eventId);
      assert.equal(error.details.ledgerTopicId, UUID);
      assert.equal(error.details.currentTopicId, OTHER_TOPIC);
      return true;
    }
  );

  // Topic B, the ledger and the review count are all untouched.
  assert.equal(topicB.review_count, 0);
  assert.equal(topicB.mf_revision, 0);
  assert.equal(topicB.mf_last_event_id, null);
  assert.equal(Object.keys(first.ledger.entries).length, 1);
  assert.equal(lookupEvent(first.ledger, e1.eventId), first.ledger.entries[e1.eventId]);
});

// ---- fingerprint hardening (owner review fix 3) ---------------------------

test('fingerprints reject values JSON would silently collapse', () => {
  const topic = makeTopic();
  const ledger = createEventLedger();
  const rejected = [
    ev(11, 'POSTPONE', { payload: { days: NaN } }),
    ev(12, 'POSTPONE', { payload: { days: undefined } }),
    ev(13, 'SET_PRIORITY', { payload: { priority: Infinity } }),
  ];
  for (const event of rejected) {
    expectCode(() => applyEventWithLedger(ledger, topic, event, SPEC_CONFIG, TODAY), 'E_EVENT_PAYLOAD_INVALID');
  }
  assert.deepEqual(ledger.entries, {}, 'rejected events never enter the ledger');

  // null is legal JSON and must not be confused with undefined: it survives the
  // fingerprint and is rejected by the POSTPONE value check instead.
  expectCode(
    () => applyEventWithLedger(ledger, topic, ev(14, 'POSTPONE', { payload: { days: null } }), SPEC_CONFIG, TODAY),
    'E_POSTPONE_DAYS_INVALID'
  );
});

test('different value types and values never share a fingerprint', () => {
  assert.notEqual(
    eventFingerprint(ev(21, 'POSTPONE', { payload: { days: 7 } })),
    eventFingerprint(ev(21, 'POSTPONE', { payload: { days: '7' } }))
  );
  assert.notEqual(
    eventFingerprint(ev(22, 'SET_PRIORITY', { payload: { priority: 0 } })),
    eventFingerprint(ev(22, 'SET_PRIORITY', { payload: { priority: '0' } }))
  );
  assert.notEqual(
    eventFingerprint(ev(23, 'POSTPONE', { payload: { days: 7 } })),
    eventFingerprint(ev(23, 'POSTPONE', { payload: { days: 8 } }))
  );
  assert.notEqual(
    eventFingerprint(ev(24, 'MANUAL_SCHEDULE', { payload: { idealDue: '2026-12-01', reason: 'a' } })),
    eventFingerprint(ev(24, 'MANUAL_SCHEDULE', { payload: { idealDue: '2026-12-01', reason: 'b' } }))
  );
  // createdAt participates in the identity too.
  const base = ev(25, 'ADVANCED');
  assert.notEqual(
    eventFingerprint({ ...base, createdAt: '2026-11-24T09:00:00+08:00' }),
    eventFingerprint({ ...base, createdAt: '2026-11-24T09:00:01+08:00' })
  );
});

test('the same eventId with a different valid payload is a conflict', () => {
  const first = applyEventWithLedger(
    createEventLedger(),
    makeTopic(),
    ev(31, 'POSTPONE', { payload: { days: 7 } }),
    SPEC_CONFIG,
    TODAY
  );
  expectCode(
    () => applyEventWithLedger(first.ledger, first.topic, ev(31, 'POSTPONE', { payload: { days: 8 } }), SPEC_CONFIG, TODAY),
    'E_EVENT_ID_CONFLICT'
  );
  assert.equal(first.topic.mf_not_before, '2026-12-01');
});
