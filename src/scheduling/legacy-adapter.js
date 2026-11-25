'use strict';

// Read-only legacy adapter for MemoFlow / Toolkit notes (PR-06, SPEC A2, A8,
// A10.2).
//
// Input is a caller-provided metadata snapshot. The adapter never reads a
// vault, never reads a clock, never mutates the input and never writes any
// frontmatter field: every result carries `writesPerformed: false`.
//
// Field mapping is candidate-only. In particular:
//   * a legal legacy `interval` is preserved even when review_count is 0 (the
//     initial-interval formula is never re-applied);
//   * missing/invalid Priority or A-Factor is reported, never defaulted to P50
//     or to the spec A-Factor;
//   * `mf_not_before` is null because a legacy postponement cannot be recovered;
//   * a legacy interval may already contain an administrative value (old
//     POSTPONE / MANUAL_SCHEDULE / Mercy wrote `interval`), so its provenance is
//     always disclosed as uncertain.

const { fail, isSchedulingError } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { isValidDateString } = require('./dates.js');
const {
  validatePriority,
  validateIntervalDays,
  validateAFactor,
  validateCount,
  isPriority,
} = require('./schema.js');
const { resolveIdentity, findIdentityCollisions } = require('./legacy-identity.js');
const { resolveRelations } = require('./legacy-relations.js');

const DATE_FORMATS = Object.freeze({
  'DD-MM-YYYY': /^(\d{2})-(\d{2})-(\d{4})$/,
  'MM-DD-YYYY': /^(\d{2})-(\d{2})-(\d{4})$/,
  'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
  'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
});

const SUPPORTED_STATUS_MAP = Object.freeze({
  active: 'active',
  done: 'done',
  dismissed: 'dismissed',
});
const UNSUPPORTED_STATUSES = Object.freeze(['inbox', 'pending', 'container']);

function parseLegacyDate(value, format) {
  if (value == null || value === '') return { empty: true };
  if (typeof value !== 'string') return { error: 'E_DATE_FORMAT', message: 'date value must be a string' };
  const text = value.trim();
  if (!text) return { empty: true };
  if (!format) return { ambiguous: true, code: 'E_LEGACY_DATE_FORMAT_REQUIRED' };

  const key = String(format).toUpperCase();
  const pattern = DATE_FORMATS[key];
  if (!pattern) return { error: 'E_LEGACY_DATE_FORMAT_UNSUPPORTED', message: `unsupported date format "${format}"` };

  const match = pattern.exec(text);
  if (!match) return { error: 'E_DATE_FORMAT', message: `"${text}" does not match ${key}` };

  let year;
  let month;
  let day;
  if (key === 'YYYY-MM-DD') {
    [, year, month, day] = match;
  } else if (key === 'DD-MM-YYYY' || key === 'DD/MM/YYYY') {
    [, day, month, year] = match;
  } else {
    [, month, day, year] = match;
  }
  const iso = `${year}-${month}-${day}`;
  if (!isValidDateString(iso)) return { error: 'E_DATE_INVALID', message: `"${text}" is not a real calendar date` };
  return { iso, format: key };
}

function legacyState(value) {
  if (value == null || value === '') return 'missing';
  if (Object.prototype.hasOwnProperty.call(SUPPORTED_STATUS_MAP, value)) return 'mapped';
  if (UNSUPPORTED_STATUSES.includes(value)) return 'unsupported';
  return 'unknown';
}

function adaptLegacyTopic(raw, context = {}) {
  const dateFormat = context && context.dateFormat;
  const result = {
    index: -1,
    status: 'invalid',
    identity: null,
    source: {
      path: typeof raw === 'object' && raw ? (raw.path ?? null) : null,
      basename: typeof raw === 'object' && raw ? (raw.basename ?? raw.title ?? null) : null,
    },
    topic: null,
    fieldSources: {},
    conflicts: [],
    warnings: [],
    errors: [],
    ambiguities: [],
    lossNotes: [
      'NOT_BEFORE_NOT_RECOVERABLE',
      'LEGACY_INTERVAL_MAY_INCLUDE_ADMINISTRATIVE_VALUE',
    ],
    relation: null,
    writesPerformed: false,
  };

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    result.errors.push({ code: 'E_OBJECT_REQUIRED', field: null, message: 'raw topic must be a plain object' });
    return result;
  }

  result.identity = resolveIdentity(raw);
  if (result.identity.error) {
    result.errors.push({ code: result.identity.error, field: 'mf_id', message: 'legacy identity could not be resolved' });
  }
  if (result.identity.warning) {
    result.warnings.push({ code: result.identity.warning, field: 'identity', message: 'identity is a read-only temporary id, not a persisted mf_id' });
  }

  // ----- type -----
  if (raw.type !== 'source' && raw.type !== 'extract') {
    result.status = 'unsupported';
    result.errors.push({
      code: 'E_UNSUPPORTED_TOPIC_TYPE',
      field: 'type',
      message: `type "${raw.type}" is not source/extract; cards stay in SR`,
      value: raw.type,
    });
    return result;
  }

  // ----- status -----
  const state = legacyState(raw.status);
  if (state !== 'mapped') {
    result.status = 'unsupported';
    result.errors.push({
      code: state === 'unsupported' ? 'E_UNSUPPORTED_STATUS' : 'E_UNKNOWN_STATUS',
      field: 'status',
      message: `status "${raw.status}" has no confirmed MF-US-1 mapping`,
      value: raw.status,
    });
    return result;
  }
  const mappedStatus = SUPPORTED_STATUS_MAP[raw.status];
  result.fieldSources.status = 'legacy_status_map';

  // ----- scalar fields -----
  let priority = null;
  if (raw.priority == null) {
    result.errors.push({ code: 'E_LEGACY_PRIORITY_MISSING', field: 'priority', message: 'priority is missing; the adapter never substitutes P50' });
  } else {
    try {
      priority = validatePriority(raw.priority);
      result.fieldSources.priority = 'legacy';
    } catch (error) {
      result.errors.push({ code: 'E_LEGACY_PRIORITY_INVALID', field: 'priority', message: error.message, value: raw.priority });
    }
  }

  let interval = null;
  if (raw.interval == null) {
    result.errors.push({ code: 'E_LEGACY_INTERVAL_MISSING', field: 'interval', message: 'interval is missing; no default is applied' });
  } else {
    try {
      interval = validateIntervalDays(raw.interval, 'interval');
      result.fieldSources.interval = 'legacy';
    } catch (error) {
      result.errors.push({ code: 'E_LEGACY_INTERVAL_INVALID', field: 'interval', message: error.message, value: raw.interval });
    }
  }

  let aFactor = null;
  if (raw.a_factor == null) {
    result.errors.push({ code: 'E_LEGACY_AFACTOR_MISSING', field: 'a_factor', message: 'a_factor is missing; the adapter never substitutes a default' });
  } else {
    try {
      aFactor = validateAFactor(raw.a_factor, 'a_factor');
      result.fieldSources.a_factor = 'legacy';
    } catch (error) {
      result.errors.push({ code: 'E_LEGACY_AFACTOR_INVALID', field: 'a_factor', message: error.message, value: raw.a_factor });
    }
  }

  let reviewCount = null;
  if (raw.review_count == null) {
    result.errors.push({ code: 'E_LEGACY_REVIEW_COUNT_MISSING', field: 'review_count', message: 'review_count is missing; no default is applied' });
  } else {
    try {
      reviewCount = validateCount(raw.review_count, 'review_count');
      result.fieldSources.review_count = 'legacy';
    } catch (error) {
      result.errors.push({ code: 'E_LEGACY_REVIEW_COUNT_INVALID', field: 'review_count', message: error.message, value: raw.review_count });
    }
  }

  // ----- dates -----
  const nextReview = parseLegacyDate(raw.next_review, dateFormat);
  let idealDue = null;
  if (nextReview.iso) {
    idealDue = nextReview.iso;
    result.fieldSources.mf_ideal_due = 'legacy:next_review';
  } else if (nextReview.ambiguous) {
    result.ambiguities.push({ code: nextReview.code, field: 'next_review', message: 'date format is required to resolve next_review' });
  } else if (nextReview.error) {
    result.errors.push({ code: nextReview.error, field: 'next_review', message: nextReview.message, value: raw.next_review });
  } else {
    result.errors.push({ code: 'E_LEGACY_NEXT_REVIEW_MISSING', field: 'next_review', message: 'next_review is missing; the ideal due date cannot be derived' });
  }

  let lastReviewed = null;
  const lastParsed = parseLegacyDate(raw.last_reviewed, dateFormat);
  if (lastParsed.iso) lastReviewed = lastParsed.iso;
  else if (lastParsed.error) {
    result.errors.push({ code: lastParsed.error, field: 'last_reviewed', message: lastParsed.message, value: raw.last_reviewed });
  } else if (lastParsed.ambiguous) {
    result.ambiguities.push({ code: lastParsed.code, field: 'last_reviewed', message: 'date format is required to resolve last_reviewed' });
  }

  let dateAdded = null;
  const addedParsed = parseLegacyDate(raw.date_added, dateFormat);
  if (addedParsed.iso) dateAdded = addedParsed.iso;
  else if (addedParsed.error || addedParsed.ambiguous) {
    result.warnings.push({
      code: 'DATE_ADDED_UNPARSEABLE',
      field: 'date_added',
      message: 'date_added is unparseable and is treated as unknown (it only affects tie-breaking order)',
    });
  }

  // ----- new fields and conflicts -----
  let modernIdeal = null;
  if (raw.mf_ideal_due != null) {
    if (typeof raw.mf_ideal_due !== 'string' || !isValidDateString(raw.mf_ideal_due)) {
      result.errors.push({ code: 'E_DATE_INVALID', field: 'mf_ideal_due', message: 'mf_ideal_due is not a strict ISO date', value: raw.mf_ideal_due });
    } else {
      modernIdeal = raw.mf_ideal_due;
      result.fieldSources.mf_ideal_due = 'modern';
      if (idealDue && idealDue !== modernIdeal) {
        result.conflicts.push({ field: 'mf_ideal_due', legacy: idealDue, modern: modernIdeal });
      }
    }
  }

  let modernInterval = null;
  if (raw.mf_interval_days != null) {
    try {
      modernInterval = validateIntervalDays(raw.mf_interval_days);
      result.fieldSources.mf_interval_days = 'modern';
      if (interval != null && modernInterval !== interval) {
        result.conflicts.push({ field: 'mf_interval_days', legacy: interval, modern: modernInterval });
      }
    } catch (error) {
      result.errors.push({ code: 'E_INTERVAL_RANGE', field: 'mf_interval_days', message: error.message, value: raw.mf_interval_days });
    }
  }

  let notBefore = null;
  if (raw.mf_not_before != null) {
    if (typeof raw.mf_not_before !== 'string' || !isValidDateString(raw.mf_not_before)) {
      result.errors.push({ code: 'E_DATE_INVALID', field: 'mf_not_before', message: 'mf_not_before is not a strict ISO date', value: raw.mf_not_before });
    } else {
      notBefore = raw.mf_not_before;
    }
  }

  let revision = 0;
  if (raw.mf_revision != null) {
    if (!Number.isSafeInteger(raw.mf_revision) || raw.mf_revision < 0) {
      result.errors.push({ code: 'E_REVISION_INVALID', field: 'mf_revision', message: 'mf_revision must be a non-negative integer', value: raw.mf_revision });
    } else {
      revision = raw.mf_revision;
    }
  } else {
    result.warnings.push({ code: 'REVISION_INITIALIZED', field: 'mf_revision', message: 'mf_revision is absent; the read-only candidate uses 0 and nothing is written' });
  }

  if (raw.mf_scheduler_version != null && raw.mf_scheduler_version !== ALGORITHM_VERSION) {
    result.conflicts.push({ field: 'mf_scheduler_version', legacy: null, modern: raw.mf_scheduler_version });
  } else if (raw.mf_scheduler_version == null) {
    result.warnings.push({ code: 'SCHEDULER_VERSION_INITIALIZED', field: 'mf_scheduler_version', message: 'mf_scheduler_version is absent; the candidate uses 1 for analysis only' });
  }

  let estimatedMinutes;
  if (raw.estimated_minutes != null) {
    if (!Number.isInteger(raw.estimated_minutes) || raw.estimated_minutes < 1 || raw.estimated_minutes > 120) {
      result.errors.push({ code: 'E_ESTIMATED_MINUTES_INVALID', field: 'estimated_minutes', message: 'estimated_minutes must be 1..120', value: raw.estimated_minutes });
    } else {
      estimatedMinutes = raw.estimated_minutes;
    }
  }

  // ----- candidate -----
  const canBuild = result.errors.length === 0
    && priority != null && interval != null && aFactor != null
    && reviewCount != null && (modernIdeal || idealDue);
  if (canBuild) {
    result.topic = {
      type: raw.type,
      status: mappedStatus,
      priority,
      mf_id: result.identity.kind === 'persistent' ? result.identity.id : null,
      mf_parent_id: null,
      mf_root_id: null,
      mf_ideal_due: modernIdeal || idealDue,
      mf_not_before: notBefore,
      mf_interval_days: modernInterval == null ? interval : modernInterval,
      a_factor: aFactor,
      review_count: reviewCount,
      last_reviewed: lastReviewed,
      mf_scheduler_version: ALGORITHM_VERSION,
      mf_revision: revision,
      mf_last_event_id: null,
    };
    if (dateAdded) result.topic.date_added = dateAdded;
    if (estimatedMinutes != null) result.topic.estimated_minutes = estimatedMinutes;
  }

  // ----- classification -----
  if (result.errors.length > 0) result.status = 'invalid';
  else if (result.ambiguities.length > 0) result.status = 'ambiguous';
  else if (result.conflicts.length > 0) result.status = 'conflict';
  else if (result.identity.kind !== 'persistent') result.status = 'read-only-limited';
  else result.status = 'ready';

  return result;
}

// Batch adaptation: field mapping + identity collisions + relation resolution.
// One broken note never prevents the others from being analysed.
function adaptLegacyTopics(rawTopics, context = {}) {
  if (!Array.isArray(rawTopics)) {
    fail('E_OBJECT_REQUIRED', 'adaptLegacyTopics expects an array of raw snapshots', { field: 'rawTopics' });
  }

  const results = rawTopics.map((raw, index) => {
    try {
      const adapted = adaptLegacyTopic(raw, context);
      adapted.index = index;
      return adapted;
    } catch (error) {
      return {
        index,
        status: 'invalid',
        identity: null,
        source: { path: null, basename: null },
        topic: null,
        fieldSources: {},
        conflicts: [],
        warnings: [],
        errors: [{
          code: isSchedulingError(error) ? error.code : 'E_LEGACY_ADAPTER_ERROR',
          field: null,
          message: error && error.message ? error.message : 'adapter failure',
        }],
        lossNotes: [],
        relation: null,
        writesPerformed: false,
      };
    }
  });

  // Identity collisions (persistent duplicates or temp-id collisions).
  const collisions = findIdentityCollisions(results);
  for (const result of results) {
    const id = result.identity && result.identity.id;
    if (!id || !collisions.has(id)) continue;
    result.errors.push({
      code: 'E_DUPLICATE_ID',
      field: 'mf_id',
      message: `stable id "${id}" appears ${collisions.get(id)} times in this snapshot`,
    });
    if (result.status !== 'invalid') result.status = 'conflict';
  }

  const relationEntries = results
    .filter(result => result.identity && result.identity.id)
    .map(result => {
      const raw = rawTopics[result.index] || {};
      return {
        id: result.identity.id,
        identity: result.identity,
        path: raw.path,
        basename: raw.basename || raw.title,
        raw,
      };
    });

  const relationResult = relationEntries.length ? resolveRelations(relationEntries) : { byId: new Map(), issues: { orphans: [], ambiguous: [], selfReferences: [], cycles: [] } };

  for (const result of results) {
    const id = result.identity && result.identity.id;
    if (!id) continue;
    const relation = relationResult.byId.get(id);
    if (!relation) continue;
    result.relation = {
      status: relation.status,
      parentId: relation.parentId,
      rootId: relation.rootId,
      depth: relation.depth,
      persistent: relation.persistent,
      link: relation.link,
    };
    if (result.topic) {
      result.topic.mf_parent_id = relation.persistent && relation.parentId ? relation.parentId : null;
      result.topic.mf_root_id = relation.persistent && relation.rootId ? relation.rootId : null;
      if (!relation.persistent) {
        result.warnings.push({
          code: 'RELATION_NOT_PERSISTENT',
          field: 'mf_parent_id',
          message: 'parent/root relation depends on a temporary identity; it is not a persisted relation',
        });
      }
    }

    if (relation.status === 'cycle') {
      result.errors.push({ code: 'E_RELATION_CYCLE', field: 'parent', message: 'parent chain contains a cycle' });
      result.status = 'invalid';
    } else if (relation.status === 'self') {
      result.errors.push({ code: 'E_RELATION_SELF', field: 'parent', message: 'topic cannot be its own parent' });
      result.status = 'invalid';
    } else if (relation.status === 'ambiguous') {
      result.warnings.push({ code: 'E_RELATION_AMBIGUOUS', field: 'parent', message: 'more than one snapshot note matches the parent link' });
      if (result.status === 'ready' || result.status === 'read-only-limited') result.status = 'ambiguous';
    } else if (relation.status === 'orphan') {
      result.warnings.push({ code: 'E_RELATION_ORPHAN', field: 'parent', message: 'the linked parent is missing from the snapshot' });
      if (result.status === 'ready') result.status = 'read-only-limited';
    }
  }

  const summary = {
    total: results.length,
    ready: results.filter(result => result.status === 'ready').length,
    readOnlyLimited: results.filter(result => result.status === 'read-only-limited').length,
    unsupported: results.filter(result => result.status === 'unsupported').length,
    invalid: results.filter(result => result.status === 'invalid').length,
    conflict: results.filter(result => result.status === 'conflict').length,
    ambiguous: results.filter(result => result.status === 'ambiguous').length,
  };

  return {
    algorithmVersion: ALGORITHM_VERSION,
    context: { dateFormat: context ? context.dateFormat ?? null : null },
    results,
    relationIssues: relationResult.issues,
    summary,
    writesPerformed: false,
  };
}

// A candidate may only be handed to the schedulers when it is fully mapped and
// has a persisted identity. Temporary ids stay analysis-only.
function isSchedulableCandidate(result) {
  return Boolean(
    result
    && result.status === 'ready'
    && result.topic
    && result.identity
    && result.identity.persistent === true
    && isPriority(result.topic.priority)
  );
}

module.exports = {
  DATE_FORMATS,
  SUPPORTED_STATUS_MAP,
  UNSUPPORTED_STATUSES,
  parseLegacyDate,
  legacyState,
  adaptLegacyTopic,
  adaptLegacyTopics,
  isSchedulableCandidate,
};
