'use strict';

// PR-02 — event state machine (SPEC A4, A5, A8, A12; A13 T05-T12, T17).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  SPEC_CONFIG,
  EVENT_TYPES,
  REVIEW_EVENTS,
  initializeTopic,
  applyEvent,
  validateTopic,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PARENT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ROOT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const TODAY = '2026-11-24';

function eventId(n) {
  return `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeTopic(overrides = {}) {
  const created = initializeTopic(
    { type: 'source', priority: 50, mfId: UUID, mfParentId: PARENT, mfRootId: ROOT },
    SPEC_CONFIG,
    TODAY
  ).topic;
  return { ...created, ...overrides };
}

let seq = 0;
function ev(type, { payload = null, revision = 0, id = null, topicId = UUID, today = TODAY, algorithmVersion = 1 } = {}) {
  seq += 1;
  return {
    eventId: id || eventId(seq),
    topicId,
    type,
    expectedRevision: revision,
    algorithmVersion,
    payload,
    ...(today ? { calendarDate: today } : {}),
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---- valid reviews (SPEC A4.2) -------------------------------------------

test('T05: ADVANCED grows the interval with the existing A-Factor', () => {
  const topic = makeTopic({ mf_interval_days: 3, a_factor: 1.5, mf_ideal_due: '2026-11-27' });
  const result = applyEvent(topic, ev('ADVANCED'), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.mf_interval_days, 5); // 3 x 1.5 = 4.5 -> 5
  assert.equal(result.topic.mf_ideal_due, '2026-11-29');
  assert.equal(result.topic.review_count, 1);
  assert.equal(result.topic.last_reviewed, TODAY);
  assert.equal(result.topic.a_factor, 1.5);
  assert.equal(result.topic.mf_revision, 1);
  assert.equal(result.topic.mf_last_event_id, result.event.eventId);
  assert.equal(result.applied, true);
  assert.equal(result.needsWrite, true);
  assert.equal(result.reviewApplied, true);
  assert.deepEqual(result.diff.fields.mf_interval_days, { from: 3, to: 5 });
});

test('T11: a topic with review_count=0 is not re-initialised from Priority', () => {
  const topic = makeTopic({ mf_interval_days: 8, a_factor: 1.5, review_count: 0, priority: 50 });
  const result = applyEvent(topic, ev('ADVANCED'), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.mf_interval_days, 12); // 8 x 1.5, NOT the P50 initial 3
  assert.notEqual(result.topic.mf_interval_days, 3);
  assert.equal(result.topic.review_count, 1);
});

test('HOLD keeps the interval but still counts as a valid review', () => {
  const topic = makeTopic({ mf_interval_days: 8, mf_ideal_due: '2026-12-02' });
  const result = applyEvent(topic, ev('HOLD'), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.mf_interval_days, 8);
  assert.equal(result.topic.mf_ideal_due, '2026-12-02'); // today + 8
  assert.equal(result.topic.review_count, 1);
  assert.equal(result.topic.last_reviewed, TODAY);
  assert.equal(result.reviewApplied, true);
  assert.equal(result.topic.mf_revision, 1);
});

test('SOON drops the interval to two days, never below one', () => {
  const long = makeTopic({ mf_interval_days: 8 });
  const soon = applyEvent(long, ev('SOON'), SPEC_CONFIG, TODAY);
  assert.equal(soon.topic.mf_interval_days, 2);
  assert.equal(soon.topic.mf_ideal_due, '2026-11-26');
  assert.equal(soon.topic.review_count, 1);

  const oneDay = makeTopic({ mf_interval_days: 1 });
  const soonOne = applyEvent(oneDay, ev('SOON'), SPEC_CONFIG, TODAY);
  assert.equal(soonOne.topic.mf_interval_days, 1);
});

test('every review event clears an existing administrative postponement', () => {
  for (const type of REVIEW_EVENTS) {
    const topic = makeTopic({ mf_not_before: '2026-12-20' });
    const result = applyEvent(topic, ev(type), SPEC_CONFIG, TODAY);
    assert.equal(result.topic.mf_not_before, null, type);
    assert.equal(result.reviewApplied, true, type);
  }
});

// ---- SKIP (SPEC A5.1) ------------------------------------------------------

test('SKIP changes nothing at all, not even the revision', () => {
  const topic = makeTopic({ mf_revision: 4, mf_last_event_id: eventId(900) });
  const result = applyEvent(topic, ev('SKIP', { revision: 999 }), SPEC_CONFIG, TODAY);
  assert.equal(result.applied, false);
  assert.equal(result.needsWrite, false);
  assert.equal(result.reviewApplied, false);
  assert.equal(result.reason, 'SESSION_ONLY');
  assert.deepEqual(result.topic, topic);
  assert.deepEqual(result.diff.fields, {});
  assert.equal(result.topic.mf_revision, 4);
  assert.equal(result.topic.mf_last_event_id, topic.mf_last_event_id);
});

// ---- POSTPONE (SPEC A5.2) --------------------------------------------------

test('POSTPONE sets only mf_not_before and leaves learning state alone', () => {
  const topic = makeTopic({ mf_interval_days: 3, mf_ideal_due: '2026-11-27', a_factor: 1.5, review_count: 2 });
  const result = applyEvent(topic, ev('POSTPONE', { payload: { days: 7 } }), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.mf_not_before, '2026-12-01');
  assert.equal(result.topic.mf_interval_days, 3);
  assert.equal(result.topic.mf_ideal_due, '2026-11-27');
  assert.equal(result.topic.a_factor, 1.5);
  assert.equal(result.topic.review_count, 2);
  assert.equal(result.topic.last_reviewed, undefined);
  assert.equal(result.applied, true);
  assert.equal(result.reviewApplied, false);
  assert.equal(result.topic.mf_revision, 1);
});

test('POSTPONE never pulls an existing postponement earlier', () => {
  const topic = makeTopic({ mf_not_before: '2026-12-10' });
  const result = applyEvent(topic, ev('POSTPONE', { payload: { days: 3 } }), SPEC_CONFIG, TODAY);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'NO_LATER_THAN_EXISTING');
  assert.equal(result.topic.mf_not_before, '2026-12-10');
  assert.equal(result.topic.mf_revision, 0);
});

test('POSTPONE reports when the ideal due date is already later', () => {
  const topic = makeTopic({ mf_ideal_due: '2026-12-20' });
  const result = applyEvent(topic, ev('POSTPONE', { payload: { days: 7 } }), SPEC_CONFIG, TODAY);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'NO_LATER_THAN_IDEAL');
  assert.equal(result.topic.mf_not_before, null);
  assert.equal(result.applied, false);
});

test('POSTPONE validates its payload', () => {
  const topic = makeTopic();
  for (const days of [0, -1, 1.5, '7', 3651, null]) {
    expectCode(() => applyEvent(topic, ev('POSTPONE', { payload: { days } }), SPEC_CONFIG, TODAY), 'E_POSTPONE_DAYS_INVALID');
  }
  expectCode(() => applyEvent(topic, ev('POSTPONE'), SPEC_CONFIG, TODAY), 'E_EVENT_PAYLOAD_INVALID');
});

// ---- MANUAL_SCHEDULE (SPEC A5.3) -------------------------------------------

test('MANUAL_SCHEDULE moves the ideal date and keeps the real interval', () => {
  const topic = makeTopic({ mf_interval_days: 3, review_count: 2, a_factor: 1.5, mf_not_before: '2026-12-10' });
  const event = ev('MANUAL_SCHEDULE', { payload: { idealDue: '2026-12-15', reason: '旅行后集中处理' } });
  const result = applyEvent(topic, event, SPEC_CONFIG, TODAY);
  assert.equal(result.topic.mf_ideal_due, '2026-12-15');
  assert.equal(result.topic.mf_not_before, null);
  assert.equal(result.topic.mf_interval_days, 3);
  assert.equal(result.topic.review_count, 2);
  assert.equal(result.topic.a_factor, 1.5);
  assert.equal(result.reviewApplied, false);
  assert.match(result.explain.text, /旅行后集中处理/);
  assert.equal(result.explain.data.manualReason, '旅行后集中处理');
});

test('MANUAL_SCHEDULE requires a reason and a valid date', () => {
  const topic = makeTopic();
  expectCode(
    () => applyEvent(topic, ev('MANUAL_SCHEDULE', { payload: { idealDue: '2026-12-15' } }), SPEC_CONFIG, TODAY),
    'E_MANUAL_REASON_REQUIRED'
  );
  expectCode(
    () => applyEvent(topic, ev('MANUAL_SCHEDULE', { payload: { idealDue: '2026-12-15', reason: '   ' } }), SPEC_CONFIG, TODAY),
    'E_MANUAL_REASON_REQUIRED'
  );
  expectCode(
    () => applyEvent(topic, ev('MANUAL_SCHEDULE', { payload: { idealDue: '2026-02-30', reason: 'x' } }), SPEC_CONFIG, TODAY),
    'E_DATE_INVALID'
  );
  expectCode(
    () => applyEvent(topic, ev('MANUAL_SCHEDULE', { payload: { reason: 'x' } }), SPEC_CONFIG, TODAY),
    'E_MANUAL_DATE_REQUIRED'
  );
});

test('MANUAL_SCHEDULE to the current ideal date is a no-op', () => {
  const topic = makeTopic({ mf_ideal_due: '2026-11-27' });
  const result = applyEvent(
    topic,
    ev('MANUAL_SCHEDULE', { payload: { idealDue: '2026-11-27', reason: 'same' } }),
    SPEC_CONFIG,
    TODAY
  );
  assert.equal(result.applied, false);
  assert.equal(result.topic.mf_revision, 0);
});

// ---- SET_PRIORITY (SPEC A5.4 / T10) ---------------------------------------

test('T10: SET_PRIORITY changes only the priority', () => {
  const topic = makeTopic({ priority: 50, mf_ideal_due: '2026-11-27', mf_interval_days: 3 });
  const result = applyEvent(topic, ev('SET_PRIORITY', { payload: { priority: 10 } }), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.priority, 10);
  assert.equal(result.topic.mf_ideal_due, '2026-11-27');
  assert.equal(result.topic.mf_interval_days, 3);
  assert.deepEqual(Object.keys(result.diff.fields).sort(), ['mf_last_event_id', 'mf_revision', 'priority']);
  for (const field of ['mf_ideal_due', 'mf_interval_days', 'a_factor', 'review_count', 'status']) {
    assert.equal(result.diff.fields[field], undefined, field);
  }
  assert.equal(result.reviewApplied, false);
});

test('SET_PRIORITY to the same value is a no-op', () => {
  const topic = makeTopic({ priority: 50 });
  const result = applyEvent(topic, ev('SET_PRIORITY', { payload: { priority: 50 } }), SPEC_CONFIG, TODAY);
  assert.equal(result.applied, false);
  assert.equal(result.topic.mf_revision, 0);
});

test('SET_PRIORITY rejects illegal priorities', () => {
  const topic = makeTopic();
  for (const priority of [0, 101]) {
    expectCode(
      () => applyEvent(topic, ev('SET_PRIORITY', { payload: { priority } }), SPEC_CONFIG, TODAY),
      'E_PRIORITY_RANGE'
    );
  }
  for (const priority of [1.5, '10', null]) {
    expectCode(
      () => applyEvent(topic, ev('SET_PRIORITY', { payload: { priority } }), SPEC_CONFIG, TODAY),
      'E_PRIORITY_TYPE'
    );
  }
});

// ---- COMPLETE / DISMISS (SPEC A4.3 / A8 / T12) -----------------------------

test('T12: COMPLETE keeps every scheduling field and deletes nothing', () => {
  const topic = makeTopic({
    mf_interval_days: 8,
    mf_ideal_due: '2026-12-02',
    mf_not_before: '2026-12-05',
    review_count: 3,
    last_reviewed: '2026-11-20',
    a_factor: 1.8,
  });
  const result = applyEvent(topic, ev('COMPLETE'), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.status, 'done');
  assert.equal(result.topic.mf_interval_days, 8);
  assert.equal(result.topic.mf_ideal_due, '2026-12-02');
  assert.equal(result.topic.mf_not_before, '2026-12-05');
  assert.equal(result.topic.review_count, 3);
  assert.equal(result.topic.last_reviewed, '2026-11-20');
  assert.equal(result.topic.a_factor, 1.8);
  assert.equal(result.topic.mf_parent_id, PARENT);
  assert.equal(result.topic.mf_root_id, ROOT);
  assert.equal(result.reviewApplied, false);
  assert.deepEqual(Object.keys(result.diff.fields).sort(), ['mf_last_event_id', 'mf_revision', 'status']);
});

test('DISMISS keeps every scheduling field', () => {
  const topic = makeTopic({ mf_interval_days: 8, review_count: 3, last_reviewed: '2026-11-20' });
  const result = applyEvent(topic, ev('DISMISS'), SPEC_CONFIG, TODAY);
  assert.equal(result.topic.status, 'dismissed');
  assert.equal(result.topic.mf_interval_days, 8);
  assert.equal(result.topic.review_count, 3);
  assert.equal(result.topic.last_reviewed, '2026-11-20');
  assert.equal(result.reviewApplied, false);
});

// ---- REACTIVATE (SPEC A4.3 / Q5) ------------------------------------------

test('REACTIVATE requires an explicit restore date and never counts a review', () => {
  for (const status of ['done', 'dismissed']) {
    const topic = makeTopic({ status, mf_interval_days: 8, review_count: 4, last_reviewed: '2026-10-01' });
    const event = ev('REACTIVATE', { payload: { idealDue: '2026-12-20' } });
    const result = applyEvent(topic, event, SPEC_CONFIG, TODAY);
    assert.equal(result.topic.status, 'active');
    assert.equal(result.topic.mf_ideal_due, '2026-12-20');
    assert.equal(result.topic.mf_not_before, null);
    assert.equal(result.topic.mf_interval_days, 8);
    assert.equal(result.topic.review_count, 4);
    assert.equal(result.topic.last_reviewed, '2026-10-01');
    assert.equal(result.reviewApplied, false);
    assert.equal(result.topic.mf_revision, 1);
  }
});

test('REACTIVATE without a date is rejected', () => {
  const topic = makeTopic({ status: 'done' });
  expectCode(() => applyEvent(topic, ev('REACTIVATE'), SPEC_CONFIG, TODAY), 'E_EVENT_PAYLOAD_INVALID');
  expectCode(() => applyEvent(topic, ev('REACTIVATE', { payload: {} }), SPEC_CONFIG, TODAY), 'E_REACTIVATE_DATE_REQUIRED');
  expectCode(
    () => applyEvent(topic, ev('REACTIVATE', { payload: { idealDue: '2026-13-01' } }), SPEC_CONFIG, TODAY),
    'E_DATE_INVALID'
  );
});

// ---- state machine / status rules -----------------------------------------

test('events are rejected from statuses the state machine does not allow', () => {
  const done = makeTopic({ status: 'done' });
  expectCode(() => applyEvent(done, ev('ADVANCED'), SPEC_CONFIG, TODAY), 'E_INVALID_TRANSITION');
  expectCode(() => applyEvent(done, ev('COMPLETE'), SPEC_CONFIG, TODAY), 'E_INVALID_TRANSITION');
  const dismissed = makeTopic({ status: 'dismissed' });
  expectCode(() => applyEvent(dismissed, ev('POSTPONE', { payload: { days: 7 } }), SPEC_CONFIG, TODAY), 'E_INVALID_TRANSITION');
  const active = makeTopic();
  expectCode(() => applyEvent(active, ev('REACTIVATE', { payload: { idealDue: '2026-12-20' } }), SPEC_CONFIG, TODAY), 'E_INVALID_TRANSITION');
});

test('legacy statuses need an adapter and are refused distinctly', () => {
  for (const status of ['inbox', 'pending', 'container']) {
    const topic = makeTopic({ status });
    expectCode(() => applyEvent(topic, ev('ADVANCED'), SPEC_CONFIG, TODAY), 'E_STATUS_UNSUPPORTED');
  }
});

// ---- event object validation (SPEC A8) ------------------------------------

test('event objects are validated field by field', () => {
  const topic = makeTopic();
  const good = ev('ADVANCED');
  expectCode(() => applyEvent(topic, { ...good, eventId: 'nope' }, SPEC_CONFIG, TODAY), 'E_ID_FORMAT');
  expectCode(() => applyEvent(topic, { ...good, eventId: null }, SPEC_CONFIG, TODAY), 'E_ID_REQUIRED');
  expectCode(() => applyEvent(topic, { ...good, type: 'ARCHIVE' }, SPEC_CONFIG, TODAY), 'E_EVENT_TYPE');
  expectCode(() => applyEvent(topic, { ...good, topicId: PARENT }, SPEC_CONFIG, TODAY), 'E_TOPIC_ID_MISMATCH');
  expectCode(() => applyEvent(topic, { ...good, algorithmVersion: 2 }, SPEC_CONFIG, TODAY), 'E_ALGORITHM_VERSION');
  expectCode(() => applyEvent(topic, { ...good, expectedRevision: -1 }, SPEC_CONFIG, TODAY), 'E_REVISION_INVALID');
  expectCode(() => applyEvent(topic, { ...good, expectedRevision: '0' }, SPEC_CONFIG, TODAY), 'E_REVISION_INVALID');
  expectCode(() => applyEvent(topic, { ...good, payload: [] }, SPEC_CONFIG, TODAY), 'E_OBJECT_REQUIRED');
});

test('an event may be applied on a later day than it happened', () => {
  const topic = makeTopic();
  const event = ev('ADVANCED', { today: '2026-11-25' });
  const result = applyEvent(topic, event, SPEC_CONFIG, '2026-11-28');
  assert.equal(result.applied, true);
  assert.equal(result.topic.last_reviewed, '2026-11-28'); // execution day (unchanged rule)
  assert.equal(result.topic.mf_ideal_due, '2026-12-03'); // today + 5
  assert.equal(result.event.eventDate, '2026-11-25'); // occurrence day
  assert.equal(result.explain.data.eventDateSource, 'calendarDate');
  assert.equal(result.explain.data.processedOnDifferentDay, true);

  const sameDay = applyEvent(topic, ev('ADVANCED', { today: TODAY }), SPEC_CONFIG, TODAY);
  assert.equal(sameDay.explain.data.processedOnDifferentDay, false);
});

test('topic validation is strict about MF-US-1 fields', () => {
  expectCode(() => validateTopic({ ...makeTopic(), mf_id: null }), 'E_ID_REQUIRED');
  expectCode(() => validateTopic({ ...makeTopic(), mf_scheduler_version: 2 }), 'E_VERSION_UNSUPPORTED');
  expectCode(() => validateTopic({ ...makeTopic(), status: 'archived' }), 'E_STATUS_UNKNOWN');
  expectCode(() => validateTopic({ ...makeTopic(), mf_revision: -1 }), 'E_REVISION_INVALID');
  expectCode(() => validateTopic({ ...makeTopic(), review_count: 1.5 }), 'E_REVIEW_COUNT_INVALID');
});

// ---- revision rules --------------------------------------------------------

test('expectedRevision must match the topic revision', () => {
  const topic = makeTopic({ mf_revision: 3 });
  assert.throws(
    () => applyEvent(topic, ev('ADVANCED', { revision: 2 }), SPEC_CONFIG, TODAY),
    error => {
      assert.equal(error.code, 'E_REVISION_CONFLICT');
      assert.deepEqual(error.details, { expected: 2, actual: 3 });
      return true;
    }
  );
});

test('revision increments exactly once per real change', () => {
  let topic = makeTopic();
  for (let i = 0; i < 5; i++) {
    const result = applyEvent(topic, ev('SET_PRIORITY', { revision: topic.mf_revision, payload: { priority: 10 + i } }), SPEC_CONFIG, TODAY);
    topic = result.topic;
    assert.equal(topic.mf_revision, i + 1);
  }
});

// ---- immutability, determinism, boundaries --------------------------------

test('applyEvent never mutates its inputs', () => {
  const topic = Object.freeze(makeTopic({ mf_revision: 2 }));
  const event = Object.freeze({
    eventId: eventId(500),
    topicId: UUID,
    type: 'ADVANCED',
    expectedRevision: 2,
    algorithmVersion: 1,
    calendarDate: TODAY,
    payload: null,
  });
  const snapshot = JSON.parse(JSON.stringify({ topic, event }));
  const result = applyEvent(topic, event, SPEC_CONFIG, TODAY);
  assert.deepEqual(JSON.parse(JSON.stringify({ topic, event })), snapshot);
  assert.notEqual(result.topic, topic);
});

test('applyEvent is deterministic', () => {
  const topic = makeTopic();
  const event = ev('ADVANCED', { id: eventId(501) });
  const first = applyEvent(topic, event, SPEC_CONFIG, TODAY);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(applyEvent(topic, event, SPEC_CONFIG, TODAY), first);
  }
});

test('dates stay correct across month, year and DST boundaries', () => {
  const monthEnd = makeTopic({ mf_interval_days: 2, a_factor: 1.5 });
  const advanced = applyEvent(monthEnd, ev('ADVANCED', { today: '2026-11-30' }), SPEC_CONFIG, '2026-11-30');
  assert.equal(advanced.topic.mf_interval_days, 3);
  assert.equal(advanced.topic.mf_ideal_due, '2026-12-03');

  const yearEnd = makeTopic({ mf_interval_days: 1 });
  const held = applyEvent(yearEnd, ev('HOLD', { today: '2026-12-31' }), SPEC_CONFIG, '2026-12-31');
  assert.equal(held.topic.mf_ideal_due, '2027-01-01');

  const leap = makeTopic({ mf_interval_days: 1 });
  const leapHeld = applyEvent(leap, ev('HOLD', { today: '2028-02-28' }), SPEC_CONFIG, '2028-02-28');
  assert.equal(leapHeld.topic.mf_ideal_due, '2028-02-29');

  const dst = makeTopic({ mf_interval_days: 1 });
  const dstHeld = applyEvent(dst, ev('HOLD', { today: '2026-03-08' }), SPEC_CONFIG, '2026-03-08');
  assert.equal(dstHeld.topic.mf_ideal_due, '2026-03-09');
});

test('no event ever changes the A-Factor (Q13)', () => {
  const scenarios = [
    ['ADVANCED', makeTopic(), {}],
    ['HOLD', makeTopic(), {}],
    ['SOON', makeTopic(), {}],
    ['SKIP', makeTopic(), {}],
    ['POSTPONE', makeTopic(), { payload: { days: 7 } }],
    ['MANUAL_SCHEDULE', makeTopic(), { payload: { idealDue: '2026-12-15', reason: 'r' } }],
    ['SET_PRIORITY', makeTopic(), { payload: { priority: 20 } }],
    ['COMPLETE', makeTopic(), {}],
    ['DISMISS', makeTopic(), {}],
    ['REACTIVATE', makeTopic({ status: 'done' }), { payload: { idealDue: '2026-12-20' } }],
  ];
  assert.equal(scenarios.length, EVENT_TYPES.length);
  for (const [type, topic, options] of scenarios) {
    const result = applyEvent(topic, ev(type, { revision: topic.mf_revision, ...options }), SPEC_CONFIG, TODAY);
    assert.equal(result.topic.a_factor, topic.a_factor, type);
  }
});

test('review events are exactly ADVANCED, HOLD and SOON', () => {
  assert.deepEqual([...REVIEW_EVENTS], ['ADVANCED', 'HOLD', 'SOON']);
  assert.equal(EVENT_TYPES.length, 10);
});

// ---- event time contract (SPEC A8, owner review fix 1) --------------------

test('an event must carry calendarDate or createdAt (A8)', () => {
  const topic = makeTopic();
  expectCode(() => applyEvent(topic, ev('ADVANCED', { today: null }), SPEC_CONFIG, TODAY), 'E_EVENT_TIME_REQUIRED');
  expectCode(() => applyEvent(topic, ev('SKIP', { today: null }), SPEC_CONFIG, TODAY), 'E_EVENT_TIME_REQUIRED');
});

test('calendarDate is a strict local date but need not equal today', () => {
  const topic = makeTopic();
  expectCode(() => applyEvent(topic, ev('ADVANCED', { today: '2026-02-30' }), SPEC_CONFIG, TODAY), 'E_DATE_INVALID');
  expectCode(() => applyEvent(topic, ev('ADVANCED', { today: '2026-1-1' }), SPEC_CONFIG, TODAY), 'E_DATE_FORMAT');
  const crossDay = applyEvent(topic, ev('ADVANCED', { today: '2026-11-25' }), SPEC_CONFIG, TODAY);
  assert.equal(crossDay.applied, true);
  assert.equal(crossDay.event.eventDate, '2026-11-25');
});

test('createdAt with an explicit offset is a valid alternative to calendarDate', () => {
  const topic = makeTopic();
  const event = {
    eventId: eventId(701),
    topicId: UUID,
    type: 'ADVANCED',
    expectedRevision: 0,
    algorithmVersion: 1,
    createdAt: '2026-11-24T09:30:00+08:00',
  };
  const result = applyEvent(topic, event, SPEC_CONFIG, TODAY);
  assert.equal(result.applied, true);
  assert.equal(result.topic.last_reviewed, TODAY);
  assert.equal(result.topic.mf_ideal_due, '2026-11-29'); // today + 5, not the timestamp's offset
});

test('createdAt is validated without converting time zones', () => {
  const topic = makeTopic();
  const base = {
    eventId: eventId(702),
    topicId: UUID,
    type: 'ADVANCED',
    expectedRevision: 0,
    algorithmVersion: 1,
  };
  // Not ISO-8601 with an offset.
  expectCode(
    () => applyEvent(topic, { ...base, createdAt: '2026-11-24 09:30' }, SPEC_CONFIG, TODAY),
    'E_EVENT_TIME_INVALID'
  );
  expectCode(
    () => applyEvent(topic, { ...base, createdAt: '2026-11-24T09:30:00' }, SPEC_CONFIG, TODAY),
    'E_EVENT_TIME_INVALID'
  );
  // Impossible clock time / impossible calendar date.
  expectCode(
    () => applyEvent(topic, { ...base, createdAt: '2026-11-24T25:00:00+08:00' }, SPEC_CONFIG, TODAY),
    'E_EVENT_TIME_INVALID'
  );
  expectCode(
    () => applyEvent(topic, { ...base, createdAt: '2026-11-24T09:30:00+24:00' }, SPEC_CONFIG, TODAY),
    'E_EVENT_TIME_INVALID'
  );
  expectCode(
    () => applyEvent(topic, { ...base, createdAt: '2026-02-30T09:30:00+08:00' }, SPEC_CONFIG, TODAY),
    'E_DATE_INVALID'
  );
  // A different event day is legal: scheduling still uses the explicit today.
  const crossDay = applyEvent(topic, { ...base, createdAt: '2026-11-23T23:59:00+08:00' }, SPEC_CONFIG, TODAY);
  assert.equal(crossDay.applied, true);
  assert.equal(crossDay.topic.last_reviewed, TODAY);
  assert.equal(crossDay.event.eventDate, '2026-11-23');
  assert.equal(crossDay.event.eventDateSource, 'createdAt-offset');
});

test('a UTC createdAt alone satisfies the event time requirement', () => {
  const topic = makeTopic();
  const base = {
    eventId: eventId(703),
    topicId: UUID,
    type: 'ADVANCED',
    expectedRevision: 0,
    algorithmVersion: 1,
    createdAt: '2026-11-24T01:30:00Z',
  };
  const result = applyEvent(topic, base, SPEC_CONFIG, TODAY);
  assert.equal(result.applied, true);
  // No local day is inferred from a UTC timestamp.
  assert.equal(result.event.eventDate, null);
  assert.equal(result.event.eventDateSource, 'utc-timestamp');
  assert.equal(result.explain.data.processedOnDifferentDay, false);

  // An explicit calendarDate still wins; UTC carries no local day to compare.
  const withDate = applyEvent(topic, { ...base, calendarDate: '2026-11-23' }, SPEC_CONFIG, TODAY);
  assert.equal(withDate.applied, true);
  assert.equal(withDate.event.eventDate, '2026-11-23');
  assert.equal(withDate.event.eventDateSource, 'calendarDate');
});

test('a numeric-offset createdAt must agree with calendarDate', () => {
  const topic = makeTopic();
  const event = {
    eventId: eventId(704),
    topicId: UUID,
    type: 'ADVANCED',
    expectedRevision: 0,
    algorithmVersion: 1,
    calendarDate: TODAY,
    createdAt: '2026-11-23T12:00:00+08:00',
  };
  expectCode(() => applyEvent(topic, event, SPEC_CONFIG, TODAY), 'E_EVENT_DATE_MISMATCH');

  // A UTC timestamp has no local day, so it cannot contradict calendarDate.
  const utc = { ...event, createdAt: '2026-11-23T16:00:00Z' };
  const result = applyEvent(topic, utc, SPEC_CONFIG, TODAY);
  assert.equal(result.applied, true);
  assert.equal(result.event.eventDate, TODAY);
});

// ---- payload schema (owner review fix 3) ----------------------------------

test('payload keys are restricted per event type', () => {
  const invalid = [
    ['POSTPONE', { days: 7, note: 'x' }],
    ['ADVANCED', { note: 'x' }],
    ['COMPLETE', { status: 'done' }],
    ['SET_PRIORITY', { priority: 10, extra: true }],
    ['MANUAL_SCHEDULE', { idealDue: '2026-12-01', reason: 'r', extra: 1 }],
    ['REACTIVATE', { idealDue: '2026-12-01', reason: 'r' }],
  ];
  for (const [type, payload] of invalid) {
    const topic = makeTopic({ status: type === 'REACTIVATE' ? 'done' : 'active' });
    expectCode(
      () => applyEvent(topic, ev(type, { payload, revision: 0 }), SPEC_CONFIG, TODAY),
      'E_EVENT_PAYLOAD_INVALID'
    );
  }
});

test('payload values must be of the declared primitive type', () => {
  const topic = makeTopic();
  expectCode(() => applyEvent(topic, ev('POSTPONE', { payload: { days: '7' } }), SPEC_CONFIG, TODAY), 'E_POSTPONE_DAYS_INVALID');
  expectCode(() => applyEvent(topic, ev('SET_PRIORITY', { payload: { priority: '10' } }), SPEC_CONFIG, TODAY), 'E_PRIORITY_TYPE');
  expectCode(
    () => applyEvent(topic, ev('MANUAL_SCHEDULE', { payload: { idealDue: 20261201, reason: 'r' } }), SPEC_CONFIG, TODAY),
    'E_DATE_FORMAT'
  );
});
