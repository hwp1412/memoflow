'use strict';

// Single authoritative Unified writer for Source/Extract scheduling events
// (PR-09). It composes the accepted pure core (applyEvent), a serializable
// event ledger and a synthetic compare-and-swap storage.
//
// This is NOT enabled in the real plugin: it requires an explicitly configured
// mode:'unified' plus an unforgeable synthetic capability, and it never calls
// the legacy Toolkit write paths. Real Obsidian wiring belongs to PR-10.

const { fail, isSchedulingError } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { isValidDateString } = require('./dates.js');
const { effectiveDue } = require('./due.js');
const { applyEvent } = require('./events.js');
const { resolveSchedulerMode } = require('./mode.js');
const { sha256Hex } = require('./migration-hash.js');
const { isPersistentUuid } = require('./legacy-identity.js');
const { stableStringify } = require('./migration-hash.js');
const { renderContent, assertTrustedTopicStorage, assertSyntheticUnifiedCapability } = require('./unified-store-contract.js');
const { PersistentEventLedger } = require('./persistent-event-ledger.js');

const SUPPORTED_DATE_FORMATS = Object.freeze(['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);

const WRITE_FIELDS = Object.freeze([
  'mf_revision',
  'mf_last_event_id',
  'mf_scheduler_version',
  'mf_interval_days',
  'mf_ideal_due',
  'mf_not_before',
  'priority',
  'a_factor',
  'review_count',
  'last_reviewed',
  'status',
]);

function formatLegacyDate(iso, format) {
  const [year, month, day] = iso.split('-');
  switch (format) {
    case 'MM-DD-YYYY': return `${month}-${day}-${year}`;
    case 'YYYY-MM-DD': return `${year}-${month}-${day}`;
    case 'DD/MM/YYYY': return `${day}/${month}/${year}`;
    case 'MM/DD/YYYY': return `${month}/${day}/${year}`;
    default: return `${day}-${month}-${year}`;
  }
}

function auditSnapshot(topic) {
  return {
    priority: topic.priority,
    intervalDays: topic.mf_interval_days,
    aFactor: topic.a_factor,
    idealDue: topic.mf_ideal_due,
    notBefore: topic.mf_not_before ?? null,
    effectiveDue: effectiveDue(topic),
    reviewCount: topic.review_count,
    status: topic.status,
  };
}

function assertLedger(ledger) {
  if (!(ledger instanceof PersistentEventLedger)) {
    fail('E_LEDGER_UNTRUSTED', 'unified writer requires a PersistentEventLedger instance', {});
  }
  return ledger;
}

function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('E_OBJECT_REQUIRED', 'an explicit unified event request is required', { field: 'request' });
  }
  if (!isPersistentUuid(request.eventId)) fail('E_EVENT_ID_INVALID', 'eventId must be a UUID', { field: 'eventId' });
  if (!isPersistentUuid(request.topicId)) fail('E_TOPIC_ID_INVALID', 'topicId must be a persistent UUID', { field: 'topicId' });
  if (typeof request.type !== 'string' || !request.type) fail('E_EVENT_TYPE_INVALID', 'type is required', { field: 'type' });
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
    fail('E_REVISION_REQUIRED', 'a persisted expectedRevision is required', { field: 'expectedRevision' });
  }
  if (!isValidDateString(request.today)) fail('E_TODAY_REQUIRED', 'an explicit valid today is required', { field: 'today' });
  if (request.calendarDate == null) {
    fail('E_EVENT_DATE_REQUIRED', 'the event occurrence date must be explicit; it is never inferred from today', { field: 'calendarDate' });
  }
  if (!isValidDateString(request.calendarDate)) {
    fail('E_EVENT_DATE_INVALID', 'calendarDate must be a strict calendar date', { field: 'calendarDate' });
  }
  if (request.algorithmVersion !== ALGORITHM_VERSION) {
    fail('E_VERSION_UNSUPPORTED', 'unsupported algorithm version', { field: 'algorithmVersion' });
  }
  return request;
}

function buildTopic(entry, request) {
  const frontmatter = entry.frontmatter || {};
  // The persisted Frontmatter is the source of truth: the index may never fill
  // in a missing or contradictory identity/revision.
  if (!isPersistentUuid(frontmatter.mf_id)) {
    return { error: 'E_ID_NOT_PERSISTED' };
  }
  if (frontmatter.mf_id !== request.topicId) {
    return { error: 'E_TOPIC_ID_MISMATCH' };
  }
  if (frontmatter.mf_id !== entry.mfId) {
    return { error: 'E_INDEX_ID_MISMATCH' };
  }
  if (frontmatter.type !== 'source' && frontmatter.type !== 'extract') {
    return { error: 'E_TOPIC_TYPE' };
  }
  const allowedStatuses = request.type === 'REACTIVATE' ? ['done', 'dismissed'] : ['active'];
  if (!allowedStatuses.includes(frontmatter.status)) {
    return { error: 'E_TOPIC_NOT_ACTIVE' };
  }
  if (!Number.isInteger(frontmatter.mf_revision) || frontmatter.mf_revision < 0) {
    return { error: 'E_REVISION_NOT_PERSISTED' };
  }
  if (!Number.isInteger(entry.revision) || entry.revision !== frontmatter.mf_revision) {
    return { error: 'E_REVISION_FRONTMATTER_MISMATCH' };
  }
  if (frontmatter.mf_revision !== request.expectedRevision) {
    return { error: 'E_REVISION_MISMATCH' };
  }
  if (frontmatter.mf_scheduler_version !== ALGORITHM_VERSION) {
    return { error: 'E_VERSION_NOT_PERSISTED' };
  }
  const topic = {
    ...frontmatter,
    mf_id: frontmatter.mf_id,
    mf_revision: frontmatter.mf_revision,
    mf_scheduler_version: frontmatter.mf_scheduler_version,
  };
  return { topic };
}

function verifyPersistedState(entry, record, topicId) {
  const frontmatter = entry.frontmatter || {};
  if (frontmatter.mf_id !== topicId) return false;
  if (!Number.isInteger(frontmatter.mf_revision)) return false;
  if (frontmatter.mf_scheduler_version !== ALGORITHM_VERSION) return false;
  const noop = record.beforeHash === record.expectedAfterHash;
  const expectedRevision = noop ? record.expectedRevision : record.expectedRevision + 1;
  return frontmatter.mf_revision === expectedRevision;
}

function buildProjection(topic, dateFormat) {
  const fields = {};
  for (const key of WRITE_FIELDS) {
    if (topic[key] !== undefined) fields[key] = topic[key];
  }
  fields.next_review = formatLegacyDate(effectiveDue(topic), dateFormat);
  return fields;
}

function applyFields(frontmatter, fields) {
  const next = { ...frontmatter };
  for (const [key, value] of Object.entries(fields)) {
    next[key] = value === undefined ? null : value;
  }
  return next;
}

function changedFields(frontmatter, fields) {
  const changed = {};
  for (const [key, value] of Object.entries(fields)) {
    if (frontmatter[key] !== value) changed[key] = value;
  }
  return changed;
}

function executeUnifiedEvent(request, dependencies = {}) {
  assertRequest(request);
  const mode = resolveSchedulerMode(dependencies.mode);
  if (mode.mode !== 'unified') fail('E_MODE_NOT_UNIFIED', 'unified writer is disabled outside unified mode', { mode: mode.mode });
  assertSyntheticUnifiedCapability(dependencies.capability);
  if (dependencies.legacyWriter) {
    fail('E_DOUBLE_WRITE_FORBIDDEN', 'a legacy writer must not be attached to a unified execution');
  }
  const storage = assertTrustedTopicStorage(dependencies.storage);
  const ledger = assertLedger(dependencies.ledger);
  const dateFormat = dependencies.dateFormat || request.dateFormat || 'DD-MM-YYYY';
  if (!SUPPORTED_DATE_FORMATS.includes(dateFormat)) {
    fail('E_DATE_FORMAT_UNSUPPORTED', 'unsupported Vault date format; no silent fallback', { dateFormat });
  }
  const configDigest = sha256Hex(stableStringify(dependencies.config ?? null));
  const ledgerRequest = { ...request, dateFormat, configDigest };

  const classification = ledger.classify(ledgerRequest);
  if (classification.state === 'conflict') {
    fail('E_EVENT_ID_CONFLICT', 'the event id was already used by a different request', { eventId: request.eventId });
  }
  const knownStates = ['new', 'duplicate', 'retryable', 'prepared', 'failed', 'uncertain', 'requires-manual-recovery', 'conflict'];
  if (!knownStates.includes(classification.state)) {
    ledger.markManual(request.eventId, 'E_LEDGER_CORRUPT', classification.record.audit);
    return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_LEDGER_CORRUPT', record: ledger.get(request.eventId) };
  }
  if (classification.state === 'duplicate') {
    return {
      status: 'duplicate', duplicate: true, writesPerformed: false,
      record: classification.record, reason: null,
    };
  }

  const located = storage.findByTopicId(request.topicId);
  if (located.duplicates.length > 0) {
    return { status: 'conflict', duplicate: false, writesPerformed: false, reason: 'E_DUPLICATE_TOPIC_ID', duplicates: located.duplicates };
  }
  if (!located.entry) {
    return { status: 'conflict', duplicate: false, writesPerformed: false, reason: 'E_TOPIC_NOT_FOUND' };
  }
  const entry = located.entry;
  const currentHash = sha256Hex(entry.content);
  // A pending/uncertain event first reconciles against the current file.
  if (classification.record && classification.state !== 'new' && classification.state !== 'retryable' && classification.state !== 'duplicate') {
    if (currentHash === classification.record.expectedAfterHash) {
      if (!verifyPersistedState(entry, classification.record, request.topicId)) {
        ledger.markManual(request.eventId, 'E_RECOVERY_STATE_MISMATCH', { ...classification.record.audit, requiresManualRecovery: true });
        return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_RECOVERY_STATE_MISMATCH', record: ledger.get(request.eventId) };
      }
      ledger.markApplied(request.eventId, {
        afterHash: currentHash, actualRevision: entry.revision,
        result: 'recovered-from-intent', writesPerformed: false,
        audit: { ...classification.record.audit, result: 'recovered-from-intent' },
      });
      return { status: 'applied', duplicate: true, recovered: true, writesPerformed: false, record: ledger.get(request.eventId) };
    }
    if (currentHash !== classification.record.beforeHash) {
      ledger.markManual(request.eventId, 'E_EXTERNAL_EDIT', { ...classification.record.audit, requiresManualRecovery: true });
      return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_EXTERNAL_EDIT', record: ledger.get(request.eventId) };
    }
  }
  if (classification.state === 'retryable' && currentHash !== classification.record.beforeHash) {
    return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_EXTERNAL_EDIT' };
  }

  const built = buildTopic(entry, request);
  if (built.error) {
    const record = classification.record;
    if (record) ledger.markConflict(request.eventId, built.error, { ...record.audit, requiresManualRecovery: false });
    return { status: 'conflict', duplicate: false, writesPerformed: false, reason: built.error, record: record ? ledger.get(request.eventId) : null };
  }
  const topic = built.topic;

  const event = {
    eventId: request.eventId,
    topicId: request.topicId,
    type: request.type,
    payload: request.payload,
    expectedRevision: request.expectedRevision,
    algorithmVersion: request.algorithmVersion,
    calendarDate: request.calendarDate,
  };

  let applied;
  try {
    applied = applyEvent(topic, event, dependencies.config, request.today);
  } catch (error) {
    const code = isSchedulingError(error) ? error.code : 'E_EVENT_FAILED';
    if (classification.record) ledger.markFailed(request.eventId, code, classification.record.audit);
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: code, record: classification.record ? ledger.get(request.eventId) : null };
  }

  if (!applied.needsWrite || applied.topic === topic) {
    const record = ledger.prepare(ledgerRequest, {
      beforeHash: currentHash, expectedAfterHash: currentHash,
      fields: {}, before: auditSnapshot(topic), after: auditSnapshot(topic),
    });
    ledger.markApplied(request.eventId, {
      afterHash: currentHash, actualRevision: entry.revision,
      result: applied.reason || 'no-op', writesPerformed: false,
      audit: { ...record.audit, result: applied.reason || 'no-op', writesPerformed: false },
    });
    return { status: 'no-op', duplicate: false, writesPerformed: false, reason: applied.reason || 'NO_STATE_CHANGE', record: ledger.get(request.eventId) };
  }

  const next = applied.topic;
  if (next.mf_revision !== request.expectedRevision + 1 || next.mf_last_event_id !== request.eventId) {
    ledger.markFailed(request.eventId, 'E_EVENT_INVARIANT', { requiresManualRecovery: false });
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: 'E_EVENT_INVARIANT', record: ledger.get(request.eventId) };
  }

  const fields = buildProjection(next, dateFormat);
  const changed = changedFields(entry.frontmatter, fields);
  const nextFrontmatter = applyFields(entry.frontmatter, changed);
  const expectedAfterHash = sha256Hex(renderContent(nextFrontmatter, entry.body));
  const auditBefore = auditSnapshot(topic);
  const auditAfter = auditSnapshot(next);

  const record = ledger.prepare(ledgerRequest, {
    beforeHash: currentHash,
    expectedAfterHash,
    fields: changed,
    before: auditBefore,
    after: auditAfter,
  });

  const cas = storage.compareAndSwap(entry.path, {
    expectedHash: currentHash,
    expectedRevision: entry.revision,
    nextFrontmatter,
    nextBody: entry.body,
    nextRevision: request.expectedRevision + 1,
  });
  if (!cas.ok) {
    if (cas.code === 'E_SNAPSHOT_MISMATCH' || cas.code === 'E_REVISION_MISMATCH') {
      ledger.markConflict(request.eventId, cas.code, record.audit);
      return { status: 'conflict', duplicate: false, writesPerformed: false, reason: cas.code, record: ledger.get(request.eventId) };
    }
    ledger.markFailed(request.eventId, cas.code, record.audit);
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: cas.code, record: ledger.get(request.eventId) };
  }

  let readback;
  try {
    readback = storage.read(entry.path);
  } catch (error) {
    ledger.markUncertain(request.eventId, 'E_WRITE_UNVERIFIED', record.audit);
    return { status: 'uncertain', duplicate: false, writesPerformed: false, reason: 'E_WRITE_UNVERIFIED', record: ledger.get(request.eventId) };
  }
  if (!readback || sha256Hex(readback.content) !== expectedAfterHash || readback.revision !== request.expectedRevision + 1) {
    ledger.markUncertain(request.eventId, 'E_WRITE_UNVERIFIED', record.audit);
    return { status: 'uncertain', duplicate: false, writesPerformed: false, reason: 'E_WRITE_UNVERIFIED', record: ledger.get(request.eventId) };
  }

  const finalRecord = ledger.markApplied(request.eventId, {
    afterHash: expectedAfterHash,
    actualRevision: readback.revision,
    result: 'applied',
    writesPerformed: true,
    audit: { ...record.audit, after: auditAfter, actualRevision: readback.revision, writesPerformed: true },
  });
  if (typeof dependencies.auditSink === 'function') dependencies.auditSink(finalRecord.audit);
  return { status: 'applied', duplicate: false, recovered: false, writesPerformed: true, record: finalRecord, audit: finalRecord.audit };
}

function reconcileUnifiedEvent(eventId, dependencies = {}) {
  const ledger = assertLedger(dependencies.ledger);
  const record = ledger.get(eventId);
  if (!record) fail('E_EVENT_NOT_FOUND', 'the ledger has no such event', { eventId });
  // A historical success stays successful even if later events changed the file.
  if (record.status === 'applied') {
    return { status: 'applied', recovered: true, writesPerformed: false, record };
  }
  const storage = assertTrustedTopicStorage(dependencies.storage);
  const located = storage.findByTopicId(record.topicId);
  if (!located.entry) {
    ledger.markManual(eventId, 'E_TOPIC_NOT_FOUND', record.audit);
    return { status: 'requires-manual-recovery', reason: 'E_TOPIC_NOT_FOUND', writesPerformed: false, record: ledger.get(eventId) };
  }
  const hash = sha256Hex(located.entry.content);
  if (record.expectedAfterHash && hash === record.expectedAfterHash) {
    if (!verifyPersistedState(located.entry, record, record.topicId)) {
      ledger.markManual(eventId, 'E_RECOVERY_STATE_MISMATCH', { ...record.audit, requiresManualRecovery: true });
      return { status: 'requires-manual-recovery', reason: 'E_RECOVERY_STATE_MISMATCH', writesPerformed: false, record: ledger.get(eventId) };
    }
    ledger.markApplied(eventId, {
      afterHash: hash, actualRevision: located.entry.revision,
      result: 'reconciled', writesPerformed: false,
      audit: { ...record.audit, result: 'reconciled', writesPerformed: false },
    });
    return { status: 'applied', recovered: true, writesPerformed: false, record: ledger.get(eventId) };
  }
  if (hash === record.beforeHash) {
    return { status: 'retryable', writesPerformed: false, record };
  }
  ledger.markManual(eventId, 'E_EXTERNAL_EDIT', { ...record.audit, requiresManualRecovery: true });
  return { status: 'requires-manual-recovery', reason: 'E_EXTERNAL_EDIT', writesPerformed: false, record: ledger.get(eventId) };
}

function getUnifiedEventResult(eventId, ledger) {
  assertLedger(ledger);
  return ledger.get(eventId);
}

module.exports = {
  WRITE_FIELDS,
  SUPPORTED_DATE_FORMATS,
  formatLegacyDate,
  // Shared pieces for the async host transport (HOST-RUNTIME-01). Exported so
  // the async executor reuses the same validation, identity and projection
  // logic instead of growing a second event state machine.
  assertRequest,
  buildTopic,
  buildProjection,
  applyFields,
  changedFields,
  verifyPersistedState,
  auditSnapshot,
  executeUnifiedEvent,
  reconcileUnifiedEvent,
  getUnifiedEventResult,
};
