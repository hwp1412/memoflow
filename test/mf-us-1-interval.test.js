'use strict';

// PR-01 — subsequent-interval mathematics (SPEC A3.3, A4.1; A13 T05, T11).
//
// Owner review (fix 1) split the contract in two:
//   * roundHalfUp(x) is a strict floor(x + 0.5) on the supplied value;
//   * I x A is multiplied exactly in decimal and only then rounded.
// The counterexamples below are regression tests for that split.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  SPEC_CONFIG,
  roundHalfUp,
  clamp,
  computeNextIntervalDays,
  explainNextInterval,
} = require('../src/scheduling/index.js');

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('roundHalfUp is strictly floor(x + 0.5)', () => {
  assert.equal(roundHalfUp(0), 0);
  assert.equal(roundHalfUp(0.4999), 0);
  assert.equal(roundHalfUp(0.5), 1);
  assert.equal(roundHalfUp(1.5), 2);
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(4.5), 5);
  assert.equal(roundHalfUp(10.5), 11);
  assert.equal(roundHalfUp(2.183673469387755), 2);
});

test('roundHalfUp never snaps a value that is genuinely below the half (fix 1)', () => {
  // Owner counterexample: 0.4999999996 is below 0.5 and must stay 0.
  assert.equal(roundHalfUp(0.4999999996), 0);
  assert.equal(roundHalfUp(0.499999999), 0);
  assert.equal(roundHalfUp(0.49999999999999994), 0);
  // A value just below an integer+0.5 stays down.
  assert.equal(roundHalfUp(8.499999999999999), 8);
  // 0.1 + 0.2 sits slightly above 0.3 but still rounds to 0.
  assert.equal(roundHalfUp(0.1 + 0.2), 0);
  // Strictness means the raw float product is rounded as-is: 57, not 58.
  // The interval API below applies the decimal contract instead.
  assert.equal(roundHalfUp(25 * 2.3), 57);
});

test('roundHalfUp rejects undefined inputs', () => {
  expectCode(() => roundHalfUp(-1), 'E_NEGATIVE_INPUT');
  expectCode(() => roundHalfUp(NaN), 'E_ROUND_TYPE');
  expectCode(() => roundHalfUp('1.5'), 'E_ROUND_TYPE');
});

test('I x A is multiplied exactly in decimal before rounding (fix 1)', () => {
  // Owner counterexamples: genuinely below the half => round down.
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 1.4999999996 }), 1);
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 2.4999999996 }), 2);
  // Exact half => round up.
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 2.5 }), 3);
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 1.5 }), 2);
  // The decimal expectation of 25 x 2.3 is preserved (57.5 -> 58).
  assert.equal(computeNextIntervalDays({ mf_interval_days: 25, a_factor: 2.3 }), 58);
  // Near-half products that are genuinely below their half.
  assert.equal(computeNextIntervalDays({ mf_interval_days: 8, a_factor: 1.4999999996 }), 12); // 11.9999999968
  assert.equal(computeNextIntervalDays({ mf_interval_days: 3, a_factor: 1.4999999996 }), 4); // 4.4999999988
  assert.equal(computeNextIntervalDays({ mf_interval_days: 4, a_factor: 1.4999999996 }), 6); // 5.9999999984
  // Long decimal A-Factors are legal input, not truncated to four places.
  assert.equal(computeNextIntervalDays({ mf_interval_days: 7, a_factor: 1.234567890123456 }), 9);
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 1.4999999999999998 }), 1);
});

test('clamp is inclusive and stable at the bounds', () => {
  assert.equal(clamp(5, 1, 30), 5);
  assert.equal(clamp(0, 1, 30), 1);
  assert.equal(clamp(31, 1, 30), 30);
  assert.equal(clamp(1, 1, 30), 1);
  assert.equal(clamp(30, 1, 30), 30);
});

test('normative interval examples (T05, T11)', () => {
  assert.equal(computeNextIntervalDays({ mf_interval_days: 3, a_factor: 1.5 }), 5); // 4.5 -> 5
  assert.equal(computeNextIntervalDays({ mf_interval_days: 8, a_factor: 1.5 }), 12);
  assert.equal(computeNextIntervalDays({ mf_interval_days: 8, a_factor: 1.8 }), 14); // 14.4 -> 14
  assert.equal(computeNextIntervalDays({ mf_interval_days: 2, a_factor: 1.8 }), 4); // 3.6 -> 4
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 1.1 }), 1); // 1.1 -> 1
});

test('next interval is clamped into 1..3650', () => {
  assert.equal(computeNextIntervalDays({ mf_interval_days: 3650, a_factor: 3 }), 3650);
  assert.equal(computeNextIntervalDays({ mf_interval_days: 3650, a_factor: 1.1 }), 3650); // 4015 -> clamp
  assert.equal(computeNextIntervalDays({ mf_interval_days: 3650, a_factor: 2.3 }), 3650); // 8395 -> clamp
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1000, a_factor: 3 }), 3000);
  assert.equal(computeNextIntervalDays({ mf_interval_days: 1, a_factor: 1.1 }), 1);
});

test('legacy A-Factor bounds are rejected, not clamped (Q2)', () => {
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 8, a_factor: 1.05 }), 'E_AFACTOR_RANGE');
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 8, a_factor: 5 }), 'E_AFACTOR_RANGE');
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 8, a_factor: 3.01 }), 'E_AFACTOR_RANGE');
});

test('invalid interval inputs are rejected', () => {
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 0, a_factor: 1.5 }), 'E_INTERVAL_RANGE');
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 3651, a_factor: 1.5 }), 'E_INTERVAL_RANGE');
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 1.5, a_factor: 1.5 }), 'E_INTERVAL_TYPE');
  expectCode(() => computeNextIntervalDays({ a_factor: 1.5 }), 'E_INTERVAL_TYPE');
  expectCode(() => computeNextIntervalDays({ mf_interval_days: 8 }), 'E_AFACTOR_TYPE');
  expectCode(() => computeNextIntervalDays(null), 'E_OBJECT_REQUIRED');
});

test('the next-interval function never consults Priority (T11)', () => {
  const base = { mf_interval_days: 8, a_factor: 1.5 };
  const lowPriority = computeNextIntervalDays({ ...base, priority: 1, type: 'source' });
  const highPriority = computeNextIntervalDays({ ...base, priority: 100, type: 'extract' });
  assert.equal(lowPriority, 12);
  assert.equal(highPriority, 12);
  assert.notEqual(lowPriority, 3);
});

test('input objects are never mutated', () => {
  const input = Object.freeze({ mf_interval_days: 3, a_factor: 1.5 });
  assert.equal(computeNextIntervalDays(input), 5);
  assert.deepEqual(input, { mf_interval_days: 3, a_factor: 1.5 });
  const explanation = explainNextInterval({ mf_interval_days: 3, a_factor: 1.5 });
  assert.equal(explanation.nextIntervalDays, 5);
  assert.deepEqual(input, { mf_interval_days: 3, a_factor: 1.5 });
});

test('property: results stay inside 1..3650 for every legal input', () => {
  const aFactors = [];
  for (let tenths = 11; tenths <= 30; tenths++) aFactors.push(tenths / 10);
  for (const interval of [1, 2, 3, 7, 8, 30, 365, 1000, 3649, 3650]) {
    for (const aFactor of aFactors) {
      const next = computeNextIntervalDays({ mf_interval_days: interval, a_factor: aFactor });
      assert.ok(Number.isInteger(next));
      assert.ok(next >= 1 && next <= 3650, `${interval} x ${aFactor} -> ${next}`);
    }
  }
});

test('property: result is monotonic in interval and in A-Factor', () => {
  for (const aFactor of [1.1, 1.5, 1.8, 2.5, 3]) {
    let previous = 0;
    for (let interval = 1; interval <= 400; interval++) {
      const next = computeNextIntervalDays({ mf_interval_days: interval, a_factor: aFactor });
      assert.ok(next >= previous, `not monotonic in I at A=${aFactor}, I=${interval}`);
      previous = next;
    }
  }
  for (const interval of [1, 3, 8, 30, 365]) {
    let previous = 0;
    for (let tenths = 11; tenths <= 30; tenths++) {
      const next = computeNextIntervalDays({ mf_interval_days: interval, a_factor: tenths / 10 });
      assert.ok(next >= previous, `not monotonic in A at I=${interval}, A=${tenths / 10}`);
      previous = next;
    }
  }
});

test('property: exact decimal arithmetic for 1, 2 and 3 decimal A-Factors', () => {
  for (const decimals of [1, 2, 3]) {
    const scale = 10 ** decimals;
    const aIntMin = Math.round(1.1 * scale);
    const aIntMax = Math.round(3.0 * scale);
    for (let aInt = aIntMin; aInt <= aIntMax; aInt++) {
      const aFactor = aInt / scale;
      for (let interval = 1; interval <= 60; interval++) {
        // floor((I * aInt / scale) + 1/2) === floor((2*I*aInt + scale) / (2*scale))
        const exact = Math.floor((2 * interval * aInt + scale) / (2 * scale));
        const clamped = Math.min(3650, Math.max(1, exact));
        const actual = computeNextIntervalDays({ mf_interval_days: interval, a_factor: aFactor });
        assert.equal(actual, clamped, `I=${interval} A=${aFactor}`);
      }
    }
  }
});

test('property: identical input always yields identical output', () => {
  const input = { mf_interval_days: 17, a_factor: 2.3 };
  const first = computeNextIntervalDays(input);
  for (let i = 0; i < 1000; i++) {
    assert.equal(computeNextIntervalDays(input), first);
  }
});

test('explanation states interval, A-Factor and exact product (SPEC A12)', () => {
  const explanation = explainNextInterval({ mf_interval_days: 2, a_factor: 1.8 }, SPEC_CONFIG);
  assert.equal(explanation.text, '后续间隔：历史间隔 2 天，A-Factor 1.8，下一次间隔 4 天。');
  assert.deepEqual(explanation.data, {
    formula: 'clamp(roundHalfUp(I x A), 1, 3650)',
    intervalDays: 2,
    aFactor: 1.8,
    exactProduct: '3.6',
    nextIntervalDays: 4,
  });
  // The reported product is the exact decimal, not the float artefact.
  assert.equal(explainNextInterval({ mf_interval_days: 25, a_factor: 2.3 }).data.exactProduct, '57.5');
});
