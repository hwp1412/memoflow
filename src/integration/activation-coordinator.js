'use strict';

// P3-02A — controlled Unified activation coordinator.
//
// This module is deliberately incapable of enabling production Unified writes:
// `authorize()` only issues a session token when an approval provider is
// injected (tests / explicitly approved offline harness). Production constructs
// the coordinator with `approvalProvider = null`, so activation is always
// denied and no token can be minted.
//
// The six runtime conditions are derived from real evidence (migration plan,
// recovery, batch recovery, identity checks, storage CAS support, user
// confirmation), not from settings.

const { issueSyntheticHostAuthorization, hasSyntheticHostAuthorization } = require('./host-runtime.js');

const CONDITION_KEYS = Object.freeze([
  'migrationComplete',
  'pendingRecovery',
  'singleWriterReady',
  'backupVerified',
  'userConfirmed',
  'storageSupportsCas',
]);

function planIsComplete(plan) {
  if (!plan || !plan.summary) return false;
  const summary = plan.summary;
  return summary.total > 0
    && summary.migratable === 0
    && summary.manualReview === 0
    && summary.conflict === 0
    && (summary.blocked || 0) === 0;
}

// A brand-new vault has nothing to migrate. That is a legitimate safe state,
// not a missing prerequisite: no migration plan/backup may be required. If the
// legacy topic count is unknown we stay conservative and require a complete
// plan.
function migrationRequirement(evidence = {}) {
  if (evidence.indexComplete === false) {
    // The vault scan could not prove the absence of legacy topics. Unknown must
    // fail closed, never be treated as "nothing to migrate".
    return { required: true, complete: false, notRequired: false, indexUnknown: true, legacyTopicCount: evidence.legacyTopicCount ?? null };
  }
  const legacyCount = Number.isInteger(evidence.legacyTopicCount) ? evidence.legacyTopicCount : null;
  if (legacyCount === 0) {
    return { required: false, complete: true, notRequired: true, legacyTopicCount: 0 };
  }
  return {
    required: true,
    complete: planIsComplete(evidence.migrationPlan),
    notRequired: false,
    legacyTopicCount: legacyCount,
  };
}

function deriveConditions(evidence = {}, { storageSupportsCas = true } = {}) {
  const migration = migrationRequirement(evidence);
  return {
    migrationComplete: migration.complete,
    migrationNotRequired: migration.notRequired,
    pendingRecovery: Array.isArray(evidence.pendingEvents) && evidence.pendingEvents.length > 0,
    singleWriterReady: evidence.singleWriterReady !== false,
    // No migration => no migration backup prerequisite; without it the
    // requirement stays strict.
    backupVerified: evidence.backupVerified === true || migration.notRequired,
    userConfirmed: evidence.userConfirmed === true,
    storageSupportsCas: storageSupportsCas === true,
  };
}

function blockersFor(evidence = {}, conditions) {
  const blockers = [];
  const migration = migrationRequirement(evidence);
  if (migration.indexUnknown) blockers.push('MIGRATION_INDEX_UNKNOWN');
  if (!conditions.migrationComplete && !migration.indexUnknown) blockers.push('MIGRATION_INCOMPLETE');
  if (!migration.notRequired && !conditions.backupVerified) blockers.push('BACKUP_NOT_VERIFIED');
  if (conditions.pendingRecovery) blockers.push('PENDING_RECOVERY');
  if (evidence.recoveryHealthy === false) blockers.push('RECOVERY_UNHEALTHY');
  if (evidence.batchRecoveryError) blockers.push('BATCH_RECOVERY_UNKNOWN');
  if (Array.isArray(evidence.blockedTopicIds) && evidence.blockedTopicIds.length) blockers.push('BLOCKED_TOPICS');
  if (Array.isArray(evidence.duplicateIds) && evidence.duplicateIds.length) blockers.push('TOPIC_ID_CONFLICT');
  if (!conditions.backupVerified) blockers.push('BACKUP_NOT_VERIFIED');
  if (!conditions.userConfirmed) blockers.push('USER_CONFIRMATION_REQUIRED');
  if (!conditions.storageSupportsCas) blockers.push('STORAGE_WITHOUT_CAS');
  if (evidence.transportAvailable === false) blockers.push('NO_HOST_TRANSPORT');
  else if (evidence.runtimeAuthorized === false) blockers.push('RUNTIME_AUTHORIZATION_REQUIRED');
  return blockers;
}

function createActivationCoordinator({ approvalProvider = null } = {}) {
  let session = null;

  function evaluate(evidence = {}, options = {}) {
    const conditions = deriveConditions(evidence, options);
    const blockers = blockersFor(evidence, conditions);
    return {
      conditions,
      blockers,
      allowed: blockers.length === 0,
      migration: migrationRequirement(evidence),
      runtimeConditions: CONDITION_KEYS.reduce((accumulator, key) => {
        accumulator[key] = conditions[key];
        return accumulator;
      }, {}),
    };
  }

  // Session authorization: denied unless the injected approval provider says
  // yes AND every derived condition is satisfied. A revoked or missing token can
  // never be re-used.
  function authorize(evidence = {}, options = {}) {
    const evaluation = evaluate(evidence, options);
    if (!evaluation.allowed) return { ok: false, blockers: evaluation.blockers, evaluation };
    const approved = typeof approvalProvider === 'function' && approvalProvider(evaluation) === true;
    if (!approved) {
      return { ok: false, blockers: [...evaluation.blockers, 'ACTIVATION_NOT_APPROVED'], evaluation };
    }
    const authorization = issueSyntheticHostAuthorization();
    session = { authorization, issuedAt: new Date().toISOString(), revoked: false, conditions: evaluation.conditions };
    return { ok: true, authorization, session, evaluation };
  }

  function revoke() {
    const had = Boolean(session);
    session = null;
    return { revoked: had };
  }

  function isAuthorized() {
    return Boolean(session && !session.revoked && hasSyntheticHostAuthorization(session.authorization));
  }

  function currentSession() {
    if (!session) return null;
    return { issuedAt: session.issuedAt, revoked: session.revoked, conditions: { ...session.conditions } };
  }

  return { evaluate, authorize, revoke, isAuthorized, currentSession };
}

module.exports = {
  CONDITION_KEYS,
  planIsComplete,
  migrationRequirement,
  deriveConditions,
  blockersFor,
  createActivationCoordinator,
};
