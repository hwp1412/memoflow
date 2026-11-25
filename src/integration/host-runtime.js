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

  function state() {
    return evaluateHostRuntime({ mode, conditions, authorization });
  }

  async function save() {
    if (typeof persist !== 'function') return { ok: true };
    return persist(persisted.store.dump());
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
      if (!persisted.get(request.eventId)) {
        const intent = planIntent(request);
        if (intent === null) {
          return { status: 'failed', duplicate: false, writesPerformed: false, reason: 'E_INTENT_PLAN_UNAVAILABLE' };
        }
        if (intent.record) {
          const prepared = { ...intent.record, status: 'prepared', afterHash: null, actualRevision: null, result: null };
          persisted.store.put(request.eventId, prepared);
          const saved = await save();
          if (!saved || !saved.ok) {
            return { status: 'failed', duplicate: false, writesPerformed: false, reason: 'E_INTENT_PERSIST_FAILED', ledgerError: saved && saved.code };
          }
        }
      }
      const result = executeUnifiedEvent(request, {
        mode: { mode: 'unified' }, storage, ledger: persisted, capability,
      });
      const flush = await save();
      if (!flush.ok && (result.status === 'applied' || result.status === 'duplicate')) {
        return { ...result, status: 'uncertain', writesPerformed: result.writesPerformed !== false, ledgerError: flush.code };
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
    if (recovered.length) await save();
    return { recovered, blockedTopicIds: blockedTopicsFromLedger(persisted) };
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
  evaluateHostRuntime,
  createHostRuntime,
  blockedTopicsFromLedger,
};
