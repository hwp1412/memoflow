'use strict';

// PR-01 — initial interval, initial A-Factor and new-topic initialisation
// (SPEC A3.1, A3.2, A3.3, A3.4; A13 T01-T04, T11 guard, T17 non-mutation).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  SPEC_CONFIG,
  baseInitialIntervalDays,
  initialIntervalDays,
  initialAFactor,
  initializeTopic,
  assertNotInitialized,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_PARENT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID_ROOT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('B(P) hits the four specification anchors exactly', () => {
  assert.equal(baseInitialIntervalDays(1), 1);
  assert.equal(baseInitialIntervalDays(50), 3);
  assert.equal(baseInitialIntervalDays(80), 7);
  assert.equal(baseInitialIntervalDays(100), 21);
});

test('B(P) is piecewise linear inside each segment', () => {
  const segmentOne = p => 1 + (p - 1) * 2 / 49;
  const segmentTwo = p => 3 + (p - 50) * 4 / 30;
  const segmentThree = p => 7 + (p - 80) * 14 / 20;
  for (const p of [2, 10, 25, 49]) assert.equal(baseInitialIntervalDays(p), segmentOne(p));
  for (const p of [51, 60, 65, 79]) assert.equal(baseInitialIntervalDays(p), segmentTwo(p));
  for (const p of [81, 85, 90, 99]) assert.equal(baseInitialIntervalDays(p), segmentThree(p));
});

test('B(P) is continuous at the segment joins', () => {
  assert.equal(baseInitialIntervalDays(50), 3);
  assert.equal(baseInitialIntervalDays(80), 7);
  assert.ok(Math.abs(baseInitialIntervalDays(50) - baseInitialIntervalDays(49) - 2 / 49) < 1e-12);
  assert.ok(Math.abs(baseInitialIntervalDays(80) - baseInitialIntervalDays(79) - 4 / 30) < 1e-12);
});

test('property: B(P) is non-decreasing in P (SPEC A13.1)', () => {
  let previous = -Infinity;
  for (let p = 1; p <= 100; p++) {
    const value = baseInitialIntervalDays(p);
    assert.ok(value >= previous, `B(P) decreased at P${p}`);
    previous = value;
  }
});

test('property: initial interval is non-decreasing in P for each type', () => {
  for (const type of ['source', 'extract']) {
    let previous = -Infinity;
    for (let p = 1; p <= 100; p++) {
      const value = initialIntervalDays({ type, priority: p });
      assert.ok(value >= previous, `${type} I0 decreased at P${p}`);
      assert.ok(value >= 1 && value <= 30);
      previous = value;
    }
  }
});

test('I0 matches the normative expectation table (SPEC A3.3)', () => {
  const table = [
    [1, 1, 1],
    [30, 2, 2],
    [50, 3, 2],
    [80, 7, 5],
    [100, 21, 16],
  ];
  for (const [priority, source, extract] of table) {
    assert.equal(initialIntervalDays({ type: 'source', priority }), source, `P${priority} source`);
    assert.equal(initialIntervalDays({ type: 'extract', priority }), extract, `P${priority} extract`);
  }
});

test('half-up rounding is applied at the boundary', () => {
  // P85: B = 10.5 exactly, so source I0 = 11 (floor+0.5), not 10 or 21.
  assert.equal(baseInitialIntervalDays(85), 10.5);
  assert.equal(initialIntervalDays({ type: 'source', priority: 85 }), 11);
  // Extract: 10.5 x 0.75 = 7.875 -> 8.
  assert.equal(initialIntervalDays({ type: 'extract', priority: 85 }), 8);
});

test('initial interval is clamped into 1..30', () => {
  // P1 extract: B=1 x 0.75 = 0.75 -> half-up 1 (never 0).
  assert.equal(initialIntervalDays({ type: 'extract', priority: 1 }), 1);
  // P100 source: 21 stays inside the initial range.
  assert.equal(initialIntervalDays({ type: 'source', priority: 100 }), 21);
});

test('invalid priorities and types are rejected, never defaulted', () => {
  expectCode(() => initialIntervalDays({ type: 'source', priority: 0 }), 'E_PRIORITY_RANGE');
  expectCode(() => initialIntervalDays({ type: 'source', priority: 101 }), 'E_PRIORITY_RANGE');
  expectCode(() => initialIntervalDays({ type: 'source', priority: '50' }), 'E_PRIORITY_TYPE');
  expectCode(() => initialIntervalDays({ type: 'card', priority: 50 }), 'E_TOPIC_TYPE');
  expectCode(() => initialIntervalDays({ priority: 50 }), 'E_TOPIC_TYPE');
  expectCode(() => baseInitialIntervalDays(undefined), 'E_PRIORITY_TYPE');
});

test('initial A-Factor is per type (SPEC A3.1)', () => {
  assert.equal(initialAFactor('source'), 1.5);
  assert.equal(initialAFactor('extract'), 1.8);
  expectCode(() => initialAFactor('card'), 'E_TOPIC_TYPE');
});

test('initializeTopic produces the full new-topic field set', () => {
  const result = initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, '2026-11-24');
  assert.equal(result.needsWrite, true);
  assert.equal(result.algorithmVersion, 1);
  assert.deepEqual(result.diff, { created: true });
  assert.deepEqual(result.topic, {
    type: 'source',
    priority: 50,
    status: 'active',
    mf_id: UUID,
    mf_parent_id: null,
    mf_root_id: null,
    mf_ideal_due: '2026-11-27',
    mf_not_before: null,
    mf_interval_days: 3,
    mf_last_event_id: null,
    mf_revision: 0,
    mf_scheduler_version: 1,
    a_factor: 1.5,
    review_count: 0,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result.topic, 'last_reviewed'), false);
});

test('initializeTopic example from SPEC A3.3 (today 2026-11-24)', () => {
  const source = initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, '2026-11-24');
  assert.equal(source.topic.mf_ideal_due, '2026-11-27');
  const extract = initializeTopic({ type: 'extract', priority: 50, mfId: UUID }, SPEC_CONFIG, '2026-11-24');
  assert.equal(extract.topic.mf_ideal_due, '2026-11-26');
  assert.equal(extract.topic.mf_interval_days, 2);
  assert.equal(extract.topic.a_factor, 1.8);
});

test('default priority applies only when the caller omits it (Q1)', () => {
  const omitted = initializeTopic({ type: 'source', mfId: UUID }, SPEC_CONFIG, '2026-11-24');
  assert.equal(omitted.topic.priority, 50);
  const explicit = initializeTopic({ type: 'extract', priority: 10, mfId: UUID }, SPEC_CONFIG, '2026-11-24');
  assert.equal(explicit.topic.priority, 10);
  assert.equal(explicit.topic.mf_interval_days, 1);
  // Present but illegal: error, never the default.
  expectCode(() => initializeTopic({ type: 'source', priority: null, mfId: UUID }, SPEC_CONFIG, '2026-11-24'), 'E_PRIORITY_TYPE');
  expectCode(() => initializeTopic({ type: 'source', priority: '50', mfId: UUID }, SPEC_CONFIG, '2026-11-24'), 'E_PRIORITY_TYPE');
  expectCode(() => initializeTopic({ type: 'source', priority: 0, mfId: UUID }, SPEC_CONFIG, '2026-11-24'), 'E_PRIORITY_RANGE');
});

test('the core never generates an id (owner decision 4.1)', () => {
  expectCode(() => initializeTopic({ type: 'source', priority: 50 }, SPEC_CONFIG, '2026-11-24'), 'E_ID_REQUIRED');
  expectCode(() => initializeTopic({ type: 'source', priority: 50, mfId: '' }, SPEC_CONFIG, '2026-11-24'), 'E_ID_FORMAT');
  expectCode(() => initializeTopic({ type: 'source', priority: 50, mfId: 'abc' }, SPEC_CONFIG, '2026-11-24'), 'E_ID_FORMAT');
});

test('parent and root ids are carried through without inventing links', () => {
  const child = initializeTopic({
    type: 'extract',
    priority: 50,
    mfId: UUID,
    mfParentId: UUID_PARENT,
    mfRootId: UUID_ROOT,
  }, SPEC_CONFIG, '2026-11-24');
  assert.equal(child.topic.mf_parent_id, UUID_PARENT);
  assert.equal(child.topic.mf_root_id, UUID_ROOT);
  expectCode(() => initializeTopic({
    type: 'extract', priority: 50, mfId: UUID, mfParentId: 'nope',
  }, SPEC_CONFIG, '2026-11-24'), 'E_ID_FORMAT');
});

test('existing scheduling state is never re-initialised (SPEC A4.1, T11)', () => {
  const cases = [
    { mf_interval_days: 8 },
    { interval: 8 },
    { next_review: '2026-12-01' },
    { mf_ideal_due: '2026-12-01' },
    { a_factor: 1.5 },
    { review_count: 2 },
    { last_reviewed: '2026-11-01' },
  ];
  for (const extra of cases) {
    expectCode(
      () => initializeTopic({ type: 'source', priority: 50, mfId: UUID, ...extra }, SPEC_CONFIG, '2026-11-24'),
      'E_ALREADY_INITIALIZED'
    );
  }
  // review_count: 0 carries no history and is accepted.
  const fresh = initializeTopic({ type: 'source', priority: 50, mfId: UUID, review_count: 0 }, SPEC_CONFIG, '2026-11-24');
  assert.equal(fresh.topic.review_count, 0);
  assert.equal(assertNotInitialized({ type: 'source' }), undefined);
});

test('today is a required explicit calendar date (SPEC A2.3)', () => {
  expectCode(() => initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, undefined), 'E_DATE_FORMAT');
  expectCode(() => initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, '2026-02-30'), 'E_DATE_INVALID');
  expectCode(() => initializeTopic({ type: 'source', priority: 50, mfId: UUID }, SPEC_CONFIG, '24-11-2026'), 'E_DATE_FORMAT');
});

test('initializeTopic never mutates its input (SPEC A13 T17)', () => {
  const input = { type: 'extract', priority: 80, mfId: UUID, mfParentId: UUID_PARENT, note: 'ignored' };
  const snapshot = JSON.parse(JSON.stringify(input));
  const result = initializeTopic(input, SPEC_CONFIG, '2026-11-24');
  assert.deepEqual(input, snapshot);
  result.topic.mf_interval_days = 999;
  result.topic.mf_parent_id = null;
  assert.deepEqual(input, snapshot);
  assert.equal(input.mf_interval_days, undefined);
});

test('initializeTopic is deterministic and returns independent objects', () => {
  const args = [{ type: 'source', priority: 42, mfId: UUID }, SPEC_CONFIG, '2026-11-24'];
  const first = initializeTopic(...args);
  const second = initializeTopic(...args);
  assert.deepEqual(first, second);
  assert.notEqual(first.topic, second.topic);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(initializeTopic(...args), first);
  }
});

test('explanation follows SPEC A12 and states the factors used', () => {
  const result = initializeTopic({ type: 'extract', priority: 50, mfId: UUID }, SPEC_CONFIG, '2026-11-24');
  assert.equal(
    result.explain.text,
    'P50 摘录：首次间隔 2 天（B=3 × K=0.75，按 half-up 取整）；首次到期 2026-11-26。'
  );
  assert.deepEqual(result.explain.data, {
    formula: 'clamp(roundHalfUp(B(P) x K_type), 1, 30)',
    type: 'extract',
    priority: 50,
    baseInitialIntervalDays: 3,
    kFactor: 0.75,
    intervalDays: 2,
    aFactor: 1.8,
    idealDue: '2026-11-26',
    today: '2026-11-24',
    algorithmVersion: 1,
  });
});
