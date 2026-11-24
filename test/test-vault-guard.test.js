'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MARKER_NAME,
  MARKER_KIND,
  sha256,
  resolveVaultPath,
  validateTestVault,
  assertTestVault,
  assertInside,
  initMarker,
} = require('../scripts/test-vault.js');

function codes(result) {
  return result.errors.map(error => error.code);
}

function makeVault(t, { name = 'MemoFlow-Test', obsidian = true, marker = true, markerOverrides = {}, markerFrom = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, name);
  fs.mkdirSync(vault, { recursive: true });
  if (obsidian) fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  const real = fs.realpathSync(vault);
  if (marker) {
    const data = {
      kind: MARKER_KIND,
      markerVersion: 1,
      vaultId: crypto.randomUUID(),
      vaultName: name,
      pathHash: markerFrom ? sha256(fs.realpathSync(markerFrom)) : sha256(real),
      createdAt: new Date().toISOString(),
      ...markerOverrides,
    };
    fs.writeFileSync(path.join(real, MARKER_NAME), JSON.stringify(data, null, 2) + '\n');
  }
  return { root, vault: real, markerPath: path.join(real, MARKER_NAME) };
}

test('a marked MemoFlow-Test vault passes validation', (t) => {
  const { root, vault } = makeVault(t);
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.vault, vault);
  assert.match(result.marker.vaultId, /^[0-9a-f-]{36}$/);
});

test('a missing marker is rejected', (t) => {
  const { root, vault } = makeVault(t, { marker: false });
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('MARKER_MISSING'));
});

test('an invalid marker JSON is rejected', (t) => {
  const { root, vault, markerPath } = makeVault(t, { marker: false });
  fs.writeFileSync(markerPath, '{ not json');
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('MARKER_INVALID_JSON'));
});

test('marker kind, version, uuid and name are validated', (t) => {
  const { root, vault } = makeVault(t, {
    markerOverrides: { kind: 'other', markerVersion: 99, vaultId: 'not-a-uuid', vaultName: 'Other' },
  });
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  const found = codes(result);
  for (const code of ['MARKER_KIND', 'MARKER_VERSION', 'MARKER_UUID', 'MARKER_NAME']) {
    assert.ok(found.includes(code), `expected ${code}, got ${found.join(',')}`);
  }
});

test('a marker copied from another vault does not match the path hash', (t) => {
  const original = makeVault(t);
  const copy = makeVault(t, { markerFrom: original.vault });
  const result = validateTestVault(copy.vault, { repoRoot: path.join(copy.root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('MARKER_PATH_MISMATCH'));
});

test('a vault without .obsidian is rejected', (t) => {
  const { root, vault } = makeVault(t, { obsidian: false });
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('OBSIDIAN_MISSING'));
});

test('a symlinked .obsidian directory is rejected', (t) => {
  const { root, vault } = makeVault(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-obsidian-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(vault, '.obsidian'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(vault, '.obsidian'));
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('OBSIDIAN_SYMLINK'));
});

test('a symlinked marker file is rejected', (t) => {
  const { root, vault, markerPath } = makeVault(t, { marker: false });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-marker-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const marker = {
    kind: MARKER_KIND,
    markerVersion: 1,
    vaultId: crypto.randomUUID(),
    vaultName: 'MemoFlow-Test',
    pathHash: sha256(vault),
    createdAt: new Date().toISOString(),
  };
  const outsideMarker = path.join(outside, 'marker.json');
  fs.writeFileSync(outsideMarker, JSON.stringify(marker));
  fs.symlinkSync(outsideMarker, markerPath);
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('MARKER_SYMLINK'));
});

test('a symlinked vault path is rejected', (t) => {
  const { root, vault } = makeVault(t);
  const link = path.join(root, 'MemoFlow-Test-link');
  fs.symlinkSync(vault, link);
  const result = validateTestVault(link, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('VAULT_SYMLINK'));
});

test('a repository inside the vault is rejected', (t) => {
  const { vault } = makeVault(t);
  const repo = path.join(vault, 'repo');
  fs.mkdirSync(repo);
  const result = validateTestVault(vault, { repoRoot: repo });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('REPO_INSIDE_VAULT'));
});

test('a vault inside the repository is rejected', (t) => {
  const { root, vault } = makeVault(t);
  const result = validateTestVault(vault, { repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('VAULT_INSIDE_REPO'));
});

test('a daily-vault-like folder name is rejected even with a marker', (t) => {
  const { root, vault } = makeVault(t, { name: 'My-Daily-Vault' });
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('VAULT_NAME'));
});

test('assertInside accepts a new nested path inside the vault', (t) => {
  const { vault } = makeVault(t);
  const target = path.join(vault, 'Sources', 'new-note.md');
  assert.equal(assertInside(vault, target), target);
});

test('assertInside rejects a path outside the vault', (t) => {
  const { root, vault } = makeVault(t);
  assert.throws(() => assertInside(vault, path.join(vault, '..', 'outside.md')), /escapes the test vault/);
  assert.throws(() => assertInside(vault, path.join(root, 'outside.md')), /escapes the test vault/);
});

test('assertInside rejects an existing symlink target', (t) => {
  const { root, vault } = makeVault(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(vault, 'link');
  fs.symlinkSync(outside, link);
  assert.throws(() => assertInside(vault, link), /must not be a symlink/);
});

test('initMarker writes only the marker and validates', (t) => {
  const { root, vault } = makeVault(t, { marker: false });
  const before = fs.readdirSync(vault).sort();
  const created = initMarker(vault);
  assert.equal(created.marker.kind, MARKER_KIND);
  assert.equal(created.marker.pathHash, sha256(vault));
  assert.ok(fs.existsSync(created.markerPath));
  const after = fs.readdirSync(vault).sort();
  assert.deepEqual(after, [...before, MARKER_NAME].sort());
  const result = validateTestVault(vault, { repoRoot: path.join(root, 'repo') });
  assert.equal(result.ok, true);
});

test('initMarker refuses a second marker without force', (t) => {
  const { vault } = makeVault(t, { marker: false });
  initMarker(vault);
  assert.throws(() => initMarker(vault), /already exists/);
});

test('initMarker --force rotates the vault id but keeps the path hash', (t) => {
  const { vault } = makeVault(t, { marker: false });
  const first = initMarker(vault);
  const second = initMarker(vault, { force: true });
  assert.notEqual(first.marker.vaultId, second.marker.vaultId);
  assert.equal(first.marker.pathHash, second.marker.pathHash);
});

test('resolveVaultPath uses the repository sibling and supports the explicit override', () => {
  const base = resolveVaultPath({ repoRoot: path.join(path.sep, 'tmp', 'example-repo'), env: {} });
  assert.equal(base.requested, path.join(path.sep, 'tmp', 'MemoFlow-Test'));
  assert.equal(base.source, 'default');

  const override = resolveVaultPath({
    repoRoot: path.join(path.sep, 'tmp', 'example-repo'),
    env: { MF_TEST_VAULT: path.join(path.sep, 'tmp', 'copy') },
  });
  assert.equal(override.requested, path.join(path.sep, 'tmp', 'copy'));
  assert.equal(override.source, 'MF_TEST_VAULT');
});

test('assertTestVault fails closed and includes the marker initialization hint', () => {
  const missing = path.join(os.tmpdir(), 'mf-missing-vault-' + crypto.randomUUID());
  assert.throws(
    () => assertTestVault({ repoRoot: path.join(os.tmpdir(), 'mf-repo'), env: { MF_TEST_VAULT: missing } }),
    /Test vault validation failed[\s\S]*--init-marker[\s\S]*--confirm/,
  );
});
