'use strict';

// PR-09 — mode isolation for the Unified writer.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeUnifiedEvent,
  assertUnifiedWriteAuthorized,
  resolveSchedulerMode,
  PersistentEventLedger,
  MemoryLedgerStore,
  issueSyntheticUnifiedCapability,
} = require('../src/scheduling/index.js');
const { setup, makeRequest } = require('./helpers/unified-fixtures.js');

function expectCode(fn, code) {
  assert.throws(fn, error => error.code === code);
}

test('default, legacy and shadow modes all refuse unified writes', () => {
  const defaultContext = setup();
  const defaultDeps = { ...defaultContext.deps };
  delete defaultDeps.mode;
  expectCode(() => executeUnifiedEvent(makeRequest(defaultContext.topic), defaultDeps), 'E_MODE_NOT_UNIFIED');

  for (const mode of [{ mode: 'legacy' }, { mode: 'shadow' }]) {
    const context = setup({ mode });
    expectCode(() => executeUnifiedEvent(makeRequest(context.topic), context.deps), 'E_MODE_NOT_UNIFIED');
  }
});

test('unified mode without a trusted synthetic capability is refused', () => {
  const context = setup();
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), { ...context.deps, capability: undefined }),
    'E_UNIFIED_NOT_AUTHORIZED');
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), { ...context.deps, capability: { authorized: true } }),
    'E_UNIFIED_NOT_AUTHORIZED');
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), {
    ...context.deps, capability: { kind: 'synthetic-unified-capability', label: 'forged' },
  }), 'E_UNIFIED_NOT_AUTHORIZED');
});

test('a forged mode object cannot grant write capability', () => {
  const context = setup({ mode: { mode: 'unified', canCommitUnified: true, writesPerformed: false } });
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), { ...context.deps, capability: undefined }),
    'E_UNIFIED_NOT_AUTHORIZED');
});

test('PR-07 still refuses real unified writes', () => {
  assert.throws(() => assertUnifiedWriteAuthorized(), error => error.code === 'E_UNIFIED_NOT_AUTHORIZED');
  const resolved = resolveSchedulerMode({ mode: 'unified' });
  assert.equal(resolved.canCommitUnified, false);
  assert.equal(resolved.writesPerformed, false);
  assert.equal(resolved.authoritativeScheduler, 'legacy');
});

test('attaching a legacy writer is a double-write violation', () => {
  const context = setup();
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), { ...context.deps, legacyWriter: {} }),
    'E_DOUBLE_WRITE_FORBIDDEN');
});

test('a plain object cannot impersonate the ledger', () => {
  const context = setup();
  const fakeLedger = { get() {}, classify() {}, prepare() {}, markApplied() {} };
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), { ...context.deps, ledger: fakeLedger }),
    'E_LEDGER_UNTRUSTED');
});

test('a card or an un-migrated topic never gets a write', () => {
  const card = setup({ frontmatter: { type: 'card' } });
  assert.equal(executeUnifiedEvent(makeRequest(card.topic), card.deps).status, 'conflict');

  const legacy = setup({ revision: null, frontmatter: { mf_revision: undefined, mf_scheduler_version: undefined } });
  const result = executeUnifiedEvent(makeRequest(legacy.topic), legacy.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.writesPerformed, false);
});

test('a valid capability only works in unified mode', () => {
  const context = setup({ mode: { mode: 'shadow' } });
  expectCode(() => executeUnifiedEvent(makeRequest(context.topic), context.deps), 'E_MODE_NOT_UNIFIED');
});
