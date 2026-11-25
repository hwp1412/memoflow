'use strict';

// PR-07 — Shadow properties and isolation guarantees (SPEC A9, A10.1, T19).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareShadowBatch,
  previewShadowEvent,
  resolveSchedulerMode,
  DEFAULT_MODE,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID3 = '5e9a7c1d-2b4f-4c8e-9f1a-0d3b6e8c2a45';
const TODAY = '2026-11-24';
const CONTEXT = { dateFormat: 'DD-MM-YYYY' };
const SHADOW = { mode: 'shadow' };

function snapshot(overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 2.0,
    review_count: 3, next_review: '24-11-2026', mf_id: UUID,
    path: 'Sources/A.md', basename: 'A',
    ...overrides,
  };
}

function observation(overrides = {}) {
  return { id: UUID, source: 'legacy-executed', priority: 50, interval: 8, aFactor: 2, idealDue: '2026-11-24', ...overrides };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

test('shadow accepts fully frozen snapshots and observations without mutating them', () => {
  const snapshots = deepFreeze([snapshot(), snapshot({ mf_id: UUID2, path: 'Sources/B.md', basename: 'B', interval: 5 })]);
  const observations = deepFreeze([observation(), observation({ id: UUID2, interval: 5 })]);
  const frozenBefore = JSON.stringify(snapshots);
  const report = compareShadowBatch(snapshots, {
    mode: SHADOW, context: CONTEXT, today: TODAY, observations,
  });
  assert.equal(report.summary.total, 2);
  assert.equal(JSON.stringify(snapshots), frozenBefore);
});

test('every shadow result is explicitly read-only', () => {
  const report = compareShadowBatch([snapshot()], {
    mode: SHADOW, context: CONTEXT, today: TODAY, observations: [observation()],
  });
  assert.equal(report.writesPerformed, false);
  assert.equal(report.mode, 'shadow');
  assert.equal(report.authoritativeScheduler, 'legacy');
  assert.equal(report.capabilities.canCommitUnified, false);
  assert.equal(report.capabilities.canComputeShadow, true);
  for (const result of report.results) {
    assert.equal(result.writesPerformed, false);
    assert.ok('id' in result);
    assert.ok(['match', 'mismatch', 'not-comparable'].includes(result.status));
    assert.ok(report.summary.total === report.results.length);
  }
});

test('shadow requires an explicit, valid today and never reads the clock', () => {
  for (const today of [undefined, null, '', '2026-13-01', '2026-02-30']) {
    assert.throws(() => compareShadowBatch([snapshot()], {
      mode: SHADOW, context: CONTEXT, today, observations: [observation()],
    }), error => error.code === 'E_SHADOW_TODAY_REQUIRED', String(today));
  }
  const missingObservations = compareShadowBatch([snapshot()], {
    mode: SHADOW, context: CONTEXT, today: TODAY,
  });
  assert.equal(missingObservations.summary.unavailable, 1);
  assert.ok(missingObservations.results[0].reasons.includes('LEGACY_OBSERVATION_MISSING'));
});

test('legacy and unified modes refuse to compute shadow results', () => {
  for (const mode of [undefined, null, { mode: 'legacy' }, { mode: 'unified' }]) {
    assert.throws(() => compareShadowBatch([snapshot()], {
      mode, context: CONTEXT, today: TODAY, observations: [observation()],
    }), error => error.code === 'E_MODE_NOT_SHADOW');
    assert.throws(() => previewShadowEvent(snapshot(), {
      eventId: UUID3, topicId: UUID, type: 'ADVANCED', expectedRevision: 0,
      algorithmVersion: 1, calendarDate: TODAY,
    }, {
      mode, context: CONTEXT, today: TODAY,
    }), error => error.code === 'E_MODE_NOT_SHADOW');
  }
});

test('an illegal mode never silently falls back to legacy or shadow', () => {
  assert.throws(() => resolveSchedulerMode({ mode: 'shadow-ish' }), error => error.code === 'E_MODE_INVALID');
  assert.equal(resolveSchedulerMode(undefined).mode, DEFAULT_MODE);
});

test('comparison results are reproducible and observation order is irrelevant', () => {
  const snapshots = [snapshot(), snapshot({ mf_id: UUID2, path: 'Sources/B.md', basename: 'B', interval: 5 })];
  const observations = [observation(), observation({ id: UUID2, interval: 9 })];
  const first = compareShadowBatch(snapshots, { mode: SHADOW, context: CONTEXT, today: TODAY, observations });
  const second = compareShadowBatch(snapshots, { mode: SHADOW, context: CONTEXT, today: TODAY, observations });
  const reversed = compareShadowBatch(snapshots, {
    mode: SHADOW, context: CONTEXT, today: TODAY, observations: observations.slice().reverse(),
  });
  assert.deepEqual(second, first);
  assert.deepEqual(reversed.results.map(result => result.status), first.results.map(result => result.status));
  assert.deepEqual(reversed.summary, first.summary);
});

test('event preview requires an explicit event and never invents one', () => {
  for (const event of [undefined, null, [], 'ADVANCED']) {
    assert.throws(() => previewShadowEvent(snapshot(), event, {
      mode: SHADOW, context: CONTEXT, today: TODAY,
    }), error => error.code === 'E_SHADOW_EVENT_REQUIRED', String(event));
  }
});

test('shadow never creates a persisted id for a temporary snapshot', () => {
  const temporary = snapshot({ path: 'Sources/Temp.md' });
  delete temporary.mf_id;
  const report = compareShadowBatch([temporary], {
    mode: SHADOW, context: CONTEXT, today: TODAY, observations: [],
  });
  assert.equal(report.results[0].identityKind, 'temporary');
  assert.equal(report.results[0].persistentIdentity, false);
  assert.equal('mf_id' in temporary, false);

  const preview = previewShadowEvent(temporary, {
    eventId: UUID3, topicId: 'ignored', type: 'ADVANCED', expectedRevision: 0,
    algorithmVersion: 1, calendarDate: TODAY,
  }, { mode: SHADOW, context: CONTEXT, today: TODAY });
  assert.equal(preview.status, 'read-only-limited');
  assert.equal('mf_id' in temporary, false);
});

test('a shadow failure leaves the resolved mode and the legacy data untouched', () => {
  const data = snapshot();
  const frozen = JSON.stringify(data);
  assert.throws(() => compareShadowBatch([data], {
    mode: { mode: 'legacy' }, context: CONTEXT, today: TODAY, observations: [observation()],
  }), error => error.code === 'E_MODE_NOT_SHADOW');
  assert.equal(JSON.stringify(data), frozen);
  assert.equal(resolveSchedulerMode(undefined).mode, 'legacy');
  assert.equal(resolveSchedulerMode({ mode: 'unified' }).mode, 'unified');
});
