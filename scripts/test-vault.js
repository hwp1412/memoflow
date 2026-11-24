'use strict';

// Test-vault guard for MemoFlow development scripts.
//
// A script that writes into an Obsidian vault must resolve the vault through
// this module first. The guard fails closed: a missing/invalid marker, a
// symlink, a path-hash mismatch, or a write target outside the vault all abort
// before anything is created or overwritten.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MARKER_NAME = '.memoflow-test-vault';
const MARKER_KIND = 'memoflow-test-vault';
const MARKER_VERSION = 1;
const VAULT_BASENAME = 'MemoFlow-Test';
const REPO_ROOT = path.resolve(__dirname, '..');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TestVaultError extends Error {
  constructor(message, details = [], code = 'TEST_VAULT_INVALID') {
    super(message);
    this.name = 'TestVaultError';
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function pathHash(realPath) {
  return sha256(realPath);
}

function defaultVaultPath(repoRoot = REPO_ROOT) {
  return path.resolve(repoRoot, '..', VAULT_BASENAME);
}

function resolveVaultPath({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const override = env && typeof env.MF_TEST_VAULT === 'string' ? env.MF_TEST_VAULT.trim() : '';
  const requested = override ? path.resolve(override) : defaultVaultPath(repoRoot);
  return { requested, source: override ? 'MF_TEST_VAULT' : 'default' };
}

function realpathOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

function insideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ''
    || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function readMarker(vaultPath) {
  const markerPath = path.join(vaultPath, MARKER_NAME);
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, code: 'MARKER_MISSING', message: `missing ${MARKER_NAME}`, markerPath };
    }
    return { ok: false, code: 'MARKER_READ_ERROR', message: `cannot read ${MARKER_NAME}`, markerPath };
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'MARKER_INVALID_JSON', message: `${MARKER_NAME} is not valid JSON`, markerPath };
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return { ok: false, code: 'MARKER_INVALID_SHAPE', message: `${MARKER_NAME} must be a JSON object`, markerPath };
  }
  return { ok: true, marker, markerPath };
}

function validateTestVault(vaultPath, { repoRoot = REPO_ROOT } = {}) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const requested = typeof vaultPath === 'string' ? vaultPath : '';
  const markerPath = path.join(requested || '.', MARKER_NAME);

  if (!requested || !path.isAbsolute(requested)) {
    add('PATH_NOT_ABSOLUTE', 'vault path must be absolute');
    return { ok: false, errors, vault: null, marker: null, markerPath };
  }

  let stat = null;
  try { stat = fs.lstatSync(requested); } catch { add('VAULT_MISSING', 'vault path does not exist'); }
  if (stat) {
    if (stat.isSymbolicLink()) add('VAULT_SYMLINK', 'vault path must not be a symlink');
    else if (!stat.isDirectory()) add('VAULT_NOT_DIR', 'vault path is not a directory');
  }

  const real = stat && !stat.isSymbolicLink() ? realpathOrNull(requested) : null;
  if (!real) {
    if (!errors.length) add('VAULT_UNRESOLVABLE', 'vault real path could not be resolved');
    return { ok: false, errors, vault: null, marker: null, markerPath };
  }

  if (path.basename(real) !== VAULT_BASENAME) {
    add('VAULT_NAME', `vault folder must be named ${VAULT_BASENAME}`);
  }

  const obsidian = path.join(real, '.obsidian');
  let obsidianStat = null;
  try { obsidianStat = fs.lstatSync(obsidian); } catch { /* handled below */ }
  if (!obsidianStat) {
    add('OBSIDIAN_MISSING', '.obsidian directory is missing');
  } else if (obsidianStat.isSymbolicLink()) {
    add('OBSIDIAN_SYMLINK', '.obsidian must not be a symlink');
  } else if (!obsidianStat.isDirectory()) {
    add('OBSIDIAN_NOT_DIR', '.obsidian is not a directory');
  }

  const markerResult = readMarker(real);
  if (!markerResult.ok) add(markerResult.code, markerResult.message);
  const marker = markerResult.marker || null;
  if (markerResult.ok) {
    try {
      if (fs.lstatSync(markerResult.markerPath).isSymbolicLink()) add('MARKER_SYMLINK', 'marker must not be a symlink');
    } catch { /* marker read succeeded, lstat should not fail */ }
  }
  if (marker) {
    if (marker.kind !== MARKER_KIND) add('MARKER_KIND', `marker.kind must be ${MARKER_KIND}`);
    if (marker.markerVersion !== MARKER_VERSION) add('MARKER_VERSION', `marker.markerVersion must be ${MARKER_VERSION}`);
    if (!UUID_V4.test(String(marker.vaultId || ''))) add('MARKER_UUID', 'marker.vaultId must be a UUID v4');
    if (marker.vaultName !== VAULT_BASENAME) add('MARKER_NAME', `marker.vaultName must be ${VAULT_BASENAME}`);
    if (typeof marker.pathHash !== 'string' || marker.pathHash !== pathHash(real)) {
      add('MARKER_PATH_MISMATCH', 'marker.pathHash does not match this vault path');
    }
  }

  const repoReal = realpathOrNull(repoRoot) || path.resolve(repoRoot);
  if (repoReal === real) add('REPO_EQUALS_VAULT', 'repository root must not be the test vault');
  if (insideOrEqual(real, repoReal)) add('REPO_INSIDE_VAULT', 'repository must not be inside the test vault');
  if (insideOrEqual(repoReal, real)) add('VAULT_INSIDE_REPO', 'test vault must not be inside the repository');

  return {
    ok: errors.length === 0,
    errors,
    vault: real,
    marker,
    markerPath: path.join(real, MARKER_NAME),
  };
}

function assertTestVault({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const { requested, source } = resolveVaultPath({ repoRoot, env });
  const result = validateTestVault(requested, { repoRoot });
  if (!result.ok) {
    const lines = result.errors.map(error => `- ${error.code}: ${error.message}`).join('\n');
    throw new TestVaultError(
      `Test vault validation failed: ${requested}\n${lines}\n`
      + 'No files were created or overwritten.\n'
      + 'After a verified backup, initialize the marker with:\n'
      + `  node scripts/test-vault.js --init-marker --vault "${requested}" --confirm`,
      result.errors,
    );
  }
  return { vault: result.vault, marker: result.marker, source, requested };
}

function assertInside(vaultPath, targetPath) {
  const vault = realpathOrNull(vaultPath);
  if (!vault) throw new TestVaultError(`Test vault is not resolvable: ${vaultPath}`);
  if (!path.isAbsolute(String(targetPath || ''))) {
    throw new TestVaultError(`Write target must be absolute: ${targetPath}`);
  }
  const target = path.resolve(targetPath);
  if (target === vault || !insideOrEqual(vault, target)) {
    throw new TestVaultError(`Write target escapes the test vault: ${target}`);
  }

  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const parentReal = realpathOrNull(parent);
  if (!parentReal || !insideOrEqual(vault, parentReal)) {
    throw new TestVaultError(`Write target parent escapes the test vault: ${target}`);
  }

  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new TestVaultError(`Write target must not be a symlink: ${target}`);
    }
  } catch (error) {
    if (error instanceof TestVaultError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

function initMarker(vaultPath, { force = false } = {}) {
  const requested = typeof vaultPath === 'string' ? vaultPath : '';
  if (!requested || !path.isAbsolute(requested)) {
    throw new TestVaultError('--vault must be an absolute path');
  }
  let stat = null;
  try { stat = fs.lstatSync(requested); } catch { throw new TestVaultError(`Vault does not exist: ${requested}`); }
  if (stat.isSymbolicLink()) throw new TestVaultError('Vault path must not be a symlink');
  if (!stat.isDirectory()) throw new TestVaultError('Vault path is not a directory');

  const real = fs.realpathSync(requested);
  if (path.basename(real) !== VAULT_BASENAME) {
    throw new TestVaultError(`Vault folder must be named ${VAULT_BASENAME}`);
  }
  const obsidian = path.join(real, '.obsidian');
  let obsidianStat = null;
  try { obsidianStat = fs.lstatSync(obsidian); } catch { obsidianStat = null; }
  if (!obsidianStat || !obsidianStat.isDirectory() || obsidianStat.isSymbolicLink()) {
    throw new TestVaultError('.obsidian must be a real directory (not missing, not a symlink)');
  }

  const markerPath = path.join(real, MARKER_NAME);
  if (fs.existsSync(markerPath) && fs.lstatSync(markerPath).isSymbolicLink()) {
    throw new TestVaultError('Existing marker is a symlink; refusing to write through it');
  }
  if (fs.existsSync(markerPath) && !force) {
    throw new TestVaultError(`Marker already exists: ${markerPath}; use --force only after a backup`);
  }

  const marker = {
    kind: MARKER_KIND,
    markerVersion: MARKER_VERSION,
    vaultId: crypto.randomUUID(),
    vaultName: VAULT_BASENAME,
    pathHash: pathHash(real),
    createdAt: new Date().toISOString(),
    warning: 'MemoFlow development test vault only. Never copy this marker into a real vault.',
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  return { marker, markerPath, vault: real };
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/test-vault.js --check [--json]',
    '  node scripts/test-vault.js --init-marker --vault <absolute-test-vault> --confirm [--force]',
    '',
    'Default vault: <repo>/../MemoFlow-Test',
    'Override:      MF_TEST_VAULT=/absolute/path (still validated)',
  ].join('\n'));
}

function runCli(argv) {
  const has = flag => argv.includes(flag);
  const valueOf = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };

  if (has('--check')) {
    const { vault, marker, source, requested } = assertTestVault();
    if (has('--json')) {
      console.log(JSON.stringify({ ok: true, vault, vaultId: marker.vaultId, markerPath: path.join(vault, MARKER_NAME), source, requested }, null, 2));
    } else {
      console.log('Test vault OK');
      console.log(`  path:   ${vault}`);
      console.log(`  vaultId: ${marker.vaultId}`);
      console.log(`  marker: ${path.join(vault, MARKER_NAME)}`);
      console.log(`  source: ${source}`);
    }
    return;
  }

  if (has('--init-marker')) {
    const vaultArg = valueOf('--vault');
    if (!vaultArg || !has('--confirm')) {
      usage();
      process.exitCode = 2;
      return;
    }
    const { marker, markerPath, vault } = initMarker(vaultArg, { force: has('--force') });
    console.log('Test vault marker written');
    console.log(`  vault:   ${vault}`);
    console.log(`  vaultId: ${marker.vaultId}`);
    console.log(`  marker:  ${markerPath}`);
    console.log('  notes, data.json, plugins and .obsidian config were not changed.');
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  MARKER_NAME,
  MARKER_KIND,
  MARKER_VERSION,
  VAULT_BASENAME,
  REPO_ROOT,
  TestVaultError,
  sha256,
  pathHash,
  defaultVaultPath,
  resolveVaultPath,
  readMarker,
  validateTestVault,
  assertTestVault,
  assertInside,
  initMarker,
};
