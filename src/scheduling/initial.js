'use strict';

// Initial scheduling for a brand-new MF-US-1 topic (SPEC A3).
//
// Scope of PR-01: B(P), the type coefficient, half-up/clamp, the initial
// A-Factor and the new-topic field set. Creating a child extract does not touch
// the parent here — hierarchy wiring is an adapter concern (PR-06), and SPEC
// A3.4 forbids treating creation as a parent review.
//
// New-topic contract (owner review, fix 2): initializeTopic() only accepts an
// input that cannot be an existing topic. Non-active status, invalid history
// counters, or any MF-US-1/legacy scheduling field present => explicit error.
// The core never silently reactivates state it did not create.
//
// Re-initialisation guard (SPEC A4.1, T11): initializeTopic() refuses a topic
// that already carries scheduling state. It never recomputes an existing
// interval from Priority.

const { fail } = require('./errors.js');
const { SPEC_CONFIG, ALGORITHM_VERSION, TYPE_LABELS } = require('./constants.js');
const {
  assertPlainObject,
  assertConfig,
  validatePriority,
  validateTopicType,
  validateUuid,
  validateOptionalUuid,
} = require('./schema.js');
const { assertDateString, addCalendarDays } = require('./dates.js');
const { clamp, formatNumber } = require('./interval.js');
const { multiplyRationals, roundHalfUpRational, toSafeNumber } = require('./decimal.js');

const NEW_TOPIC_STATUS = 'active';
const NUMERIC_STATE_FIELDS = ['mf_interval_days', 'interval', 'a_factor'];
const DATE_STATE_FIELDS = ['last_reviewed', 'next_review', 'mf_ideal_due', 'mf_not_before'];
const OPAQUE_STATE_FIELDS = ['mf_last_event_id', 'mf_revision', 'mf_scheduler_version'];
const STATE_FIELDS = [
  'status',
  'review_count',
  ...NUMERIC_STATE_FIELDS,
  ...DATE_STATE_FIELDS,
  ...OPAQUE_STATE_FIELDS,
];

function hasValue(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
}

// SPEC A3.2 — piecewise linear B(P) through the four anchors, held as an exact
// rational so I0 never depends on float representation.
//   1..50    : 1 + (P-1)*2/49   = (2P + 47) / 49
//   51..80   : 3 + (P-50)*4/30  = (2P - 55) / 15
//   81..100  : 7 + (P-80)*14/20 = (7P - 490) / 10
function initialBaseRational(priority) {
  if (priority <= 50) return { n: BigInt(2 * priority + 47), d: 49n };
  if (priority <= 80) return { n: BigInt(2 * priority - 55), d: 15n };
  return { n: BigInt(7 * priority - 490), d: 10n };
}

const TYPE_K_RATIONAL = {
  source: { n: 1n, d: 1n },
  extract: { n: 3n, d: 4n }, // SPEC A3.1: K_extract = 0.75
};

// Any of these means "this topic already exists" (or is ambiguous) and must not
// be initialised. Illegal values are reported as such instead of being read as
// "no history".
function assertNotInitialized(input) {
  if (hasValue(input, 'status') && input.status !== NEW_TOPIC_STATUS) {
    fail(
      'E_STATUS_NOT_NEW',
      `status must be absent or "${NEW_TOPIC_STATUS}" for a new topic; initializeTopic() never reactivates existing state (SPEC A8)`,
      { field: 'status', value: input.status }
    );
  }

  if (hasValue(input, 'review_count')) {
    const value = input.review_count;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      fail('E_REVIEW_COUNT_INVALID', 'review_count must be a non-negative integer', { field: 'review_count', value });
    }
    if (value > 0) {
      fail('E_ALREADY_INITIALIZED', 'topic already has review history; initializeTopic() only creates new topics', { field: 'review_count', value });
    }
  }

  for (const field of NUMERIC_STATE_FIELDS) {
    if (!hasValue(input, field)) continue;
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('E_STATE_FIELD_INVALID', `${field} is present but is not a finite number`, { field, value });
    }
    fail(
      'E_ALREADY_INITIALIZED',
      `topic already carries ${field}; initializeTopic() only creates new topics and never re-derives an existing interval (SPEC A4.1)`,
      { field, value }
    );
  }

  for (const field of DATE_STATE_FIELDS) {
    if (!hasValue(input, field)) continue;
    const value = input[field];
    if (typeof value !== 'string' || value === '') {
      fail('E_STATE_FIELD_INVALID', `${field} is present but is not a date string`, { field, value });
    }
    fail('E_ALREADY_INITIALIZED', `topic already carries ${field}; initializeTopic() only creates new topics`, { field, value });
  }

  for (const field of OPAQUE_STATE_FIELDS) {
    if (!hasValue(input, field)) continue;
    fail('E_ALREADY_INITIALIZED', `topic already carries ${field}; initializeTopic() only creates new topics`, { field, value: input[field] });
  }
}

// Public float view of B(P) for explanations and tests. The rounding itself
// always uses initialBaseRational(), never this float.
function baseInitialIntervalDays(priority, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  const p = validatePriority(priority);
  const rational = initialBaseRational(p);
  return Number(rational.n) / Number(rational.d);
}

// SPEC A3.3 — I0 = clamp(roundHalfUp(B(P) × K_type), 1, 30), computed exactly.
function initialIntervalDays(input, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  assertPlainObject(input, 'initial interval input');
  const type = validateTopicType(input.type);
  const priority = validatePriority(input.priority);
  const product = multiplyRationals(initialBaseRational(priority), TYPE_K_RATIONAL[type]);
  const rounded = toSafeNumber(roundHalfUpRational(product), 'initial interval');
  const { min, max } = cfg.initialIntervalRange;
  return clamp(rounded, min, max);
}

// SPEC A3.1 — initial A-Factor per topic type.
function initialAFactor(type, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  const topicType = validateTopicType(type);
  return cfg.initialAFactor[topicType];
}

// SPEC A3.3 / A3.4 / A8 — create the scheduling fields of a new topic.
//
// The stable id is supplied and validated by the caller; this module never
// generates a UUID, never reads a clock and never touches storage.
function initializeTopic(input, config = SPEC_CONFIG, today = undefined) {
  const cfg = assertConfig(config);
  assertPlainObject(input, 'topic input');

  const type = validateTopicType(input.type);
  const priority = input.priority === undefined
    ? cfg.defaultPriority // Q1: new topic, caller omitted the value
    : validatePriority(input.priority); // Q1/A3.2: present but illegal => error

  if (input.mfId == null) {
    fail('E_ID_REQUIRED', 'mfId must be supplied by the caller; the core never generates identifiers', { field: 'mfId' });
  }
  const mfId = validateUuid(input.mfId, 'mfId');
  const mfParentId = validateOptionalUuid(input.mfParentId, 'mf_parent_id');
  const mfRootId = validateOptionalUuid(input.mfRootId, 'mf_root_id');

  assertNotInitialized(input);
  assertDateString(today, 'today');

  const intervalDays = initialIntervalDays({ type, priority }, cfg);
  const idealDue = addCalendarDays(today, intervalDays, 'today');
  const aFactor = initialAFactor(type, cfg);
  const base = baseInitialIntervalDays(priority, cfg);

  const topic = {
    type,
    priority,
    status: NEW_TOPIC_STATUS, // SPEC A8: creation -> active
    mf_id: mfId,
    mf_parent_id: mfParentId,
    mf_root_id: mfRootId,
    mf_ideal_due: idealDue,
    mf_not_before: null, // SPEC A3.3
    mf_interval_days: intervalDays,
    mf_last_event_id: null,
    mf_revision: 0,
    mf_scheduler_version: ALGORITHM_VERSION,
    a_factor: aFactor,
    review_count: 0, // SPEC A3.3
  };

  const label = TYPE_LABELS[type];
  const explain = {
    text: `P${priority} ${label}：首次间隔 ${intervalDays} 天（B=${formatNumber(base)} × K=${formatNumber(cfg.kFactor[type])}，按 half-up 取整）；首次到期 ${idealDue}。`,
    data: {
      formula: 'clamp(roundHalfUp(B(P) x K_type), 1, 30)',
      type,
      priority,
      baseInitialIntervalDays: base,
      kFactor: cfg.kFactor[type],
      intervalDays,
      aFactor,
      idealDue,
      today,
      algorithmVersion: ALGORITHM_VERSION,
    },
  };

  return {
    topic: { ...topic },
    diff: { created: true },
    explain,
    algorithmVersion: ALGORITHM_VERSION,
    needsWrite: true,
  };
}

module.exports = {
  NEW_TOPIC_STATUS,
  NUMERIC_STATE_FIELDS,
  DATE_STATE_FIELDS,
  OPAQUE_STATE_FIELDS,
  STATE_FIELDS,
  assertNotInitialized,
  initialBaseRational,
  baseInitialIntervalDays,
  initialIntervalDays,
  initialAFactor,
  initializeTopic,
};
