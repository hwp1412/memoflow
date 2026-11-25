'use strict';

// Async Unified event execution for the real host chain (HOST-RUNTIME-01).
//
// This is a *transport* for the accepted MF-US-1 core, not a second state
// machine: it reuses the same request validation, identity/revision gate,
// applyEvent, field projection and PersistentEventLedger record lifecycle as
// the synchronous PR-09 writer. What differs is only how bytes are committed:
//
//   plan (pure)  →  durable Intent (await save)  →  async CAS (Vault.process)
//                →  byte read-back          →  ledger result (await save)
//
// The prepare record is persisted BEFORE the topic CAS. A failed intent save
// can therefore never be followed by a write, and `writesPerformed` is only
// true when the read-back hash matches the bytes actually produced by the
// byte-preserving editor.

const { fail, isSchedulingError } = require('../scheduling/errors.js');
const { ALGORITHM_VERSION } = require('../scheduling/constants.js');
const { applyEvent } = require('../scheduling/events.js');
const { sha256Hex, stableStringify } = require('../scheduling/migration-hash.js');
const { PersistentEventLedger } = require('../scheduling/persistent-event-ledger.js');
const { assertSyntheticUnifiedCapability } = require('../scheduling/unified-store-contract.js');
const {
  assertRequest,
  buildTopic,
  buildProjection,
  changedFields,
  verifyPersistedState,
  auditSnapshot,
} = require('../scheduling/unified-writer.js');
const { applyEdits } = require('./obsidian-process-storage.js');
const { assertTrustedAsyncTopicStorage } = require('./host-async-storage.js');

const KNOWN_STATES = Object.freeze([
  'new', 'duplicate', 'retryable', 'prepared', 'failed', 'uncertain', 'requires-manual-recovery', 'conflict',
]);

function assertLedger(ledger) {
  if (!(ledger instanceof PersistentEventLedger)) {
    fail('E_LEDGER_UNTRUSTED', 'the async executor requires a PersistentEventLedger instance');
  }
  return ledger;
}

async function persistOrFail(persist, code) {
  if (typeof persist !== 'function') return { ok: false, code: 'E_LEDGER_PERSIST_REQUIRED' };
  try {
    const result = await persist();
    if (result && result.ok) return { ok: true };
    return { ok: false, code: (result && result.code) || code };
  } catch (error) {
    return { ok: false, code: code, message: error && error.message };
  }
}

async function executeUnifiedEventAsync(request, dependencies = {}) {
  assertRequest(request);
  if (!dependencies.mode || dependencies.mode.mode !== 'unified') {
    fail('E_MODE_NOT_UNIFIED', 'the async executor is disabled outside unified mode');
  }
  assertSyntheticUnifiedCapability(dependencies.capability);
  const store = assertTrustedAsyncTopicStorage(dependencies.storage);
  const ledger = assertLedger(dependencies.ledger);
  const dateFormat = dependencies.dateFormat || request.dateFormat || 'DD-MM-YYYY';
  const configDigest = sha256Hex(stableStringify(dependencies.config ?? null));
  const ledgerRequest = { ...request, dateFormat, configDigest };

  const classification = ledger.classify(ledgerRequest);
  if (classification.state === 'conflict') {
    fail('E_EVENT_ID_CONFLICT', 'the event id was already used by a different request', { eventId: request.eventId });
  }
  if (!KNOWN_STATES.includes(classification.state)) {
    ledger.markManual(request.eventId, 'E_LEDGER_CORRUPT', classification.record.audit);
    return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_LEDGER_CORRUPT', record: ledger.get(request.eventId) };
  }
  if (classification.state === 'duplicate') {
    return { status: 'duplicate', duplicate: true, writesPerformed: false, record: classification.record, reason: null };
  }

  const located = await store.readTopic(request.topicId);
  if (located.duplicates && located.duplicates.length > 0) {
    return { status: 'conflict', duplicate: false, writesPerformed: false, reason: 'E_DUPLICATE_TOPIC_ID', duplicates: located.duplicates };
  }
  if (!located.entry) {
    return { status: 'conflict', duplicate: false, writesPerformed: false, reason: located.code || 'E_TOPIC_NOT_FOUND' };
  }
  const entry = located.entry;
  const currentHash = entry.hash;

  // A previously prepared/uncertain event reconciles against the real bytes
  // before anything new is attempted.
  if (classification.record && !['new', 'retryable', 'duplicate'].includes(classification.state)) {
    if (currentHash === classification.record.expectedAfterHash) {
      if (!verifyPersistedState(entry, classification.record, request.topicId)) {
        ledger.markManual(request.eventId, 'E_RECOVERY_STATE_MISMATCH', { ...classification.record.audit, requiresManualRecovery: true });
        return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_RECOVERY_STATE_MISMATCH', record: ledger.get(request.eventId) };
      }
      ledger.markApplied(request.eventId, {
        afterHash: currentHash,
        actualRevision: entry.revision,
        result: 'recovered-from-intent',
        writesPerformed: false,
        audit: { ...classification.record.audit, result: 'recovered-from-intent' },
      });
      const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
      if (!saved.ok) {
        // The recovery could not be made durable. It must never be reported as
        // a successful duplicate: the caller has to treat this as uncertain.
        ledger.markUncertain(request.eventId, 'E_APPLIED_PERSIST_FAILED', classification.record.audit);
        return {
          status: 'uncertain', duplicate: false, verified: false, recovered: true,
          writesPerformed: false, reason: 'E_APPLIED_PERSIST_FAILED', ledgerError: saved.code,
          requiresManualRecovery: true, record: ledger.get(request.eventId),
        };
      }
      return { status: 'applied', duplicate: true, verified: true, recovered: true, writesPerformed: false, record: ledger.get(request.eventId) };
    }
    if (currentHash !== classification.record.beforeHash) {
      ledger.markManual(request.eventId, 'E_EXTERNAL_EDIT', { ...classification.record.audit, requiresManualRecovery: true });
      return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_EXTERNAL_EDIT', record: ledger.get(request.eventId) };
    }
  }
  if (classification.state === 'retryable' && classification.record && currentHash !== classification.record.beforeHash) {
    return { status: 'requires-manual-recovery', duplicate: false, writesPerformed: false, reason: 'E_EXTERNAL_EDIT' };
  }

  const built = buildTopic(entry, request);
  if (built.error) {
    if (classification.record) ledger.markConflict(request.eventId, built.error, { ...classification.record.audit, requiresManualRecovery: false });
    return {
      status: 'conflict', duplicate: false, writesPerformed: false, reason: built.error,
      record: classification.record ? ledger.get(request.eventId) : null,
    };
  }
  const topic = built.topic;

  const event = {
    eventId: request.eventId,
    topicId: request.topicId,
    type: request.type,
    payload: request.payload,
    expectedRevision: request.expectedRevision,
    algorithmVersion: request.algorithmVersion,
    calendarDate: request.calendarDate,
  };

  let applied;
  try {
    applied = applyEvent(topic, event, dependencies.config, request.today);
  } catch (error) {
    const code = isSchedulingError(error) ? error.code : 'E_EVENT_FAILED';
    if (classification.record) ledger.markFailed(request.eventId, code, classification.record.audit);
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: code };
  }

  if (!applied.needsWrite || applied.topic === topic) {
    const record = ledger.prepare(ledgerRequest, {
      beforeHash: currentHash, expectedAfterHash: currentHash,
      fields: {}, before: auditSnapshot(topic), after: auditSnapshot(topic),
    });
    ledger.markApplied(request.eventId, {
      afterHash: currentHash, actualRevision: entry.revision, result: applied.reason || 'no-op',
      writesPerformed: false, audit: { ...record.audit, result: applied.reason || 'no-op', writesPerformed: false },
    });
    const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
    if (!saved.ok) {
      ledger.markUncertain(request.eventId, 'E_APPLIED_PERSIST_FAILED', record.audit);
      return { status: 'uncertain', duplicate: false, writesPerformed: false, reason: 'E_APPLIED_PERSIST_FAILED', ledgerError: saved.code, requiresManualRecovery: true };
    }
    return { status: 'no-op', duplicate: false, writesPerformed: false, reason: applied.reason || 'NO_STATE_CHANGE', record: ledger.get(request.eventId) };
  }

  const next = applied.topic;
  if (next.mf_revision !== request.expectedRevision + 1 || next.mf_last_event_id !== request.eventId) {
    ledger.markFailed(request.eventId, 'E_EVENT_INVARIANT', { requiresManualRecovery: false });
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: 'E_EVENT_INVARIANT' };
  }

  const fields = buildProjection(next, dateFormat);
  const changed = changedFields(entry.frontmatter, fields);

  // Predict the exact post-edit bytes with the *same* byte-preserving editor
  // that the commit will run. No synthetic YAML rendering is hashed here.
  let predicted;
  try {
    predicted = applyEdits(entry.content, { ...changed, mf_revision: request.expectedRevision + 1 }, { allowNestedBlocks: store.allowNestedBlocks === true });
  } catch (error) {
    return { status: 'conflict', duplicate: false, writesPerformed: false, reason: (error && error.code) || 'E_FIELD_NOT_WRITABLE' };
  }
  const expectedAfterHash = sha256Hex(predicted);
  const record = ledger.prepare(ledgerRequest, {
    beforeHash: currentHash,
    expectedAfterHash,
    fields: { ...changed, mf_revision: request.expectedRevision + 1 },
    before: auditSnapshot(topic),
    after: auditSnapshot(next),
  });

  // WAL: the prepared record must be durable before any topic byte changes.
  const intent = await persistOrFail(dependencies.persistIntent, 'E_INTENT_PERSIST_FAILED');
  if (!intent.ok) {
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: intent.code, intentPersisted: false, record: ledger.get(request.eventId) };
  }

  const cas = await store.compareAndSwap(request.topicId, {
    expectedHash: currentHash,
    expectedRevision: request.expectedRevision,
    updates: { ...changed, mf_revision: request.expectedRevision + 1 },
  });
  if (!cas || !cas.ok) {
    const code = (cas && cas.code) || 'E_STORAGE_WRITE_FAILED';
    if (code === 'E_SNAPSHOT_MISMATCH' || code === 'E_REVISION_MISMATCH' || code === 'E_ID_NOT_PERSISTED'
      || code === 'E_TOPIC_ID_MISMATCH' || code === 'E_TOPIC_NOT_ACTIVE' || code === 'E_TOPIC_TYPE'
      || code === 'E_REVISION_NOT_PERSISTED' || code === 'E_VERSION_NOT_PERSISTED') {
      ledger.markConflict(request.eventId, code, record.audit);
      return { status: 'conflict', duplicate: false, writesPerformed: false, reason: code, record: ledger.get(request.eventId) };
    }
    if (code === 'E_WRITE_UNVERIFIED' || code === 'E_WRITE_UNCERTAIN') {
      ledger.markUncertain(request.eventId, code, record.audit);
      const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
      return { status: 'uncertain', duplicate: false, writesPerformed: null, reason: code, requiresManualRecovery: true, ledgerError: saved.ok ? null : saved.code };
    }
    ledger.markFailed(request.eventId, code, record.audit);
    return { status: 'failed', duplicate: false, writesPerformed: false, reason: code };
  }

  if (cas.afterHash !== expectedAfterHash) {
    ledger.markUncertain(request.eventId, 'E_WRITE_UNVERIFIED', record.audit);
    await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
    return { status: 'uncertain', duplicate: false, writesPerformed: null, reason: 'E_WRITE_UNVERIFIED', requiresManualRecovery: true };
  }

  const finalRecord = ledger.markApplied(request.eventId, {
    afterHash: cas.afterHash,
    actualRevision: request.expectedRevision + 1,
    result: 'applied',
    writesPerformed: true,
    audit: { ...record.audit, after: auditSnapshot(next), actualRevision: request.expectedRevision + 1, writesPerformed: true },
  });
  const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
  if (!saved.ok) {
    // The topic changed but the durable result did not land: uncertain, not
    // applied. The in-memory record must say uncertain too, otherwise recover()
    // would skip a write whose confirmation never persisted.
    ledger.markUncertain(request.eventId, 'E_APPLIED_PERSIST_FAILED', { ...record.audit, requiresManualRecovery: true });
    return {
      status: 'uncertain', duplicate: false, writesPerformed: true, reason: 'E_APPLIED_PERSIST_FAILED',
      ledgerError: saved.code, requiresManualRecovery: true, record: finalRecord,
    };
  }
  return { status: 'applied', duplicate: false, recovered: false, writesPerformed: true, record: finalRecord, audit: finalRecord.audit };
}

async function reconcileUnifiedEventAsync(eventId, dependencies = {}) {
  const ledger = assertLedger(dependencies.ledger);
  const record = ledger.get(eventId);
  if (!record) fail('E_EVENT_NOT_FOUND', 'the ledger has no such event', { eventId });
  if (record.status === 'applied') return { status: 'applied', recovered: true, writesPerformed: false, record };

  const store = assertTrustedAsyncTopicStorage(dependencies.storage);
  const located = await store.readTopic(record.topicId);
  if (!located.entry) {
    ledger.markManual(eventId, 'E_TOPIC_NOT_FOUND', record.audit);
    const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
    return { status: 'requires-manual-recovery', reason: 'E_TOPIC_NOT_FOUND', writesPerformed: false, persisted: saved.ok, record: ledger.get(eventId) };
  }
  const hash = located.entry.hash;
  if (record.expectedAfterHash && hash === record.expectedAfterHash) {
    if (!verifyPersistedState(located.entry, record, record.topicId)) {
      ledger.markManual(eventId, 'E_RECOVERY_STATE_MISMATCH', { ...record.audit, requiresManualRecovery: true });
      const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
      return { status: 'requires-manual-recovery', reason: 'E_RECOVERY_STATE_MISMATCH', writesPerformed: false, persisted: saved.ok, record: ledger.get(eventId) };
    }
    ledger.markApplied(eventId, {
      afterHash: hash, actualRevision: located.entry.revision, result: 'reconciled', writesPerformed: false,
      audit: { ...record.audit, result: 'reconciled', writesPerformed: false },
    });
    const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
    return { status: 'applied', recovered: true, writesPerformed: false, persisted: saved.ok, record: ledger.get(eventId) };
  }
  if (hash === record.beforeHash) {
    return { status: 'retryable', writesPerformed: false, record };
  }
  ledger.markManual(eventId, 'E_EXTERNAL_EDIT', { ...record.audit, requiresManualRecovery: true });
  const saved = await persistOrFail(dependencies.persistResult, 'E_LEDGER_SAVE_FAILED');
  return { status: 'requires-manual-recovery', reason: 'E_EXTERNAL_EDIT', writesPerformed: false, persisted: saved.ok, record: ledger.get(eventId) };
}

module.exports = {
  ALGORITHM_VERSION,
  executeUnifiedEventAsync,
  reconcileUnifiedEventAsync,
};
