'use strict';

// PR-10 — reading action mapping and event deduplication.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapReadingAction,
  createActionToken,
  ReadingEventCoordinator,
  ACTION_MAP,
} = require('../src/scheduling/index.js');
const { uuid } = require('./helpers/unified-fixtures.js');

test('every scheduling action maps to an accepted event type', () => {
  const cases = {
    'grade.advanced': 'ADVANCED',
    'grade.hold': 'HOLD',
    'grade.soon': 'SOON',
    skip: 'SKIP',
    postpone: 'POSTPONE',
    'set-priority': 'SET_PRIORITY',
    'manual-schedule': 'MANUAL_SCHEDULE',
    complete: 'COMPLETE',
    dismiss: 'DISMISS',
    reactivate: 'REACTIVATE',
  };
  for (const [action, type] of Object.entries(cases)) {
    assert.equal(mapReadingAction({ action }).type, type, action);
  }
});

test('postpone, priority, manual schedule and reactivate carry explicit payloads', () => {
  assert.deepEqual(mapReadingAction({ action: 'postpone', days: 7 }).payload, { days: 7 });
  assert.deepEqual(mapReadingAction({ action: 'set-priority', priority: 10 }).payload, { priority: 10 });
  assert.deepEqual(mapReadingAction({ action: 'manual-schedule', idealDue: '2026-12-01', reason: 'travel' }).payload,
    { idealDue: '2026-12-01', reason: 'travel' });
  assert.deepEqual(mapReadingAction({ action: 'reactivate', idealDue: '2026-12-05' }).payload, { idealDue: '2026-12-05' });
});

test('opening a PDF, scrolling or creating an extract is not an event', () => {
  for (const action of ['source.open', 'pdf.scroll', 'pdf.locate', 'extract.create', 'extract.refine']) {
    const mapped = mapReadingAction({ action });
    assert.equal(mapped.scheduling, false, action);
    assert.equal(mapped.ignored, true, action);
  }
});

test('unknown actions are rejected', () => {
  assert.throws(() => mapReadingAction({ action: 'grade.teleport' }), error => error.code === 'E_ACTION_UNKNOWN');
  assert.throws(() => mapReadingAction(null), error => error.code === 'E_ACTION_REQUIRED');
});

test('a token requires a persistent event id, topic id and revision', () => {
  const token = createActionToken({
    eventId: uuid(1), topicId: uuid(2), expectedRevision: 1, today: '2026-11-24', action: 'grade.advanced',
  });
  assert.equal(token.eventId, uuid(1));
  assert.throws(() => createActionToken({ eventId: 'x', topicId: uuid(2), expectedRevision: 1, action: 'skip' }),
    error => error.code === 'E_EVENT_ID_INVALID');
  assert.throws(() => createActionToken({ eventId: uuid(1), topicId: 'x', expectedRevision: 1, action: 'skip' }),
    error => error.code === 'E_TOPIC_ID_INVALID');
  assert.throws(() => createActionToken({ eventId: uuid(1), topicId: uuid(2), expectedRevision: null, action: 'skip' }),
    error => error.code === 'E_REVISION_REQUIRED');
});

test('a retried UI action reuses one event and never dispatches twice', () => {
  let dispatches = 0;
  const coordinator = new ReadingEventCoordinator(request => {
    dispatches += 1;
    return { status: 'applied', writesPerformed: true, eventId: request.eventId };
  });
  const token = createActionToken({
    eventId: uuid(3), topicId: uuid(4), expectedRevision: 1, today: '2026-11-24', action: 'grade.advanced',
  });
  assert.equal(coordinator.execute(token).status, 'applied');
  const retry = coordinator.execute(token);
  assert.equal(retry.status, 'applied');
  assert.equal(retry.duplicate, true);
  assert.equal(dispatches, 1);
});

test('two different events both dispatch', () => {
  let dispatches = 0;
  const coordinator = new ReadingEventCoordinator(() => {
    dispatches += 1;
    return { status: 'applied', writesPerformed: true };
  });
  coordinator.execute(createActionToken({
    eventId: uuid(5), topicId: uuid(6), expectedRevision: 1, today: '2026-11-24', action: 'grade.advanced',
  }));
  coordinator.execute(createActionToken({
    eventId: uuid(7), topicId: uuid(6), expectedRevision: 2, today: '2026-11-24', action: 'grade.hold',
  }));
  assert.equal(dispatches, 2);
});

test('the action map is frozen and complete', () => {
  assert.equal(Object.isFrozen(ACTION_MAP), true);
  assert.equal(Object.keys(ACTION_MAP).length, 10);
});

// ---- event-id conflicts, failure retry and async in-flight (review fix 1) --

function token(overrides = {}) {
  return createActionToken({
    eventId: uuid(10),
    topicId: uuid(1),
    expectedRevision: 1,
    today: '2026-11-24',
    calendarDate: '2026-11-24',
    action: 'grade.advanced',
    ...overrides,
  });
}

test('the same event id with a different request is a conflict', () => {
  const coordinator = new ReadingEventCoordinator(() => ({ status: 'applied', writesPerformed: true }));
  coordinator.execute(token());
  const conflicts = [
    { topicId: uuid(2) },
    { action: 'complete' },
    { expectedRevision: 2 },
    { today: '2026-11-25' },
    { calendarDate: '2026-11-18' },
    { dateFormat: 'YYYY-MM-DD' },
  ];
  for (const override of conflicts) {
    assert.throws(() => coordinator.execute(token(override)),
      error => error.code === 'E_EVENT_ID_CONFLICT', JSON.stringify(override));
  }
});

test('postpone payload differences are a conflict', () => {
  const coordinator = new ReadingEventCoordinator(() => ({ status: 'applied', writesPerformed: true }));
  coordinator.execute(token({ action: 'postpone', days: 3 }));
  assert.throws(() => coordinator.execute(token({ action: 'postpone', days: 7 })),
    error => error.code === 'E_EVENT_ID_CONFLICT');
});

test('failed and uncertain results are retried, not cached as success', () => {
  let attempts = 0;
  const coordinator = new ReadingEventCoordinator(() => {
    attempts += 1;
    return attempts === 1
      ? { status: 'failed', writesPerformed: false, reason: 'E_TRANSIENT' }
      : { status: 'applied', writesPerformed: true };
  });
  assert.equal(coordinator.execute(token()).status, 'failed');
  assert.equal(coordinator.execute(token()).status, 'applied');
  assert.equal(attempts, 2);
});

test('an async dispatch is deduplicated while in flight', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = new ReadingEventCoordinator(async () => {
    calls += 1;
    await gate;
    return { status: 'applied', writesPerformed: true };
  });
  const first = coordinator.execute(token());
  const second = coordinator.execute(token());
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.status, 'applied');
  assert.equal(b.duplicate, true);
});

test('E1 -> E2 -> E1 still yields one review per distinct event', () => {
  const results = [];
  const coordinator = new ReadingEventCoordinator(request => {
    results.push(request);
    return { status: 'applied', writesPerformed: true };
  });
  coordinator.execute(token({ eventId: uuid(11) }));
  coordinator.execute(token({ eventId: uuid(12), expectedRevision: 2 }));
  const replay = coordinator.execute(token({ eventId: uuid(11) }));
  assert.equal(replay.duplicate, true);
  assert.equal(results.length, 2);
});
