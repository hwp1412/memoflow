'use strict';

// Single reading-scheduler router (PR-10).
//
// In legacy mode the legacy scheduler is the only writer. In shadow mode the
// legacy scheduler still writes and the shadow comparison is read-only. In
// unified mode the legacy scheduler is NEVER called: either the single unified
// writer executes, or the action is rejected.

const { evaluateRuntimeMode } = require('./runtime-mode-guard.js');

function createReadingSchedulerRouter({ config, conditions = {}, legacyScheduler = null, shadowComparator = null, unifiedExecutor = null } = {}) {
  const evaluation = evaluateRuntimeMode(config, conditions);

  function route(action) {
    if (!action || typeof action !== 'object') {
      return { route: 'rejected', status: 'rejected', reason: 'E_ACTION_REQUIRED', writesPerformed: false };
    }

    if (evaluation.mode === 'unified') {
      if (!evaluation.allowed) {
        return { route: 'rejected', status: 'rejected', reason: 'E_RUNTIME_MODE_BLOCKED', blockers: evaluation.blockers, writesPerformed: false };
      }
      if (typeof unifiedExecutor !== 'function') {
        return { route: 'rejected', status: 'rejected', reason: 'E_UNIFIED_EXECUTOR_MISSING', writesPerformed: false };
      }
      const result = unifiedExecutor(action);
      return { route: 'unified', status: result.status, result, writesPerformed: Boolean(result.writesPerformed) };
    }

    // Legacy and shadow both require exactly one legacy execution.
    if (typeof legacyScheduler !== 'function') {
      return { route: 'rejected', status: 'rejected', reason: 'E_LEGACY_SCHEDULER_MISSING', writesPerformed: false };
    }
    const legacyResult = legacyScheduler(action);

    if (evaluation.mode === 'shadow') {
      let shadow = null;
      let shadowError = null;
      if (typeof shadowComparator === 'function') {
        try {
          shadow = shadowComparator(action, legacyResult);
        } catch (error) {
          shadowError = error && error.code ? error.code : 'E_SHADOW_FAILED';
        }
      }
      return {
        route: 'shadow',
        status: legacyResult.status,
        legacy: legacyResult,
        shadow,
        shadowError,
        writesPerformed: Boolean(legacyResult.writesPerformed),
      };
    }

    return { route: 'legacy', status: legacyResult.status, legacy: legacyResult, writesPerformed: Boolean(legacyResult.writesPerformed) };
  }

  return { evaluation, route };
}

module.exports = { createReadingSchedulerRouter };
