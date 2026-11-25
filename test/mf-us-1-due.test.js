'use strict';

// PR-02 — Effective Due semantics (SPEC A2.4, A12; A13 property 8).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  SPEC_CONFIG,
  initializeTopic,
  effectiveDue,
  dueState,
  summarizeDue,
  isAvailable,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TODAY = '2026-11-24';

function makeTopic(overrides = {}) {
  const created = initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, TODAY).topic;
  return { ...created, ...overrides };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError);
    assert.equal(error.code, code);
    return true;
  });
}

test('effective due is the ideal date when there is no postponement', () => {
  assert.equal(effectiveDue(makeTopic({ mf_ideal_due: '2026-11-27' })), '2026-11-27');
});

test('effective due is the later of ideal and not-before', () => {
  assert.equal(effectiveDue(makeTopic({ mf_ideal_due: '2026-11-27', mf_not_before: '2026-12-05' })), '2026-12-05');
  assert.equal(effectiveDue(makeTopic({ mf_ideal_due: '2026-12-05', mf_not_before: '2026-11-27' })), '2026-12-05');
  assert.equal(effectiveDue(makeTopic({ mf_ideal_due: '2026-11-27', mf_not_before: '2026-11-27' })), '2026-11-27');
});

test('a topic due today is available with zero overdue days', () => {
  const state = dueState(makeTopic({ mf_ideal_due: TODAY }), TODAY);
  assert.equal(state.available, true);
  assert.equal(state.idealOverdue, false);
  assert.equal(state.postponedOnly, false);
  assert.equal(state.notYetDue, false);
  assert.equal(state.overdueDays, 0);
  assert.equal(state.effectiveDue, TODAY);
});

test('an ideally overdue topic reports its overdue days', () => {
  const state = dueState(makeTopic({ mf_ideal_due: '2026-11-20' }), TODAY);
  assert.equal(state.idealOverdue, true);
  assert.equal(state.available, true);
  assert.equal(state.overdueDays, 4);
  assert.equal(isAvailable(makeTopic({ mf_ideal_due: '2026-11-20' }), TODAY), true);
});

test('postponement hides an overdue topic without deleting the backlog (A2.4)', () => {
  const topic = makeTopic({ mf_ideal_due: '2026-11-20', mf_not_before: '2026-12-01' });
  const state = dueState(topic, TODAY);
  assert.equal(state.idealOverdue, true); // the real backlog is still visible
  assert.equal(state.available, false);
  assert.equal(state.postponedOnly, true);
  assert.equal(state.notYetDue, false);
  assert.equal(state.overdueDays, 0);
  assert.equal(state.effectiveDue, '2026-12-01');
});

test('a topic whose ideal date is in the future is not due yet', () => {
  const state = dueState(makeTopic({ mf_ideal_due: '2026-12-01' }), TODAY);
  assert.equal(state.available, false);
  assert.equal(state.idealOverdue, false);
  assert.equal(state.postponedOnly, false);
  assert.equal(state.notYetDue, true);
  assert.equal(state.overdueDays, 0);
});

test('the three due categories stay separate in the summary', () => {
  const topics = [
    makeTopic({ mf_ideal_due: '2026-11-20' }), // ideally overdue, available
    makeTopic({ mf_ideal_due: '2026-11-22', mf_not_before: '2026-12-01' }), // overdue but postponed
    makeTopic({ mf_ideal_due: TODAY }), // due today
    makeTopic({ mf_ideal_due: '2026-12-10' }), // not yet due
  ];
  const summary = summarizeDue(topics, TODAY);
  assert.equal(summary.total, 4);
  assert.equal(summary.idealOverdue, 2);
  assert.equal(summary.available, 2);
  assert.equal(summary.postponedOnly, 1);
  assert.equal(summary.notYetDue, 1);
  assert.equal(summary.maxOverdueDays, 4);
});

test('summaries are deterministic and never mutate input topics', () => {
  const topics = Object.freeze([
    Object.freeze(makeTopic({ mf_ideal_due: '2026-11-20' })),
    Object.freeze(makeTopic({ mf_ideal_due: '2026-11-22', mf_not_before: '2026-12-01' })),
  ]);
  const snapshot = JSON.parse(JSON.stringify(topics));
  const first = summarizeDue(topics, TODAY);
  for (let i = 0; i < 50; i++) assert.deepEqual(summarizeDue(topics, TODAY), first);
  assert.deepEqual(JSON.parse(JSON.stringify(topics)), snapshot);
});

test('due calculations reject invalid input instead of guessing', () => {
  expectCode(() => effectiveDue({ ...makeTopic(), mf_ideal_due: '2026-02-30' }), 'E_DATE_INVALID');
  expectCode(() => effectiveDue({ ...makeTopic(), mf_not_before: 'nope' }), 'E_DATE_FORMAT');
  expectCode(() => dueState(makeTopic(), '2026-13-01'), 'E_DATE_INVALID');
  expectCode(() => summarizeDue(null, TODAY), 'E_OBJECT_REQUIRED');
  expectCode(() => summarizeDue([{ bad: true }], TODAY), 'E_TOPIC_TYPE');
});

test('DST and month boundaries do not distort due state', () => {
  const dst = dueState(makeTopic({ mf_ideal_due: '2026-03-08' }), '2026-03-09');
  assert.equal(dst.overdueDays, 1);
  const newYear = dueState(makeTopic({ mf_ideal_due: '2026-12-31' }), '2027-01-01');
  assert.equal(newYear.overdueDays, 1);
  const leap = dueState(makeTopic({ mf_ideal_due: '2028-02-29' }), '2028-03-01');
  assert.equal(leap.overdueDays, 1);
});
