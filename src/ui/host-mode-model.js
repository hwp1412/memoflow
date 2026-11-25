'use strict';

// Mode-switch model (closure): exposes every prerequisite and never grants a
// real production write. Only a synthetic runtime can report writeEnabled.

const { evaluateHostRuntime, blockedTopicsFromLedger } = require('../integration/host-runtime.js');

const CHECKLIST = [
  ['MIGRATION_INCOMPLETE', 'Topic migration complete'],
  ['PENDING_RECOVERY', 'No pending recovery'],
  ['LEGACY_WRITER_STILL_ACTIVE', 'Legacy writer retired'],
  ['BACKUP_NOT_VERIFIED', 'Backup verified'],
  ['STORAGE_WITHOUT_CAS', 'Storage satisfies the CAS protocol'],
  ['USER_CONFIRMATION_REQUIRED', 'User confirmed the switch'],
  ['PRODUCTION_WRITE_UNAUTHORIZED', 'Production write authorization'],
];

function buildHostModeView({ mode = 'legacy', conditions = {}, authorization = null, ledger = null, migration = null, recovery = null } = {}) {
  const evaluation = evaluateHostRuntime({ mode, conditions, authorization });
  const blockedTopics = ledger ? blockedTopicsFromLedger(ledger) : [];
  return {
    mode: evaluation.mode,
    synthetic: evaluation.synthetic,
    allowed: evaluation.allowed,
    blockers: evaluation.blockers,
    checklist: CHECKLIST.map(([code, label]) => ({ code, label, ok: !evaluation.blockers.includes(code) })),
    requiresExplicitConfirmation: evaluation.mode !== 'unified',
    writeEnabled: evaluation.mode === 'unified' && evaluation.allowed,
    migration: migration ? { summary: migration.summary ?? null } : null,
    recovery: recovery ? { pendingCount: recovery.pendingCount ?? 0 } : null,
    blockedTopicIds: blockedTopics,
    canSwitchToUnified: evaluation.allowed,
    reason: evaluation.allowed ? null : evaluation.blockers[0],
  };
}

module.exports = { buildHostModeView };
