'use strict';

// P2-US1-HOST-CLOSURE / Actions Agent — COMPLETE / DISMISS / REACTIVATE / SKIP
// through src/integration/state-actions-host.js.
//
// Pure synthetic notes only: no Vault, no Obsidian, no real runtime I/O. The
// injected `run` stands in for the host scheduler service / async runtime, and
// the descriptor is additionally fed to the REAL pure state machine
// (applyEvent) to prove the host contract and the A8 event contract match.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATE_TYPES,
  SKIP_NO_OP_MESSAGE,
  buildStateDescriptor,
  runStateAction,
} = require('../src/integration/state-actions-host.js');
const { applyEvent, ALGORITHM_VERSION } = require('../src/scheduling/index.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-27';
const DATE_FORMAT = 'YYYY-MM-DD';
const TOPIC_ID = uuid(101);
const EVENT_ID_RE = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;

function noteFile(overrides = {}) {
  return { path: 'Sources/Host-A.md', basename: 'Host-A', extension: 'md', ...overrides };
}

function noteFm(overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    mf_id: TOPIC_ID,
    mf_revision: 3,
    mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20',
    mf_not_before: 'null',
    mf_interval_days: 8,
    a_factor: 1.6,
    review_count: 2,
    last_reviewed: '2026-11-01',
    ...overrides,
  };
}

function build(type, options = {}) {
  return buildStateDescriptor({
    type,
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
    ...options,
  });
}

// The event the host runtime builds from a descriptor (host-runtime.js
// _mfUs1UnifiedRequest + ALGORITHM_VERSION).
function eventOf(descriptor) {
  return {
    eventId: descriptor.eventId,
    topicId: descriptor.topicId,
    type: descriptor.action,
    payload: descriptor.payload,
    expectedRevision: descriptor.expectedRevision,
    calendarDate: descriptor.calendarDate,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

// Normalised Topic handed to the pure core (mf_not_before 'null' -> null).
function topicOf(fm) {
  return {
    type: fm.type,
    status: fm.status,
    priority: fm.priority,
    mf_id: fm.mf_id,
    mf_revision: fm.mf_revision,
    mf_scheduler_version: fm.mf_scheduler_version,
    mf_ideal_due: fm.mf_ideal_due,
    mf_not_before: fm.mf_not_before == null || fm.mf_not_before === 'null' ? null : fm.mf_not_before,
    mf_interval_days: fm.mf_interval_days,
    a_factor: fm.a_factor,
    review_count: fm.review_count,
    last_reviewed: fm.last_reviewed,
  };
}

// ---- descriptor construction --------------------------------------------

test('COMPLETE from active builds one stable host descriptor', () => {
  const first = build('COMPLETE');
  const second = build('COMPLETE');
  assert.equal(first.ok, true);
  assert.equal(first.scheduling, true);
  assert.equal(first.type, 'COMPLETE');
  assert.equal(first.descriptor.action, 'COMPLETE');
  assert.equal(first.descriptor.type, 'COMPLETE');
  assert.equal(first.descriptor.topicId, TOPIC_ID);
  assert.equal(first.descriptor.expectedRevision, 3);
  assert.equal(first.descriptor.today, TODAY);
  assert.equal(first.descriptor.calendarDate, TODAY);
  assert.equal(first.descriptor.payload, null);
  assert.equal(first.descriptor.dateFormat, DATE_FORMAT);
  assert.match(first.descriptor.eventId, EVENT_ID_RE);
  assert.equal(first.descriptor.eventId, second.descriptor.eventId, 'identical inputs must reuse the eventId');
  assert.deepEqual(STATE_TYPES, ['COMPLETE', 'DISMISS', 'REACTIVATE', 'SKIP']);
});

test('the state type is case-insensitive and a new revision yields a new eventId', () => {
  const lower = build('complete');
  const upper = build('COMPLETE');
  assert.equal(lower.ok, true);
  assert.equal(lower.descriptor.eventId, upper.descriptor.eventId);

  const revised = build('COMPLETE', { fm: noteFm({ mf_revision: 4 }) });
  assert.notEqual(revised.descriptor.eventId, upper.descriptor.eventId);
  assert.equal(revised.descriptor.expectedRevision, 4);
});

test('cards, non-Markdown notes and unknown actions are refused before any runner call', () => {
  const card = build('COMPLETE', { fm: noteFm({ type: 'card' }) });
  assert.equal(card.ok, false);
  assert.equal(card.code, 'E_TOPIC_NOT_SCHEDULABLE');

  const pdf = build('COMPLETE', { file: noteFile({ extension: 'pdf', path: 'Papers/X.pdf', basename: 'X' }) });
  assert.equal(pdf.ok, false);
  assert.equal(pdf.code, 'E_TOPIC_NOT_SCHEDULABLE');

  const pdfByPathOnly = build('COMPLETE', { file: { path: 'Papers/X.pdf', basename: 'X' } });
  assert.equal(pdfByPathOnly.code, 'E_TOPIC_NOT_SCHEDULABLE');

  const unknown = build('ARCHIVE');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'E_STATE_ACTION_UNKNOWN');
});

test('a topic without a persisted mf_id or mf_revision is not writable', () => {
  const noRevision = build('COMPLETE', { fm: noteFm({ mf_revision: undefined }) });
  assert.equal(noRevision.ok, false);
  assert.equal(noRevision.code, 'E_ID_NOT_PERSISTED');

  const badRevision = build('COMPLETE', { fm: noteFm({ mf_revision: '3' }) });
  assert.equal(badRevision.code, 'E_ID_NOT_PERSISTED');

  const noId = build('COMPLETE', { fm: noteFm({ mf_id: null }) });
  assert.equal(noId.code, 'E_ID_NOT_PERSISTED');

  const tempId = build('COMPLETE', { fm: noteFm({ mf_id: 'temp-abc12345' }) });
  assert.equal(tempId.code, 'E_ID_NOT_PERSISTED');
});

test('COMPLETE and DISMISS only accept an active source/extract', () => {
  const done = build('COMPLETE', { fm: noteFm({ status: 'done' }) });
  assert.equal(done.code, 'E_STATUS_NOT_ALLOWED');

  const dismissed = build('DISMISS', { fm: noteFm({ status: 'dismissed' }) });
  assert.equal(dismissed.code, 'E_STATUS_NOT_ALLOWED');

  const legacyInbox = build('COMPLETE', { fm: noteFm({ status: 'inbox' }) });
  assert.equal(legacyInbox.code, 'E_STATUS_NOT_ALLOWED');

  const dismissActive = build('DISMISS', { fm: noteFm({ status: 'active' }) });
  assert.equal(dismissActive.ok, true);
  assert.equal(dismissActive.descriptor.action, 'DISMISS');
  assert.equal(dismissActive.descriptor.payload, null);
});

test('REACTIVATE needs done/dismissed plus an explicit valid restore date', () => {
  const noDate = build('REACTIVATE', { fm: noteFm({ status: 'done' }) });
  assert.equal(noDate.ok, false);
  assert.equal(noDate.code, 'E_REACTIVATE_DATE_REQUIRED');

  const emptyDate = build('REACTIVATE', { fm: noteFm({ status: 'dismissed' }), payload: {} });
  assert.equal(emptyDate.code, 'E_REACTIVATE_DATE_REQUIRED');

  const badDate = build('REACTIVATE', { fm: noteFm({ status: 'done' }), payload: { idealDue: '2026-02-30' } });
  assert.equal(badDate.code, 'E_REACTIVATE_DATE_REQUIRED');

  const activeTopic = build('REACTIVATE', { payload: { idealDue: '2026-12-10' } });
  assert.equal(activeTopic.code, 'E_STATUS_NOT_ALLOWED');

  const accepted = build('REACTIVATE', { fm: noteFm({ status: 'done' }), payload: { idealDue: '2026-12-10' } });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.scheduling, true);
  assert.equal(accepted.descriptor.action, 'REACTIVATE');
  assert.deepEqual(accepted.descriptor.payload, { idealDue: '2026-12-10' });
  assert.equal(accepted.payload, accepted.descriptor.payload);

  const otherDate = build('REACTIVATE', { fm: noteFm({ status: 'done' }), payload: { idealDue: '2026-12-11' } });
  assert.notEqual(otherDate.descriptor.eventId, accepted.descriptor.eventId);
});

test('a pinned valid today is required and state payloads are strict', () => {
  assert.equal(build('COMPLETE', { today: '2026-13-40' }).code, 'E_TODAY_REQUIRED');
  assert.equal(build('COMPLETE', { payload: { reason: 'because' } }).code, 'E_EVENT_PAYLOAD_INVALID');

  const reactivateExtra = build('REACTIVATE', {
    fm: noteFm({ status: 'done' }),
    payload: { idealDue: '2026-12-10', reason: 'nope' },
  });
  assert.equal(reactivateExtra.code, 'E_EVENT_PAYLOAD_INVALID');
});

// ---- descriptor <> pure state machine compatibility ----------------------

test('the COMPLETE descriptor is accepted by the real A8 state machine without a review', () => {
  const fm = noteFm();
  const built = build('COMPLETE');
  const result = applyEvent(topicOf(fm), eventOf(built.descriptor), undefined, TODAY);
  assert.equal(result.applied, true);
  assert.equal(result.reviewApplied, false);
  assert.equal(result.topic.status, 'done');
  assert.equal(result.topic.review_count, fm.review_count, 'COMPLETE must not count as a review');
  assert.equal(result.topic.mf_ideal_due, fm.mf_ideal_due);
  assert.equal(result.topic.mf_revision, fm.mf_revision + 1);
});

test('the REACTIVATE descriptor restores active with the user-chosen date', () => {
  const fm = noteFm({ status: 'dismissed' });
  const built = build('REACTIVATE', { fm, payload: { idealDue: '2026-12-18' } });
  assert.equal(built.ok, true);
  const result = applyEvent(topicOf(fm), eventOf(built.descriptor), undefined, TODAY);
  assert.equal(result.applied, true);
  assert.equal(result.topic.status, 'active');
  assert.equal(result.topic.mf_ideal_due, '2026-12-18');
  assert.equal(result.topic.mf_not_before, null);
  assert.equal(result.reviewApplied, false);
  assert.equal(result.topic.mf_revision, fm.mf_revision + 1);
});

// ---- SKIP ----------------------------------------------------------------

test('SKIP produces no scheduling descriptor and never calls the runner', async () => {
  const built = build('SKIP');
  assert.deepEqual(built, { ok: true, scheduling: false, type: 'SKIP' });

  // Session-only: even a topic without a persisted revision is fine.
  const noRevision = build('SKIP', { fm: noteFm({ mf_revision: undefined, mf_id: null }) });
  assert.deepEqual(noRevision, { ok: true, scheduling: false, type: 'SKIP' });

  let calls = 0;
  const result = await runStateAction({
    run: async () => { calls += 1; return { status: 'applied', writesPerformed: true }; },
    type: 'SKIP',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(calls, 0, 'SKIP must not reach the host runner');
  assert.equal(result.status, 'no-op');
  assert.equal(result.message, SKIP_NO_OP_MESSAGE);
  assert.equal(result.reason, 'SESSION_ONLY');
  assert.equal(result.confirmed, false);
  assert.equal(result.outcome, null);
});

// ---- runStateAction outcome normalisation --------------------------------

test('an applied state action is confirmed and passes descriptor + legacy writer through', async () => {
  const legacy = async () => ({ status: 'legacy' });
  let seen = null;
  const result = await runStateAction({
    run: async (descriptor, legacyArg) => {
      seen = { descriptor, legacyArg };
      return {
        status: 'applied',
        writesPerformed: true,
        record: { audit: { after: { status: 'done', idealDue: '2026-11-20' } } },
      };
    },
    type: 'COMPLETE',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
    legacy,
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.confirmed, true);
  assert.match(result.message, /done/);
  assert.equal(seen.legacyArg, legacy);
  assert.equal(seen.descriptor.action, 'COMPLETE');
  assert.equal(seen.descriptor.topicId, TOPIC_ID);
  assert.equal(seen.descriptor.expectedRevision, 3);
});

test('an applied REACTIVATE reports the restored date', async () => {
  const result = await runStateAction({
    run: async () => ({
      status: 'applied',
      writesPerformed: true,
      record: { audit: { after: { status: 'active', idealDue: '2026-12-10' } } },
    }),
    type: 'REACTIVATE',
    file: noteFile(),
    fm: noteFm({ status: 'done' }),
    today: TODAY,
    payload: { idealDue: '2026-12-10' },
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.confirmed, true);
  assert.match(result.message, /2026-12-10/);
  assert.match(result.message, /active/);
});

test('a host-service wrapper result is unwrapped before normalisation', async () => {
  const applied = await runStateAction({
    run: async () => ({
      route: 'unified',
      result: { status: 'applied', writesPerformed: true, record: { audit: { after: { status: 'dismissed' } } } },
    }),
    type: 'DISMISS',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.confirmed, true);

  // Legacy writer results are undefined by convention; the host wrapper then
  // returns route+undefined and describeOutcome reports `legacy` (the legacy
  // writer already showed its own notice).
  const legacy = await runStateAction({
    run: async () => ({ route: 'legacy', result: undefined }),
    type: 'COMPLETE',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(legacy.status, 'legacy');
  assert.equal(legacy.confirmed, false);
});

test('a conflict outcome is never presented as success', async () => {
  const result = await runStateAction({
    run: async () => ({ status: 'conflict', reason: 'E_REVISION_CONFLICT', writesPerformed: false }),
    type: 'DISMISS',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.confirmed, false);
  assert.match(result.message, /写入被拒绝/);
  assert.doesNotMatch(result.message, /已移出/);
});

test('an uncertain outcome is never presented as success', async () => {
  const result = await runStateAction({
    run: async () => ({ status: 'uncertain', reason: 'E_APPLIED_PERSIST_FAILED', writesPerformed: true }),
    type: 'COMPLETE',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.confirmed, false);
  assert.match(result.message, /尚未确认/);
  assert.doesNotMatch(result.message, /已完成/);
});

test('a refused target or a throwing runner fails honestly without a descriptor write', async () => {
  let calls = 0;
  const refused = await runStateAction({
    run: async () => { calls += 1; return { status: 'applied', writesPerformed: true }; },
    type: 'COMPLETE',
    file: noteFile(),
    fm: noteFm({ type: 'card' }),
    today: TODAY,
  });
  assert.equal(calls, 0, 'a refused target must not reach the runner');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.reason, 'E_TOPIC_NOT_SCHEDULABLE');
  assert.equal(refused.confirmed, false);
  assert.equal(refused.outcome, null);

  const thrown = await runStateAction({
    run: async () => { throw Object.assign(new Error('locked'), { code: 'E_TOPIC_LOCKED' }); },
    type: 'COMPLETE',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(thrown.status, 'failed');
  assert.equal(thrown.reason, 'E_TOPIC_LOCKED');
  assert.equal(thrown.confirmed, false);
});

test('a missing runner fails closed for a writing action', async () => {
  const result = await runStateAction({
    type: 'COMPLETE',
    file: noteFile(),
    fm: noteFm(),
    today: TODAY,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'E_RUN_REQUIRED');
  assert.equal(result.confirmed, false);
});
