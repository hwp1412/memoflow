'use strict';

// Runtime mode guard for the Obsidian integration layer (PR-10).
//
// This never enables Unified in a real vault. It only describes whether the
// runtime conditions are satisfied and refuses writes when they are not.
// A synthetic authorization object (test-only) is required to exercise the
// unified path; a plain {authorized:true} cannot forge it.

const { fail } = require('./errors.js');
const { resolveSchedulerMode } = require('./mode.js');

const SYNTHETIC_RUNTIME_AUTHORIZATIONS = new WeakSet();

function issueSyntheticRuntimeAuthorization(label = 'synthetic-runtime') {
  const authorization = Object.freeze({ kind: 'synthetic-runtime-authorization', label });
  SYNTHETIC_RUNTIME_AUTHORIZATIONS.add(authorization);
  return authorization;
}

function hasSyntheticRuntimeAuthorization(value) {
  return Boolean(value && SYNTHETIC_RUNTIME_AUTHORIZATIONS.has(value));
}

function evaluateRuntimeMode(config, conditions = {}) {
  const resolved = resolveSchedulerMode(config);
  const blockers = [];
  if (resolved.mode === 'unified') {
    if (conditions.migrationComplete !== true) blockers.push({ code: 'MIGRATION_INCOMPLETE' });
    if (conditions.pendingRecovery !== false) blockers.push({ code: 'PENDING_RECOVERY' });
    if (conditions.singleWriterReady !== true) blockers.push({ code: 'LEGACY_WRITER_STILL_ACTIVE' });
    if (conditions.backupVerified !== true) blockers.push({ code: 'BACKUP_NOT_VERIFIED' });
    if (conditions.userConfirmed !== true) blockers.push({ code: 'USER_CONFIRMATION_REQUIRED' });
    if (conditions.authorization == null || !hasSyntheticRuntimeAuthorization(conditions.authorization)) {
      blockers.push({ code: 'RUNTIME_AUTHORIZATION_REQUIRED' });
    }
    if (conditions.storageSupportsCas !== true) blockers.push({ code: 'STORAGE_WITHOUT_CAS' });
  }
  const allowed = resolved.mode !== 'unified' || blockers.length === 0;
  return {
    mode: resolved.mode,
    authoritativeScheduler: resolved.authoritativeScheduler,
    // PR-07 keeps canCommitUnified=false for the real runtime; a synthetic
    // capability is separate and test-only.
    canComputeShadow: resolved.canComputeShadow,
    canCommitUnified: false,
    writesPerformed: false,
    allowed,
    blockers,
    diagnostics: resolved.diagnostics,
  };
}

// Legacy is allowed to write the old way; shadow may not write new fields;
// unified may only write through the single writer when fully authorized.
function assertRuntimeActionAllowed(evaluation, action = 'write') {
  if (!evaluation || !evaluation.allowed) {
    fail('E_RUNTIME_MODE_BLOCKED', 'the runtime is not allowed to perform this action', {
      action,
      mode: evaluation ? evaluation.mode : null,
      blockers: evaluation ? evaluation.blockers.map(blocker => blocker.code) : [],
    });
  }
  if (evaluation.mode === 'shadow' && action !== 'legacy-write') {
    fail('E_SHADOW_READ_ONLY', 'shadow mode may only observe; it cannot write scheduling state', { action });
  }
  if (evaluation.mode === 'unified' && action !== 'unified-write') {
    fail('E_UNIFIED_ACTION', 'unified mode only accepts the single unified writer', { action });
  }
  return evaluation;
}

module.exports = {
  issueSyntheticRuntimeAuthorization,
  hasSyntheticRuntimeAuthorization,
  evaluateRuntimeMode,
  assertRuntimeActionAllowed,
};
