'use strict';

// Async host runtime: the same durable-ledger contract as host-runtime.js, but
// transporting events through the async Obsidian adapter instead of the
// synthetic in-memory store.
//
// Shared with the sync runtime (no second state machine):
//   * evaluateHostRuntime()       — identical mode/authorization gate
//   * PersistentEventLedger        — identical record lifecycle and fingerprints
//   * applyEvent / buildProjection — identical algorithm and field projection
// Async-only:
//   * await-able Vault read/process, byte-level read-back, async reconcile
//
// Locks mirror host-runtime: a topic with an unresolved durable intent cannot
// accept another event, and an unknown persistence outcome blocks until it is
// re-read and verified.

const { fail } = require('../scheduling/errors.js');
const { PersistentEventLedger, MemoryLedgerStore } = require('../scheduling/index.js');
const { evaluateHostRuntime, blockedTopicsFromLedger } = require('./host-runtime.js');
const { executeUnifiedEventAsync, reconcileUnifiedEventAsync } = require('./host-async-executor.js');

const BLOCKING_STATUSES = new Set(['prepared', 'uncertain', 'requires-manual-recovery', 'conflict']);

function createAsyncHostRuntime({
  mode = 'legacy',
  conditions = {},
  authorization = null,
  storage = null,
  ledger = null,
  capability = null,
  config = null,
  dateFormat = 'DD-MM-YYYY',
  persist = null,
} = {}) {
  const persisted = ledger instanceof PersistentEventLedger
    ? ledger
    : new PersistentEventLedger(new MemoryLedgerStore(ledger && ledger.records ? ledger.records : {}));

  const confirmed = new Set(Object.values(persisted.store.dump())
    .filter(record => record && record.status === 'applied')
    .map(record => record.eventId));
  const topicLocks = new Map();

  function state() {
    return evaluateHostRuntime({ mode, conditions, authorization });
  }

  async function save() {
    if (typeof persist !== 'function') return { ok: false, code: 'E_LEDGER_PERSIST_REQUIRED' };
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
    return null;
  }

  async function execute(request) {
    const evaluation = state();
    if (evaluation.mode !== 'unified') {
      fail('E_MODE_NOT_UNIFIED', 'the async host runtime only executes unified events');
    }
    if (!evaluation.allowed) {
      const error = new Error('the async host runtime is not authorized for a unified write');
      error.code = 'E_HOST_MODE_BLOCKED';
      error.blockers = evaluation.blockers;
      throw error;
    }
    if (!storage) {
      const error = new Error('a trusted async topic storage is required');
      error.code = 'E_STORAGE_REQUIRED';
      throw error;
    }
    if (typeof persist !== 'function') {
      const error = new Error('a durable ledger sink is required for unified writes');
      error.code = 'E_LEDGER_PERSIST_REQUIRED';
      throw error;
    }
    const blocked = unresolved(request.topicId, request);
    if (blocked) return blocked;

    const result = await executeUnifiedEventAsync(request, {
      mode: { mode: 'unified' },
      storage,
      ledger: persisted,
      capability,
      config,
      dateFormat,
      persistIntent: () => save(),
      persistResult: () => save(),
    });

    if (result.status === 'failed' && result.intentPersisted === false) {
      const unknown = result.reason === 'E_INTENT_STATE_UNKNOWN' || result.reason === 'E_LEDGER_SAVE_THREW';
      lockTopic(request.topicId, request.eventId, result.reason, unknown);
    }
    if (result.status === 'uncertain') {
      lockTopic(request.topicId, request.eventId, result.reason || 'E_WRITE_UNCERTAIN', true);
    }
    if (result.status === 'applied' || result.status === 'duplicate' || result.status === 'no-op') {
      confirmed.add(request.eventId);
    }
    return result;
  }

  async function recover() {
    const recovered = [];
    for (const record of Object.values(persisted.store.dump())) {
      if (!record || (record.status !== 'prepared' && record.status !== 'uncertain')) continue;
      const result = await reconcileUnifiedEventAsync(record.eventId, {
        storage,
        ledger: persisted,
        persistResult: () => save(),
      });
      recovered.push({
        eventId: record.eventId,
        status: result.status,
        writesPerformed: result.writesPerformed,
        persisted: result.persisted !== false,
      });
      if (result.status === 'applied' && result.persisted !== false) confirmed.add(record.eventId);
    }
    return { recovered, persisted: recovered.every(entry => entry.persisted !== false), blockedTopicIds: blockedTopicsFromLedger(persisted) };
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
      transport: 'obsidian-async',
    };
  }

  return { execute, recover, view, state, ledger: persisted };
}

function blockedTopics(ledger) {
  return [...new Set(Object.values(ledger.store.dump())
    .filter(record => record && BLOCKING_STATUSES.has(record.status))
    .map(record => record.topicId))];
}

module.exports = { createAsyncHostRuntime, blockedTopics };
