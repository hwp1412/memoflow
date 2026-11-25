'use strict';

// PR-10 — Fake Obsidian storage adapter contract and CAS fail-closed gate.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeObsidianVault,
  createFakeVaultAdapter,
  createFakeAtomicVaultAdapter,
  assertUnifiedStorageReady,
} = require('../src/integration/obsidian-storage-adapter.js');
const { uuid } = require('./helpers/unified-fixtures.js');

function topic(seq, overrides = {}) {
  return {
    frontmatter: {
      type: 'source', status: 'active', priority: 50, a_factor: 2.0,
      review_count: 3, mf_id: uuid(seq), mf_revision: 1, mf_scheduler_version: 1,
      mf_ideal_due: '2026-11-20', mf_not_before: null, mf_interval_days: 8, custom: 'keep',
      ...overrides,
    },
    body: 'Body text',
    revision: 1,
  };
}

test('the adapter locates a topic by mf_id and follows a rename', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  assert.equal(adapter.locateByTopicId(uuid(1)).snapshot.path, 'Sources/A.md');

  vault.rename('Sources/A.md', 'Sources/Renamed.md');
  const after = adapter.locateByTopicId(uuid(1));
  assert.equal(after.snapshot.path, 'Sources/Renamed.md');
  assert.equal(after.snapshot.frontmatter.mf_id, uuid(1));
});

test('duplicate or invalid persisted ids are reported', () => {
  const vault = new FakeObsidianVault({
    'Sources/A.md': topic(1),
    'Sources/B.md': topic(1),
  });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const located = adapter.locateByTopicId(uuid(1));
  assert.equal(located.snapshot, null);
  assert.equal(located.duplicates.length, 2);

  const bad = new FakeObsidianVault({ 'Sources/Bad.md': topic(1, { mf_id: 'not-a-uuid' }) });
  const badAdapter = createFakeVaultAdapter({ vault: bad, dateFormat: 'DD-MM-YYYY' });
  assert.throws(() => badAdapter.readSnapshot('Sources/Bad.md'), error => error.code === 'E_ID_FORMAT');
});

test('date format is explicit and unknown formats are refused', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  assert.throws(() => createFakeVaultAdapter({ vault, dateFormat: 'DD.MM.YYYY' }),
    error => error.code === 'E_DATE_FORMAT_UNSUPPORTED');
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'YYYY-MM-DD' });
  assert.equal(adapter.formatEffectiveDue('2026-11-20'), '2026-11-20');
});

test('snapshot verification checks hash and revision', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const snapshot = adapter.readSnapshot('Sources/A.md');
  assert.equal(adapter.verifySnapshot(snapshot, {
    expectedHash: snapshot.hash, expectedRevision: 1,
  }).ok, true);
  assert.equal(adapter.verifySnapshot(snapshot, { expectedHash: '0'.repeat(64) }).code, 'E_SNAPSHOT_MISMATCH');
  assert.equal(adapter.verifySnapshot(snapshot, { expectedRevision: 9 }).code, 'E_REVISION_MISMATCH');
});

test('the legacy write path is explicitly non-atomic', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const snapshot = adapter.readSnapshot('Sources/A.md');
  const result = adapter.writeFrontMatterLegacy('Sources/A.md', {
    expectedHash: snapshot.hash, expectedRevision: 1,
  }, fm => { fm.mf_not_before = '2026-11-27'; });
  assert.equal(result.ok, true);
  assert.equal(result.atomic, false);
  assert.equal(result.warning, 'NON_ATOMIC_FRONTMATTER_WRITE');
  assert.equal(vault.read('Sources/A.md').frontmatter.custom, 'keep');
});

test('unified storage readiness fails closed for a non-CAS adapter', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  assert.equal(adapter.supportsAtomicCas, false);
  assert.throws(() => assertUnifiedStorageReady(adapter), error => error.code === 'E_STORAGE_WITHOUT_CAS');
});

test('the atomic fake adapter supports a real CAS contract for tests', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  const adapter = createFakeAtomicVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  assert.equal(assertUnifiedStorageReady(adapter), adapter);
  const snapshot = adapter.readSnapshot('Sources/A.md');
  const next = { ...snapshot.frontmatter, mf_not_before: '2026-11-27', mf_revision: 2 };
  const cas = adapter.compareAndSwap('Sources/A.md', {
    expectedHash: snapshot.hash, expectedRevision: 1, nextFrontmatter: next, nextRevision: 2,
  });
  assert.equal(cas.ok, true);
  assert.equal(adapter.readSnapshot('Sources/A.md').frontmatter.mf_not_before, '2026-11-27');

  const stale = adapter.compareAndSwap('Sources/A.md', {
    expectedHash: snapshot.hash, expectedRevision: 1, nextFrontmatter: next, nextRevision: 3,
  });
  assert.equal(stale.ok, false);
});

// ---- case-insensitive identity and CAS forgery (review fix 3) ------------

test('UUID comparison is case-insensitive and duplicate ids are reported', () => {
  const vault = new FakeObsidianVault({
    'Sources/Lower.md': topic(1),
    'Sources/Upper.md': topic(2, { mf_id: uuid(1).toUpperCase() }),
  });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const located = adapter.locateByTopicId(uuid(1).toLowerCase());
  assert.equal(located.snapshot, null);
  assert.equal(located.duplicates.length, 2);
  // The stored UUID casing is never rewritten.
  assert.equal(vault.read('Sources/Upper.md').frontmatter.mf_id, uuid(1).toUpperCase());
});

test('a rename keeps identity and the original UUID casing', () => {
  const upper = uuid(1).toUpperCase();
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1, { mf_id: upper }) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  vault.rename('Sources/A.md', 'Sources/B.md');
  const located = adapter.locateByTopicId(uuid(1));
  assert.equal(located.snapshot.path, 'Sources/B.md');
  assert.equal(located.snapshot.frontmatter.mf_id, upper);
});

test('a topic without persisted mf_id cannot be a write target', () => {
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1, { mf_id: undefined }) });
  const adapter = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const snapshot = adapter.readSnapshot('Sources/A.md');
  assert.equal(snapshot.mfId, null);
  assert.throws(() => adapter.writeFrontMatterLegacy('Sources/A.md', {}, fm => { fm.next = 1; }),
    error => error.code === 'E_ID_NOT_PERSISTED');
});

test('a forged CAS marker cannot pass the unified storage gate', () => {
  for (const forged of [
    { kind: 'forged', supportsAtomicCas: true },
    { kind: 'forged', supportsAtomicCas: true, compareAndSwap() {} },
  ]) {
    assert.throws(() => assertUnifiedStorageReady(forged), error => error.code === 'E_STORAGE_WITHOUT_CAS');
  }
  const vault = new FakeObsidianVault({ 'Sources/A.md': topic(1) });
  const fake = createFakeVaultAdapter({ vault, dateFormat: 'DD-MM-YYYY' });
  const forgedCopy = { ...fake, supportsAtomicCas: true, compareAndSwap() {} };
  assert.throws(() => assertUnifiedStorageReady(forgedCopy), error => error.code === 'E_STORAGE_WITHOUT_CAS');
});
