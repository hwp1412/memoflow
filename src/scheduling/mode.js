'use strict';

// Scheduler mode isolation for MF-US-1 (PR-07, SPEC A10.1).
//
// Three mode names exist: legacy / shadow / unified.
//
//   legacy   the old scheduler stays authoritative; MF-US-1 performs no write
//   shadow   the old scheduler stays authoritative; MF-US-1 may only compute
//            read-only candidates and diagnostics
//   unified  NOT enabled by this PR: there is no write adapter, no persisted
//            revision and no completed migration, so any write authorization is
//            refused explicitly. It never falls back to legacy or shadow.
//
// The default is always legacy. A missing config means legacy; an explicit but
// illegal config raises a clear error instead of enabling another mode.
//
// The capability flags below describe intent and contract. They do not by
// themselves prove that no physical write can happen; that proof still needs
// the runtime integration review (PR-09/10).

const { fail } = require('./errors.js');

const MODES = Object.freeze(['legacy', 'shadow', 'unified']);
const DEFAULT_MODE = 'legacy';

const CAPABILITIES = Object.freeze({
  legacy: Object.freeze({
    authoritativeScheduler: 'legacy',
    canComputeShadow: false,
    canCommitUnified: false,
    writesPerformed: false,
    requiresMigration: false,
    requiresUserAuthorization: false,
    unifiedEnabled: false,
  }),
  shadow: Object.freeze({
    authoritativeScheduler: 'legacy',
    canComputeShadow: true,
    canCommitUnified: false,
    writesPerformed: false,
    requiresMigration: false,
    requiresUserAuthorization: true,
    unifiedEnabled: false,
  }),
  unified: Object.freeze({
    // Until the unified write path is authorized and the migration is complete,
    // the legacy scheduler remains the real authority.
    authoritativeScheduler: 'legacy',
    canComputeShadow: false,
    canCommitUnified: false,
    writesPerformed: false,
    requiresMigration: true,
    requiresUserAuthorization: true,
    unifiedEnabled: false,
  }),
});

function resolveSchedulerMode(config) {
  if (config === undefined || config === null) {
    return {
      mode: DEFAULT_MODE,
      ...CAPABILITIES[DEFAULT_MODE],
      configured: false,
      diagnostics: [],
    };
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    fail('E_MODE_INVALID', 'scheduler mode config must be an object', { value: config });
  }

  const hasMode = Object.prototype.hasOwnProperty.call(config, 'mode');
  const mode = hasMode ? config.mode : DEFAULT_MODE;
  if (typeof mode !== 'string' || !MODES.includes(mode)) {
    fail('E_MODE_INVALID', `unknown scheduler mode "${String(mode)}"; expected legacy, shadow or unified`, { value: mode });
  }

  const resolved = {
    mode,
    ...CAPABILITIES[mode],
    configured: hasMode,
    diagnostics: [],
  };
  if (mode === 'unified') {
    resolved.diagnostics.push({
      code: 'E_UNIFIED_NOT_AUTHORIZED',
      message: 'unified writes are not authorized in PR-07: no write adapter, no persisted revision, no completed migration',
    });
  }
  if (mode === 'shadow') {
    resolved.diagnostics.push({
      code: 'SHADOW_READ_ONLY',
      message: 'shadow computes read-only candidates only; the legacy scheduler remains authoritative',
    });
  }
  return resolved;
}

function assertShadowEnabled(resolved) {
  if (!resolved || resolved.canComputeShadow !== true || resolved.mode !== 'shadow') {
    fail('E_MODE_NOT_SHADOW', 'shadow computation requires an explicit shadow mode', {
      mode: resolved ? resolved.mode : null,
    });
  }
  return resolved;
}

// There is deliberately no authorization parameter that could enable this in
// PR-07. Any caller attempting a unified write gets a hard refusal.
function assertUnifiedWriteAuthorized() {
  fail('E_UNIFIED_NOT_AUTHORIZED', 'unified writes are disabled until the authorized migration/write PR', {
    mode: 'unified',
  });
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  CAPABILITIES,
  resolveSchedulerMode,
  assertShadowEnabled,
  assertUnifiedWriteAuthorized,
};
