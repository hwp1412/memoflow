'use strict';

// Host layer for the four state / session actions of MF-US-1
// (P2-US1-HOST-CLOSURE, Actions Agent): COMPLETE, DISMISS, REACTIVATE and SKIP.
//
// Responsibilities, deliberately narrow (same split as reading-actions-host.js):
//   * validate the user's target note and parameters against SPEC A4.3 / A5.1
//     and the A8 state machine;
//   * build the *single* host event descriptor (one stable eventId, persistent
//     topicId, persistent expectedRevision, a pinned `today`);
//   * hand the descriptor to the injected host runner and normalise the outcome
//     through `describeOutcome`, so the UI never shows a success message for
//     conflict / uncertain / failed results.
//
// It never writes Frontmatter and never computes scheduling. The actual write
// always happens behind the host scheduler service / Unified runtime, and the
// legacy writer (if any) is injected by the caller as the `legacy` callback.
//
// Owner rulings enforced here:
//   * Q5 / SPEC A4.3: REACTIVATE requires an explicit user-chosen restore date;
//   * SPEC A5.1: SKIP changes nothing — it is session-pointer-only and produces
//     NO scheduling write, so it never calls the runner at all;
//   * cards are never schedulable through MF-US-1 (SPEC A1.2);
//   * a topic without persisted mf_id / mf_revision is not writable in Unified
//     (E_ID_NOT_PERSISTED); no implicit migration is attempted.

const { mapReadingAction } = require('../scheduling/reading-integration.js');
const { isValidDateString } = require('../scheduling/dates.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');
const { requestFingerprint } = require('../scheduling/persistent-event-ledger.js');
const { ALGORITHM_VERSION } = require('../scheduling/constants.js');
const { describeOutcome } = require('./reading-actions-host.js');

const STATE_TYPES = Object.freeze(['COMPLETE', 'DISMISS', 'REACTIVATE', 'SKIP']);

// Host-facing state type -> accepted reading-action key (reading-integration.js).
// There is deliberately no second mapping table: every payload is produced by
// `mapReadingAction`, the same translator the event ledger already fingerprints.
const READING_ACTION = Object.freeze({
  COMPLETE: 'complete',
  DISMISS: 'dismiss',
  REACTIVATE: 'reactivate',
  SKIP: 'skip',
});

// SPEC A8: typed source-status contract for the three writing state events.
const ALLOWED_SOURCE_STATUS = Object.freeze({
  COMPLETE: ['active'],
  DISMISS: ['active'],
  REACTIVATE: ['done', 'dismissed'],
});

const SKIP_NO_OP_MESSAGE = '跳过仅移动会话指针，未改变调度。';

function reject(code, message) {
  return { ok: false, code, message };
}

function normalizeStateType(type) {
  if (typeof type !== 'string') return null;
  const upper = type.trim().toUpperCase();
  return STATE_TYPES.includes(upper) ? upper : null;
}

// The host target is always a Markdown note. `extension` is used when present
// (real TFile); synthetic rows in tests only carry path/basename.
function isMarkdownFile(file) {
  if (!file || typeof file !== 'object') return false;
  if (typeof file.extension === 'string' && file.extension.trim() !== '') {
    return file.extension.toLowerCase() === 'md';
  }
  return typeof file.path === 'string' && /\.md$/i.test(file.path);
}

function hasPayloadKeys(payload) {
  return payload != null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.keys(payload).length > 0;
}

// A stable, UUID-shaped event id derived from the immutable request (same
// requestFingerprint used by reading-integration / the persistent ledger, and
// the same digest slice convention as the existing host descriptor). Identical
// inputs therefore produce the same eventId, so a retry is an idempotent
// duplicate instead of a second transition.
function deriveEventId({ type, topicId, expectedRevision, today, payload, dateFormat }) {
  const fingerprint = requestFingerprint({
    eventId: null,
    topicId,
    type,
    payload: payload ?? null,
    expectedRevision,
    algorithmVersion: ALGORITHM_VERSION,
    today,
    calendarDate: today,
    dateFormat: dateFormat ?? null,
    configDigest: null,
  });
  return `00000000-0000-4000-8000-${fingerprint.slice(0, 12)}`;
}

// Build one host event descriptor for COMPLETE / DISMISS / REACTIVATE, or the
// explicit "no scheduling write" answer for SKIP.
//
// Returns:
//   { ok:true, scheduling:true, type, descriptor, payload }
//   { ok:true, scheduling:false, type:'SKIP' }               for SKIP only
//   { ok:false, code, message }                              for every refusal
function buildStateDescriptor({
  type,
  file,
  fm,
  today,
  payload = null,
  dateFormat = 'YYYY-MM-DD',
} = {}) {
  const stateType = normalizeStateType(type);
  if (!stateType) return reject('E_STATE_ACTION_UNKNOWN', `未知的状态操作：${type}`);

  if (!isMarkdownFile(file)) {
    return reject('E_TOPIC_NOT_SCHEDULABLE', '只能对 Markdown 来源或摘录执行该操作。');
  }
  if (!fm || typeof fm !== 'object') {
    return reject('E_TOPIC_NOT_SCHEDULABLE', '无法读取该笔记的 Frontmatter。');
  }
  if (fm.type !== 'source' && fm.type !== 'extract') {
    return reject(
      'E_TOPIC_NOT_SCHEDULABLE',
      fm.type === 'card'
        ? '卡片由 Spaced Repetition 管理，不经过 Topic 状态操作。'
        : '只能对来源或摘录执行该操作。'
    );
  }

  if (stateType === 'SKIP') {
    // SPEC A5.1: SKIP only moves the session pointer. No field is written, so
    // neither a pinned date nor a persisted revision is required here.
    return { ok: true, scheduling: false, type: 'SKIP' };
  }

  if (!isValidDateString(today)) {
    return reject('E_TODAY_REQUIRED', '需要一个固定的今天日期（YYYY-MM-DD）。');
  }

  const status = typeof fm.status === 'string' ? fm.status : '';
  const allowedFrom = ALLOWED_SOURCE_STATUS[stateType];
  if (!allowedFrom.includes(status)) {
    return reject(
      'E_STATUS_NOT_ALLOWED',
      `当前状态 "${status || '未知'}" 不允许 ${stateType}；允许的源状态：${allowedFrom.join(' / ')}。`
    );
  }

  let canonicalPayload = null;
  let mappedType = stateType;
  if (stateType === 'REACTIVATE') {
    const idealDue = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.idealDue
      : null;
    if (typeof idealDue !== 'string' || !isValidDateString(idealDue)) {
      return reject('E_REACTIVATE_DATE_REQUIRED', '重新激活需要一个合法的本地日历日期（payload.idealDue，YYYY-MM-DD）。');
    }
    const extraKeys = Object.keys(payload).filter(key => key !== 'idealDue');
    if (extraKeys.length > 0) {
      return reject('E_EVENT_PAYLOAD_INVALID', `REACTIVATE payload 不允许多余字段：${extraKeys.join(', ')}。`);
    }
    const mapped = mapReadingAction({ action: READING_ACTION.REACTIVATE, idealDue });
    mappedType = mapped.type;
    canonicalPayload = mapped.payload ?? { idealDue };
  } else {
    // COMPLETE / DISMISS carry no payload at all (SPEC A8 / PAYLOAD_SCHEMA).
    if (hasPayloadKeys(payload)) {
      return reject('E_EVENT_PAYLOAD_INVALID', `${stateType} 不接受 payload。`);
    }
    mappedType = mapReadingAction({ action: READING_ACTION[stateType] }).type;
    canonicalPayload = null;
  }

  if (!isPersistentUuid(fm.mf_id)) {
    return reject('E_ID_NOT_PERSISTED', '该主题缺少持久化 mf_id，无法在 Unified 中写入（请先迁移）。');
  }
  const expectedRevision = fm.mf_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return reject('E_ID_NOT_PERSISTED', '该主题缺少持久化 mf_revision，无法在 Unified 中写入（请先迁移）。');
  }

  const descriptor = {
    action: mappedType,
    type: mappedType,
    eventId: deriveEventId({
      type: mappedType,
      topicId: fm.mf_id,
      expectedRevision,
      today,
      payload: canonicalPayload,
      dateFormat,
    }),
    topicId: fm.mf_id,
    expectedRevision,
    today,
    calendarDate: today,
    payload: canonicalPayload,
    dateFormat,
  };
  return { ok: true, scheduling: true, type: mappedType, descriptor, payload: canonicalPayload };
}

// The host scheduler service wraps the runtime result for legacy/shadow mode.
// `_mfUs1Run` hands that wrapper over; `_mfUs1RunLegacy` already unwraps it.
// Both are accepted: a wrapper is identified by its `route` key.
function unwrapHostOutcome(raw) {
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'route')) {
    return raw.result === undefined ? null : raw.result;
  }
  return raw == null ? null : raw;
}

function stateSuccessMessage(stateType, outcome) {
  if (stateType === 'COMPLETE') {
    return '已完成：状态改为 done，已退出 Topic 队列（未计评阅）。';
  }
  if (stateType === 'DISMISS') {
    return '已移出 Topic 队列：状态改为 dismissed（未计评阅）。';
  }
  if (stateType === 'REACTIVATE') {
    const after = outcome && outcome.record && outcome.record.audit && outcome.record.audit.after;
    const idealDue = after && after.idealDue;
    return idealDue
      ? `已重新激活：状态改为 active，理想到期 ${idealDue}（未计评阅）。`
      : '已重新激活：状态改为 active（未计评阅）。';
  }
  return null;
}

// Build the descriptor, run it through the injected host runner and normalise
// the outcome for the UI. `run(descriptor, legacy)` is the host entry; `legacy`
// is the (optional) legacy writer the host facade needs outside Unified mode.
async function runStateAction({
  run,
  type,
  file,
  fm,
  today,
  payload = null,
  legacy = null,
  dateFormat = 'YYYY-MM-DD',
} = {}) {
  const built = buildStateDescriptor({ type, file, fm, today, payload, dateFormat });
  if (!built.ok) {
    return {
      status: 'failed',
      message: built.message || `状态操作未被允许（${built.code}）。`,
      reason: built.code,
      confirmed: false,
      outcome: null,
    };
  }

  if (built.scheduling === false) {
    // SKIP: session pointer only. The runner is never called and no write can
    // happen, so this is an honest no-op rather than a silent success.
    return {
      status: 'no-op',
      message: SKIP_NO_OP_MESSAGE,
      reason: 'SESSION_ONLY',
      confirmed: false,
      outcome: null,
    };
  }

  if (typeof run !== 'function') {
    return {
      status: 'failed',
      message: '状态操作缺少宿主执行函数。',
      reason: 'E_RUN_REQUIRED',
      confirmed: false,
      outcome: null,
    };
  }

  let raw;
  try {
    raw = await run(built.descriptor, legacy);
  } catch (error) {
    raw = {
      status: 'failed',
      reason: (error && error.code) || 'E_STATE_ACTION_FAILED',
      message: error && error.message,
    };
  }

  const outcome = unwrapHostOutcome(raw);
  const described = describeOutcome(built.type.toLowerCase(), outcome);
  const appliedMessage = described.status === 'applied'
    ? stateSuccessMessage(built.type, outcome)
    : null;
  return {
    status: described.status,
    message: appliedMessage || described.message,
    reason: described.reason,
    confirmed: described.confirmed,
    outcome: described.outcome,
  };
}

module.exports = {
  STATE_TYPES,
  READING_ACTION,
  ALLOWED_SOURCE_STATUS,
  SKIP_NO_OP_MESSAGE,
  normalizeStateType,
  buildStateDescriptor,
  runStateAction,
};
