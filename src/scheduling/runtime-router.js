'use strict';

// Single reading-scheduler router (PR-10).
//
// All writers are awaited. Legacy and shadow always execute the legacy writer
// exactly once; shadow compares only after the legacy result completed. Unified
// never calls legacy and rejects on failure without falling back. Concurrent
// calls with the same eventId share one in-flight execution.

const { evaluateRuntimeMode } = require('./runtime-mode-guard.js');

function codeOf(error, fallback) {
  return error && error.code ? error.code : fallback;
}

function createReadingSchedulerRouter({ config, conditions = {}, legacyScheduler = null, shadowComparator = null, unifiedExecutor = null } = {}) {
  const evaluation = evaluateRuntimeMode(config, conditions);
  const inflight = new Map();

  async function routeOnce(action) {
    if (evaluation.mode === 'unified') {
      if (!evaluation.allowed) {
        return { route: 'rejected', status: 'rejected', reason: 'E_RUNTIME_MODE_BLOCKED', blockers: evaluation.blockers, writesPerformed: false };
      }
      if (typeof unifiedExecutor !== 'function') {
        return { route: 'rejected', status: 'rejected', reason: 'E_UNIFIED_EXECUTOR_MISSING', writesPerformed: false };
      }
      try {
        const result = await unifiedExecutor(action);
        return { route: 'unified', status: result && result.status, result, writesPerformed: Boolean(result && result.writesPerformed) };
      } catch (error) {
        return { route: 'unified', status: 'failed', reason: codeOf(error, 'E_UNIFIED_FAILED'), writesPerformed: false };
      }
    }

    if (typeof legacyScheduler !== 'function') {
      return { route: 'rejected', status: 'rejected', reason: 'E_LEGACY_SCHEDULER_MISSING', writesPerformed: false };
    }
    let legacyResult;
    try {
      legacyResult = await legacyScheduler(action);
    } catch (error) {
      return { route: evaluation.mode, status: 'failed', reason: codeOf(error, 'E_LEGACY_FAILED'), writesPerformed: false };
    }

    if (evaluation.mode === 'shadow') {
      let shadow = null;
      let shadowError = null;
      if (typeof shadowComparator === 'function') {
        try {
          shadow = await shadowComparator(action, legacyResult);
        } catch (error) {
          shadowError = codeOf(error, 'E_SHADOW_FAILED');
        }
      }
      return {
        route: 'shadow',
        status: legacyResult && legacyResult.status,
        legacy: legacyResult,
        shadow,
        shadowError,
        writesPerformed: Boolean(legacyResult && legacyResult.writesPerformed),
      };
    }
    return { route: 'legacy', status: legacyResult && legacyResult.status, legacy: legacyResult, writesPerformed: Boolean(legacyResult && legacyResult.writesPerformed) };
  }

  async function route(action) {
    if (!action || typeof action !== 'object') {
      return { route: 'rejected', status: 'rejected', reason: 'E_ACTION_REQUIRED', writesPerformed: false };
    }
    const key = action.eventId;
    if (key && inflight.has(key)) {
      const shared = await inflight.get(key);
      return { ...shared, duplicate: true };
    }
    const promise = routeOnce(action);
    if (key) inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (key) inflight.delete(key);
    }
  }

  return { evaluation, route };
}

module.exports = { createReadingSchedulerRouter };
