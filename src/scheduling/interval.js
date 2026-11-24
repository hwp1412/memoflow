'use strict';

// Interval mathematics for MF-US-1 (SPEC A3.3, A4.1).
//
// PR-01 scope: the formulas only. No event state machine, no review_count,
// no last_reviewed, no idempotency and no persistence — those belong to
// applyEvent() in PR-02 (owner decision, section 四.2/四.3).

const { fail } = require('./errors.js');
const { SPEC_CONFIG } = require('./constants.js');
const { assertPlainObject, assertConfig, validateIntervalDays, validateAFactor } = require('./schema.js');

// SPEC A3.3: roundHalfUp(x) = floor(x + 0.5).
//
// The guard digit matters: `1.7 * 5` is 8.499999999999999778 in IEEE-754, whose
// mathematical value is 8.5 and must round to 9. Normalising to nine decimal
// places before the floor removes that representation artefact while leaving
// every genuine half-way value on the half-up side. Still fully deterministic.
const DECIMAL_GUARD_DIGITS = 9;

function roundHalfUp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('E_ROUND_TYPE', 'roundHalfUp expects a finite number', { value });
  }
  if (value < 0) {
    fail('E_NEGATIVE_INPUT', 'roundHalfUp is defined for non-negative values only (SPEC A3.3)', { value });
  }
  const normalised = Number(value.toFixed(DECIMAL_GUARD_DIGITS));
  return Math.floor(normalised + 0.5);
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
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
  const raw = intervalDays * aFactor;
  const rounded = roundHalfUp(raw);
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
  const next = computeNextIntervalDays({ mf_interval_days: intervalDays, a_factor: aFactor }, cfg);
  return {
    intervalDays,
    nextIntervalDays: next,
    text: `后续间隔：历史间隔 ${intervalDays} 天，A-Factor ${formatNumber(aFactor)}，下一次间隔 ${next} 天。`,
    data: {
      formula: 'clamp(roundHalfUp(I x A), 1, 3650)',
      intervalDays,
      aFactor,
      rawProduct: intervalDays * aFactor,
      nextIntervalDays: next,
    },
  };
}

module.exports = {
  DECIMAL_GUARD_DIGITS,
  roundHalfUp,
  clamp,
  formatNumber,
  computeNextIntervalDays,
  explainNextInterval,
};
