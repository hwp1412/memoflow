'use strict';

// PR-10 — runtime mode gate (defaults, blockers, unforgeable authorization).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateRuntimeMode,
  assertRuntimeActionAllowed,
  issueSyntheticRuntimeAuthorization,
  hasSyntheticRuntimeAuthorization,
  resolveSchedulerMode,
} = require('../src/scheduling/index.js');

const READY = () => ({
  migrationComplete: true,
  pendingRecovery: false,
  singleWriterReady: true,
  backupVerified: true,
  userConfirmed: true,
  authorization: issueSyntheticRuntimeAuthorization(),
  storageSupportsCas: true,
});

test('the runtime defaults to legacy and allows only the legacy path', () => {
  const evaluation = evaluateRuntimeMode(undefined);
  assert.equal(evaluation.mode, 'legacy');
  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.canCommitUnified, false);
  assert.equal(evaluation.writesPerformed, false);
});

test('shadow is read-only and unified is blocked without every condition', () => {
  const shadow = evaluateRuntimeMode({ mode: 'shadow' });
  assert.equal(shadow.allowed, true);
  assert.equal(shadow.canComputeShadow, true);

  const blocked = evaluateRuntimeMode({ mode: 'unified' }, {});
  assert.equal(blocked.allowed, false);
  const codes = blocked.blockers.map(blocker => blocker.code);
  for (const code of [
    'MIGRATION_INCOMPLETE', 'PENDING_RECOVERY', 'LEGACY_WRITER_STILL_ACTIVE',
    'BACKUP_NOT_VERIFIED', 'USER_CONFIRMATION_REQUIRED', 'RUNTIME_AUTHORIZATION_REQUIRED', 'STORAGE_WITHOUT_CAS',
  ]) {
    assert.ok(codes.includes(code), code);
  }
});

test('unified becomes allowed only with all conditions and a synthetic authorization', () => {
  const evaluation = evaluateRuntimeMode({ mode: 'unified' }, READY());
  assert.equal(evaluation.allowed, true);
  assert.deepEqual(evaluation.blockers, []);
  // PR-07 capability stays false; the synthetic authorization is separate.
  assert.equal(evaluation.canCommitUnified, false);
  assert.equal(resolveSchedulerMode({ mode: 'unified' }).canCommitUnified, false);
  assert.equal(assertRuntimeActionAllowed(evaluation, 'unified-write').allowed, true);
});

test('a forged authorization cannot satisfy the gate', () => {
  const forged = { kind: 'synthetic-runtime-authorization', label: 'forged' };
  assert.equal(hasSyntheticRuntimeAuthorization(forged), false);
  const evaluation = evaluateRuntimeMode({ mode: 'unified' }, { ...READY(), authorization: forged });
  assert.equal(evaluation.allowed, false);
  assert.ok(evaluation.blockers.some(blocker => blocker.code === 'RUNTIME_AUTHORIZATION_REQUIRED'));
  assert.equal(hasSyntheticRuntimeAuthorization({ authorized: true }), false);
});

test('mode-specific actions are rejected across modes', () => {
  const shadow = evaluateRuntimeMode({ mode: 'shadow' });
  assert.throws(() => assertRuntimeActionAllowed(shadow, 'unified-write'), error => error.code === 'E_SHADOW_READ_ONLY');

  const unified = evaluateRuntimeMode({ mode: 'unified' }, READY());
  assert.throws(() => assertRuntimeActionAllowed(unified, 'legacy-write'), error => error.code === 'E_UNIFIED_ACTION');

  const blocked = evaluateRuntimeMode({ mode: 'unified' }, {});
  assert.throws(() => assertRuntimeActionAllowed(blocked, 'unified-write'), error => error.code === 'E_RUNTIME_MODE_BLOCKED');
});
