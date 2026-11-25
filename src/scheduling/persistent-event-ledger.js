'use strict';

// Serializable, restart-safe event ledger for the Unified writer (PR-09).
//
// The ledger is an injected store of plain JSON records. A writer instance can
// be recreated from the same store, and the store can be dumped and reloaded
// into a fresh instance, which is how restart idempotency is tested.
//
// Records never contain note bodies, PDF text or absolute paths.

const { fail } = require('./errors.js');
const { sha256Hex, stableStringify } = require('./migration-hash.js');
const { assertTrustedLedgerStore } = require('./unified-store-contract.js');

const LEDGER_STATUSES = Object.freeze([
  'prepared',
  'applied',
  'failed',
  'uncertain',
  'conflict',
  'requires-manual-recovery',
]);

function requestFingerprint(request) {
  return sha256Hex(stableStringify({
    eventId: request.eventId,
    topicId: request.topicId,
    type: request.type,
    payload: request.payload ?? null,
    expectedRevision: request.expectedRevision,
    algorithmVersion: request.algorithmVersion,
    today: request.today,
    calendarDate: request.calendarDate ?? null,
    dateFormat: request.dateFormat ?? null,
    configDigest: request.configDigest ?? null,
  }));
}

function emptyAudit() {
  return {
    eventId: null,
    topicId: null,
    algorithmVersion: null,
    type: null,
    today: null,
    expectedRevision: null,
    actualRevision: null,
    before: {},
    after: {},
    writesPerformed: false,
    result: null,
    reason: null,
    requiresManualRecovery: false,
  };
}

class PersistentEventLedger {
  constructor(store) {
    assertTrustedLedgerStore(store);
    this.store = store;
  }

  get(eventId) {
    return this.store.get(eventId);
  }

  classify(request) {
    const existing = this.store.get(request.eventId);
    if (!existing) return { state: 'new', record: null };
    const fingerprint = requestFingerprint(request);
    if (existing.fingerprint !== fingerprint) {
      return { state: 'conflict', record: existing, reason: 'E_EVENT_ID_CONFLICT' };
    }
    if (existing.status === 'applied') return { state: 'duplicate', record: existing };
    if (existing.status === 'failed') return { state: 'retryable', record: existing };
    return { state: existing.status, record: existing };
  }

  prepare(request, intent) {
    const existing = this.store.get(request.eventId);
    const fingerprint = requestFingerprint(request);
    if (existing && existing.fingerprint !== fingerprint) {
      fail('E_EVENT_ID_CONFLICT', 'the event id is already used by a different request', { eventId: request.eventId });
    }
    if (existing && existing.status === 'applied') return existing;

    const record = {
      eventId: request.eventId,
      topicId: request.topicId,
      fingerprint,
      type: request.type,
      algorithmVersion: request.algorithmVersion,
      expectedRevision: request.expectedRevision,
      today: request.today,
      eventDate: request.calendarDate ?? null,
      status: 'prepared',
      beforeHash: intent.beforeHash,
      expectedAfterHash: intent.expectedAfterHash,
      afterHash: null,
      actualRevision: null,
      fields: intent.fields,
      audit: {
        ...emptyAudit(),
        eventId: request.eventId,
        topicId: request.topicId,
        algorithmVersion: request.algorithmVersion,
        type: request.type,
        today: request.today,
        expectedRevision: request.expectedRevision,
        before: intent.before ?? {},
        after: intent.after ?? {},
      },
      result: null,
      reason: null,
      writeAttempted: false,
    };
    this.store.put(request.eventId, record);
    return record;
  }

  update(eventId, patch) {
    const record = this.store.get(eventId);
    if (!record) fail('E_EVENT_NOT_FOUND', 'the ledger has no such event', { eventId });
    const next = { ...record, ...patch };
    this.store.put(eventId, next);
    return next;
  }

  markApplied(eventId, details) {
    return this.update(eventId, {
      status: 'applied',
      afterHash: details.afterHash ?? null,
      actualRevision: details.actualRevision ?? null,
      result: details.result ?? 'applied',
      reason: null,
      writeAttempted: Boolean(details.writesPerformed),
      writesPerformed: Boolean(details.writesPerformed),
      audit: { ...details.audit, result: details.result ?? 'applied', writesPerformed: Boolean(details.writesPerformed) },
    });
  }

  markFailed(eventId, reason, audit) {
    return this.update(eventId, {
      status: 'failed',
      reason: reason || 'E_EVENT_FAILED',
      audit: { ...audit, result: 'failed', reason: reason || 'E_EVENT_FAILED', requiresManualRecovery: false },
    });
  }

  markUncertain(eventId, reason, audit) {
    return this.update(eventId, {
      status: 'uncertain',
      reason: reason || 'E_WRITE_UNCERTAIN',
      audit: { ...audit, result: 'uncertain', reason: reason || 'E_WRITE_UNCERTAIN', requiresManualRecovery: true },
    });
  }

  markConflict(eventId, reason, audit) {
    return this.update(eventId, {
      status: 'conflict',
      reason: reason || 'E_CONFLICT',
      audit: { ...audit, result: 'conflict', reason: reason || 'E_CONFLICT', requiresManualRecovery: false },
    });
  }

  markManual(eventId, reason, audit) {
    return this.update(eventId, {
      status: 'requires-manual-recovery',
      reason: reason || 'MANUAL_RECOVERY_REQUIRED',
      audit: { ...audit, result: 'requires-manual-recovery', reason: reason || 'MANUAL_RECOVERY_REQUIRED', requiresManualRecovery: true },
    });
  }

  listPending() {
    const dump = this.store.dump();
    return Object.values(dump).filter(record => record.status !== 'applied');
  }
}

module.exports = { LEDGER_STATUSES, requestFingerprint, PersistentEventLedger };
