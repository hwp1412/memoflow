'use strict';

// Unified reading-action mapping and event coordination (PR-10).
//
// Every UI/channel action is translated once into an accepted event type. The
// coordinator deduplicates by eventId so a UI retry cannot create a second
// effective review. Non-scheduling actions (opening a PDF, scrolling, creating
// an extract) never become ADVANCED.

const { fail } = require('./errors.js');
const { isPersistentUuid } = require('./legacy-identity.js');

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

function createActionToken({ actionId, eventId, topicId, expectedRevision, today, calendarDate, action }) {
  if (!isPersistentUuid(eventId)) fail('E_EVENT_ID_INVALID', 'an explicit persistent eventId is required (reuse it on retry)', { field: 'eventId' });
  if (!isPersistentUuid(topicId)) fail('E_TOPIC_ID_INVALID', 'topicId must be a persistent UUID', { field: 'topicId' });
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('E_REVISION_REQUIRED', 'expectedRevision is required');
  return { actionId: actionId ?? eventId, eventId, topicId, expectedRevision, today, calendarDate, action };
}

class ReadingEventCoordinator {
  constructor(dispatch) {
    if (typeof dispatch !== 'function') fail('E_DISPATCH_REQUIRED', 'a dispatch function is required');
    this.dispatch = dispatch;
    this.results = new Map();
  }

  execute(token) {
    if (token && this.results.has(token.eventId)) {
      return { ...this.results.get(token.eventId), duplicate: true };
    }
    const action = typeof token.action === 'string'
      ? { ...token, action: token.action }
      : token.action;
    const mapped = mapReadingAction(action);
    if (!mapped.scheduling) return { status: 'ignored', writesPerformed: false, ...mapped };
    const result = this.dispatch({ ...token, type: mapped.type, payload: mapped.payload });
    if (token && token.eventId) this.results.set(token.eventId, result);
    return result;
  }
}

module.exports = { ACTION_MAP, NON_SCHEDULING_ACTIONS, mapReadingAction, createActionToken, ReadingEventCoordinator };
