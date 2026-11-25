'use strict';

// PR-10B — host scheduling facade: legacy, shadow and fail-closed unified.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostSchedulerService } = require('../src/integration/host-scheduler-service.js');
const { uuid } = require('./helpers/unified-fixtures.js');

test('legacy runs the original implementation exactly once', async () => {
  let calls = 0;
  const service = createHostSchedulerService({ mode: 'legacy' });
  const result = await service.execute({ action: 'COMPLETE' }, async () => {
    calls += 1;
    return { writesPerformed: true, status: 'done' };
  });
  assert.equal(calls, 1);
  assert.equal(result.route, 'legacy');
  assert.equal(result.result.status, 'done');
});

test('shadow runs legacy once and observes only after it completed', async () => {
  const events = [];
  const service = createHostSchedulerService({
    mode: 'shadow',
    shadowObserver: async (descriptor, result) => {
      events.push(['observer', descriptor.action, result.status]);
    },
  });
  const outcome = await service.execute({ action: 'ADVANCED', eventId: uuid(1) }, async () => {
    events.push(['legacy']);
    return { status: 'applied', writesPerformed: true };
  });
  assert.deepEqual(events, [['legacy'], ['observer', 'ADVANCED', 'applied']]);
  assert.equal(outcome.route, 'shadow');
});

test('a shadow observer failure is diagnostic only', async () => {
  const service = createHostSchedulerService({
    mode: 'shadow',
    shadowObserver: async () => { throw Object.assign(new Error('x'), { code: 'E_SHADOW_FAILED' }); },
  });
  const outcome = await service.execute({ action: 'ADVANCED' }, async () => ({ status: 'applied', writesPerformed: true }));
  assert.equal(outcome.shadowError, 'E_SHADOW_FAILED');
  assert.equal(outcome.result.writesPerformed, true);
});

test('unified is always refused and never runs legacy in this branch', async () => {
  for (const conditions of [{}, { migrationComplete: true, singleWriterReady: true }]) {
    let calls = 0;
    const service = createHostSchedulerService({ mode: 'unified', conditions });
    await assert.rejects(
      service.execute({ action: 'COMPLETE' }, async () => { calls += 1; return { writesPerformed: true }; }),
      error => error.code === 'E_UNIFIED_NOT_AUTHORIZED'
    );
    assert.equal(calls, 0);
  }
});

test('resetCurrent is blocked in unified instead of being remapped', async () => {
  const service = createHostSchedulerService({ mode: 'unified' });
  await assert.rejects(
    service.execute({ action: 'RESET_CURRENT' }, async () => ({ writesPerformed: true })),
    error => error.code === 'E_UNIFIED_NOT_AUTHORIZED'
  );
});

test('one event id with different host requests conflicts before writing', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = createHostSchedulerService({ mode: 'legacy' });
  const eventId = uuid(2);
  const first = service.execute({ action: 'ADVANCED', eventId, topicId: uuid(3) }, async () => {
    calls += 1;
    await gate;
    return { writesPerformed: true };
  });
  const second = service.execute({ action: 'DISMISS', eventId, topicId: uuid(3) }, async () => {
    calls += 1;
    return { writesPerformed: true };
  });
  release();
  await assert.rejects(second, error => error.code === 'E_EVENT_ID_CONFLICT');
  await first;
  assert.equal(calls, 1);
});

test('identical concurrent host requests execute once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = createHostSchedulerService({ mode: 'legacy' });
  const descriptor = { action: 'ADVANCED', eventId: uuid(4), topicId: uuid(5) };
  const first = service.execute(descriptor, async () => { calls += 1; await gate; return { writesPerformed: true }; });
  const second = service.execute(descriptor, async () => { calls += 1; return { writesPerformed: true }; });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(b.duplicate, true);
  assert.equal(a.result.writesPerformed, true);
});

// ---- observation validity and live mode refresh (review fixes 4/5) -------

test('failed, no-op and void legacy results never produce a shadow match', async () => {
  for (const legacyResult of [
    { status: 'failed', writesPerformed: false },
    { status: 'no-op', writesPerformed: false },
    { status: 'uncertain', writesPerformed: true },
    undefined,
  ]) {
    let compared = 0;
    const service = createHostSchedulerService({
      mode: 'shadow',
      shadowObserver: () => { compared += 1; return { differences: [] }; },
    });
    const outcome = await service.execute({ action: 'ADVANCED' }, async () => legacyResult);
    assert.equal(compared, 0);
    assert.equal(outcome.shadow.status, 'not-comparable');
    assert.equal(outcome.shadow.reason, 'LEGACY_OBSERVATION_UNAVAILABLE');
  }
});

test('a legacy exception is uncertain and preserves the original error', async () => {
  const service = createHostSchedulerService({ mode: 'legacy' });
  const error = Object.assign(new Error('after write'), { code: 'E_CONFIRM_FAILED' });
  const outcome = await service.execute({ action: 'ADVANCED' }, async () => { throw error; });
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.writesPerformed, null);
  assert.equal(outcome.writeOutcome, 'uncertain');
  assert.equal(outcome.requiresManualRecovery, true);
  assert.equal(outcome.reason, 'E_CONFIRM_FAILED');
  assert.equal(outcome.error, error);
});

test('a mode change is observed on the next call without rebuilding', async () => {
  let setting = 'legacy';
  let legacyCalls = 0;
  const service = createHostSchedulerService({ getMode: () => setting });
  const first = await service.execute({ action: 'COMPLETE' }, async () => {
    legacyCalls += 1;
    return { status: 'applied', writesPerformed: true };
  });
  assert.equal(first.route, 'legacy');

  setting = 'unified';
  await assert.rejects(
    service.execute({ action: 'COMPLETE' }, async () => { legacyCalls += 1; return { writesPerformed: true }; }),
    error => error.code === 'E_UNIFIED_NOT_AUTHORIZED'
  );
  assert.equal(legacyCalls, 1, 'legacy must not run after switching to unified');
});

test('switching to shadow keeps the read-only observation contract', async () => {
  let setting = 'legacy';
  const events = [];
  const service = createHostSchedulerService({
    getMode: () => setting,
    shadowObserver: (descriptor, result) => { events.push(['observe', result.status]); },
  });
  await service.execute({ action: 'ADVANCED' }, async () => { events.push(['legacy']); return { status: 'applied', writesPerformed: true }; });
  setting = 'shadow';
  await service.execute({ action: 'ADVANCED' }, async () => { events.push(['legacy']); return { status: 'applied', writesPerformed: true }; });
  assert.deepEqual(events, [['legacy'], ['legacy'], ['observe', 'applied']]);
});
