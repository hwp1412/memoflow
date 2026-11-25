'use strict';

// PR-10 — single-writer routing across legacy / shadow / unified, async aware.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReadingSchedulerRouter, issueSyntheticRuntimeAuthorization, markPreWriteFailure } = require('../src/scheduling/index.js');

function readyConditions() {
  return {
    migrationComplete: true,
    pendingRecovery: false,
    singleWriterReady: true,
    backupVerified: true,
    userConfirmed: true,
    authorization: issueSyntheticRuntimeAuthorization(),
    storageSupportsCas: true,
  };
}

function legacySpy(result = { status: 'applied', writesPerformed: true }) {
  const calls = [];
  const fn = async action => {
    calls.push(action);
    return typeof result === 'function' ? result(action) : result;
  };
  fn.calls = calls;
  return fn;
}

test('async legacy succeeds once', async () => {
  const legacy = legacySpy();
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.route, 'legacy');
  assert.equal(result.status, 'applied');
  assert.equal(result.writesPerformed, true);
  assert.equal(legacy.calls.length, 1);
});

test('an async legacy failure is not reported as a success', async () => {
  const legacy = async () => { throw Object.assign(new Error('nope'), { code: 'E_LEGACY_REJECTED' }); };
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'E_LEGACY_REJECTED');
  assert.equal(result.writesPerformed, null);
  assert.equal(result.writeOutcome, 'uncertain');
  assert.equal(result.requiresManualRecovery, true);
});

test('async shadow waits for the legacy result and passes it to the comparator', async () => {
  let observed = null;
  const legacy = legacySpy({ status: 'applied', writesPerformed: true, legacy: true });
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: legacy,
    shadowComparator: async (action, legacyResult) => {
      observed = legacyResult;
      return { differences: [] };
    },
  });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.route, 'shadow');
  assert.equal(legacy.calls.length, 1);
  assert.equal(observed.legacy, true);
});

test('an async shadow rejection is isolated from the legacy result', async () => {
  const legacy = legacySpy();
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: legacy,
    shadowComparator: async () => { throw Object.assign(new Error('boom'), { code: 'E_SHADOW_FAILED' }); },
  });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.legacy.status, 'applied');
  assert.equal(result.shadowError, 'E_SHADOW_FAILED');
  assert.equal(legacy.calls.length, 1);
});

test('async unified success never calls legacy', async () => {
  const legacy = legacySpy();
  let executorCalls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: readyConditions(),
    legacyScheduler: legacy,
    unifiedExecutor: async action => {
      executorCalls += 1;
      return { status: 'applied', writesPerformed: true, action };
    },
  });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.route, 'unified');
  assert.equal(executorCalls, 1);
  assert.equal(legacy.calls.length, 0);
});

test('async unified failure still leaves legacy at zero calls', async () => {
  const legacy = legacySpy();
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: readyConditions(),
    legacyScheduler: legacy,
    unifiedExecutor: async () => { throw Object.assign(new Error('x'), { code: 'E_UNIFIED_REJECTED' }); },
  });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, null);
  assert.equal(result.writeOutcome, 'uncertain');
  assert.equal(legacy.calls.length, 0);
});

test('concurrent clicks with one eventId execute legacy once', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const legacy = async action => {
    calls.push(action);
    await gate;
    return { status: 'applied', writesPerformed: true };
  };
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const first = router.route({ action: 'grade.advanced', eventId: '00000000-0000-4000-8000-000000009001' });
  const second = router.route({ action: 'grade.advanced', eventId: '00000000-0000-4000-8000-000000009001' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a.status, 'applied');
  assert.equal(b.duplicate, true);
});

test('a blocked unified runtime rejects without touching either writer', async () => {
  const legacy = legacySpy();
  let executorCalls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: {},
    legacyScheduler: legacy,
    unifiedExecutor: async () => { executorCalls += 1; return { status: 'applied', writesPerformed: true }; },
  });
  const result = await router.route({ action: 'grade.advanced' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'E_RUNTIME_MODE_BLOCKED');
  assert.equal(legacy.calls.length, 0);
  assert.equal(executorCalls, 0);
});

// ---- in-flight identity and shadow observation validity (final review) ----

function delayedLegacy() {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fn = async action => {
    calls.push(action);
    await gate;
    return { status: 'applied', writesPerformed: true };
  };
  fn.calls = calls;
  fn.release = release;
  return fn;
}

function action(eventId, overrides = {}) {
  return {
    action: 'grade.advanced',
    eventId,
    topicId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 1,
    today: '2026-11-24',
    calendarDate: '2026-11-24',
    ...overrides,
  };
}

const E1 = '00000000-0000-4000-8000-000000009001';

test('concurrent same eventId with different topic ids is a conflict', async () => {
  const legacy = delayedLegacy();
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const first = router.route(action(E1));
  const second = router.route(action(E1, { topicId: '00000000-0000-4000-8000-000000000002' }));
  legacy.release();
  await assert.rejects(second, error => error.code === 'E_EVENT_ID_CONFLICT');
  assert.equal((await first).status, 'applied');
  assert.equal(legacy.calls.length, 1);
});

test('concurrent same eventId with different action types is a conflict', async () => {
  const legacy = delayedLegacy();
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const first = router.route(action(E1));
  const second = router.route(action(E1, { action: 'dismiss' }));
  legacy.release();
  await assert.rejects(second, error => error.code === 'E_EVENT_ID_CONFLICT');
  await first;
  assert.equal(legacy.calls.length, 1);
});

test('concurrent same eventId with different postpone durations is a conflict', async () => {
  const legacy = delayedLegacy();
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const first = router.route(action(E1, { action: 'postpone', days: 3 }));
  const second = router.route(action(E1, { action: 'postpone', days: 7 }));
  legacy.release();
  await assert.rejects(second, error => error.code === 'E_EVENT_ID_CONFLICT');
  await first;
  assert.equal(legacy.calls.length, 1);
});

test('concurrent same eventId with different revision, dates or format is a conflict', async () => {
  const variations = [
    { expectedRevision: 2 },
    { today: '2026-11-25' },
    { calendarDate: '2026-11-18' },
    { dateFormat: 'YYYY-MM-DD' },
  ];
  for (const variation of variations) {
    const legacy = delayedLegacy();
    const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
    const first = router.route(action(E1));
    const second = router.route(action(E1, variation));
    legacy.release();
    await assert.rejects(second, error => error.code === 'E_EVENT_ID_CONFLICT', JSON.stringify(variation));
    await first;
    assert.equal(legacy.calls.length, 1);
  }
});

test('identical concurrent requests still execute legacy once', async () => {
  const legacy = delayedLegacy();
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const first = router.route(action(E1));
  const second = router.route(action(E1));
  legacy.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(legacy.calls.length, 1);
  assert.equal(a.status, 'applied');
  assert.equal(b.duplicate, true);
});

test('different event ids run independently', async () => {
  let calls = 0;
  const router = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => { calls += 1; return { status: 'applied', writesPerformed: true }; },
  });
  await Promise.all([
    router.route(action('00000000-0000-4000-8000-000000009002')),
    router.route(action('00000000-0000-4000-8000-000000009003')),
  ]);
  assert.equal(calls, 2);
});

test('a conflicting unified request never falls back to legacy', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let executorCalls = 0;
  const legacy = legacySpy();
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: readyConditions(),
    legacyScheduler: legacy,
    unifiedExecutor: async () => { executorCalls += 1; await gate; return { status: 'applied', writesPerformed: true }; },
  });
  const first = router.route(action(E1));
  const second = router.route(action(E1, { topicId: '00000000-0000-4000-8000-000000000002' }));
  release();
  await assert.rejects(second, error => error.code === 'E_EVENT_ID_CONFLICT');
  await first;
  assert.equal(executorCalls, 1);
  assert.equal(legacy.calls.length, 0);
});

function shadowRouter(legacyResult, comparator) {
  return createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: async () => legacyResult,
    shadowComparator: comparator,
  });
}

test('failed or rejected legacy results never produce a shadow match', async () => {
  for (const legacyResult of [
    { status: 'failed', writesPerformed: false },
    { status: 'rejected', writesPerformed: false },
    { status: 'conflict', writesPerformed: false },
    { status: 'no-op', writesPerformed: false },
  ]) {
    let compared = 0;
    const router = shadowRouter(legacyResult, () => { compared += 1; return { differences: [] }; });
    const result = await router.route(action(E1));
    assert.equal(compared, 0, legacyResult.status);
    assert.equal(result.shadow.status, 'not-comparable', legacyResult.status);
    assert.equal(result.shadow.reason, 'LEGACY_OBSERVATION_UNAVAILABLE', legacyResult.status);
  }
});

test('a rejected legacy promise performs no shadow comparison', async () => {
  let compared = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: async () => { throw Object.assign(new Error('x'), { code: 'E_LEGACY_FAILED' }); },
    shadowComparator: () => { compared += 1; },
  });
  const result = await router.route(action(E1));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, null);
  assert.equal(result.shadow.status, 'not-comparable');
  assert.equal(result.shadow.reason, 'LEGACY_OUTCOME_UNCERTAIN');
  assert.equal(compared, 0);
});

test('a valid applied observation is compared after legacy completed', async () => {
  let sawObserved = null;
  const router = shadowRouter({ status: 'applied', writesPerformed: false, token: 'observed' }, (action, observed) => {
    sawObserved = observed;
    return { differences: [] };
  });
  const result = await router.route(action(E1));
  assert.equal(sawObserved.token, 'observed');
  assert.deepEqual(result.shadow, { differences: [] });
  assert.equal(result.writesPerformed, false);
});

test('an uncertain legacy write is never reported as a clean failure or success', async () => {
  const router = shadowRouter({ status: 'uncertain', writesPerformed: true }, () => { throw new Error('should not compare'); });
  const result = await router.route(action(E1));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, true);
  assert.equal(result.writeOutcome, 'uncertain');
  assert.equal(result.requiresManualRecovery, true);
  assert.equal(result.shadow.status, 'not-comparable');
});

test('an unknown legacy write outcome is reported as null, not false', async () => {
  const router = shadowRouter({ status: 'uncertain' }, () => ({ differences: [] }));
  const result = await router.route(action(E1));
  assert.equal(result.writesPerformed, null);
  assert.equal(result.writeOutcome, 'uncertain');
});

test('a shadow comparator rejection leaves legacy at one call', async () => {
  let calls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: async () => { calls += 1; return { status: 'applied', writesPerformed: true }; },
    shadowComparator: async () => { throw Object.assign(new Error('boom'), { code: 'E_SHADOW_FAILED' }); },
  });
  const result = await router.route(action(E1));
  assert.equal(calls, 1);
  assert.equal(result.shadowError, 'E_SHADOW_FAILED');
  assert.equal(result.shadow.status, 'not-comparable');
});

// ---- post-exception write state is conservative (final review) -----------

test('a legacy side effect followed by a rejection is uncertain, not "no write"', async () => {
  let sideEffects = 0;
  const router = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => {
      sideEffects += 1; // write happened, then the confirmation failed
      throw Object.assign(new Error('confirmation failed'), { code: 'E_CONFIRM_FAILED' });
    },
  });
  const result = await router.route(action(E1));
  assert.equal(sideEffects, 1);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, null);
  assert.equal(result.writeOutcome, 'uncertain');
  assert.equal(result.requiresManualRecovery, true);
  assert.equal(result.reason, 'E_CONFIRM_FAILED');
});

test('a shadow legacy side effect followed by a rejection never compares', async () => {
  let sideEffects = 0;
  let compared = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: async () => {
      sideEffects += 1;
      throw Object.assign(new Error('confirm'), { code: 'E_CONFIRM_FAILED' });
    },
    shadowComparator: () => { compared += 1; },
  });
  const result = await router.route(action(E1));
  assert.equal(sideEffects, 1);
  assert.equal(compared, 0);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.shadow.status, 'not-comparable');
  assert.equal(result.shadow.reason, 'LEGACY_OUTCOME_UNCERTAIN');
});

test('a unified side effect followed by a rejection stays unified and uncertain', async () => {
  let sideEffects = 0;
  let legacyCalls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: readyConditions(),
    legacyScheduler: async () => { legacyCalls += 1; return { status: 'applied', writesPerformed: true }; },
    unifiedExecutor: async () => {
      sideEffects += 1;
      throw Object.assign(new Error('confirm'), { code: 'E_UNIFIED_CONFIRM_FAILED' });
    },
  });
  const result = await router.route(action(E1));
  assert.equal(sideEffects, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(result.route, 'unified');
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, null);
  assert.equal(result.writeOutcome, 'uncertain');
  assert.equal(result.requiresManualRecovery, true);
});

test('a trusted pre-write failure may report a definite no-write', async () => {
  const error = markPreWriteFailure(Object.assign(new Error('validation'), { code: 'E_PRE_WRITE_INVALID' }));
  const router = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => { throw error; },
  });
  const result = await router.route(action(E1));
  assert.equal(result.status, 'failed');
  assert.equal(result.writesPerformed, false);
  assert.equal(result.writeOutcome, 'none');
  assert.equal(result.requiresManualRecovery, false);
});

test('a forged pre-write marker is not trusted', async () => {
  const router = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => { throw { code: 'E_PRE_WRITE_INVALID', preWrite: true, noWrite: true }; },
  });
  const result = await router.route(action(E1));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.writesPerformed, null);
});

test('a resolved failed result remains failed, while applied and no-op are unchanged', async () => {
  const failed = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => ({ status: 'failed', writesPerformed: false }),
  });
  const failedResult = await failed.route(action(E1));
  assert.equal(failedResult.status, 'failed');
  assert.equal(failedResult.writesPerformed, false);
  assert.equal(failedResult.writeOutcome, 'none');

  const applied = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => ({ status: 'applied', writesPerformed: true }),
  });
  const appliedResult = await applied.route(action(E1));
  assert.equal(appliedResult.status, 'applied');
  assert.equal(appliedResult.writesPerformed, true);

  const noop = createReadingSchedulerRouter({
    config: undefined,
    legacyScheduler: async () => ({ status: 'no-op', writesPerformed: false }),
  });
  const noopResult = await noop.route(action(E1));
  assert.equal(noopResult.status, 'no-op');
  assert.equal(noopResult.writesPerformed, false);
});
