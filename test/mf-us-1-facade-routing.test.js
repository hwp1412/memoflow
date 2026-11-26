'use strict';

// HOST-CLOSURE — regression for the facade precondition bug: in Unified mode a
// legacy callback must not be required, and every main event must reach the
// injected transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostSchedulerService } = require('../src/integration/host-scheduler-service.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const ACTIONS = ['ADVANCED', 'COMPLETE', 'DISMISS', 'POSTPONE', 'MANUAL_SCHEDULE', 'SET_PRIORITY', 'POSTPONE_SUBTREE'];

function descriptor(action, index) {
  return {
    action,
    eventId: uuid(100 + index),
    topicId: uuid(1),
    expectedRevision: 0,
    today: '2026-11-27',
    calendarDate: '2026-11-27',
    payload: null,
  };
}

test('every main event reaches the unified transport with no legacy callback', async () => {
  for (const [index, action] of ACTIONS.entries()) {
    const calls = [];
    const service = createHostSchedulerService({
      getMode: () => 'unified',
      unified: async (request) => { calls.push(request.action); return { status: 'applied' }; },
    });
    const outcome = await service.execute(descriptor(action, index), null);
    assert.equal(calls.length, 1, `${action} must reach the transport`);
    assert.equal(outcome.result.status, 'applied');
  }
});

test('legacy mode still requires a legacy callback', async () => {
  const service = createHostSchedulerService({ getMode: () => 'legacy' });
  await assert.rejects(
    () => service.execute(descriptor('ADVANCED', 0), null),
    error => error.code === 'E_LEGACY_CALLBACK_REQUIRED',
  );
});

test('RESET_CURRENT stays explicitly blocked in unified mode', async () => {
  const service = createHostSchedulerService({
    getMode: () => 'unified',
    unified: async () => ({ status: 'applied' }),
  });
  await assert.rejects(
    () => service.execute(descriptor('RESET_CURRENT', 0), null),
    error => error.code === 'E_RESET_CURRENT_UNDECIDED',
  );
});
