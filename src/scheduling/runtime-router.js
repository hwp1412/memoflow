'use strict';

// Single reading-scheduler router (PR-10).
//
// All writers are awaited. Legacy and shadow always execute the legacy writer
// exactly once; shadow compares only after a valid legacy observation. Unified
// never calls legacy and rejects on failure without falling back. Concurrent
// calls share one in-flight execution only when the request fingerprint is
// identical; a different request with the same eventId is a conflict.

const { evaluateRuntimeMode } = require('./runtime-mode-guard.js');
const { mapReadingAction } = require('./reading-integration.js');
const { requestFingerprint } = require('./persistent-event-ledger.js');

function codeOf(error, fallback) {
  return error && error.code ? error.code : fallback;
}

// PR-07 comparison needs a real legacy observation. A resolved promise with a
// failed/rejected/uncertain/no-op status is not one. An applied result is valid
// even when writesPerformed is false (an idempotent replay).
const OBSERVABLE_LEGACY_STATUSES = new Set(['applied']);

function actionFingerprint(action) {
  const mapped = mapReadingAction(action);
  return requestFingerprint({
    eventId: action.eventId,
    topicId: action.topicId ?? null,
    type: mapped.type,
    payload: mapped.payload ?? null,
    expectedRevision: action.expectedRevision ?? null,
    algorithmVersion: action.algorithmVersion ?? 1,
    today: action.today ?? null,
    calendarDate: action.calendarDate ?? null,
    dateFormat: action.dateFormat ?? null,
    configDigest: action.configDigest ?? null,
  });
}

function writeOutcomeOf(result) {
  if (!result) return 'none';
  if (result.status === 'uncertain') return 'uncertain';
  return result.writesPerformed ? 'committed' : 'none';
}

function needsRecovery(result) {
  if (!result) return false;
  if (result.status === 'uncertain') return true;
  return Boolean(result.requiresManualRecovery);
}

function createReadingSchedulerRouter({ config, conditions = {}, legacyScheduler = null, shadowComparator = null, unifiedExecutor = null } = {}) {
  const evaluation = evaluateRuntimeMode(config, conditions);
  const inflight = new Map();

  async function routeOnce(action) {
    if (evaluation.mode === 'unified') {
      if (!evaluation.allowed) {
        return { route: 'rejected', status: 'rejected', reason: 'E_RUNTIME_MODE_BLOCKED', blockers: evaluation.blockers, writesPerformed: false, writeOutcome: 'none' };
      }
      if (typeof unifiedExecutor !== 'function') {
        return { route: 'rejected', status: 'rejected', reason: 'E_UNIFIED_EXECUTOR_MISSING', writesPerformed: false, writeOutcome: 'none' };
      }
      try {
        const result = await unifiedExecutor(action);
        return {
          route: 'unified',
          status: result && result.status,
          result,
          writesPerformed: result && result.status === 'uncertain' ? (result.writesPerformed === true ? true : null) : Boolean(result && result.writesPerformed),
          writeOutcome: writeOutcomeOf(result),
          requiresManualRecovery: needsRecovery(result),
        };
      } catch (error) {
        return { route: 'unified', status: 'failed', reason: codeOf(error, 'E_UNIFIED_FAILED'), writesPerformed: false, writeOutcome: 'none' };
      }
    }

    if (typeof legacyScheduler !== 'function') {
      return { route: 'rejected', status: 'rejected', reason: 'E_LEGACY_SCHEDULER_MISSING', writesPerformed: false, writeOutcome: 'none' };
    }
    let legacyResult;
    try {
      legacyResult = await legacyScheduler(action);
    } catch (error) {
      return { route: evaluation.mode, status: 'failed', reason: codeOf(error, 'E_LEGACY_FAILED'), writesPerformed: false, writeOutcome: 'none' };
    }

    const base = {
      status: legacyResult && legacyResult.status,
      writesPerformed: legacyResult && legacyResult.status === 'uncertain'
        ? (legacyResult.writesPerformed === true ? true : null)
        : Boolean(legacyResult && legacyResult.writesPerformed),
      writeOutcome: writeOutcomeOf(legacyResult),
      requiresManualRecovery: needsRecovery(legacyResult),
    };

    if (evaluation.mode === 'shadow') {
      const observable = Boolean(legacyResult && OBSERVABLE_LEGACY_STATUSES.has(legacyResult.status));
      let shadow;
      let shadowError = null;
      if (!observable) {
        shadow = {
          status: 'not-comparable',
          reason: 'LEGACY_OBSERVATION_UNAVAILABLE',
          legacyStatus: legacyResult ? legacyResult.status : null,
        };
      } else if (typeof shadowComparator === 'function') {
        try {
          shadow = await shadowComparator(action, legacyResult);
        } catch (error) {
          shadowError = codeOf(error, 'E_SHADOW_FAILED');
          shadow = { status: 'not-comparable', reason: 'SHADOW_COMPARATOR_FAILED' };
        }
      } else {
        shadow = { status: 'not-comparable', reason: 'SHADOW_COMPARATOR_MISSING' };
      }
      return { route: 'shadow', ...base, legacy: legacyResult, shadow, shadowError };
    }
    return { route: 'legacy', ...base, legacy: legacyResult };
  }

  async function route(action) {
    if (!action || typeof action !== 'object') {
      return { route: 'rejected', status: 'rejected', reason: 'E_ACTION_REQUIRED', writesPerformed: false, writeOutcome: 'none' };
    }
    const key = typeof action.eventId === 'string' ? action.eventId : null;
    const fingerprint = key ? actionFingerprint(action) : null;
    if (key && inflight.has(key)) {
      const shared = inflight.get(key);
      if (shared.fingerprint !== fingerprint) {
        const error = new Error('the event id was already used by a different routing request');
        error.code = 'E_EVENT_ID_CONFLICT';
        error.details = { eventId: key };
        throw error;
      }
      const result = await shared.promise;
      return { ...result, duplicate: true };
    }
    const promise = routeOnce(action);
    if (key) inflight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (key) inflight.delete(key);
    }
  }

  return { evaluation, route };
}

module.exports = { createReadingSchedulerRouter };
