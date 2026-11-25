'use strict';

// PR-07 — scheduler mode isolation (SPEC A10.1).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveSchedulerMode,
  assertShadowEnabled,
  assertUnifiedWriteAuthorized,
  DEFAULT_MODE,
  MODES,
} = require('../src/scheduling/index.js');

test('the default mode is legacy and performs no writes', () => {
  for (const config of [undefined, null, {}]) {
    const resolved = resolveSchedulerMode(config);
    assert.equal(resolved.mode, 'legacy');
    assert.equal(resolved.authoritativeScheduler, 'legacy');
    assert.equal(resolved.canComputeShadow, false);
    assert.equal(resolved.canCommitUnified, false);
    assert.equal(resolved.writesPerformed, false);
    assert.equal(resolved.configured, false);
  }
  assert.equal(DEFAULT_MODE, 'legacy');
  assert.deepEqual(MODES, ['legacy', 'shadow', 'unified']);
});

test('shadow is explicit and keeps the legacy scheduler authoritative', () => {
  const resolved = resolveSchedulerMode({ mode: 'shadow' });
  assert.equal(resolved.mode, 'shadow');
  assert.equal(resolved.authoritativeScheduler, 'legacy');
  assert.equal(resolved.canComputeShadow, true);
  assert.equal(resolved.canCommitUnified, false);
  assert.equal(resolved.requiresUserAuthorization, true);
  assert.equal(resolved.writesPerformed, false);
  assert.equal(resolved.configured, true);
  assert.ok(resolved.diagnostics.some(item => item.code === 'SHADOW_READ_ONLY'));
});

test('unified is defined but refuses to write in PR-07', () => {
  const resolved = resolveSchedulerMode({ mode: 'unified' });
  assert.equal(resolved.mode, 'unified');
  assert.equal(resolved.canCommitUnified, false);
  assert.equal(resolved.unifiedEnabled, false);
  assert.equal(resolved.requiresMigration, true);
  assert.equal(resolved.requiresUserAuthorization, true);
  assert.equal(resolved.writesPerformed, false);
  assert.ok(resolved.diagnostics.some(item => item.code === 'E_UNIFIED_NOT_AUTHORIZED'));

  assert.throws(() => assertUnifiedWriteAuthorized(), error => error.code === 'E_UNIFIED_NOT_AUTHORIZED');
  assert.throws(() => assertShadowEnabled(resolved), error => error.code === 'E_MODE_NOT_SHADOW');
});

test('an explicit illegal mode fails instead of enabling another mode', () => {
  for (const mode of ['nope', '', 'Legacy', null, 1, true]) {
    assert.throws(() => resolveSchedulerMode({ mode }), error => error.code === 'E_MODE_INVALID', String(mode));
  }
  for (const config of ['shadow', 42, [], true]) {
    assert.throws(() => resolveSchedulerMode(config), error => error.code === 'E_MODE_INVALID');
  }
});

test('legacy mode cannot compute shadow results', () => {
  const legacy = resolveSchedulerMode({ mode: 'legacy' });
  assert.throws(() => assertShadowEnabled(legacy), error => error.code === 'E_MODE_NOT_SHADOW');
  assert.throws(() => assertShadowEnabled(undefined), error => error.code === 'E_MODE_NOT_SHADOW');
});

test('resolving a mode never mutates the configuration', () => {
  const config = Object.freeze({ mode: 'shadow', extra: Object.freeze({ keep: true }) });
  const snapshot = JSON.parse(JSON.stringify(config));
  resolveSchedulerMode(config);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), snapshot);
});

test('capability flags never claim a physical write is possible', () => {
  for (const mode of MODES) {
    const resolved = resolveSchedulerMode({ mode });
    assert.equal(resolved.writesPerformed, false);
    assert.equal(resolved.canCommitUnified, false);
    assert.equal(resolved.unifiedEnabled, false);
    assert.equal(resolved.authoritativeScheduler, 'legacy');
  }
});
