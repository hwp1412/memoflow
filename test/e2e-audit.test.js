'use strict';

// Read-only vault audit: verifies identities, relations, ledger/batch evidence,
// Card isolation and baseline diffing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auditPromise = import('../scripts/e2e-audit.mjs');

const ID = {
  source: '00000000-0000-4000-8000-000000000001',
  extract: '00000000-0000-4000-8000-000000000002',
  extract2: '00000000-0000-4000-8000-000000000003',
  card: '00000000-0000-4000-8000-000000000004',
};

function note(fields) {
  const body = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value === null ? 'null' : value}`)
    .join('\n');
  return `---\n${body}\n---\n\n# note\n`;
}

function validSource(overrides = {}) {
  return note({
    type: 'source', status: 'active', priority: 50, interval: 8,
    mf_id: ID.source, mf_revision: 1, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_parent_id: 'null',
    mf_root_id: ID.source, mf_last_event_id: 'null', ...overrides,
  });
}

function validExtract(overrides = {}) {
  return note({
    type: 'extract', status: 'active', priority: 50, interval: 8, source: '[[A]]',
    mf_id: ID.extract, mf_revision: 2, mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20', mf_not_before: 'null',
    mf_parent_id: ID.source, mf_root_id: ID.source, mf_last_event_id: 'null', ...overrides,
  });
}

function makeVault({ sources = {}, extracts = {}, cards = {}, data = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-e2e-audit-'));
  const pluginDir = path.join(dir, '.obsidian', 'plugins', 'memoflow');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'memoflow', name: 'MemoFlow', version: '0.1.0' }));
  fs.writeFileSync(path.join(pluginDir, 'main.js'), '/* build */');
  fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify(data));
  const writeAll = (folder, files) => {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, folder, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  };
  writeAll('Sources', sources);
  writeAll('Extracts', extracts);
  writeAll('Cards', cards);
  return dir;
}

function codes(result) {
  return result.checks.map(item => item.code);
}

test('a clean empty vault passes and is migration-not-required', async () => {
  const { auditVault } = await auditPromise;
  const dir = makeVault({
    sources: { 'A.md': validSource() },
    extracts: { 'E1.md': validExtract() },
    cards: { 'C1.md': note({ type: 'card', status: 'active', priority: 40 }) },
  });
  const result = await auditVault({ vaultDir: dir, profile: 'empty' });
  assert.equal(result.ok, true, JSON.stringify(codes(result)));
  assert.ok(codes(result).includes('MIGRATION_NOT_REQUIRED'));
  assert.ok(codes(result).includes('CARD_MF_FIELDS') === false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate mf_id fails the audit', async () => {
  const { auditVault } = await auditPromise;
  const dir = makeVault({
    sources: { 'A.md': validSource(), 'B.md': validSource({ mf_root_id: ID.source }) },
  });
  const result = await auditVault({ vaultDir: dir });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('DUPLICATE_MF_ID'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('broken parent and root relations fail', async () => {
  const { auditVault } = await auditPromise;
  const missingParent = makeVault({ extracts: { 'E.md': validExtract({ mf_parent_id: ID.extract2 }) } });
  const first = await auditVault({ vaultDir: missingParent });
  assert.equal(first.ok, false);
  assert.ok(codes(first).includes('PARENT_MISSING'));
  fs.rmSync(missingParent, { recursive: true, force: true });

  const wrongRoot = makeVault({
    sources: { 'A.md': validSource({ mf_root_id: ID.extract }) },
    extracts: { 'E.md': validExtract() },
  });
  const second = await auditVault({ vaultDir: wrongRoot });
  assert.equal(second.ok, false);
  assert.ok(codes(second).includes('ROOT_NOT_SOURCE') || codes(second).includes('ROOT_SELF_MISMATCH'));
  fs.rmSync(wrongRoot, { recursive: true, force: true });
});

test('an extract without a parent fails', async () => {
  const { auditVault } = await auditPromise;
  const dir = makeVault({ extracts: { 'E.md': validExtract({ mf_parent_id: null, mf_root_id: null }) } });
  const result = await auditVault({ vaultDir: dir });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('EXTRACT_WITHOUT_PARENT'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a card carrying mf_* fields fails Card isolation', async () => {
  const { auditVault } = await auditPromise;
  const dir = makeVault({ cards: { 'C.md': note({ type: 'card', status: 'active', mf_id: ID.card, mf_revision: 0 }) } });
  const result = await auditVault({ vaultDir: dir });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('CARD_MF_FIELDS'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ledger applied records must point at a real topic', async () => {
  const { auditVault } = await auditPromise;
  const data = {
    mfUs1Ledger: { records: { 'event-1': { eventId: 'event-1', topicId: ID.extract2, status: 'applied' } } },
  };
  const dir = makeVault({ sources: { 'A.md': validSource() }, data });
  const result = await auditVault({ vaultDir: dir });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('LEDGER_ORPHAN'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applied boost batches need event ids and matching targets', async () => {
  const { auditVault } = await auditPromise;
  const dataNoIds = { mfUs1Batches: { b1: { batchId: 'b1', kind: 'BOOST', status: 'applied', targets: [{ topicId: ID.source, from: 50, to: 45 }] } } };
  const dir = makeVault({ sources: { 'A.md': validSource({ priority: 45 }) }, data: dataNoIds });
  const first = await auditVault({ vaultDir: dir });
  assert.equal(first.ok, false);
  assert.ok(codes(first).includes('BATCH_NO_EVENT_IDS'));
  fs.rmSync(dir, { recursive: true, force: true });

  const dataWrongTarget = {
    mfUs1Batches: { b1: { batchId: 'b1', kind: 'BOOST', status: 'applied', eventIds: [{ topicId: ID.source, eventId: 'ev' }], targets: [{ topicId: ID.source, from: 50, to: 45 }] } },
  };
  const dir2 = makeVault({ sources: { 'A.md': validSource({ priority: 50 }) }, data: dataWrongTarget });
  const second = await auditVault({ vaultDir: dir2 });
  assert.equal(second.ok, false);
  assert.ok(codes(second).includes('BATCH_TARGET_MISMATCH'));
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('baseline comparison detects changes and honours --allow-changes', async () => {
  const { auditVault, snapshotVault } = await auditPromise;
  const dir = makeVault({ sources: { 'A.md': validSource() } });
  const baseline = await snapshotVault(dir);
  fs.writeFileSync(path.join(dir, 'Sources', 'A.md'), validSource({ priority: 10 }));
  const strict = await auditVault({ vaultDir: dir, baseline });
  assert.equal(strict.ok, false);
  assert.ok(codes(strict).includes('UNEXPECTED_CHANGES'));
  const allowed = await auditVault({ vaultDir: dir, baseline, allowChanges: true });
  assert.equal(allowed.ok, true, JSON.stringify(codes(allowed)));
  assert.ok(codes(allowed).includes('CHANGES_ALLOWED'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('empty profile rejects legacy topics; a legacy topic is reported as migration-required', async () => {
  const { auditVault } = await auditPromise;
  const legacy = note({ type: 'source', status: 'active', priority: 50, interval: 8, next_review: '2026-11-20' });
  const dir = makeVault({ sources: { 'Old.md': legacy } });
  const empty = await auditVault({ vaultDir: dir, profile: 'empty' });
  assert.equal(empty.ok, false);
  assert.ok(codes(empty).includes('LEGACY_TOPICS_IN_EMPTY_VAULT'));
  const auto = await auditVault({ vaultDir: dir });
  assert.ok(codes(auto).includes('MIGRATION_REQUIRED'));
  fs.rmSync(dir, { recursive: true, force: true });
});
