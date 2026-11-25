'use strict';

// Read-only Shadow comparison for MF-US-1 (PR-07, SPEC A10.1, A12, A13 T19).
//
// Shadow never touches the legacy scheduler. It takes a caller-provided legacy
// snapshot plus caller-provided legacy observations, computes MF-US-1 candidates
// through the already accepted pure core, and reports differences.
//
// It does not apply events, does not write fields, does not create UUIDs, does
// not run Mercy or migration and never fabricates a legacy observation. A
// missing observation is reported as `legacy-observation-unavailable`, and a
// proxy is clearly marked as proxy instead of being presented as real legacy
// behaviour.

const { fail, isSchedulingError } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { applyEvent } = require('./events.js');
const { effectiveDue, effectiveDueFromDates } = require('./due.js');
const { calendarDayDifference, isValidDateString } = require('./dates.js');
const { adaptLegacyTopic, adaptLegacyTopics, isSchedulableCandidate } = require('./legacy-adapter.js');
const { isPersistentUuid } = require('./legacy-identity.js');
const { resolveSchedulerMode, assertShadowEnabled } = require('./mode.js');

const TRUST_BY_SOURCE = Object.freeze({
  'legacy-executed': 'executed',
  'legacy-export': 'observed',
  'legacy-observed': 'observed',
  'legacy-proxy': 'proxy',
  proxy: 'proxy',
});

const CAVEATS = Object.freeze([
  'LEGACY_DUE_MAY_INCLUDE_ADMINISTRATIVE_CHANGE',
  'LEGACY_INTERVAL_PROVENANCE_UNCERTAIN',
  'LEGACY_TRUST_IS_CALLER_CLAIM',
]);

const COMPARABLE_FIELDS = Object.freeze(['priority', 'interval', 'aFactor', 'idealDue', 'effectiveDue']);

// Capabilities are ALWAYS recomputed from resolveSchedulerMode; a caller cannot
// smuggle canCommitUnified/authoritativeScheduler/writesPerformed in through the
// options object. An already-resolved mode is simply re-resolved from its name.
function resolveMode(modeOption) {
  return resolveSchedulerMode(modeOption);
}

function requireToday(today) {
  if (typeof today !== 'string' || !isValidDateString(today)) {
    fail('E_SHADOW_TODAY_REQUIRED', 'shadow requires an explicit valid today (YYYY-MM-DD)', { today });
  }
  return today;
}

// Collect every observation per id so a duplicate is a reported conflict
// instead of a silent first-wins choice.
function collectObservations(observations) {
  const byId = new Map();
  if (!Array.isArray(observations)) return { byId, duplicates: new Set() };
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    const id = observation.id || observation.mf_id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const key = id.toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(observation);
  }
  const duplicates = new Set();
  for (const [key, list] of byId) if (list.length > 1) duplicates.add(key);
  return { byId, duplicates };
}

// Validate the fields that will actually be compared. A provided but illegal
// value is an explicit diagnostic, never treated as "missing".
function validateObservation(observation) {
  const reasons = [];
  const values = { priority: null, interval: null, aFactor: null, idealDue: null, nextReview: null, effectiveDue: null };

  if (observation.priority != null) {
    if (!Number.isInteger(observation.priority) || observation.priority < 1 || observation.priority > 100) reasons.push('INVALID_LEGACY_PRIORITY');
    else values.priority = observation.priority;
  }
  if (observation.interval != null) {
    if (!Number.isInteger(observation.interval) || observation.interval < 1 || observation.interval > 3650) reasons.push('INVALID_LEGACY_INTERVAL');
    else values.interval = observation.interval;
  }
  const aFactor = observation.aFactor ?? observation.a_factor;
  if (aFactor != null) {
    if (typeof aFactor !== 'number' || !Number.isFinite(aFactor) || aFactor < 1.1 || aFactor > 3) reasons.push('INVALID_LEGACY_AFACTOR');
    else values.aFactor = aFactor;
  }
  for (const field of ['idealDue', 'nextReview', 'effectiveDue']) {
    const value = observation[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !isValidDateString(value)) reasons.push('INVALID_LEGACY_DATE');
    else values[field] = value;
  }

  const comparableFields = COMPARABLE_FIELDS.filter(field => values[field] != null);
  return { reasons, values, comparableFields, valid: reasons.length === 0 };
}

function diffNumber(field, legacy, candidate, cause) {
  if (legacy == null) return null;
  if (typeof legacy !== 'number' || !Number.isFinite(legacy)) return null;
  if (legacy === candidate) return null;
  return { field, legacy, candidate, delta: candidate - legacy, cause };
}

function diffDate(field, legacy, candidate, cause) {
  if (legacy == null) return null;
  if (typeof legacy !== 'string' || !isValidDateString(legacy)) return null;
  if (legacy === candidate) return null;
  return {
    field,
    legacy,
    candidate,
    deltaDays: calendarDayDifference(legacy, candidate),
    cause,
  };
}

function compareCandidate(result, observations) {
  const schedulable = isSchedulableCandidate(result);
  const base = {
    index: result.index,
    id: result.identity ? result.identity.id : null,
    identityKind: result.identity ? result.identity.kind : 'missing',
    persistentIdentity: Boolean(result.identity && result.identity.persistent),
    adapterStatus: result.status,
    writesPerformed: false,
    relationStatus: result.relation ? result.relation.status : null,
    relationVerified: result.relation ? result.relation.verified : null,
    schedulable,
    caveats: [...CAVEATS],
    legacy: null,
    candidate: null,
    differences: [],
    missingFields: [],
    nextReviewComparison: null,
    causes: [],
    reasons: [],
    status: 'not-comparable',
    comparable: false,
    observationTrust: 'unavailable',
    explanation: '',
  };

  if (!result.topic) {
    base.reasons = [
      ...result.errors.map(error => error.code),
      ...result.ambiguities.map(item => item.code),
    ];
    if (!base.reasons.length) base.reasons = ['ADAPTER_NO_CANDIDATE'];
    base.explanation = `MF-US-1 candidate is unavailable (${base.reasons.join(', ')}).`;
    return base;
  }

  base.candidate = {
    priority: result.topic.priority,
    intervalDays: result.topic.mf_interval_days,
    aFactor: result.topic.a_factor,
    idealDue: result.topic.mf_ideal_due,
    effectiveDue: result.identity && result.identity.persistent
      ? effectiveDue(result.topic)
      : effectiveDueFromDates(result.topic.mf_ideal_due, result.topic.mf_not_before),
    status: result.topic.status,
    schedulable,
  };

  if (['conflict', 'ambiguous', 'unsupported', 'invalid'].includes(result.status)) {
    base.reasons = [
      ...result.conflicts.map(conflict => `FIELD_CONFLICT:${conflict.field}`),
      ...result.ambiguities.map(item => item.code),
      ...result.errors.map(error => error.code),
      `ADAPTER_STATUS:${result.status}`,
    ];
    base.explanation = `The legacy record cannot be compared reliably (${result.status}).`;
    return base;
  }

  if (!observations.length) {
    base.reasons = ['LEGACY_OBSERVATION_MISSING'];
    base.explanation = 'No trusted legacy observation was provided for this topic.';
    return base;
  }

  if (observations.length > 1) {
    base.reasons = ['LEGACY_OBSERVATION_DUPLICATE'];
    base.explanation = `The same topic id has ${observations.length} legacy observations; none is chosen.`;
    base.observationTrust = 'conflict';
    return base;
  }

  const observation = observations[0];
  const trust = TRUST_BY_SOURCE[observation.source] || 'untrusted';
  base.observationTrust = trust;
  base.legacy = {
    source: observation.source || null,
    priority: observation.priority ?? null,
    interval: observation.interval ?? null,
    aFactor: observation.aFactor ?? observation.a_factor ?? null,
    idealDue: observation.idealDue ?? null,
    nextReview: observation.nextReview ?? null,
    effectiveDue: observation.effectiveDue ?? null,
    status: observation.status ?? null,
  };

  if (trust === 'proxy') {
    base.reasons = ['LEGACY_PROXY_NOT_AUTHORITATIVE'];
    base.explanation = 'The legacy observation is a proxy, not a real legacy execution. It cannot serve as an authoritative baseline.';
    return base;
  }
  if (trust === 'untrusted') {
    base.reasons = ['LEGACY_OBSERVATION_UNTRUSTED'];
    base.explanation = 'The legacy observation has no recognized source and cannot be trusted.';
    return base;
  }
  if (observation.administrative === true) {
    base.reasons = ['LEGACY_ADMINISTRATIVE_CONTAMINATION'];
    base.explanation = 'The legacy observation was affected by POSTPONE/Mercy (administrative change) and is not directly comparable.';
    base.causes = ['SEMANTICS'];
    return base;
  }

  const validation = validateObservation(observation);
  if (!validation.valid) {
    base.reasons = validation.reasons;
    base.explanation = `The legacy observation contains illegal fields (${validation.reasons.join(', ')}); it is not treated as missing.`;
    return base;
  }
  if (validation.comparableFields.length === 0) {
    base.reasons = ['NO_COMPARABLE_LEGACY_FIELDS'];
    base.explanation = 'The legacy observation provides no comparable scheduling field, so no match can be claimed.';
    return base;
  }

  base.comparable = true;
  const values = validation.values;
  base.missingFields = COMPARABLE_FIELDS.filter(field => values[field] == null);

  const differences = [
    diffNumber('priority', values.priority, base.candidate.priority, 'DATA_SEMANTICS'),
    diffNumber('interval', values.interval, base.candidate.intervalDays, 'ALGORITHM_OR_LEGACY_HISTORY'),
    diffNumber('aFactor', values.aFactor, base.candidate.aFactor, 'ALGORITHM'),
    diffDate('idealDue', values.idealDue, base.candidate.idealDue, 'SCHEDULE_OR_ADMIN'),
    diffDate('effectiveDue', values.effectiveDue, base.candidate.effectiveDue, 'ADMIN_OR_SCHEDULE'),
  ].filter(Boolean);
  base.differences = differences;
  base.causes = [...new Set(differences.map(difference => difference.cause))];

  if (values.nextReview) {
    base.nextReviewComparison = {
      legacyNextReview: values.nextReview,
      candidateIdealDue: base.candidate.idealDue,
      deltaDays: calendarDayDifference(values.nextReview, base.candidate.idealDue),
      equivalent: false,
      reason: 'LEGACY_NEXT_REVIEW_MAY_INCLUDE_ADMINISTRATIVE_CHANGE',
    };
  }

  if (result.status === 'read-only-limited') {
    base.reasons.push('CANDIDATE_READ_ONLY_LIMITED');
  }
  if (!schedulable) {
    base.reasons.push('CANDIDATE_NOT_SCHEDULABLE');
  }
  if (differences.length > 0) {
    base.status = 'mismatch';
    base.explanation = `Differences: ${differences.map(difference => difference.field).join(', ')}. Values may reflect algorithm differences, legacy data semantics or past administrative changes; this comparison does not decide which is correct.`;
  } else {
    base.status = 'match';
    base.explanation = 'The provided legacy values agree with the MF-US-1 read-only candidate.';
  }
  return base;
}

function summarise(results) {
  const summary = { total: results.length, match: 0, mismatch: 0, unavailable: 0, notComparable: 0 };
  for (const result of results) {
    if (result.status === 'match') summary.match += 1;
    else if (result.status === 'mismatch') summary.mismatch += 1;
    else if (result.unavailable) summary.unavailable += 1;
    else summary.notComparable += 1;
  }
  return summary;
}

function compareShadowBatch(snapshots, options = {}) {
  if (!Array.isArray(snapshots)) {
    fail('E_OBJECT_REQUIRED', 'compareShadowBatch expects an array of legacy snapshots', { field: 'snapshots' });
  }
  const resolved = resolveMode(options.mode);
  assertShadowEnabled(resolved);
  const today = requireToday(options.today);
  const context = options.context || {};
  if (typeof context !== 'object' || Array.isArray(context)) {
    fail('E_OBJECT_REQUIRED', 'shadow context must be an object', { field: 'context' });
  }

  const report = adaptLegacyTopics(snapshots, context);
  const { byId } = collectObservations(options.observations);
  const results = report.results.map(result => {
    const observations = result.identity && result.identity.id
      ? (byId.get(result.identity.id.toLowerCase()) || [])
      : [];
    const compared = compareCandidate(result, observations);
    if (compared.status !== 'match' && compared.status !== 'mismatch') {
      compared.unavailable = compared.reasons.includes('LEGACY_OBSERVATION_MISSING')
        || compared.reasons.includes('LEGACY_PROXY_NOT_AUTHORITATIVE')
        || compared.reasons.includes('LEGACY_OBSERVATION_UNTRUSTED');
    }
    return compared;
  });

  return {
    mode: 'shadow',
    authoritativeScheduler: resolved.authoritativeScheduler,
    algorithmVersion: ALGORITHM_VERSION,
    today,
    dateFormat: context.dateFormat ?? null,
    writesPerformed: false,
    capabilities: {
      canComputeShadow: resolved.canComputeShadow,
      canCommitUnified: resolved.canCommitUnified,
      requiresMigration: resolved.requiresMigration,
      requiresUserAuthorization: resolved.requiresUserAuthorization,
    },
    results,
    summary: summarise(results),
  };
}

function previewShadowEvent(snapshot, event, options = {}) {
  const resolved = resolveMode(options.mode);
  assertShadowEnabled(resolved);
  const today = requireToday(options.today);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail('E_SHADOW_EVENT_REQUIRED', 'shadow event preview requires an explicit event', { field: 'event' });
  }

  const context = options.context || {};
  const adapted = adaptLegacyTopic(snapshot, context);
  const result = {
    mode: 'shadow',
    algorithmVersion: ALGORITHM_VERSION,
    writesPerformed: false,
    status: 'not-comparable',
    proposedState: null,
    committedLegacyState: options.committedLegacyState ?? null,
    committedSource: options.committedLegacyState
      ? (options.committedLegacySource || 'caller-provided')
      : null,
    reviewApplied: false,
    diagnostics: [],
    explanation: '',
  };

  if (!adapted.topic) {
    result.diagnostics = [
      ...adapted.errors.map(error => error.code),
      ...adapted.ambiguities.map(item => item.code),
    ];
    result.explanation = `The legacy snapshot cannot be adapted (${result.diagnostics.join(', ')}).`;
    return result;
  }
  if (!isPersistentUuid(adapted.topic.mf_id)) {
    result.status = 'read-only-limited';
    result.diagnostics = ['IDENTITY_NOT_PERSISTENT'];
    result.explanation = 'Shadow cannot propose an event for a temporary identity; no UUID is created.';
    return result;
  }

  if (adapted.status !== 'ready') {
    result.status = 'not-schedulable';
    result.diagnostics = [
      ...adapted.errors.map(error => error.code),
      ...adapted.conflicts.map(conflict => `FIELD_CONFLICT:${conflict.field}`),
      ...adapted.ambiguities.map(item => item.code),
      `ADAPTER_STATUS:${adapted.status}`,
    ];
    result.explanation = 'The adapted legacy record is not a schedulable candidate; no state is proposed and nothing is written.';
    return result;
  }

  if (!isSchedulableCandidate(adapted)) {
    result.status = 'not-schedulable';
    result.diagnostics = ['SCHEDULABLE_GATE_FAILED'];
    if (adapted.topic.status !== 'active') result.diagnostics.push('TOPIC_NOT_ACTIVE');
    if (adapted.relationVerified !== true) result.diagnostics.push('RELATION_UNVERIFIED');
    result.explanation = 'The adapted record fails the schedulable-candidate gate; no state is proposed and nothing is written.';
    return result;
  }

  try {
    const applied = applyEvent(adapted.topic, event, options.config, today);
    result.status = 'ok';
    result.proposedState = applied.topic;
    result.reviewApplied = applied.reviewApplied;
    result.diff = applied.diff;
    result.explain = applied.explain;
    result.eventDate = applied.eventDate;
    result.explanation = 'The proposed state is read-only; the legacy topic was not modified.';
    return result;
  } catch (error) {
    result.status = 'error';
    result.error = {
      code: isSchedulingError(error) ? error.code : 'E_SHADOW_EVENT_FAILED',
      message: error && error.message ? error.message : 'shadow event preview failed',
    };
    result.explanation = 'The event preview failed; nothing was applied and the legacy scheduler is unaffected.';
    return result;
  }
}

module.exports = {
  TRUST_BY_SOURCE,
  CAVEATS,
  resolveSchedulerMode,
  compareShadowBatch,
  previewShadowEvent,
};
