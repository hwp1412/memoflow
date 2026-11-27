'use strict';

// Production-shaped host runtime for the MF-US-1 single writer (closure).
//
// Real Unified activation stays locked: a runtime only becomes writable when
// the caller supplies a synthetic authorization token issued by this module
// AND every migration/backup/recovery/storage/single-writer/user condition
// holds. The synthetic token exists for isolated tests only.

const { executeUnifiedEvent, reconcileUnifiedEvent, PersistentEventLedger, MemoryLedgerStore, SyntheticUnifiedStorage } = require('../scheduling/index.js');
const { evaluateRuntimeMode, issueSyntheticRuntimeAuthorization } = require('../scheduling/runtime-mode-guard.js');

const SYNTHETIC_HOST_AUTHORIZATIONS = new WeakSet();
const BLOCKING_STATUSES = new Set(['prepared', 'uncertain', 'requires-manual-recovery', 'conflict']);

function issueSyntheticHostAuthorization() {
  const token = Object.freeze({ kind: 'synthetic-host-runtime-authorization' });
  SYNTHETIC_HOST_AUTHORIZATIONS.add(token);
  return token;
}

function hasSyntheticHostAuthorization(token) {
  return Boolean(token && typeof token === 'object' && SYNTHETIC_HOST_AUTHORIZATIONS.has(token));
}

// Session-level invalidation: deleting the token from the module registry makes
// ALREADY CAPTURED references fail every subsequent per-write check.
function revokeSyntheticHostAuthorization(token) {
  if (!token || typeof token !== 'object') return false;
  return SYNTHETIC_HOST_AUTHORIZATIONS.delete(token);
}

function evaluateHostRuntime({ mode = 'legacy', conditions = {}, authorization = null } = {}) {
  const synthetic = hasSyntheticHostAuthorization(authorization);
  const runtimeConditions = {
    ...conditions,
    authorization: synthetic ? issueSyntheticRuntimeAuthorization() : undefined,
  };
  const evaluation = evaluateRuntimeMode({ mode }, runtimeConditions);
  const blockers = evaluation.blockers.map(blocker => blocker.code);
  if (mode === 'unified' && !synthetic) blockers.push('PRODUCTION_WRITE_UNAUTHORIZED');
  return {
    mode: evaluation.mode,
    allowed: blockers.length === 0,
    blockers,
    synthetic,
  };
}

function blockedTopicsFromLedger(ledger) {
  const records = ledger && ledger.store ? ledger.store.dump() : {};
  return [...new Set(Object.values(records)
    .filter(record => BLOCKING_STATUSES.has(record.status))
    .map(record => record.topicId))];
}

function createHostRuntime({ mode = 'legacy', conditions = {}, authorization = null, storage, ledger, capability, persist = null, shadowObserver = null } = {}) {
  const persisted = ledger instanceof PersistentEventLedger
    ? ledger
    : new PersistentEventLedger(new MemoryLedgerStore(ledger && ledger.records ? ledger.records : {}));

  const confirmed = new Set(Object.keys(persisted.store.dump()));
  const topicLocks = new Map();

  function state() {
    return evaluateHostRuntime({ mode, conditions, authorization });
  }

  async function save() {
    if (typeof persist !== 'function') return { ok: true };
    try {
      return await persist(persisted.store.dump());
    } catch (error) {
      return { ok: false, code: 'E_LEDGER_SAVE_THREW', message: error && error.message };
    }
  }

  function lockTopic(topicId, eventId, reason, unknown = false) {
    topicLocks.set(topicId, { eventId, reason, unknown });
  }

  function unresolved(topicId, request) {
    const lock = topicLocks.get(topicId);
    if (!lock) return null;
    if (lock.unknown) {
      return {
        status: 'requires-manual-recovery', duplicate: false, writesPerformed: false,
        reason: 'E_TOPIC_INTENT_STATE_UNKNOWN', lockedEventId: lock.eventId,
      };
    }
    if (lock.eventId !== request.eventId) {
      return {
        status: 'failed', duplicate: false, writesPerformed: false,
        reason: 'E_TOPIC_INTENT_UNRESOLVED', lockedEventId: lock.eventId,
      };
    }
    return null; // same event may retry the durable intent save
  }

  async function saveIntent(record) {
    persisted.store.put(record.eventId, record);
    const saved = await save();
    if (!saved || !saved.ok) {
      const unknown = !saved || saved.code === 'E_LEDGER_SAVE_THREW' || saved.code === 'E_LEDGER_SAVE_UNKNOWN';
      // Keep the unconfirmed record in memory; the topic lock and the missing
      // durable-confirmation flag prevent any CAS bypass.
      lockTopic(record.topicId, record.eventId, unknown ? 'E_INTENT_STATE_UNKNOWN' : 'E_INTENT_PERSIST_FAILED', unknown);
      return { ok: false, code: unknown ? 'E_INTENT_STATE_UNKNOWN' : 'E_INTENT_PERSIST_FAILED' };
    }
    confirmed.add(record.eventId);
    topicLocks.delete(record.topicId);
    return { ok: true };
  }

  // Plan the exact write on a detached storage clone + throwaway ledger, so the
  // prepared record (beforeHash/expectedAfterHash/fields) can be persisted
  // BEFORE the real topic CAS. Only the synthetic storage can be cloned; any
  // other backend fails closed because intent planning is unavailable.
  function planIntent(request) {
    if (!(storage instanceof SyntheticUnifiedStorage)) return null;
    const clone = new SyntheticUnifiedStorage(Object.fromEntries(
      [...storage.files.entries()].map(([filePath, entry]) => [filePath, {
        mfId: entry.mfId, revision: entry.revision, frontmatter: entry.frontmatter, body: entry.body,
      }]),
    ));
    const tempLedger = new PersistentEventLedger(new MemoryLedgerStore());
    const planned = executeUnifiedEvent(request, {
      mode: { mode: 'unified' }, storage: clone, ledger: tempLedger, capability,
    });
    if (planned.status !== 'applied' || !planned.writesPerformed) return { planned, record: null };
    return { planned, record: tempLedger.get(request.eventId) };
  }

  async function execute(request, { legacy = null, shadow = null } = {}) {
    const evaluation = state();
    if (evaluation.mode === 'unified') {
      if (!evaluation.allowed) {
        const error = new Error('the host runtime is not authorized for a unified write');
        error.code = 'E_HOST_MODE_BLOCKED';
        error.blockers = evaluation.blockers;
        throw error;
      }
      if (typeof persist !== 'function') {
        const error = new Error('a durable ledger sink is required for unified writes');
        error.code = 'E_LEDGER_PERSIST_REQUIRED';
        throw error;
      }
      const blocked = unresolved(request.topicId, request);
      if (blocked) return blocked;

      if (!confirmed.has(request.eventId)) {
        let planned = null;
        if (!persisted.get(request.eventId)) {
          const intent = planIntent(request);
          if (intent === null) {
            return { status: 'failed', duplicate: false, writesPerformed: false, reason: 'E_INTENT_PLAN_UNAVAILABLE' };
          }
          planned = intent.record;
        }
        const record = persisted.get(request.eventId) || (planned
          ? { ...planned, status: 'prepared', afterHash: null, actualRevision: null, result: null }
          : null);
        if (record) {
          const intentSave = await saveIntent(record);
          if (!intentSave.ok) {
            return { status: 'failed', duplicate: false, writesPerformed: false, reason: intentSave.code };
          }
        }
      }

      const result = executeUnifiedEvent(request, {
        mode: { mode: 'unified' }, storage, ledger: persisted, capability,
      });

      if (result.status === 'applied' || result.status === 'duplicate' || result.status === 'no-op') {
        const flush = await save();
        if (!flush || !flush.ok) {
          lockTopic(request.topicId, request.eventId, 'E_APPLIED_PERSIST_FAILED', false);
          return { ...result, status: 'uncertain', writesPerformed: result.writesPerformed !== false, ledgerError: flush && flush.code };
        }
        confirmed.add(request.eventId);
      }
      return result;
    }
    if (typeof legacy !== 'function') {
      const error = new Error('legacy callback required');
      error.code = 'E_LEGACY_CALLBACK_REQUIRED';
      throw error;
    }
    const result = await legacy();
    if (evaluation.mode === 'shadow' && typeof shadowObserver === 'function' && result && result.status === 'applied') {
      try {
        await shadowObserver(request, result);
      } catch (error) {
        return { ...result, shadowError: error && error.code ? error.code : 'E_SHADOW_FAILED' };
      }
    }
    return result;
  }

  async function recover() {
    const records = persisted.store.dump();
    const recovered = [];
    for (const record of Object.values(records)) {
      if (record.status !== 'prepared' && record.status !== 'uncertain') continue;
      const result = reconcileUnifiedEvent(record.eventId, { storage, ledger: persisted });
      recovered.push({ eventId: record.eventId, status: result.status, writesPerformed: result.writesPerformed });
    }
    let persistedOk = true;
    if (recovered.length) {
      const saved = await save();
      if (!saved || !saved.ok) {
        persistedOk = false;
        for (const entry of recovered) {
          const record = persisted.get(entry.eventId);
          if (record) lockTopic(record.topicId, record.eventId, 'E_RECOVERY_PERSIST_FAILED', false);
        }
      } else {
        for (const entry of recovered) confirmed.add(entry.eventId);
      }
    }
    return { recovered, persisted: persistedOk, blockedTopicIds: blockedTopicsFromLedger(persisted) };
  }

  function view() {
    const evaluation = state();
    return {
      mode: evaluation.mode,
      allowed: evaluation.allowed,
      blockers: evaluation.blockers,
      synthetic: evaluation.synthetic,
      blockedTopicIds: blockedTopicsFromLedger(persisted),
      writeEnabled: evaluation.mode === 'unified' && evaluation.allowed,
    };
  }

  return { execute, recover, view, state, ledger: persisted };
}

module.exports = {
  issueSyntheticHostAuthorization,
  hasSyntheticHostAuthorization,
  revokeSyntheticHostAuthorization,
  evaluateHostRuntime,
  createHostRuntime,
  blockedTopicsFromLedger,
};
