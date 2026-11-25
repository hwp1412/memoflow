'use strict';

// PR-07 — read-only Shadow comparison (SPEC A10.1, A12, A13 T19).

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  compareShadowBatch,
  previewShadowEvent,
  resolveSchedulerMode,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID3 = '5e9a7c1d-2b4f-4c8e-9f1a-0d3b6e8c2a45';
const TODAY = '2026-11-24';
const CONTEXT = { dateFormat: 'DD-MM-YYYY' };
const SHADOW = { mode: 'shadow' };

function uuid(seq) {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function rawSource(overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    interval: 8,
    a_factor: 2.0,
    review_count: 3,
    next_review: '24-11-2026',
    last_reviewed: '01-11-2026',
    mf_id: UUID,
    path: 'Sources/A.md',
    basename: 'A',
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    id: UUID,
    source: 'legacy-executed',
    priority: 50,
    interval: 8,
    aFactor: 2,
    idealDue: '2026-11-24',
    ...overrides,
  };
}

function compare(snapshots, options = {}) {
  return compareShadowBatch(snapshots, {
    mode: SHADOW,
    context: CONTEXT,
    today: TODAY,
    observations: [],
    ...options,
  });
}

function event(type, overrides = {}) {
  return {
    eventId: UUID3,
    topicId: UUID,
    type,
    expectedRevision: 0,
    algorithmVersion: 1,
    calendarDate: TODAY,
    ...overrides,
  };
}

// ---- comparison model -----------------------------------------------------

test('matching legacy and MF-US-1 values are reported as match', () => {
  const report = compare([rawSource()], { observations: [observation()] });
  assert.equal(report.mode, 'shadow');
  assert.equal(report.authoritativeScheduler, 'legacy');
  assert.equal(report.writesPerformed, false);
  const result = report.results[0];
  assert.equal(result.status, 'match');
  assert.equal(result.observationTrust, 'executed');
  assert.deepEqual(result.differences, []);
  assert.equal(result.candidate.intervalDays, 8);
  assert.equal(result.candidate.aFactor, 2);
  assert.equal(result.candidate.idealDue, '2026-11-24');
  assert.equal(result.candidate.effectiveDue, '2026-11-24');
  assert.equal(result.writesPerformed, false);
  assert.deepEqual(report.summary, { total: 1, match: 1, mismatch: 0, unavailable: 0, notComparable: 0 });
});

test('an interval difference is reported with its cause and caveats', () => {
  const report = compare([rawSource()], { observations: [observation({ interval: 5 })] });
  const result = report.results[0];
  assert.equal(result.status, 'mismatch');
  assert.equal(result.differences[0].field, 'interval');
  assert.equal(result.differences[0].delta, 3);
  assert.ok(result.causes.includes('ALGORITHM_OR_LEGACY_HISTORY'));
  assert.ok(result.caveats.includes('LEGACY_INTERVAL_PROVENANCE_UNCERTAIN'));
  assert.match(result.explanation, /does not decide which is correct/);
});

test('legacy next_review is never treated as an equivalent of ideal due', () => {
  const report = compare([rawSource()], { observations: [observation({ nextReview: '2026-12-01' })] });
  const result = report.results[0];
  assert.equal(result.status, 'match', 'next_review alone is not a comparable field');
  assert.equal(result.nextReviewComparison.equivalent, false);
  assert.equal(result.nextReviewComparison.deltaDays, 7);
  assert.equal(result.nextReviewComparison.reason, 'LEGACY_NEXT_REVIEW_MAY_INCLUDE_ADMINISTRATIVE_CHANGE');
});

test('ideal due and effective due are compared separately', () => {
  const report = compare([rawSource()], {
    observations: [observation({ effectiveDue: '2026-12-05' })],
  });
  const result = report.results[0];
  assert.equal(result.status, 'mismatch');
  assert.equal(result.differences[0].field, 'effectiveDue');
  assert.equal(result.differences[0].deltaDays, 11);
  assert.ok(result.causes.includes('ADMIN_OR_SCHEDULE'));
});

test('a legacy administrative change is not directly comparable', () => {
  const report = compare([rawSource()], {
    observations: [observation({ administrative: true })],
  });
  const result = report.results[0];
  assert.equal(result.status, 'not-comparable');
  assert.equal(result.comparable, false);
  assert.ok(result.reasons.includes('LEGACY_ADMINISTRATIVE_CONTAMINATION'));
});

test('a missing legacy observation is reported, never fabricated', () => {
  const report = compare([rawSource()], { observations: [] });
  const result = report.results[0];
  assert.equal(result.status, 'not-comparable');
  assert.equal(result.observationTrust, 'unavailable');
  assert.ok(result.reasons.includes('LEGACY_OBSERVATION_MISSING'));
  assert.equal(report.summary.unavailable, 1);
});

test('a legacy proxy is marked as proxy and rejected as a baseline', () => {
  const report = compare([rawSource()], { observations: [observation({ source: 'legacy-proxy' })] });
  const result = report.results[0];
  assert.equal(result.observationTrust, 'proxy');
  assert.equal(result.status, 'not-comparable');
  assert.ok(result.reasons.includes('LEGACY_PROXY_NOT_AUTHORITATIVE'));
});

test('an observation without a recognized source is untrusted', () => {
  for (const source of [undefined, 'guess', 'simulated']) {
    const report = compare([rawSource()], { observations: [observation({ source })] });
    assert.equal(report.results[0].status, 'not-comparable', String(source));
    assert.ok(report.results[0].reasons.includes('LEGACY_OBSERVATION_UNTRUSTED'));
  }
});

test('a read-only limited candidate can still be compared, with its limitation', () => {
  const temporary = rawSource({ mf_id: undefined, path: 'Sources/Temp.md' });
  const first = compare([temporary]).results[0];
  assert.equal(first.identityKind, 'temporary');
  assert.equal(first.persistentIdentity, false);

  const report = compare([temporary], {
    observations: [observation({ id: first.id, interval: 8, idealDue: '2026-11-24' })],
  });
  const result = report.results[0];
  assert.equal(result.status, 'match');
  assert.ok(result.reasons.includes('CANDIDATE_READ_ONLY_LIMITED'));
});

test('conflicts, unsupported statuses and invalid dates are not comparable', () => {
  const conflict = compare([rawSource({ mf_ideal_due: '2026-11-25' })], { observations: [observation()] }).results[0];
  assert.equal(conflict.status, 'not-comparable');
  assert.ok(conflict.reasons.some(reason => reason.startsWith('FIELD_CONFLICT')));

  const unsupported = compare([rawSource({ status: 'pending' })], { observations: [observation()] }).results[0];
  assert.equal(unsupported.status, 'not-comparable');
  assert.ok(unsupported.reasons.includes('E_UNSUPPORTED_STATUS'));

  const invalid = compare([rawSource({ next_review: '31-04-2026' })], { observations: [observation()] }).results[0];
  assert.equal(invalid.status, 'not-comparable');
  assert.ok(invalid.reasons.includes('E_DATE_INVALID'));
});

test('duplicate ids are conflicts and do not produce a comparison', () => {
  const report = compare([
    rawSource(),
    rawSource({ path: 'Sources/B.md', basename: 'B' }),
  ], { observations: [observation()] });
  assert.equal(report.results[0].status, 'not-comparable');
  assert.equal(report.results[1].status, 'not-comparable');
  assert.ok(report.results[0].reasons.includes('E_DUPLICATE_ID'));
});

test('one broken record does not stop the others from being compared', () => {
  const report = compare([
    rawSource({ next_review: 'not-a-date' }),
    rawSource({ mf_id: UUID2, path: 'Sources/B.md', basename: 'B' }),
  ], {
    observations: [observation(), observation({ id: UUID2 })],
  });
  assert.equal(report.results[0].status, 'not-comparable');
  assert.equal(report.results[1].status, 'match');
  assert.deepEqual(report.summary, { total: 2, match: 1, mismatch: 0, unavailable: 0, notComparable: 1 });
});

test('comparison is deterministic and independent of input order', () => {
  const topics = [
    rawSource(),
    rawSource({ mf_id: UUID2, path: 'Sources/B.md', basename: 'B', interval: 5 }),
  ];
  const observations = [observation(), observation({ id: UUID2, interval: 9 })];

  const forward = compare(topics, { observations });
  const again = compare(topics, { observations });
  const backward = compare(topics.slice().reverse(), { observations });

  assert.deepEqual(again, forward);
  const byId = report => Object.fromEntries(report.results.map(result => [result.id, result.status]));
  assert.deepEqual(byId(backward), byId(forward));
  assert.equal(forward.results[0].status, 'match');
  assert.equal(forward.results[1].status, 'mismatch');
});

// ---- event preview --------------------------------------------------------

test('ADVANCED / HOLD / SOON propose a new state without touching the snapshot', () => {
  for (const type of ['ADVANCED', 'HOLD', 'SOON']) {
    const snapshot = rawSource();
    const frozen = JSON.stringify(snapshot);
    const preview = previewShadowEvent(snapshot, event(type), {
      mode: SHADOW,
      context: CONTEXT,
      today: TODAY,
    });
    assert.equal(preview.status, 'ok', type);
    assert.equal(preview.reviewApplied, true, type);
    assert.equal(preview.proposedState.review_count, 4, type);
    assert.equal(preview.writesPerformed, false);
    assert.equal(JSON.stringify(snapshot), frozen, `${type} must not mutate the snapshot`);
  }
});

test('SKIP and POSTPONE are not described as effective reviews', () => {
  for (const [type, payload] of [['SKIP', undefined], ['POSTPONE', { days: 7 }]]) {
    const preview = previewShadowEvent(rawSource(), event(type, { payload }), {
      mode: SHADOW,
      context: CONTEXT,
      today: TODAY,
    });
    assert.equal(preview.status, 'ok', type);
    assert.equal(preview.reviewApplied, false, type);
    assert.equal(preview.proposedState.review_count, 3, type);
  }
});

test('repeated previews are identical and never increase revision or review_count', () => {
  const snapshot = rawSource();
  const frozen = JSON.stringify(snapshot);
  const first = previewShadowEvent(snapshot, event('ADVANCED'), { mode: SHADOW, context: CONTEXT, today: TODAY });
  const second = previewShadowEvent(snapshot, event('ADVANCED'), { mode: SHADOW, context: CONTEXT, today: TODAY });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.equal(snapshot.review_count, 3);
  assert.equal(snapshot.mf_revision, undefined);
});

test('T19: previews never modify interval, A-Factor, priority, due or not-before', () => {
  const snapshot = rawSource();
  const before = {
    interval: snapshot.interval,
    a_factor: snapshot.a_factor,
    priority: snapshot.priority,
    next_review: snapshot.next_review,
    last_reviewed: snapshot.last_reviewed,
    review_count: snapshot.review_count,
  };
  for (const type of ['ADVANCED', 'HOLD', 'SOON', 'SKIP']) {
    previewShadowEvent(snapshot, event(type), { mode: SHADOW, context: CONTEXT, today: TODAY });
  }
  assert.deepEqual({
    interval: snapshot.interval,
    a_factor: snapshot.a_factor,
    priority: snapshot.priority,
    next_review: snapshot.next_review,
    last_reviewed: snapshot.last_reviewed,
    review_count: snapshot.review_count,
  }, before);
  assert.equal('mf_id' in snapshot, true);
});

test('a temporary identity gets no event proposal and no UUID is created', () => {
  const snapshot = rawSource({ path: 'Sources/Temp.md' });
  delete snapshot.mf_id;
  const preview = previewShadowEvent(snapshot, event('ADVANCED', { topicId: undefined }), {
    mode: SHADOW,
    context: CONTEXT,
    today: TODAY,
  });
  assert.equal(preview.status, 'read-only-limited');
  assert.equal(preview.proposedState, null);
  assert.ok(preview.diagnostics.includes('IDENTITY_NOT_PERSISTENT'));
  assert.equal('mf_id' in snapshot, false);
});

test('a card is not a Topic and is never previewed', () => {
  const preview = previewShadowEvent(rawSource({ type: 'card' }), event('ADVANCED'), {
    mode: SHADOW,
    context: CONTEXT,
    today: TODAY,
  });
  assert.equal(preview.status, 'not-comparable');
  assert.ok(preview.diagnostics.includes('E_UNSUPPORTED_TOPIC_TYPE'));
});

test('an event failure is returned as a diagnostic and changes nothing', () => {
  const snapshot = rawSource();
  const frozen = JSON.stringify(snapshot);
  const preview = previewShadowEvent(snapshot, event('NOT_AN_EVENT'), {
    mode: SHADOW,
    context: CONTEXT,
    today: TODAY,
  });
  assert.equal(preview.status, 'error');
  assert.ok(preview.error.code);
  assert.equal(preview.proposedState, null);
  assert.equal(JSON.stringify(snapshot), frozen);
  const mode = resolveSchedulerMode(SHADOW);
  assert.equal(mode.mode, 'shadow');
});

test('a committed legacy state is only echoed when the caller supplies it', () => {
  const committed = rawSource({ review_count: 4, mf_revision: 1 });
  const preview = previewShadowEvent(rawSource(), event('ADVANCED'), {
    mode: SHADOW,
    context: CONTEXT,
    today: TODAY,
    committedLegacyState: committed,
    committedLegacySource: 'legacy-executed',
  });
  assert.equal(preview.committedSource, 'legacy-executed');
  assert.deepEqual(preview.committedLegacyState, committed);
  assert.notEqual(preview.proposedState, committed);
});

// ---- isolation and performance -------------------------------------------

test('shadow cannot run in legacy or unified mode', () => {
  for (const mode of [undefined, { mode: 'legacy' }, { mode: 'unified' }]) {
    assert.throws(() => compareShadowBatch([rawSource()], {
      mode,
      context: CONTEXT,
      today: TODAY,
      observations: [observation()],
    }), error => error.code === 'E_MODE_NOT_SHADOW');
  }
});

test('a 10k synthetic comparison completes without changing the inputs', () => {
  const snapshots = [];
  const observations = [];
  for (let index = 1; index <= 10000; index += 1) {
    const id = uuid(index);
    snapshots.push({
      type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 2.0,
      review_count: 3, next_review: '24-11-2026', mf_id: id,
      path: `Sources/${id}.md`, basename: id,
    });
    observations.push({ id, source: 'legacy-executed', priority: 50, interval: 8, aFactor: 2, idealDue: '2026-11-24' });
  }
  const frozen = snapshots.length;
  const started = performance.now();
  const report = compare(snapshots, { observations });
  const elapsed = performance.now() - started;
  assert.equal(report.results.length, 10000);
  assert.equal(report.summary.match, 10000);
  assert.ok(elapsed < 30000, `10k comparison took ${elapsed.toFixed(0)}ms`);
  assert.equal(snapshots.length, frozen);
  assert.equal(snapshots[0].mf_id, uuid(1));
  console.log(`[shadow] 10k comparison ${elapsed.toFixed(0)}ms`);
});
