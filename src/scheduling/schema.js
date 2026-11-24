'use strict';

// Input validation for the MF-US-1 pure core.
//
// Rules encoded here come straight from SPEC A1.4 / A3.1 / A3.2 and the owner
// rulings of this PR:
//   Q1  default priority 50 applies ONLY to a new topic whose caller omitted it;
//   Q2  the A-Factor range is strict — historical out-of-range values are
//       reported, never clamped or replaced by a default;
//   A3.2 an invalid priority on an existing topic is an error, not P50.
//
// Nothing in this module repairs data. A rejected value leaves the caller's
// object untouched.

const { fail } = require('./errors.js');
const { TOPIC_TYPES, SPEC_CONFIG, ALGORITHM_VERSION } = require('./constants.js');
const { assertDateString } = require('./dates.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainObject(value, field) {
  if (!isPlainObject(value)) {
    fail('E_OBJECT_REQUIRED', `${field} must be a plain object`, { field, value });
  }
  return value;
}

function assertNumber(value, field, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(code, `${field} must be a finite number`, { field, value });
  }
  return value;
}

// SPEC A3.2 / A1.4 — integer 1..100. A quoted string is a type error, not a 50.
function validatePriority(value, field = 'priority') {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    fail('E_PRIORITY_TYPE', `${field} must be an integer number (1..100)`, { field, value });
  }
  const { min, max } = SPEC_CONFIG.priorityRange;
  if (value < min || value > max) {
    fail('E_PRIORITY_RANGE', `${field} must be within ${min}..${max}`, { field, value, min, max });
  }
  return value;
}

function isPriority(value) {
  try {
    validatePriority(value);
    return true;
  } catch {
    return false;
  }
}

// SPEC A1.4 — integer 1..3650 natural days.
function validateIntervalDays(value, field = 'mf_interval_days') {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    fail('E_INTERVAL_TYPE', `${field} must be an integer number of days`, { field, value });
  }
  const { min, max } = SPEC_CONFIG.intervalRange;
  if (value < min || value > max) {
    fail('E_INTERVAL_RANGE', `${field} must be within ${min}..${max}`, { field, value, min, max });
  }
  return value;
}

// SPEC A1.4 / Q2 — finite 1.10..3.00, strict. Legacy 1.05 or 5.0 is an error.
function validateAFactor(value, field = 'a_factor') {
  assertNumber(value, field, 'E_AFACTOR_TYPE');
  const { min, max } = SPEC_CONFIG.aFactorRange;
  if (value < min || value > max) {
    fail('E_AFACTOR_RANGE', `${field} must be within ${min}..${max}`, { field, value, min, max });
  }
  return value;
}

// SPEC A1.2: only Source and Extract are MF-US-1 topics. Cards belong to SR.
function validateTopicType(value, field = 'type') {
  if (typeof value !== 'string' || !TOPIC_TYPES.includes(value)) {
    fail('E_TOPIC_TYPE', `${field} must be one of ${TOPIC_TYPES.join(', ')}`, { field, value });
  }
  return value;
}

function validateUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail('E_ID_FORMAT', `${field} must be a UUID string`, { field, value });
  }
  return value;
}

function validateOptionalUuid(value, field) {
  if (value == null) return null;
  return validateUuid(value, field);
}

function deepEqualSpec(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqualSpec(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => (
      Object.prototype.hasOwnProperty.call(right, key) && deepEqualSpec(left[key], right[key])
    ));
  }
  return false;
}

// Guards SPEC A15: the published parameters are not a tuning surface. Passing a
// config is supported so adapters can carry it through, but every value must
// equal the specification and unknown keys are refused. The canonical frozen
// config is always what gets returned and used.
function assertConfig(config) {
  if (config == null) return SPEC_CONFIG;
  assertPlainObject(config, 'config');
  const expectedKeys = Object.keys(SPEC_CONFIG);
  for (const key of Object.keys(config)) {
    if (!expectedKeys.includes(key)) {
      fail('E_CONFIG_UNKNOWN_KEY', `config.${key} is not an MF-US-1 parameter`, { key });
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      fail('E_CONFIG_SPEC_VIOLATION', `config.${key} is missing`, { key });
    }
    if (!deepEqualSpec(config[key], SPEC_CONFIG[key])) {
      fail(
        'E_CONFIG_SPEC_VIOLATION',
        `config.${key} must equal the MF-US-1 specification value; parameters are not tunable (SPEC A15)`,
        { key, value: config[key], expected: SPEC_CONFIG[key] }
      );
    }
  }
  return SPEC_CONFIG;
}

// Statuses that exist in MemoFlow data. SPEC A8: inbox/pending/container are
// legacy states whose meaning must come from a compatibility adapter — the pure
// core never guesses what they mean, it only reports that an event cannot be
// applied to them yet.
const KNOWN_STATUSES = Object.freeze(['active', 'done', 'dismissed', 'inbox', 'pending', 'container']);
const ACTIVE_STATUS = 'active';
const REACTIVATABLE_STATUSES = Object.freeze(['done', 'dismissed']);

function validateStatus(value, field = 'status') {
  if (typeof value !== 'string' || !KNOWN_STATUSES.includes(value)) {
    fail('E_STATUS_UNKNOWN', `${field} is not a known scheduling status`, { field, value });
  }
  return value;
}

function validateRevision(value, field = 'mf_revision') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('E_REVISION_INVALID', `${field} must be a non-negative safe integer`, { field, value });
  }
  return value;
}

function validateCount(value, field = 'review_count') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('E_REVIEW_COUNT_INVALID', `${field} must be a non-negative safe integer`, { field, value });
  }
  return value;
}

// Full validation of an existing, normalised MF-US-1 topic. Used by applyEvent
// and the due calculations; it never repairs a field.
function validateTopic(topic, field = 'topic') {
  assertPlainObject(topic, field);
  validateTopicType(topic.type);
  validatePriority(topic.priority);
  validateIntervalDays(topic.mf_interval_days);
  validateAFactor(topic.a_factor);
  validateStatus(topic.status);
  validateRevision(topic.mf_revision);
  if (topic.mf_id == null) {
    fail('E_ID_REQUIRED', 'topic.mf_id is required for MF-US-1 scheduling', { field: 'mf_id' });
  }
  validateUuid(topic.mf_id, 'mf_id');
  if (topic.mf_scheduler_version !== ALGORITHM_VERSION) {
    fail('E_VERSION_UNSUPPORTED', `topic.mf_scheduler_version must be ${ALGORITHM_VERSION}`, {
      field: 'mf_scheduler_version',
      value: topic.mf_scheduler_version,
    });
  }
  assertDateString(topic.mf_ideal_due, 'mf_ideal_due');
  if (topic.mf_not_before != null) assertDateString(topic.mf_not_before, 'mf_not_before');
  validateCount(topic.review_count, 'review_count');
  if (topic.last_reviewed != null) assertDateString(topic.last_reviewed, 'last_reviewed');
  return topic;
}

module.exports = {
  UUID_RE,
  KNOWN_STATUSES,
  ACTIVE_STATUS,
  REACTIVATABLE_STATUSES,
  isPlainObject,
  assertPlainObject,
  validatePriority,
  isPriority,
  validateIntervalDays,
  validateAFactor,
  validateTopicType,
  validateUuid,
  validateOptionalUuid,
  validateStatus,
  validateRevision,
  validateCount,
  validateTopic,
  assertConfig,
};
