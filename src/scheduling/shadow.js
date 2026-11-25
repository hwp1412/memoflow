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
const { adaptLegacyTopic, adaptLegacyTopics } = require('./legacy-adapter.js');
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
]);

function resolveMode(modeOption) {
  if (modeOption && typeof modeOption === 'object' && typeof modeOption.canComputeShadow === 'boolean') {
    return modeOption;
  }
  return resolveSchedulerMode(modeOption);
}

function requireToday(today) {
  if (typeof today !== 'string' || !isValidDateString(today)) {
    fail('E_SHADOW_TODAY_REQUIRED', 'shadow requires an explicit valid today (YYYY-MM-DD)', { today });
  }
  return today;
}

function observationMap(observations) {
  const map = new Map();
  if (!Array.isArray(observations)) return map;
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    const id = observation.id || observation.mf_id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const key = id.toLowerCase();
    if (!map.has(key)) map.set(key, observation);
  }
  return map;
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

function compareCandidate(result, observation) {
  const base = {
    index: result.index,
    id: result.identity ? result.identity.id : null,
    identityKind: result.identity ? result.identity.kind : 'missing',
    persistentIdentity: Boolean(result.identity && result.identity.persistent),
    adapterStatus: result.status,
    writesPerformed: false,
    relationStatus: result.relation ? result.relation.status : null,
    relationVerified: result.relation ? result.relation.verified : null,
    caveats: [...CAVEATS],
    legacy: null,
    candidate: null,
    differences: [],
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
    schedulable: result.status === 'ready',
  };

  if (result.status === 'conflict' || result.status === 'ambiguous' || result.status === 'unsupported') {
    base.reasons = [
      ...result.conflicts.map(conflict => `FIELD_CONFLICT:${conflict.field}`),
      ...result.ambiguities.map(item => item.code),
      ...result.errors.map(error => error.code),
    ];
    base.explanation = `The legacy record cannot be compared reliably (${result.status}).`;
    return base;
  }

  if (!observation) {
    base.reasons = ['LEGACY_OBSERVATION_MISSING'];
    base.explanation = 'No trusted legacy observation was provided for this topic.';
    return base;
  }

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

  base.comparable = true;
  base.observationTrust = trust;
  const differences = [
    diffNumber('priority', base.legacy.priority, base.candidate.priority, 'DATA_SEMANTICS'),
    diffNumber('interval', base.legacy.interval, base.candidate.intervalDays, 'ALGORITHM_OR_LEGACY_HISTORY'),
    diffNumber('aFactor', base.legacy.aFactor, base.candidate.aFactor, 'ALGORITHM'),
    diffDate('idealDue', base.legacy.idealDue, base.candidate.idealDue, 'SCHEDULE_OR_ADMIN'),
    diffDate('effectiveDue', base.legacy.effectiveDue, base.candidate.effectiveDue, 'ADMIN_OR_SCHEDULE'),
  ].filter(Boolean);
  base.differences = differences;
  base.causes = [...new Set(differences.map(difference => difference.cause))];

  if (base.legacy.nextReview) {
    base.nextReviewComparison = {
      legacyNextReview: base.legacy.nextReview,
      candidateIdealDue: base.candidate.idealDue,
      deltaDays: isValidDateString(base.legacy.nextReview)
        ? calendarDayDifference(base.legacy.nextReview, base.candidate.idealDue)
        : null,
      equivalent: false,
      reason: 'LEGACY_NEXT_REVIEW_MAY_INCLUDE_ADMINISTRATIVE_CHANGE',
    };
  }

  if (result.status === 'read-only-limited') {
    base.reasons.push('CANDIDATE_READ_ONLY_LIMITED');
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
  const observations = observationMap(options.observations);
  const results = report.results.map(result => {
    const observation = result.identity && result.identity.id
      ? observations.get(result.identity.id.toLowerCase())
      : null;
    const compared = compareCandidate(result, observation || null);
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
