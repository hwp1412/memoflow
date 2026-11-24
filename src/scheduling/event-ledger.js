'use strict';

// In-memory event ledger and idempotency coordination for MF-US-1 (SPEC A8,
// A13 T13, A13.1 "idempotent across retries").
//
// This module is deliberately storage-free: it coordinates a plain ledger value
// with applyEvent() and returns a NEW ledger. Nothing is written to disk, to
// frontmatter, or to plugin data.json. Durable persistence is a later,
// separately authorised integration step (Q14).
//
// Ordering is a hard requirement: a duplicate event is recognised BEFORE the
// expectedRevision check, otherwise a successful retry of an older event would
// be misreported as a revision conflict.
//
// A ledger entry records BOTH applied and no-op outcomes, so replaying a no-op
// returns the original no-op result instead of re-evaluating it against a topic
// that other events have since changed. Failures (invalid event, revision
// conflict, illegal transition) are never recorded.

const { fail } = require('./errors.js');
const { assertPlainObject, validateUuid } = require('./schema.js');
const { applyEvent, EVENT_TYPES } = require('./events.js');

const LEDGER_VERSION = 1;

function createEventLedger() {
  return Object.freeze({ version: LEDGER_VERSION, entries: Object.freeze({}) });
}

function assertLedger(ledger, field = 'ledger') {
  assertPlainObject(ledger, field);
  if (ledger.version !== LEDGER_VERSION) {
    fail('E_LEDGER_INVALID', `ledger.version must be ${LEDGER_VERSION}`, { field: `${field}.version`, value: ledger.version });
  }
  assertPlainObject(ledger.entries, `${field}.entries`);
  return ledger;
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// Identity of an event's content. A retry with the same id must carry the same
// content; anything else is an id collision, not a retry.
function eventFingerprint(event) {
  return stableStringify({
    eventId: event.eventId,
    topicId: event.topicId ?? null,
    type: event.type ?? null,
    expectedRevision: event.expectedRevision ?? null,
    algorithmVersion: event.algorithmVersion ?? null,
    calendarDate: event.calendarDate ?? null,
    payload: event.payload ?? null,
  });
}

function lookupEvent(ledger, eventId) {
  assertLedger(ledger);
  validateUuid(eventId, 'eventId');
  return Object.prototype.hasOwnProperty.call(ledger.entries, eventId) ? ledger.entries[eventId] : null;
}

function duplicateResult(topic, event, entry) {
  return {
    topic: { ...topic },
    applied: false,
    needsWrite: false,
    reviewApplied: false,
    duplicate: true,
    reason: 'DUPLICATE',
    diff: { fields: {} },
    explain: {
      text: `重复事件（${event.type}）：eventId ${event.eventId} 已处理过，返回幂等结果；未再次修改 Topic，未重复计入评阅。`,
      data: {
        type: event.type,
        eventId: event.eventId,
        duplicate: true,
        applied: false,
        originalStatus: entry.status,
        originalRevisionAfter: entry.revisionAfterProcessing,
        recordedOn: entry.recordedOn,
      },
    },
    algorithmVersion: entry.algorithmVersion,
    event: {
      eventId: event.eventId,
      topicId: event.topicId ?? null,
      type: event.type,
      expectedRevision: event.expectedRevision,
    },
  };
}

// Pure coordination: same arguments always produce the same ledger + result.
function applyEventWithLedger(ledger, topic, event, config = undefined, today = undefined) {
  assertLedger(ledger);
  assertPlainObject(event, 'event');
  if (event.eventId == null) {
    fail('E_ID_REQUIRED', 'event.eventId is required', { field: 'eventId' });
  }
  validateUuid(event.eventId, 'eventId');
  if (typeof event.type !== 'string' || !EVENT_TYPES.includes(event.type)) {
    fail('E_EVENT_TYPE', `event.type must be one of ${EVENT_TYPES.join(', ')}`, { field: 'type', value: event.type });
  }

  const fingerprint = eventFingerprint(event);
  const existing = Object.prototype.hasOwnProperty.call(ledger.entries, event.eventId)
    ? ledger.entries[event.eventId]
    : null;

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      fail('E_EVENT_ID_CONFLICT', `eventId ${event.eventId} was already used by a different event payload`, {
        eventId: event.eventId,
        storedType: existing.type,
        incomingType: event.type,
        storedFingerprint: existing.fingerprint,
        incomingFingerprint: fingerprint,
      });
    }
    // Duplicate is decided before any revision check (see module comment).
    return {
      ledger,
      topic: { ...topic },
      duplicate: true,
      result: duplicateResult(topic, event, existing),
    };
  }

  const result = applyEvent(topic, event, config, today);

  const entry = Object.freeze({
    eventId: event.eventId,
    topicId: topic.mf_id,
    type: event.type,
    fingerprint,
    status: result.applied ? 'applied' : 'noop',
    reviewApplied: result.reviewApplied,
    revisionAfterProcessing: result.topic.mf_revision,
    recordedOn: today ?? null,
    algorithmVersion: result.algorithmVersion,
  });
  const nextLedger = Object.freeze({
    version: LEDGER_VERSION,
    entries: Object.freeze({ ...ledger.entries, [event.eventId]: entry }),
  });

  return { ledger: nextLedger, topic: result.topic, duplicate: false, result };
}

module.exports = {
  LEDGER_VERSION,
  createEventLedger,
  assertLedger,
  eventFingerprint,
  lookupEvent,
  applyEventWithLedger,
};
