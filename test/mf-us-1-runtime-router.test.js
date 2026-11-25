'use strict';

// PR-10 — single-writer routing across legacy / shadow / unified.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReadingSchedulerRouter, issueSyntheticRuntimeAuthorization } = require('../src/scheduling/index.js');

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

function legacySpy() {
  const calls = [];
  const fn = action => {
    calls.push(action);
    return { status: 'applied', writesPerformed: true, legacy: true };
  };
  fn.calls = calls;
  return fn;
}

test('legacy mode executes the legacy scheduler exactly once', () => {
  const legacy = legacySpy();
  const router = createReadingSchedulerRouter({ config: undefined, legacyScheduler: legacy });
  const result = router.route({ action: 'grade.advanced' });
  assert.equal(result.route, 'legacy');
  assert.equal(result.writesPerformed, true);
  assert.equal(legacy.calls.length, 1);
});

test('shadow executes legacy once and never writes from the comparison', () => {
  const legacy = legacySpy();
  let shadowCalls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: legacy,
    shadowComparator: () => { shadowCalls += 1; return { differences: [] }; },
  });
  const result = router.route({ action: 'grade.advanced' });
  assert.equal(result.route, 'shadow');
  assert.equal(legacy.calls.length, 1);
  assert.equal(shadowCalls, 1);
  assert.equal(result.writesPerformed, true);
});

test('a shadow failure leaves the legacy result intact', () => {
  const legacy = legacySpy();
  const router = createReadingSchedulerRouter({
    config: { mode: 'shadow' },
    legacyScheduler: legacy,
    shadowComparator: () => { throw Object.assign(new Error('boom'), { code: 'E_SHADOW_FAILED' }); },
  });
  const result = router.route({ action: 'grade.advanced' });
  assert.equal(result.legacy.status, 'applied');
  assert.equal(result.shadowError, 'E_SHADOW_FAILED');
  assert.equal(legacy.calls.length, 1);
});

test('unified never calls the legacy scheduler', () => {
  const legacy = legacySpy();
  let executorCalls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: readyConditions(),
    legacyScheduler: legacy,
    unifiedExecutor: action => {
      executorCalls += 1;
      return { status: 'applied', writesPerformed: true, action };
    },
  });
  const result = router.route({ action: 'grade.advanced' });
  assert.equal(result.route, 'unified');
  assert.equal(executorCalls, 1);
  assert.equal(legacy.calls.length, 0, 'legacy must never write in unified mode');
});

test('a blocked unified runtime rejects without touching either writer', () => {
  const legacy = legacySpy();
  let executorCalls = 0;
  const router = createReadingSchedulerRouter({
    config: { mode: 'unified' },
    conditions: {},
    legacyScheduler: legacy,
    unifiedExecutor: () => { executorCalls += 1; return { status: 'applied', writesPerformed: true }; },
  });
  const result = router.route({ action: 'grade.advanced' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'E_RUNTIME_MODE_BLOCKED');
  assert.equal(legacy.calls.length, 0);
  assert.equal(executorCalls, 0);
});

test('missing writers are rejected instead of silently falling back', () => {
  const router = createReadingSchedulerRouter({ config: undefined });
  const result = router.route({ action: 'grade.advanced' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'E_LEGACY_SCHEDULER_MISSING');
});
