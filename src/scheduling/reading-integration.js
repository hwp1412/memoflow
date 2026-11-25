'use strict';

// Unified reading-action mapping and event coordination (PR-10).
//
// Every UI/channel action is translated once into an accepted event type. The
// coordinator deduplicates by eventId only when the request is semantically
// identical, reusing the PR-09 fingerprint. A different request with the same
// eventId is a conflict. Failed/uncertain/pending results are never cached as
// successful, so a retry can proceed to the persistent ledger.

const { fail } = require('./errors.js');
const { isPersistentUuid } = require('./legacy-identity.js');
const { requestFingerprint } = require('./persistent-event-ledger.js');

const ACTION_MAP = Object.freeze({
  'grade.advanced': { type: 'ADVANCED' },
  'grade.hold': { type: 'HOLD' },
  'grade.soon': { type: 'SOON' },
  'skip': { type: 'SKIP' },
  'postpone': { type: 'POSTPONE', payload: action => ({ days: action.days }) },
  'set-priority': { type: 'SET_PRIORITY', payload: action => ({ priority: action.priority }) },
  'manual-schedule': { type: 'MANUAL_SCHEDULE', payload: action => ({ idealDue: action.idealDue, reason: action.reason }) },
  'complete': { type: 'COMPLETE' },
  'dismiss': { type: 'DISMISS' },
  'reactivate': { type: 'REACTIVATE', payload: action => ({ idealDue: action.idealDue }) },
});

const NON_SCHEDULING_ACTIONS = Object.freeze([
  'source.open',
  'pdf.scroll',
  'pdf.locate',
  'extract.create',
  'extract.refine',
]);

const TERMINAL_SUCCESS = new Set(['applied', 'duplicate', 'no-op']);

function mapReadingAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    fail('E_ACTION_REQUIRED', 'a reading action object is required');
  }
  if (NON_SCHEDULING_ACTIONS.includes(action.action)) {
    return { scheduling: false, ignored: true, reason: 'NON_SCHEDULING_ACTION' };
  }
  const mapping = ACTION_MAP[action.action];
  if (!mapping) fail('E_ACTION_UNKNOWN', `unknown reading action "${action.action}"`, { action: action.action });
  const payload = mapping.payload ? mapping.payload(action) : undefined;
  return { scheduling: true, ignored: false, type: mapping.type, payload };
}

function createActionToken({
  actionId, eventId, topicId, expectedRevision, today, calendarDate, action,
  algorithmVersion, dateFormat, configDigest, days, priority, idealDue, reason,
}) {
  if (!isPersistentUuid(eventId)) fail('E_EVENT_ID_INVALID', 'an explicit persistent eventId is required (reuse it on retry)', { field: 'eventId' });
  if (!isPersistentUuid(topicId)) fail('E_TOPIC_ID_INVALID', 'topicId must be a persistent UUID', { field: 'topicId' });
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('E_REVISION_REQUIRED', 'expectedRevision is required');
  return {
    actionId: actionId ?? eventId,
    eventId,
    topicId,
    expectedRevision,
    today,
    calendarDate,
    action,
    algorithmVersion: algorithmVersion ?? 1,
    dateFormat,
    configDigest,
    days,
    priority,
    idealDue,
    reason,
  };
}

function isThenable(value) {
  return Boolean(value && typeof value.then === 'function');
}

function normalizeRequest(token, mapped) {
  return {
    eventId: token.eventId,
    topicId: token.topicId,
    type: mapped.type,
    payload: mapped.payload ?? null,
    expectedRevision: token.expectedRevision,
    algorithmVersion: token.algorithmVersion ?? 1,
    today: token.today ?? null,
    calendarDate: token.calendarDate ?? null,
    dateFormat: token.dateFormat ?? null,
    configDigest: token.configDigest ?? null,
  };
}

class ReadingEventCoordinator {
  constructor(dispatch) {
    if (typeof dispatch !== 'function') fail('E_DISPATCH_REQUIRED', 'a dispatch function is required');
    this.dispatch = dispatch;
    this.cache = new Map();
    this.inflight = new Map();
  }

  execute(token) {
    if (!token || typeof token !== 'object') fail('E_ACTION_REQUIRED', 'an action token is required');
    const action = typeof token.action === 'string' ? { ...token, action: token.action } : token.action;
    const mapped = mapReadingAction(action);
    if (!mapped.scheduling) return { status: 'ignored', writesPerformed: false, ...mapped };
    const fingerprint = requestFingerprint(normalizeRequest(token, mapped));

    const cached = this.cache.get(token.eventId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) this.conflict(token.eventId);
      return { ...cached.result, duplicate: true };
    }
    const inflight = this.inflight.get(token.eventId);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) this.conflict(token.eventId);
      return inflight.promise.then(result => ({ ...result, duplicate: true, inflight: true }));
    }

    const result = this.dispatch({ ...token, type: mapped.type, payload: mapped.payload });
    if (isThenable(result)) {
      const promise = Promise.resolve(result).then(async resolved => {
        const value = await resolved;
        this.inflight.delete(token.eventId);
        if (value && TERMINAL_SUCCESS.has(value.status)) this.cache.set(token.eventId, { fingerprint, result: value });
        return value;
      }, error => {
        this.inflight.delete(token.eventId);
        throw error;
      });
      this.inflight.set(token.eventId, { fingerprint, promise });
      return promise;
    }
    if (result && TERMINAL_SUCCESS.has(result.status)) {
      this.cache.set(token.eventId, { fingerprint, result });
    }
    return result;
  }

  conflict(eventId) {
    fail('E_EVENT_ID_CONFLICT', 'the event id was already used by a different reading request', { eventId });
  }
}

module.exports = { ACTION_MAP, NON_SCHEDULING_ACTIONS, mapReadingAction, createActionToken, ReadingEventCoordinator };
