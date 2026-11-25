'use strict';

// PR-10 — single-writer routing across legacy / shadow / unified, async aware.

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
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'E_LEGACY_REJECTED');
  assert.equal(result.writesPerformed, false);
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
  assert.equal(result.status, 'failed');
  assert.equal(result.writesPerformed, false);
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
