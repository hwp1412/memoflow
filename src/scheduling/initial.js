'use strict';

// Initial scheduling for a brand-new MF-US-1 topic (SPEC A3).
//
// Scope of PR-01: B(P), the type coefficient, half-up/clamp, the initial
// A-Factor and the new-topic field set. Creating a child extract does not touch
// the parent here — hierarchy wiring is an adapter concern (PR-06), and SPEC
// A3.4 forbids treating creation as a parent review.
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
const { roundHalfUp, clamp, formatNumber } = require('./interval.js');

// Any of these means "this topic already exists" and must not be re-initialised.
const EXISTING_STATE_FIELDS = [
  'mf_interval_days',
  'mf_ideal_due',
  'interval',
  'next_review',
  'a_factor',
  'review_count',
  'last_reviewed',
];

function hasMeaningfulState(field, value) {
  if (value == null || value === '') return false;
  if (field === 'review_count') return Number(value) > 0;
  return true;
}

function assertNotInitialized(input) {
  for (const field of EXISTING_STATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (!hasMeaningfulState(field, input[field])) continue;
    fail(
      'E_ALREADY_INITIALIZED',
      `topic already carries ${field}; initializeTopic() only creates new topics and never re-derives an existing interval (SPEC A4.1)`,
      { field, value: input[field] }
    );
  }
}

// SPEC A3.2 — piecewise linear B(P) through the four anchors.
function baseInitialIntervalDays(priority, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  const p = validatePriority(priority);
  if (p <= 50) return 1 + (p - 1) * 2 / 49;
  if (p <= 80) return 3 + (p - 50) * 4 / 30;
  return 7 + (p - 80) * 14 / 20;
}

// SPEC A3.3 — I0 = clamp(roundHalfUp(B(P) × K_type), 1, 30).
function initialIntervalDays(input, config = SPEC_CONFIG) {
  const cfg = assertConfig(config);
  assertPlainObject(input, 'initial interval input');
  const type = validateTopicType(input.type);
  const priority = validatePriority(input.priority);
  const base = baseInitialIntervalDays(priority, cfg);
  const kFactor = cfg.kFactor[type];
  const { min, max } = cfg.initialIntervalRange;
  const intervalDays = clamp(roundHalfUp(base * kFactor), min, max);
  return intervalDays;
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
    status: 'active', // SPEC A8: creation -> active
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
  EXISTING_STATE_FIELDS,
  assertNotInitialized,
  baseInitialIntervalDays,
  initialIntervalDays,
  initialAFactor,
  initializeTopic,
};
