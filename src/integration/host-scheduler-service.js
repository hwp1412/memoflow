'use strict';

// Trusted host facade for real Source/Extract scheduling entries (PR-10B).
//
// Legacy and shadow keep the legacy writer; shadow only observes after a valid
// legacy observation. Unified is deliberately unreachable: the facade has no
// production write authorization, so it fails closed before running legacy or
// any new writer. The mode is read on every call so a settings change takes
// effect immediately without rebuilding the service (in-flight stays stable).

const { fail } = require('../scheduling/errors.js');
const { evaluateRuntimeMode } = require('../scheduling/runtime-mode-guard.js');
const { requestFingerprint } = require('../scheduling/persistent-event-ledger.js');

const OBSERVABLE_STATUS = 'applied';

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

function createHostSchedulerService({ mode = 'legacy', getMode = null, conditions = {}, shadowObserver = null } = {}) {
  const inflight = new Map();

  function currentEvaluation() {
    const currentMode = typeof getMode === 'function' ? getMode() : mode;
    return evaluateRuntimeMode({ mode: currentMode }, conditions);
  }

  async function execute(descriptor, legacy) {
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.action !== 'string') {
      fail('E_ACTION_REQUIRED', 'a host scheduling action descriptor is required');
    }
    if (typeof legacy !== 'function') fail('E_LEGACY_CALLBACK_REQUIRED', 'a legacy implementation callback is required');

    const evaluation = currentEvaluation();
    const key = typeof descriptor.eventId === 'string' ? descriptor.eventId : null;
    const fingerprint = key ? fingerprintOf(descriptor) : null;
    if (key && inflight.has(key)) {
      const shared = inflight.get(key);
      if (shared.fingerprint !== fingerprint) fail('E_EVENT_ID_CONFLICT', 'the event id is used by another host action', { eventId: key });
      return { ...(await shared.promise), duplicate: true };
    }

    const promise = (async () => {
      if (evaluation.mode === 'unified') {
        fail('E_UNIFIED_NOT_AUTHORIZED', 'real Unified writes are not authorized for the host runtime', {
          blockers: evaluation.blockers.map(blocker => blocker.code),
        });
      }
      let result;
      try {
        result = await legacy();
      } catch (error) {
        // A legacy write may have happened before the exception; never report a
        // definite no-write here. The host wrapper rethrows the original error.
        return {
          route: evaluation.mode,
          status: 'uncertain',
          writesPerformed: null,
          writeOutcome: 'uncertain',
          requiresManualRecovery: true,
          reason: error && error.code ? error.code : 'E_LEGACY_FAILED',
          error,
        };
      }

      const status = result && typeof result === 'object' && typeof result.status === 'string' ? result.status : 'unknown';
      const writesPerformed = result && result.writesPerformed === true
        ? true
        : (result && result.writesPerformed === false ? false : null);
      const outcome = {
        route: evaluation.mode,
        result,
        status,
        writesPerformed,
        writeOutcome: writesPerformed === true ? 'committed' : (writesPerformed === false ? 'none' : 'uncertain'),
      };

      if (evaluation.mode === 'shadow') {
        if (status !== OBSERVABLE_STATUS) {
          outcome.shadow = {
            status: 'not-comparable',
            reason: 'LEGACY_OBSERVATION_UNAVAILABLE',
            legacyStatus: status,
          };
        } else if (typeof shadowObserver === 'function') {
          try {
            outcome.shadow = await shadowObserver(descriptor, result);
          } catch (error) {
            outcome.shadow = { status: 'not-comparable', reason: 'SHADOW_COMPARATOR_FAILED' };
            outcome.shadowError = error && error.code ? error.code : 'E_SHADOW_FAILED';
          }
        } else {
          outcome.shadow = { status: 'not-comparable', reason: 'SHADOW_OBSERVER_MISSING' };
        }
      }
      return outcome;
    })();

    if (key) inflight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (key) inflight.delete(key);
    }
  }

  return { execute, currentEvaluation };
}

module.exports = { createHostSchedulerService };
