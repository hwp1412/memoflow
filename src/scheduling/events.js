'use strict';

// MF-US-1 event state machine (SPEC A4, A5, A8, A9, A12, A13).
//
// applyEvent(topic, event, config, today) is pure: it validates, transitions and
// returns a new topic with diff/explanation. It never writes, never reads a
// clock and never touches an event ledger — idempotency lives in
// event-ledger.js so the maths core stays free of storage concerns.
//
// Owner rulings enforced here:
//   * Q13: no event changes the A-Factor;
//   * Q6: SKIP changes nothing (no revision, no last_event_id);
//   * Q7: COMPLETE/DISMISS keep interval, ideal due, not-before, A-Factor and
//     review history;
//   * Q5: REACTIVATE requires an explicit restore date;
//   * revision: +1 only when the authoritative state really changed.

const { fail } = require('./errors.js');
const { SPEC_CONFIG, ALGORITHM_VERSION } = require('./constants.js');
const {
  assertPlainObject,
  assertConfig,
  validateUuid,
  validateRevision,
  validateTopic,
  validatePriority,
} = require('./schema.js');
const { assertDateString, addCalendarDays, compareDate, maxDate } = require('./dates.js');
const { computeNextIntervalDays, formatNumber } = require('./interval.js');

const EVENT_TYPES = Object.freeze([
  'ADVANCED',
  'HOLD',
  'SOON',
  'SKIP',
  'POSTPONE',
  'MANUAL_SCHEDULE',
  'SET_PRIORITY',
  'COMPLETE',
  'DISMISS',
  'REACTIVATE',
]);

const REVIEW_EVENTS = Object.freeze(['ADVANCED', 'HOLD', 'SOON']);

// SPEC A8: inbox/pending/container are legacy states whose meaning must come
// from a compatibility adapter. The core refuses to guess and reports them
// distinctly from "this event is not allowed from this status".
const LEGACY_STATUSES = Object.freeze(['inbox', 'pending', 'container']);

const ALLOWED_SOURCE_STATUS = Object.freeze({
  ADVANCED: ['active'],
  HOLD: ['active'],
  SOON: ['active'],
  SKIP: ['active'],
  POSTPONE: ['active'],
  MANUAL_SCHEDULE: ['active'],
  SET_PRIORITY: ['active'],
  COMPLETE: ['active'],
  DISMISS: ['active'],
  REACTIVATE: ['done', 'dismissed'],
});

const AUTHORITATIVE_FIELDS = Object.freeze([
  'type',
  'priority',
  'status',
  'mf_id',
  'mf_parent_id',
  'mf_root_id',
  'mf_ideal_due',
  'mf_not_before',
  'mf_interval_days',
  'mf_last_event_id',
  'mf_revision',
  'mf_scheduler_version',
  'a_factor',
  'review_count',
  'last_reviewed',
]);

const MANUAL_REASON_MAX = 500;

// Allowed payload keys per event type (owner review fix 3). Anything else is
// rejected instead of being silently folded into a fingerprint.
const PAYLOAD_SCHEMA = Object.freeze({
  ADVANCED: Object.freeze([]),
  HOLD: Object.freeze([]),
  SOON: Object.freeze([]),
  SKIP: Object.freeze([]),
  POSTPONE: Object.freeze(['days']),
  MANUAL_SCHEDULE: Object.freeze(['idealDue', 'reason']),
  SET_PRIORITY: Object.freeze(['priority']),
  COMPLETE: Object.freeze([]),
  DISMISS: Object.freeze([]),
  REACTIVATE: Object.freeze(['idealDue']),
});

// SPEC A8: an event carries createdAt or a local calendar date. We accept both
// but never convert time zones: a numeric offset means the literal date part is
// the local date, and a "Z" timestamp cannot define a local date on its own.
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseCreatedAt(value) {
  if (typeof value !== 'string') {
    fail('E_EVENT_TIME_INVALID', 'event.createdAt must be an ISO-8601 string with an explicit offset', {
      field: 'createdAt',
      value,
    });
  }
  const match = TIMESTAMP_RE.exec(value);
  if (!match) {
    fail('E_EVENT_TIME_INVALID', 'event.createdAt must look like 2026-11-24T09:30:00+08:00 or ...Z', {
      field: 'createdAt',
      value,
    });
  }
  const [, year, month, day, hours, minutes, seconds, offset] = match;
  const datePart = `${year}-${month}-${day}`;
  assertDateString(datePart, 'createdAt');
  const hh = Number(hours);
  const mm = Number(minutes);
  const ss = seconds == null ? 0 : Number(seconds);
  if (hh > 23 || mm > 59 || ss > 59) {
    fail('E_EVENT_TIME_INVALID', 'event.createdAt has an out-of-range clock time', { field: 'createdAt', value });
  }
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) {
      fail('E_EVENT_TIME_INVALID', 'event.createdAt has an out-of-range UTC offset', { field: 'createdAt', value });
    }
  }
  return { date: datePart, offset };
}

// The three dates are distinct (SPEC A8, owner review):
//   createdAt     when the user acted; may be UTC or offset-bearing
//   calendarDate  the event's local calendar day, when the caller knows it
//   today         the explicit day this event is being APPLIED on
//
// An event may be applied on a later day than it happened. Only structural
// validity is enforced here; no comparison with `today` is made, so a queued
// event stays processable and its eventId does not need to be regenerated.
// When calendarDate and a numeric-offset createdAt disagree the event is
// self-contradictory and is rejected; a UTC createdAt carries no local day and
// is therefore not comparable.
function validateEventTime(event) {
  const hasCalendarDate = event.calendarDate != null;
  const hasCreatedAt = event.createdAt != null;
  if (!hasCalendarDate && !hasCreatedAt) {
    fail('E_EVENT_TIME_REQUIRED', 'event must carry calendarDate or createdAt (SPEC A8)', { field: 'calendarDate' });
  }

  let calendarDate = null;
  if (hasCalendarDate) {
    calendarDate = assertDateString(event.calendarDate, 'calendarDate');
  }

  let createdAt = null;
  if (hasCreatedAt) {
    createdAt = parseCreatedAt(event.createdAt);
    if (hasCalendarDate && createdAt.offset !== 'Z' && createdAt.date !== calendarDate) {
      fail('E_EVENT_DATE_MISMATCH', 'event.createdAt and event.calendarDate describe different local days', {
        field: 'createdAt',
        value: event.createdAt,
        calendarDate,
      });
    }
  }

  return { calendarDate, createdAt };
}

// Best-effort local day of the event, without ever converting time zones.
// Returns null when only a UTC timestamp is available: the local day is then
// genuinely unknown and must not be guessed.
function resolveEventDate(event) {
  const info = validateEventTime(event);
  if (info.calendarDate != null) return { date: info.calendarDate, source: 'calendarDate' };
  if (info.createdAt != null && info.createdAt.offset !== 'Z') {
    return { date: info.createdAt.date, source: 'createdAt-offset' };
  }
  return { date: null, source: info.createdAt != null ? 'utc-timestamp' : null };
}

function validatePayloadSchema(type, payload) {
  const allowed = PAYLOAD_SCHEMA[type] || [];
  if (payload == null) {
    if (allowed.length > 0) {
      fail('E_EVENT_PAYLOAD_INVALID', `payload for ${type} is required and must contain ${allowed.join(', ')}`, {
        type,
        payload,
        allowed,
      });
    }
    return;
  }
  assertPlainObject(payload, 'payload');
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      fail('E_EVENT_PAYLOAD_INVALID', `payload.${key} is not allowed for ${type}`, { type, key, allowed });
    }
  }
}

function isReviewEvent(type) {
  return REVIEW_EVENTS.includes(type);
}

function validateEvent(event, topic, today, field = 'event') {
  assertPlainObject(event, field);
  if (event.eventId == null) {
    fail('E_ID_REQUIRED', 'event.eventId is required', { field: 'eventId' });
  }
  validateUuid(event.eventId, 'eventId');
  if (typeof event.type !== 'string' || !EVENT_TYPES.includes(event.type)) {
    fail('E_EVENT_TYPE', `event.type must be one of ${EVENT_TYPES.join(', ')}`, { field: 'type', value: event.type });
  }
  if (event.topicId !== topic.mf_id) {
    fail('E_TOPIC_ID_MISMATCH', 'event.topicId does not match topic.mf_id', {
      field: 'topicId',
      value: event.topicId,
      expected: topic.mf_id,
    });
  }
  if (event.algorithmVersion !== ALGORITHM_VERSION) {
    fail('E_ALGORITHM_VERSION', `event.algorithmVersion must be ${ALGORITHM_VERSION}`, {
      field: 'algorithmVersion',
      value: event.algorithmVersion,
    });
  }
  validateRevision(event.expectedRevision, 'expectedRevision');
  validateEventTime(event);
  validatePayloadSchema(event.type, event.payload);
  return event;
}

function readPostponeDays(payload) {
  assertPlainObject(payload, 'payload');
  const days = payload.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650) {
    fail('E_POSTPONE_DAYS_INVALID', 'POSTPONE payload.days must be an integer within 1..3650', {
      field: 'payload.days',
      value: days,
    });
  }
  return days;
}

function readManualReason(payload) {
  const reason = payload.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    fail('E_MANUAL_REASON_REQUIRED', 'MANUAL_SCHEDULE payload.reason must be a non-empty string', {
      field: 'payload.reason',
      value: reason,
    });
  }
  if (reason.length > MANUAL_REASON_MAX) {
    fail('E_MANUAL_REASON_REQUIRED', `MANUAL_SCHEDULE payload.reason must be at most ${MANUAL_REASON_MAX} characters`, {
      field: 'payload.reason',
      length: reason.length,
    });
  }
  return reason;
}

function readPayloadDate(payload, field, code) {
  const value = payload[field];
  if (value == null) {
    fail(code, `payload.${field} is required`, { field: `payload.${field}` });
  }
  return assertDateString(value, `payload.${field}`);
}

function noop(reason, text) {
  return { changes: {}, reviewApplied: false, applied: false, reason, text };
}

function formatDateChange(before, after) {
  return `${before == null ? '无' : before} → ${after == null ? '无' : after}`;
}

function transitionAdvanced(topic, event, cfg, today) {
  const nextInterval = computeNextIntervalDays(
    { mf_interval_days: topic.mf_interval_days, a_factor: topic.a_factor },
    cfg
  );
  const nextIdeal = addCalendarDays(today, nextInterval);
  return {
    changes: {
      mf_interval_days: nextInterval,
      mf_ideal_due: nextIdeal,
      mf_not_before: null,
      review_count: topic.review_count + 1,
      last_reviewed: today,
    },
    reviewApplied: true,
    applied: true,
    reason: null,
    text: `有效推进（ADVANCED）：间隔 ${topic.mf_interval_days} → ${nextInterval} 天（A-Factor ${formatNumber(topic.a_factor)}，按 half-up 取整）；理想到期 ${nextIdeal}，已清除行政延期。`,
  };
}

function transitionHold(topic, event, cfg, today) {
  const nextIdeal = addCalendarDays(today, topic.mf_interval_days);
  return {
    changes: {
      mf_ideal_due: nextIdeal,
      mf_not_before: null,
      review_count: topic.review_count + 1,
      last_reviewed: today,
    },
    reviewApplied: true,
    applied: true,
    reason: null,
    text: `保持间隔（HOLD）：间隔 ${topic.mf_interval_days} 天不变；理想到期 ${nextIdeal}，已清除行政延期。`,
  };
}

function transitionSoon(topic, event, cfg, today) {
  const nextInterval = Math.min(topic.mf_interval_days, 2);
  const nextIdeal = addCalendarDays(today, nextInterval);
  return {
    changes: {
      mf_interval_days: nextInterval,
      mf_ideal_due: nextIdeal,
      mf_not_before: null,
      review_count: topic.review_count + 1,
      last_reviewed: today,
    },
    reviewApplied: true,
    applied: true,
    reason: null,
    text: `近期再读（SOON）：间隔 ${topic.mf_interval_days} → ${nextInterval} 天；理想到期 ${nextIdeal}，已清除行政延期。`,
  };
}

function transitionSkip() {
  return noop(
    'SESSION_ONLY',
    '跳过（SKIP）：仅移动会话指针，未改变任何调度字段、评阅次数、版本或最后事件。'
  );
}

function transitionPostpone(topic, event, cfg, today) {
  const days = readPostponeDays(event.payload);
  const target = addCalendarDays(today, days);
  const ideal = topic.mf_ideal_due;
  const current = topic.mf_not_before;
  const floor = maxDate(ideal, target); // SPEC A5.2: max(not_before?, ideal, today+N)
  const candidate = current == null ? floor : maxDate(current, floor);

  if (current != null && candidate === current) {
    return noop(
      'NO_LATER_THAN_EXISTING',
      `未进一步推迟：现有最早可展示日 ${current} 已不早于今天 +${days} 天（${target}）与理想到期 ${ideal}。`
    );
  }
  if (candidate === ideal) {
    return noop(
      'NO_LATER_THAN_IDEAL',
      `未进一步推迟：理想到期 ${ideal} 晚于今天 +${days} 天（${target}），行政延期不会产生可见变化。`
    );
  }
  return {
    changes: { mf_not_before: candidate },
    reviewApplied: false,
    applied: true,
    reason: null,
    text: `行政延期（POSTPONE）：理想到期 ${ideal} 不变，最早可展示 ${formatDateChange(current, candidate)}（今天 +${days} 天）；真实间隔 ${topic.mf_interval_days} 天与评阅历史不变。`,
  };
}

function transitionManualSchedule(topic, event, cfg, today) {
  const payload = event.payload;
  assertPlainObject(payload, 'payload');
  const idealDue = readPayloadDate(payload, 'idealDue', 'E_MANUAL_DATE_REQUIRED');
  const reason = readManualReason(payload);
  const note = compareDate(idealDue, today) < 0 ? '（目标日期早于今天，将立即到期）' : '';
  return {
    changes: { mf_ideal_due: idealDue, mf_not_before: null },
    reviewApplied: false,
    applied: true,
    reason: null,
    text: `手动排期（MANUAL_SCHEDULE）：理想到期 ${formatDateChange(topic.mf_ideal_due, idealDue)}，已清除旧行政延期；真实间隔 ${topic.mf_interval_days} 天、评阅次数 ${topic.review_count} 与 A-Factor 保持不变${note}。原因：${reason}`,
    meta: { manualReason: reason },
  };
}

function transitionSetPriority(topic, event, cfg) {
  const payload = event.payload;
  assertPlainObject(payload, 'payload');
  const next = validatePriority(payload.priority, 'payload.priority');
  return {
    changes: { priority: next },
    reviewApplied: false,
    applied: true,
    reason: null,
    text: `优先级设置（SET_PRIORITY）：P${topic.priority} → P${next}；理想到期 ${topic.mf_ideal_due}、间隔 ${topic.mf_interval_days} 天与 A-Factor 均不变。`,
  };
}

function transitionComplete(topic) {
  return {
    changes: { status: 'done' },
    reviewApplied: false,
    applied: true,
    reason: null,
    text: `完成（COMPLETE）：状态 active → done；间隔 ${topic.mf_interval_days} 天、理想到期 ${topic.mf_ideal_due}、评阅次数 ${topic.review_count} 保留，未计评阅，未删除任何子节点或卡片。`,
  };
}

function transitionDismiss(topic) {
  return {
    changes: { status: 'dismissed' },
    reviewApplied: false,
    applied: true,
    reason: null,
    text: `移出队列（DISMISS）：状态 active → dismissed；间隔 ${topic.mf_interval_days} 天、理想到期 ${topic.mf_ideal_due}、评阅次数 ${topic.review_count} 保留，未计评阅。`,
  };
}

function transitionReactivate(topic, event) {
  const payload = event.payload;
  assertPlainObject(payload, 'payload');
  const idealDue = readPayloadDate(payload, 'idealDue', 'E_REACTIVATE_DATE_REQUIRED');
  return {
    changes: { status: 'active', mf_ideal_due: idealDue, mf_not_before: null },
    reviewApplied: false,
    applied: true,
    reason: null,
    text: `重新激活（REACTIVATE）：状态 ${topic.status} → active；以指定日期 ${idealDue} 作为恢复后的理想到期，并清除不再适用的行政延期；间隔 ${topic.mf_interval_days} 天与评阅次数 ${topic.review_count} 保留，未计评阅。`,
  };
}

const TRANSITIONS = Object.freeze({
  ADVANCED: transitionAdvanced,
  HOLD: transitionHold,
  SOON: transitionSoon,
  SKIP: transitionSkip,
  POSTPONE: transitionPostpone,
  MANUAL_SCHEDULE: transitionManualSchedule,
  SET_PRIORITY: transitionSetPriority,
  COMPLETE: transitionComplete,
  DISMISS: transitionDismiss,
  REACTIVATE: transitionReactivate,
});

function sameValue(left, right) {
  return Object.is(left ?? null, right ?? null);
}

function computeDiff(before, after) {
  const fields = {};
  for (const field of AUTHORITATIVE_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      fields[field] = { from: before[field] ?? null, to: after[field] ?? null };
    }
  }
  return fields;
}

function assertTransitionInvariants(before, after, context) {
  const { eventType, eventId, today, reviewApplied, applied } = context;
  const invariant = (condition, message, details) => {
    if (!condition) {
      fail('E_INTERNAL_INVARIANT', message, { eventType, eventId, ...details });
    }
  };

  invariant(sameValue(before.a_factor, after.a_factor), 'A-Factor must not change (Q13)');
  invariant(sameValue(before.type, after.type), 'topic type must not change');
  invariant(sameValue(before.mf_id, after.mf_id), 'stable id must not change');
  invariant(sameValue(before.mf_parent_id, after.mf_parent_id), 'parent link must not change');
  invariant(sameValue(before.mf_root_id, after.mf_root_id), 'root link must not change');

  if (reviewApplied) {
    invariant(after.review_count === before.review_count + 1, 'review events increment review_count by one');
    invariant(after.last_reviewed === today, 'review events set last_reviewed to today');
    invariant(after.mf_not_before === null, 'review events clear mf_not_before');
  } else {
    invariant(after.review_count === before.review_count, 'non-review events keep review_count');
    invariant(sameValue(before.last_reviewed, after.last_reviewed), 'non-review events keep last_reviewed');
  }

  if (eventType === 'SKIP') {
    invariant(applied === false, 'SKIP never applies a change');
    invariant(after.mf_revision === before.mf_revision, 'SKIP keeps revision');
    invariant(sameValue(before.mf_last_event_id, after.mf_last_event_id), 'SKIP keeps last_event_id');
    invariant(Object.keys(computeDiff(before, after)).length === 0, 'SKIP keeps every authoritative field');
  }

  if (applied) {
    invariant(after.mf_revision === before.mf_revision + 1, 'a real change increments revision by one');
    invariant(after.mf_last_event_id === eventId, 'a real change records last_event_id');
    const statusChanged = !sameValue(before.status, after.status);
    const statusMayChange = ['COMPLETE', 'DISMISS', 'REACTIVATE'].includes(eventType);
    invariant(statusChanged === statusMayChange, 'status changes only for COMPLETE/DISMISS/REACTIVATE');
  } else {
    invariant(after.mf_revision === before.mf_revision, 'no-op keeps revision');
    invariant(sameValue(before.mf_last_event_id, after.mf_last_event_id), 'no-op keeps last_event_id');
    invariant(Object.keys(computeDiff(before, after)).length === 0, 'no-op keeps every authoritative field');
  }
}

// SPEC A8/A9 — the single pure entry point for every event type.
function applyEvent(topic, event, config = SPEC_CONFIG, today = undefined) {
  const cfg = assertConfig(config);
  validateTopic(topic);
  assertDateString(today, 'today');
  validateEvent(event, topic, today);

  const allowed = ALLOWED_SOURCE_STATUS[event.type];
  if (LEGACY_STATUSES.includes(topic.status)) {
    fail('E_STATUS_UNSUPPORTED', `status "${topic.status}" needs a compatibility adapter before MF-US-1 can schedule it (SPEC A8)`, {
      status: topic.status,
      type: event.type,
    });
  }
  if (!allowed.includes(topic.status)) {
    fail('E_INVALID_TRANSITION', `event ${event.type} is not allowed from status "${topic.status}"`, {
      type: event.type,
      status: topic.status,
      allowed,
    });
  }

  // SPEC A5.1: SKIP writes nothing, so a stale expectedRevision is irrelevant.
  if (event.type !== 'SKIP' && event.expectedRevision !== topic.mf_revision) {
    fail('E_REVISION_CONFLICT', `expectedRevision ${event.expectedRevision} does not match topic revision ${topic.mf_revision}`, {
      expected: event.expectedRevision,
      actual: topic.mf_revision,
    });
  }

  const transition = TRANSITIONS[event.type](topic, event, cfg, today);

  const changes = {};
  for (const [field, value] of Object.entries(transition.changes)) {
    if (!sameValue(topic[field], value)) changes[field] = value;
  }
  const applied = Object.keys(changes).length > 0;

  const after = { ...topic, ...changes };
  if (applied) {
    after.mf_revision = topic.mf_revision + 1;
    after.mf_last_event_id = event.eventId;
  }

  const reviewApplied = transition.reviewApplied && applied;
  const eventDate = resolveEventDate(event);
  const processedOnDifferentDay = eventDate.date != null && eventDate.date !== today;
  assertTransitionInvariants(topic, after, {
    eventType: event.type,
    eventId: event.eventId,
    today,
    reviewApplied,
    applied,
  });

  const reason = applied ? null : (transition.reason || 'NO_STATE_CHANGE');
  const text = transition.text;
  const diff = computeDiff(topic, after);

  return {
    topic: after,
    applied,
    needsWrite: applied,
    reviewApplied,
    duplicate: false,
    reason,
    diff: { fields: diff },
    explain: {
      text,
      data: {
        type: event.type,
        eventId: event.eventId,
        today,
        applied,
        reviewApplied,
        reason,
        changes: diff,
        eventDate: eventDate.date,
        eventDateSource: eventDate.source,
        processedOnDifferentDay,
        ...(transition.meta || {}),
      },
    },
    algorithmVersion: ALGORITHM_VERSION,
    event: {
      eventId: event.eventId,
      topicId: event.topicId,
      type: event.type,
      expectedRevision: event.expectedRevision,
      eventDate: eventDate.date,
      eventDateSource: eventDate.source,
    },
  };
}

module.exports = {
  EVENT_TYPES,
  REVIEW_EVENTS,
  LEGACY_STATUSES,
  ALLOWED_SOURCE_STATUS,
  AUTHORITATIVE_FIELDS,
  MANUAL_REASON_MAX,
  PAYLOAD_SCHEMA,
  isReviewEvent,
  parseCreatedAt,
  validateEventTime,
  resolveEventDate,
  validatePayloadSchema,
  validateEvent,
  applyEvent,
};
