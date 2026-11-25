'use strict';

// Trusted host facade for real Source/Extract scheduling entries (PR-10B).
//
// Legacy and shadow keep the legacy writer; shadow only observes after the
// legacy call completed. Unified is deliberately unreachable here: the host
// service has no production write authorization, so it fails closed before
// running legacy or any new writer.

const { fail } = require('../scheduling/errors.js');
const { evaluateRuntimeMode } = require('../scheduling/runtime-mode-guard.js');
const { requestFingerprint } = require('../scheduling/persistent-event-ledger.js');

function fingerprintOf(descriptor) {
  return requestFingerprint({
    eventId: descriptor.eventId,
    topicId: descriptor.topicId ?? null,
    type: descriptor.action,
    payload: descriptor.payload ?? null,
    expectedRevision: descriptor.expectedRevision ?? null,
    algorithmVersion: 1,
    today: descriptor.today ?? null,
    calendarDate: descriptor.calendarDate ?? null,
    dateFormat: descriptor.dateFormat ?? null,
    configDigest: descriptor.configDigest ?? null,
  });
}

function createHostSchedulerService({ mode = 'legacy', conditions = {}, shadowObserver = null } = {}) {
  const evaluation = evaluateRuntimeMode({ mode }, conditions);
  const inflight = new Map();

  async function execute(descriptor, legacy) {
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.action !== 'string') {
      fail('E_ACTION_REQUIRED', 'a host scheduling action descriptor is required');
    }
    if (typeof legacy !== 'function') fail('E_LEGACY_CALLBACK_REQUIRED', 'a legacy implementation callback is required');

    const key = typeof descriptor.eventId === 'string' ? descriptor.eventId : null;
    const fingerprint = key ? fingerprintOf(descriptor) : null;
    if (key && inflight.has(key)) {
      const shared = inflight.get(key);
      if (shared.fingerprint !== fingerprint) fail('E_EVENT_ID_CONFLICT', 'the event id is used by another host action', { eventId: key });
      return { ...(await shared.promise), duplicate: true };
    }

    const promise = (async () => {
      if (evaluation.mode === 'unified') {
        // No production Unified authorization exists in this branch. Never run
        // the legacy writer as a fallback.
        fail('E_UNIFIED_NOT_AUTHORIZED', 'real Unified writes are not authorized for the host runtime', {
          blockers: evaluation.blockers.map(blocker => blocker.code),
        });
      }
      const result = await legacy();
      if (evaluation.mode === 'shadow' && typeof shadowObserver === 'function') {
        try {
          await shadowObserver(descriptor, result);
        } catch (error) {
          return {
            route: evaluation.mode,
            result,
            writesPerformed: Boolean(result && result.writesPerformed),
            shadowError: error && error.code ? error.code : 'E_SHADOW_FAILED',
          };
        }
      }
      return { route: evaluation.mode, result, writesPerformed: Boolean(result && result.writesPerformed) };
    })();

    if (key) inflight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (key) inflight.delete(key);
    }
  }

  return { mode: evaluation.mode, evaluation, execute };
}

module.exports = { createHostSchedulerService };
