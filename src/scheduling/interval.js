'use strict';

// Interval mathematics for MF-US-1 (SPEC A3.3, A4.1).
//
// PR-01 scope: the formulas only. No event state machine, no review_count,
// no last_reviewed, no idempotency and no persistence — those belong to
// applyEvent() in PR-02 (owner decision, section 四.2/四.3).
//
// Two distinct rounding contracts live here:
//
//   roundHalfUp(x)              strict floor(x + 0.5) on the value supplied.
//                               Arbitrary floats are NOT snapped: a genuine
//                               0.4999999996 stays 0.
//   computeNextIntervalDays()   exact decimal I x A (see decimal.js), then
//                               floor(product + 1/2). 25 x 2.3 -> 58 because the
//                               decimal product is exactly 57.5, while
//                               1 x 1.4999999996 -> 1 because the product is
//                               genuinely below 1.5.

const { fail } = require('./errors.js');
const { SPEC_CONFIG } = require('./constants.js');
const { assertPlainObject, assertConfig, validateIntervalDays, validateAFactor } = require('./schema.js');
const {
  toRational,
  multiplyRationals,
  roundHalfUpRational,
  rationalToDecimalString,
  toSafeNumber,
} = require('./decimal.js');

// SPEC A3.3: roundHalfUp(x) = floor(x + 0.5), for non-negative values.
//
// Implemented as floor(x) + (fraction >= 0.5) because evaluating `x + 0.5`
// directly can round the sum up: the double just below 0.5 (0.49999999999999994)
// yields exactly 1.0 when 0.5 is added to it. For x >= 0 the subtraction
// `x - Math.floor(x)` is exact (Sterbenz), so the comparison with the exact
// 0.5 is exact too. The function is strict: it never widens a value towards a
// half-integer.
function roundHalfUp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('E_ROUND_TYPE', 'roundHalfUp expects a finite number', { value });
  }
  if (value < 0) {
    fail('E_NEGATIVE_INPUT', 'roundHalfUp is defined for non-negative values only (SPEC A3.3)', { value });
  }
  const whole = Math.floor(value);
  const fraction = value - whole;
  return fraction >= 0.5 ? whole + 1 : whole;
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

// Exact decimal product of an integer and an A-Factor.
function exactProduct(intervalDays, aFactor) {
  return multiplyRationals(toRational(intervalDays, 'mf_interval_days'), toRational(aFactor, 'a_factor'));
}

// SPEC A4.1: I_next = clamp(roundHalfUp(I_current × A_current), 1, 3650).
//
// This is deliberately NOT the initial-interval function: an existing topic is
// never re-initialised from its Priority (SPEC A4.1, T11).
function computeNextIntervalDays(input, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  assertPlainObject(input, 'interval input');
  const intervalDays = validateIntervalDays(input.mf_interval_days);
  const aFactor = validateAFactor(input.a_factor);
  const product = exactProduct(intervalDays, aFactor);
  const rounded = toSafeNumber(roundHalfUpRational(product), 'next interval');
  const { min, max } = cfg.intervalRange;
  return clamp(rounded, min, max);
}

function formatNumber(value) {
  return String(Number(value.toFixed(6)));
}

// SPEC A12: a human-readable trace of one interval step, separating the
// formula inputs from the clamped result. PR-02 attaches this to ADVANCED.
function explainNextInterval(input, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  assertPlainObject(input, 'interval input');
  const intervalDays = validateIntervalDays(input.mf_interval_days);
  const aFactor = validateAFactor(input.a_factor);
  const product = exactProduct(intervalDays, aFactor);
  const exactProductDecimal = rationalToDecimalString(product);
  const next = clamp(toSafeNumber(roundHalfUpRational(product), 'next interval'), cfg.intervalRange.min, cfg.intervalRange.max);
  return {
    intervalDays,
    nextIntervalDays: next,
    text: `后续间隔：历史间隔 ${intervalDays} 天，A-Factor ${formatNumber(aFactor)}，下一次间隔 ${next} 天。`,
    data: {
      formula: 'clamp(roundHalfUp(I x A), 1, 3650)',
      intervalDays,
      aFactor,
      exactProduct: exactProductDecimal,
      nextIntervalDays: next,
    },
  };
}

module.exports = {
  roundHalfUp,
  clamp,
  formatNumber,
  exactProduct,
  computeNextIntervalDays,
  explainNextInterval,
};
