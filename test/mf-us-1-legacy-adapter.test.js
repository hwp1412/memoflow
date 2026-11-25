'use strict';

// PR-06 — read-only legacy adapter (SPEC A2, A8, A10.2).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adaptLegacyTopic,
  adaptLegacyTopics,
  isSchedulableCandidate,
  parseLegacyDate,
  selectDailyQueue,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

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
    path: 'Sources/A.md',
    basename: 'A',
    ...overrides,
  };
}

function rawExtract(overrides = {}) {
  return {
    type: 'extract',
    status: 'active',
    priority: 30,
    interval: 5,
    a_factor: 2.0,
    review_count: 1,
    next_review: '20-11-2026',
    last_reviewed: '10-11-2026',
    parent: '[[A]]',
    source: '[[A]]',
    path: 'Extracts/E1.md',
    basename: 'E1',
    ...overrides,
  };
}

test('a legal legacy Source becomes a ready candidate with mapped dates', () => {
  const result = adaptLegacyTopic(rawSource({ mf_id: UUID }), CONTEXT);
  assert.equal(result.status, 'ready');
  assert.equal(result.topic.type, 'source');
  assert.equal(result.topic.status, 'active');
  assert.equal(result.topic.priority, 50);
  assert.equal(result.topic.mf_ideal_due, '2026-11-24');
  assert.equal(result.topic.mf_interval_days, 8);
  assert.equal(result.topic.a_factor, 2);
  assert.equal(result.topic.review_count, 3);
  assert.equal(result.topic.last_reviewed, '2026-11-01');
  assert.equal(result.topic.mf_not_before, null);
  assert.equal(result.topic.mf_id, UUID);
  assert.equal(result.writesPerformed, false);
  assert.ok(result.lossNotes.includes('NOT_BEFORE_NOT_RECOVERABLE'));
  assert.ok(result.lossNotes.includes('LEGACY_INTERVAL_MAY_INCLUDE_ADMINISTRATIVE_VALUE'));
});

test('review_count=0 never re-runs the initial interval formula', () => {
  const result = adaptLegacyTopic(rawSource({ interval: 13, review_count: 0 }), CONTEXT);
  assert.equal(result.status, 'read-only-limited'); // no persisted id
  assert.equal(result.topic.mf_interval_days, 13);
  assert.notEqual(result.topic.mf_interval_days, 8); // ceil(50 * 0.15)
});

test('missing or illegal Priority is reported, never defaulted to P50', () => {
  for (const priority of [undefined, null]) {
    const result = adaptLegacyTopic(rawSource({ priority }), CONTEXT);
    assert.equal(result.status, 'invalid');
    assert.equal(result.errors[0].code, 'E_LEGACY_PRIORITY_MISSING');
    assert.equal(result.topic, null);
  }
  for (const priority of [0, 101, 1.5, '50']) {
    const result = adaptLegacyTopic(rawSource({ priority }), CONTEXT);
    assert.equal(result.status, 'invalid', String(priority));
    assert.equal(result.errors[0].code, 'E_LEGACY_PRIORITY_INVALID');
  }
});

test('missing or out-of-spec A-Factor is reported, never defaulted', () => {
  const missing = adaptLegacyTopic(rawSource({ a_factor: undefined }), CONTEXT);
  assert.equal(missing.errors[0].code, 'E_LEGACY_AFACTOR_MISSING');
  for (const aFactor of [1.05, 5, 1.0, 3.01, '2.0']) {
    const result = adaptLegacyTopic(rawSource({ a_factor: aFactor }), CONTEXT);
    assert.equal(result.errors[0].code, 'E_LEGACY_AFACTOR_INVALID', String(aFactor));
  }
});

test('missing interval, review_count or next_review is an explicit error', () => {
  assert.equal(adaptLegacyTopic(rawSource({ interval: undefined }), CONTEXT).errors[0].code, 'E_LEGACY_INTERVAL_MISSING');
  assert.equal(adaptLegacyTopic(rawSource({ review_count: undefined }), CONTEXT).errors[0].code, 'E_LEGACY_REVIEW_COUNT_MISSING');
  assert.equal(adaptLegacyTopic(rawSource({ next_review: undefined }), CONTEXT).errors[0].code, 'E_LEGACY_NEXT_REVIEW_MISSING');
});

test('legacy statuses map only when confirmed', () => {
  const active = adaptLegacyTopic(rawSource({ status: 'active' }), CONTEXT);
  assert.equal(active.topic.status, 'active');
  const done = adaptLegacyTopic(rawSource({ status: 'done' }), CONTEXT);
  assert.equal(done.status, 'read-only-limited');
  assert.equal(done.topic.status, 'done');
  const dismissed = adaptLegacyTopic(rawSource({ status: 'dismissed' }), CONTEXT);
  assert.equal(dismissed.topic.status, 'dismissed');

  for (const status of ['inbox', 'pending', 'container', 'archived']) {
    const result = adaptLegacyTopic(rawSource({ status }), CONTEXT);
    assert.equal(result.status, 'unsupported', status);
    assert.ok(['E_UNSUPPORTED_STATUS', 'E_UNKNOWN_STATUS'].includes(result.errors[0].code));
  }
});

test('cards and unknown types are unsupported', () => {
  for (const type of ['card', 'pdf', undefined]) {
    const result = adaptLegacyTopic(rawSource({ type }), CONTEXT);
    assert.equal(result.status, 'unsupported', String(type));
    assert.equal(result.errors[0].code, 'E_UNSUPPORTED_TOPIC_TYPE');
  }
});

test('legacy dates are parsed strictly by the configured format', () => {
  assert.equal(parseLegacyDate('24-11-2026', 'DD-MM-YYYY').iso, '2026-11-24');
  assert.equal(parseLegacyDate('11-24-2026', 'MM-DD-YYYY').iso, '2026-11-24');
  assert.equal(parseLegacyDate('2026-11-24', 'YYYY-MM-DD').iso, '2026-11-24');
  assert.equal(parseLegacyDate('24/11/2026', 'DD/MM/YYYY').iso, '2026-11-24');
  assert.equal(parseLegacyDate('11/24/2026', 'MM/DD/YYYY').iso, '2026-11-24');
});

test('an absent date format is ambiguous, never guessed', () => {
  const result = adaptLegacyTopic(rawSource(), {});
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ambiguities[0].code, 'E_LEGACY_DATE_FORMAT_REQUIRED');
  assert.equal(result.topic, null);
});

test('slash dates are ambiguous without a format and resolvable with one', () => {
  const raw = rawSource({ next_review: '03/04/2026', last_reviewed: '10/11/2026' });
  const ambiguous = adaptLegacyTopic(raw, {});
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(adaptLegacyTopic(raw, { dateFormat: 'DD/MM/YYYY' }).topic.mf_ideal_due, '2026-04-03');
  assert.equal(adaptLegacyTopic(raw, { dateFormat: 'MM/DD/YYYY' }).topic.mf_ideal_due, '2026-03-04');
});

test('impossible and mismatched dates are invalid', () => {
  for (const value of ['31-04-2026', '29-02-2027', '32-01-2026', '2026-02-30']) {
    const result = adaptLegacyTopic(rawSource({ next_review: value }), CONTEXT);
    assert.equal(result.status, 'invalid', value);
    assert.ok(['E_DATE_INVALID', 'E_DATE_FORMAT'].includes(result.errors[0].code), value);
  }
  // Leap day and year boundary are accepted.
  assert.equal(adaptLegacyTopic(rawSource({ next_review: '29-02-2028' }), CONTEXT).topic.mf_ideal_due, '2028-02-29');
  assert.equal(adaptLegacyTopic(rawSource({ next_review: '31-12-2026' }), CONTEXT).topic.mf_ideal_due, '2026-12-31');
});

test('legacy and modern fields that disagree are a conflict', () => {
  const idealConflict = adaptLegacyTopic(rawSource({ mf_ideal_due: '2026-11-25' }), CONTEXT);
  assert.equal(idealConflict.status, 'conflict');
  assert.deepEqual(idealConflict.conflicts[0], { field: 'mf_ideal_due', legacy: '2026-11-24', modern: '2026-11-25' });

  const intervalConflict = adaptLegacyTopic(rawSource({ mf_interval_days: 9 }), CONTEXT);
  assert.equal(intervalConflict.status, 'conflict');
  assert.deepEqual(intervalConflict.conflicts[0], { field: 'mf_interval_days', legacy: 8, modern: 9 });

  const aligned = adaptLegacyTopic(rawSource({ mf_ideal_due: '2026-11-24', mf_interval_days: 8 }), CONTEXT);
  assert.equal(aligned.status, 'read-only-limited'); // aligned fields, but no persisted id yet
  assert.equal(aligned.conflicts.length, 0);
  assert.equal(aligned.fieldSources.mf_ideal_due, 'modern');
});

test('the candidate Effective Due equals the strictly parsed legacy due date', () => {
  const result = adaptLegacyTopic(rawSource({ mf_id: UUID }), CONTEXT);
  assert.equal(result.topic.mf_not_before, null);
  assert.equal(result.topic.mf_ideal_due, '2026-11-24');
  const queue = selectDailyQueue([result.topic], undefined, '2026-11-24');
  assert.deepEqual(queue.selected.map(entry => entry.stableId), [UUID]);
  assert.equal(queue.selected[0].effectiveDue, '2026-11-24');
});

test('estimated_minutes is validated or reported', () => {
  assert.equal(adaptLegacyTopic(rawSource({ estimated_minutes: 5 }), CONTEXT).topic.estimated_minutes, 5);
  for (const value of [0, 121, 1.5]) {
    const result = adaptLegacyTopic(rawSource({ estimated_minutes: value }), CONTEXT);
    assert.equal(result.status, 'invalid', String(value));
    assert.equal(result.errors[0].code, 'E_ESTIMATED_MINUTES_INVALID');
  }
});

test('unparseable date_added is a warning, not a fatal error', () => {
  const result = adaptLegacyTopic(rawSource({ date_added: 'not-a-date' }), CONTEXT);
  assert.ok(result.warnings.some(warning => warning.code === 'DATE_ADDED_UNPARSEABLE'));
  assert.equal(result.status, 'read-only-limited');
  assert.equal(result.topic.date_added, undefined);
});

test('batch adaptation isolates broken notes and reports a summary', () => {
  const report = adaptLegacyTopics([
    rawSource({ mf_id: UUID }),
    null,
    rawSource({ path: 'Sources/B.md', basename: 'B', priority: 0 }),
    rawSource({ path: 'Sources/C.md', basename: 'C', status: 'pending' }),
    rawExtract({ mf_id: UUID2, path: 'Extracts/E1.md', basename: 'E1' }),
  ], CONTEXT);

  assert.equal(report.writesPerformed, false);
  assert.equal(report.results.length, 5);
  assert.equal(report.summary.ready, 2); // source + extract with persisted ids and a resolved parent
  assert.equal(report.summary.invalid, 2); // null + bad priority
  assert.equal(report.summary.unsupported, 1);
  assert.equal(report.summary.readOnlyLimited, 0);
  assert.equal(report.results[0].status, 'ready');
});

test('adaptation never mutates its input and never writes', () => {
  const raw = Object.freeze(rawSource({ mf_id: UUID, tags: Object.freeze(['x']) }));
  const snapshot = JSON.parse(JSON.stringify(raw));
  const report = adaptLegacyTopics(Object.freeze([raw]), CONTEXT);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), snapshot);
  assert.equal(report.writesPerformed, false);
  assert.equal(report.results[0].writesPerformed, false);
});

test('only a ready persistent candidate is schedulable', () => {
  const ready = adaptLegacyTopic(rawSource({ mf_id: UUID }), CONTEXT);
  assert.equal(isSchedulableCandidate(ready), true);

  const temporary = adaptLegacyTopic(rawSource(), CONTEXT);
  assert.equal(temporary.status, 'read-only-limited');
  assert.equal(isSchedulableCandidate(temporary), false);

  const invalid = adaptLegacyTopic(rawSource({ mf_id: 'nope' }), CONTEXT);
  assert.equal(isSchedulableCandidate(invalid), false);
});
