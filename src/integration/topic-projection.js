'use strict';

// Canonical Topic projection (HOST-CLOSURE P0).
//
// The queue, dashboard and session must not read scheduling fields ad hoc.
// This module is the single read-side projection:
//   * Unified authority: mf_* fields, identity + revision + version verified;
//   * Legacy authority: legacy fields mapped read-only (never written back);
//   * cards are never queue-eligible and never writable through MF-US-1.
//
// It performs no I/O and no writes.

const { isPersistentUuid } = require('../scheduling/legacy-identity.js');
const { isValidDateString } = require('../scheduling/dates.js');

const AUTHORITY = Object.freeze({ unified: 'unified', legacy: 'legacy' });
const READABLE_TYPES = Object.freeze(['source', 'extract']);
const LEGACY_ONLY_STATUSES = Object.freeze(['inbox', 'pending', 'container']);

function toInt(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function legacyDate(value) {
  const text = asString(value);
  return text && isValidDateString(text) ? text : null;
}

function projectTopic(row, { mode = 'legacy', tempId = null } = {}) {
  const file = row && (row.tfile || row.file);
  const fm = row && row.fm;
  if (!file || !fm || typeof fm !== 'object') {
    return { ok: false, blockers: ['E_TOPIC_MISSING'], authority: mode === 'unified' ? AUTHORITY.unified : AUTHORITY.legacy, queueEligible: false };
  }
  const type = fm.type;
  const status = asString(fm.status) || 'unknown';
  const base = {
    path: file.path,
    basename: file.basename,
    type,
    status,
    priority: toInt(fm.priority),
    reviewCount: toInt(fm.review_count),
    aFactor: Number.isFinite(Number(fm.a_factor)) ? Number(fm.a_factor) : null,
    dateAdded: legacyDate(fm.date_added),
    blockers: [],
  };

  if (!READABLE_TYPES.includes(type)) {
    return {
      ...base,
      ok: false,
      authority: AUTHORITY.legacy,
      queueEligible: false,
      writable: false,
      blockers: type === 'card' ? ['CARD'] : ['E_TOPIC_TYPE'],
    };
  }

  if (mode === 'unified') {
    const blockers = [];
    const topicId = isPersistentUuid(fm.mf_id) ? fm.mf_id : null;
    if (!topicId) blockers.push('ID_NOT_PERSISTED');
    const revision = toInt(fm.mf_revision);
    if (revision == null || revision < 0) blockers.push('REVISION_NOT_PERSISTED');
    if (toInt(fm.mf_scheduler_version) !== 1) blockers.push('VERSION_NOT_PERSISTED');
    const idealDue = asString(fm.mf_ideal_due);
    if (!idealDue || !isValidDateString(idealDue)) blockers.push('IDEAL_DUE_INVALID');
    const notBeforeRaw = fm.mf_not_before;
    const notBefore = notBeforeRaw == null || notBeforeRaw === 'null' ? null : asString(notBeforeRaw);
    if (notBefore != null && !isValidDateString(notBefore)) blockers.push('NOT_BEFORE_INVALID');
    const intervalDays = toInt(fm.mf_interval_days);
    if (intervalDays == null || intervalDays < 1) blockers.push('INTERVAL_NOT_PERSISTED');
    const knownStatus = status === 'active' || status === 'done' || status === 'dismissed';
    if (!knownStatus) blockers.push('STATUS_UNSUPPORTED');
    const queueEligible = blockers.length === 0 && status === 'active';
    return {
      ...base,
      ok: blockers.length === 0,
      authority: AUTHORITY.unified,
      topicId,
      tempId: null,
      revision,
      schedulerVersion: toInt(fm.mf_scheduler_version),
      idealDue,
      notBefore,
      intervalDays,
      effectiveDue: notBefore && idealDue && notBefore > idealDue ? notBefore : idealDue,
      writable: blockers.length === 0,
      queueEligible,
      blockers,
    };
  }

  // Legacy authority: read-only mapping. Never write these back to mf_*.
  const blockers = [];
  const legacyDue = legacyDate(fm.next_review);
  const interval = toInt(fm.interval);
  if (LEGACY_ONLY_STATUSES.includes(status)) blockers.push('STATUS_NEEDS_MIGRATION');
  if (status !== 'active') blockers.push('STATUS_NOT_ACTIVE');
  return {
    ...base,
    ok: true,
    authority: AUTHORITY.legacy,
    topicId: null,
    tempId: tempId || null,
    revision: null,
    schedulerVersion: null,
    idealDue: legacyDue,
    notBefore: null,
    intervalDays: interval,
    effectiveDue: legacyDue,
    writable: false,
    queueEligible: blockers.length === 0,
    blockers,
  };
}

function projectTopics(rows, options = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => projectTopic(row, options));
}

// Shape accepted by src/scheduling/queue.js selectDailyQueue. Unified
// projections only; a legacy projection is only valid where the caller
// explicitly allows legacy input (migration preview / legacy mode).
function toQueueTopic(projection) {
  if (!projection) return null;
  const id = projection.topicId || projection.tempId;
  const topic = {
    type: projection.type,
    status: projection.status,
    priority: projection.priority,
    a_factor: projection.aFactor,
    review_count: projection.reviewCount,
  };
  if (projection.topicId) topic.mf_id = projection.topicId;
  if (id) topic.stableId = id;
  if (projection.idealDue) topic.mf_ideal_due = projection.idealDue;
  if (projection.notBefore) topic.mf_not_before = projection.notBefore;
  if (projection.revision != null) topic.mf_revision = projection.revision;
  if (projection.schedulerVersion != null) topic.mf_scheduler_version = projection.schedulerVersion;
  if (projection.intervalDays != null) topic.mf_interval_days = projection.intervalDays;
  if (projection.dateAdded) topic.date_added = projection.dateAdded;
  return topic;
}

module.exports = {
  AUTHORITY,
  READABLE_TYPES,
  LEGACY_ONLY_STATUSES,
  projectTopic,
  projectTopics,
  toQueueTopic,
};
