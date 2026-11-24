'use strict';

// Single source of truth for the MF-US-1 parameters.
//
// Source: docs/MF-US-1-SPEC.md (version 1.0.0-draft), chapter A3.1 (initial
// interval parameters), A1.4 (data invariants) and A2.3 (date contract).
//
// These values are EXPERIMENTAL heuristics per SPEC A15. An agent MUST NOT tune
// them. `assertConfig()` in schema.js rejects any attempt to pass a different
// value, so a caller cannot quietly displace the specification.

const ALGORITHM_VERSION = 1; // A2.2: mf_scheduler_version = 1 for v1
const TOPIC_TYPES = Object.freeze(['source', 'extract']); // A1.2: cards stay in SR
const TYPE_LABELS = Object.freeze({ source: '来源', extract: '摘录' });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SPEC_CONFIG = deepFreeze({
  algorithmVersion: ALGORITHM_VERSION,
  defaultPriority: 50, // A3.1 (Q1: new topics only, when the caller omits it)
  kFactor: { source: 1, extract: 0.75 }, // A3.1
  initialAFactor: { source: 1.5, extract: 1.8 }, // A3.1
  priorityRange: { min: 1, max: 100 }, // A1.4
  intervalRange: { min: 1, max: 3650 }, // A1.4
  initialIntervalRange: { min: 1, max: 30 }, // A3.1 / A3.3
  aFactorRange: { min: 1.1, max: 3 }, // A1.4 (Q2: strict, historical values are reported)
  initialAnchors: [
    { priority: 1, days: 1 }, // A3.2
    { priority: 50, days: 3 },
    { priority: 80, days: 7 },
    { priority: 100, days: 21 },
  ],
  dateFormat: 'YYYY-MM-DD', // A2.3
  // Q3 ruling: strict four-digit ISO calendar dates, 0001-01-01 .. 9999-12-31.
  yearRange: { min: 1, max: 9999 },
});

module.exports = { ALGORITHM_VERSION, TOPIC_TYPES, TYPE_LABELS, SPEC_CONFIG, deepFreeze };
