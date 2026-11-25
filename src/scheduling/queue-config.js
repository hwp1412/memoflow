'use strict';

// Queue runtime configuration (SPEC A6.3, A6.4).
//
// Two kinds of numbers are deliberately kept apart:
//   * SPEC_CONFIG (constants.js) — fixed algorithm heuristics, not tunable;
//   * QUEUE_CONFIG (this module) — the daily budget is explicitly configurable.
//
// Per the Q15 ruling the budget accepts 1..1440 integer minutes (default 30).
// The cost defaults (Source 10 / Extract 5) and the per-topic 1..120 range stay
// fixed heuristics; only the budget can be overridden.

const { fail } = require('./errors.js');
const { deepFreeze } = require('./constants.js');
const { assertPlainObject } = require('./schema.js');

const QUEUE_CONFIG_VERSION = 1;
const CONFIGURABLE_KEYS = Object.freeze(['dailyBudgetMinutes']);
const QUEUE_CONFIG_KEYS = Object.freeze([
  'version',
  'dailyBudgetMinutes',
  'budgetRange',
  'defaultMinutes',
  'customMinutesRange',
  'workloadDays',
]);

const DEFAULT_QUEUE_CONFIG = deepFreeze({
  version: QUEUE_CONFIG_VERSION,
  dailyBudgetMinutes: 30,
  budgetRange: { min: 1, max: 1440 },
  defaultMinutes: { source: 10, extract: 5 },
  customMinutesRange: { min: 1, max: 120 },
  workloadDays: 7,
});

function validateBudget(value) {
  const { min, max } = DEFAULT_QUEUE_CONFIG.budgetRange;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('E_QUEUE_BUDGET_INVALID', `dailyBudgetMinutes must be an integer within ${min}..${max}`, {
      field: 'dailyBudgetMinutes',
      value,
      min,
      max,
    });
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Accepts either a partial override ({ dailyBudgetMinutes }) or a full config
// previously produced here. Fixed parts must match the defaults exactly.
function assertQueueConfig(config) {
  if (config == null) return DEFAULT_QUEUE_CONFIG;
  assertPlainObject(config, 'queueConfig');

  for (const key of Object.keys(config)) {
    if (!QUEUE_CONFIG_KEYS.includes(key)) {
      fail('E_QUEUE_CONFIG_INVALID', `queueConfig.${key} is not a known queue setting`, { key });
    }
  }

  if (config.dailyBudgetMinutes === undefined) {
    // Pure fixed-parameter object: every supplied key must equal the default.
    for (const key of Object.keys(config)) {
      if (key === 'dailyBudgetMinutes') continue;
      if (!sameValue(config[key], DEFAULT_QUEUE_CONFIG[key])) {
        fail('E_QUEUE_CONFIG_INVALID', `queueConfig.${key} is fixed by SPEC A6.3 and cannot be overridden`, {
          key,
          value: config[key],
        });
      }
    }
    return DEFAULT_QUEUE_CONFIG;
  }

  for (const key of Object.keys(config)) {
    if (CONFIGURABLE_KEYS.includes(key)) continue;
    if (!sameValue(config[key], DEFAULT_QUEUE_CONFIG[key])) {
      fail('E_QUEUE_CONFIG_INVALID', `queueConfig.${key} is fixed by SPEC A6.3 and cannot be overridden`, {
        key,
        value: config[key],
      });
    }
  }

  const budget = validateBudget(config.dailyBudgetMinutes);
  if (budget === DEFAULT_QUEUE_CONFIG.dailyBudgetMinutes) return DEFAULT_QUEUE_CONFIG;
  return deepFreeze({ ...DEFAULT_QUEUE_CONFIG, dailyBudgetMinutes: budget });
}

function createQueueConfig(overrides = {}) {
  if (overrides == null) return DEFAULT_QUEUE_CONFIG;
  assertPlainObject(overrides, 'queueConfig');
  for (const key of Object.keys(overrides)) {
    if (!CONFIGURABLE_KEYS.includes(key)) {
      fail('E_QUEUE_CONFIG_INVALID', `queueConfig.${key} is not configurable`, { key });
    }
  }
  return assertQueueConfig({
    ...DEFAULT_QUEUE_CONFIG,
    dailyBudgetMinutes: overrides.dailyBudgetMinutes === undefined
      ? DEFAULT_QUEUE_CONFIG.dailyBudgetMinutes
      : overrides.dailyBudgetMinutes,
  });
}

function costFor(type, estimatedMinutes, config = DEFAULT_QUEUE_CONFIG) {
  const cfg = assertQueueConfig(config);
  if (estimatedMinutes != null) return estimatedMinutes;
  return cfg.defaultMinutes[type];
}

module.exports = {
  QUEUE_CONFIG_VERSION,
  QUEUE_CONFIG_KEYS,
  DEFAULT_QUEUE_CONFIG,
  assertQueueConfig,
  createQueueConfig,
  validateBudget,
  costFor,
};
