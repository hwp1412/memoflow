'use strict';

// M02 backup/restore library for the isolated MemoFlow test vault.
// It deliberately depends on the M01 test-vault guard: no path handler here
// bypasses marker, realpath or boundary checks.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const guard = require('./test-vault.js');

const {
  MARKER_NAME,
  MARKER_KIND,
  MARKER_VERSION,
  REPO_ROOT,
  assertTestVault,
  readMarker,
  validateTestVault,
  pathHash,
} = guard;

const MANIFEST_NAME = 'manifest.json';
const CHECKSUMS_NAME = 'checksums.sha256';
const VAULT_DIR = 'vault';
const RESTORE_DOC = 'RESTORE.md';
const MANIFEST_SCHEMA = 1;
const JOURNAL_SCHEMA = 1;
const DEFAULT_LABEL = 'manual';
const CATEGORIES = [
  'notes',
  'pdf',
  'attachments',
  'obsidian-config',
  'memoflow',
  'spaced-repetition',
  'marker',
  'other',
];

class VaultSnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VaultSnapshotError';
    this.code = code;
    this.details = details;
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(value) {
  return sha256Buffer(Buffer.from(String(value), 'utf8'));
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function posixPath(relativePath) {
  return String(relativePath).split(path.sep).join('/');
}

function fromPosix(relativePath) {
  return String(relativePath).split('/').join(path.sep);
}

function normalizeRelative(relativePath) {
  const value = String(relativePath == null ? '' : relativePath).trim();
  if (!value) throw new VaultSnapshotError('PATH_EMPTY', 'path must not be empty');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new VaultSnapshotError('PATH_ABSOLUTE', `path must be relative: ${value}`);
  }
  if (value.includes('\\')) {
    throw new VaultSnapshotError('PATH_BACKSLASH', `path must use forward slashes: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw new VaultSnapshotError('PATH_TRAVERSAL', `path escapes the vault: ${value}`);
  }
  if (normalized === '.') throw new VaultSnapshotError('PATH_EMPTY', 'path must not be the vault root');
  return normalized;
}

function categoryFor(relativePath) {
  const rel = posixPath(relativePath);
  if (rel === MARKER_NAME) return 'marker';
  if (rel.startsWith(`.obsidian/plugins/memoflow/`)) return 'memoflow';
  if (rel.startsWith(`.obsidian/plugins/obsidian-spaced-repetition/`)) return 'spaced-repetition';
  if (rel.startsWith('.obsidian/')) return 'obsidian-config';
  if (rel.toLowerCase().endsWith('.md')) return 'notes';
  if (rel.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (rel.split('/').pop() === '.DS_Store') return 'other';
  return 'attachments';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function nowStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeLabel(label) {
  const value = String(label == null ? DEFAULT_LABEL : label)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || DEFAULT_LABEL;
}

function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new VaultSnapshotError('PATH_IN_USE', `could not find a free path for ${base}`);
}

function insideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ''
    || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function realForCheck(target) {
  let current = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const real = await fsp.realpath(current);
  return tail.length ? path.join(real, ...tail) : real;
}

async function assertOutsidePath(parent, target, label) {
  const parentReal = await realForCheck(parent);
  const targetReal = await realForCheck(target);
  if (insideOrEqual(parentReal, targetReal)) {
    throw new VaultSnapshotError('PATH_ESCAPE', `${label} must be outside ${parentReal}: ${targetReal}`);
  }
  return targetReal;
}

function defaultBackupRoot() {
  return path.resolve(REPO_ROOT, '..', 'MemoFlow-Backups');
}

function isDefaultVault(vaultPath) {
  try {
    const target = fs.realpathSync(vaultPath);
    const fallback = path.resolve(REPO_ROOT, '..', 'MemoFlow-Test');
    if (!fs.existsSync(fallback)) return false;
    return target === fs.realpathSync(fallback);
  } catch {
    return false;
  }
}

function isDefaultVaultPath(vaultPath) {
  const target = path.resolve(String(vaultPath || ''));
  const fallback = path.resolve(REPO_ROOT, '..', 'MemoFlow-Test');
  if (target === fallback) return true;
  try {
    return fs.realpathSync(target) === fs.realpathSync(fallback);
  } catch {
    return false;
  }
}

function assertObsidianClosedForTarget(target, {
  isRunning = isObsidianRunning,
  isDefault = isDefaultVaultPath,
  confirmed = false,
} = {}) {
  if (!isDefault(target)) return;
  const status = isRunning();
  if (status.running) {
    throw new VaultSnapshotError('OBSIDIAN_RUNNING', 'Obsidian is running; fully quit Obsidian before recovering the default test vault');
  }
  if (!status.supported && !confirmed) {
    throw new VaultSnapshotError('OBSIDIAN_UNVERIFIED', 'cannot verify that Obsidian is closed; re-run with --confirm-obsidian-closed');
  }
}

function isObsidianRunning({ platform = process.platform, exec = spawnSync } = {}) {
  if (platform === 'darwin' || platform === 'linux') {
    const name = platform === 'darwin' ? 'Obsidian' : 'obsidian';
    const result = exec('pgrep', ['-x', name], { encoding: 'utf8' });
    if (result.error || result.status == null) return { running: false, supported: false };
    if (result.status === 0) return { running: true, supported: true };
    if (result.status === 1) return { running: false, supported: true };
    return { running: false, supported: false };
  }
  if (platform === 'win32') {
    const result = exec('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe'], { encoding: 'utf8' });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      return { running: false, supported: false };
    }
    return { running: result.stdout.toLowerCase().includes('obsidian.exe'), supported: true };
  }
  return { running: false, supported: false };
}

function checkFreeSpace(target, requiredBytes, { statfs = fs.statfsSync } = {}) {
  if (typeof statfs !== 'function') return { ok: true, supported: false, available: null };
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const stat = statfs(current);
    const available = Number(stat.bavail) * Number(stat.bsize);
    return { ok: available >= requiredBytes, supported: true, available, required: requiredBytes };
  } catch {
    return { ok: true, supported: false, available: null };
  }
}

async function walkVault(root) {
  const rootReal = await fsp.realpath(root);
  const rootStat = await fsp.lstat(rootReal);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new VaultSnapshotError('VAULT_ROOT', `vault root must be a real directory: ${root}`);
  }
  const files = [];
  const dirs = [];
  async function walk(absoluteDir, relativeDir) {
    const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new VaultSnapshotError('SYMLINK_FOUND', `symlinks are not allowed in the test vault: ${relative}`);
      }
      if (stat.isDirectory()) {
        dirs.push({ path: relative, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs });
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        files.push({
          path: relative,
          absolute,
          size: stat.size,
          mode: stat.mode & 0o777,
          mtimeMs: stat.mtimeMs,
        });
      } else {
        throw new VaultSnapshotError('SPECIAL_FILE', `unsupported special file: ${relative}`);
      }
    }
  }
  await walk(rootReal, '');
  return { root: rootReal, files, dirs };
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function buildManifest(root, { sourcePath = root } = {}) {
  const tree = await walkVault(root);
  const files = [];
  const byCategory = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  let totalBytes = 0;
  for (const file of tree.files) {
    const category = categoryFor(file.path);
    const hash = await sha256File(file.absolute);
    totalBytes += file.size;
    byCategory[category] += 1;
    files.push({
      path: file.path,
      size: file.size,
      sha256: hash,
      mode: file.mode,
      mtimeMs: file.mtimeMs,
      category,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const markerPath = path.join(tree.root, MARKER_NAME);
  let marker = null;
  if (fs.existsSync(markerPath)) {
    const parsed = readMarker(tree.root);
    marker = {
      path: MARKER_NAME,
      sha256: await sha256File(markerPath),
      vaultId: parsed && parsed.ok !== false && parsed.marker ? parsed.marker.vaultId : null,
      vaultName: parsed && parsed.ok !== false && parsed.marker ? parsed.marker.vaultName : null,
    };
  }
  const memoflowManifest = await readJson(path.join(tree.root, '.obsidian/plugins/memoflow/manifest.json'));
  const srManifest = await readJson(path.join(tree.root, '.obsidian/plugins/obsidian-spaced-repetition/manifest.json'));
  const dataHash = async relative => {
    const file = path.join(tree.root, relative);
    return fs.existsSync(file) ? sha256File(file) : null;
  };
  return {
    schemaVersion: MANIFEST_SCHEMA,
    kind: 'memoflow-test-vault-backup',
    createdAt: new Date().toISOString(),
    tool: 'm02',
    source: {
      path: path.resolve(sourcePath),
      realpath: tree.root,
      vaultId: marker ? marker.vaultId : null,
      vaultName: marker ? marker.vaultName : path.basename(tree.root),
    },
    counts: {
      files: files.length,
      directories: tree.dirs.length,
      bytes: totalBytes,
      byCategory,
    },
    plugins: {
      memoflow: memoflowManifest ? {
        version: memoflowManifest.version || null,
        dataSha256: await dataHash('.obsidian/plugins/memoflow/data.json'),
      } : null,
      'obsidian-spaced-repetition': srManifest ? {
        version: srManifest.version || null,
        dataSha256: await dataHash('.obsidian/plugins/obsidian-spaced-repetition/data.json'),
      } : null,
    },
    files,
    directories: tree.dirs.map(dir => ({ path: dir.path, mode: dir.mode, mtimeMs: dir.mtimeMs })),
    marker,
    archive: null,
  };
}

function manifestFileMap(manifest) {
  const map = new Map();
  for (const file of manifest.files || []) {
    map.set(file.path, file);
  }
  return map;
}

function manifestDirectorySet(manifest) {
  return new Set((manifest.directories || []).map(dir => (typeof dir === 'string' ? dir : dir.path)));
}

function sameManifest(left, right) {
  if (!left || !right) return false;
  const leftFiles = manifestFileMap(left);
  const rightFiles = manifestFileMap(right);
  if (leftFiles.size !== rightFiles.size) return false;
  for (const [name, file] of leftFiles) {
    const other = rightFiles.get(name);
    if (!other || other.size !== file.size || other.sha256 !== file.sha256) return false;
  }
  const leftDirs = manifestDirectorySet(left);
  const rightDirs = manifestDirectorySet(right);
  if (leftDirs.size !== rightDirs.size) return false;
  for (const dir of leftDirs) if (!rightDirs.has(dir)) return false;
  return true;
}

async function verifyTree(root, expectedFiles, { strict = true } = {}) {
  const tree = await walkVault(root);
  const actual = new Map();
  for (const file of tree.files) {
    const hash = await sha256File(file.absolute);
    actual.set(file.path, { path: file.path, size: file.size, sha256: hash });
  }
  const missing = [];
  const changed = [];
  for (const [name, expected] of expectedFiles) {
    const file = actual.get(name);
    if (!file) missing.push(name);
    else if (file.size !== expected.size || file.sha256 !== expected.sha256) changed.push(name);
  }
  const extra = [];
  if (strict) {
    for (const name of actual.keys()) if (!expectedFiles.has(name)) extra.push(name);
  }
  if (missing.length || changed.length || extra.length) {
    throw new VaultSnapshotError('BACKUP_MISMATCH', 'backup verification failed', { missing, changed, extra });
  }
  return { files: actual, tree };
}

async function copyTree(source, destination, { exclude = [] } = {}) {
  const tree = await walkVault(source);
  const excluded = new Set(exclude.map(value => normalizeRelative(value)));
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const dir of tree.dirs) {
    if (excluded.has(dir.path)) continue;
    const target = path.join(destination, fromPosix(dir.path));
    await fsp.mkdir(target, { recursive: true, mode: dir.mode || 0o700 });
    if (process.platform !== 'win32') await fsp.chmod(target, dir.mode || 0o700).catch(() => {});
  }
  for (const file of tree.files) {
    if (excluded.has(file.path)) continue;
    const target = path.join(destination, fromPosix(file.path));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(file.absolute, target);
    if (process.platform !== 'win32') await fsp.chmod(target, file.mode || 0o600).catch(() => {});
    await fsp.utimes(target, new Date(file.mtimeMs), new Date(file.mtimeMs)).catch(() => {});
  }
}

async function copyOneFile(sourceRoot, relativePath, destinationRoot) {
  const relative = normalizeRelative(relativePath);
  const source = path.join(sourceRoot, fromPosix(relative));
  const destination = path.join(destinationRoot, fromPosix(relative));
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new VaultSnapshotError('NOT_A_FILE', `not a regular file: ${relative}`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
  if (process.platform !== 'win32') await fsp.chmod(destination, stat.mode & 0o777).catch(() => {});
  await fsp.utimes(destination, stat.atime, stat.mtime).catch(() => {});
}

function checksumsText(manifest) {
  return `${(manifest.files || [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(file => `${file.sha256}  ${file.path}`)
    .join('\n')}\n`;
}

function parseChecksums(content) {
  const entries = new Map();
  for (const line of String(content || '').split('\n')) {
    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (!match) continue;
    const raw = match[2].trim().replace(/^\.\//, '');
    entries.set(normalizeRelative(raw), match[1].toLowerCase());
  }
  return entries;
}

async function readChecksums(backupDir) {
  const file = path.join(backupDir, CHECKSUMS_NAME);
  if (!fs.existsSync(file)) return null;
  return parseChecksums(await fsp.readFile(file, 'utf8'));
}

async function writeManifestFiles(backupDir, manifest) {
  await fsp.writeFile(path.join(backupDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(backupDir, CHECKSUMS_NAME), checksumsText(manifest), 'utf8');
  await fsp.writeFile(path.join(backupDir, RESTORE_DOC), restoreDoc(backupDir, manifest), 'utf8');
}

function restoreDoc(backupDir, manifest) {
  return `# MemoFlow test vault restore

- Backup: ${backupDir}
- Source: ${manifest.source.path}
- Files: ${manifest.counts.files}, bytes: ${manifest.counts.bytes}
- Format: vault-backup v${manifest.schemaVersion}

## Safety

1. Quit Obsidian completely.
2. Never restore this backup into a daily/real vault.
3. Preview first:
   node scripts/restore-test-vault.mjs --backup "${backupDir}" --vault "<test-vault>" --dry-run
4. Apply only after reviewing the plan:
   node scripts/restore-test-vault.mjs --backup "${backupDir}" --vault "<test-vault>" --apply --mode merge --yes

## Marker

The backup contains the source vault marker, but restore never writes it to a
different path. The target vault marker is preserved; a fresh target must be
prepared with:

  mkdir -p "<test-vault>/.obsidian"
  node scripts/test-vault.js --init-marker --vault "<test-vault>" --confirm

## Recovery

A failed/interrupted restore keeps the old target at
<target>.before-restore-<timestamp> and writes a restore journal next to it.
Run:

  node scripts/restore-test-vault.mjs --recover --journal "<journal>"
`;
}

async function createBackup({
  vault,
  outRoot = defaultBackupRoot(),
  label = DEFAULT_LABEL,
  archive = false,
  dryRun = false,
  obsidianRunning = false,
  hooks = {},
  now = new Date(),
  statfs = fs.statfsSync,
} = {}) {
  if (!vault) throw new VaultSnapshotError('VAULT_REQUIRED', 'vault path is required');
  const { vault: vaultReal } = assertTestVault({ repoRoot: REPO_ROOT, env: { MF_TEST_VAULT: vault } });
  if (obsidianRunning) {
    throw new VaultSnapshotError('OBSIDIAN_RUNNING', 'Obsidian must be fully quit before backing up the default test vault');
  }
  const root = path.resolve(outRoot);
  await assertOutsidePath(vaultReal, root, 'backup root');
  await assertOutsidePath(REPO_ROOT, root, 'repository');
  const manifest = await buildManifest(vaultReal);
  if (dryRun) {
    return { dryRun: true, vault: vaultReal, outRoot: root, manifest };
  }
  const space = checkFreeSpace(root, Math.ceil(manifest.counts.bytes * (archive ? 2.2 : 1.2)), { statfs });
  if (space.supported && !space.ok) {
    throw new VaultSnapshotError('NO_SPACE', `insufficient space for backup: need ${space.required}, available ${space.available}`);
  }
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = nowStamp(now);
  const finalDir = uniquePath(path.join(root, `${stamp}_${sanitizeLabel(label)}`));
  const partialDir = `${finalDir}.partial`;
  const partialVault = path.join(partialDir, VAULT_DIR);
  await fsp.rm(partialDir, { recursive: true, force: true });
  await fsp.mkdir(partialVault, { recursive: true, mode: 0o700 });
  try {
    await copyTree(vaultReal, partialVault);
    await hooks.afterCopy?.({ vault: vaultReal, partialDir });
    const after = await buildManifest(vaultReal);
    if (!sameManifest(manifest, after)) {
      throw new VaultSnapshotError('SOURCE_CHANGED', 'source vault changed while the backup was being copied');
    }
    await verifyTree(partialVault, manifestFileMap(manifest), { strict: true });
    if (archive) {
      const archivePath = path.join(partialDir, 'vault.tar.gz');
      const result = spawnSync('tar', ['-czf', archivePath, '-C', partialVault, '.'], { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        throw new VaultSnapshotError('ARCHIVE_FAILED', `tar failed: ${result.error ? result.error.message : result.stderr || result.status}`);
      }
      const archiveStat = await fsp.stat(archivePath);
      manifest.archive = { name: 'vault.tar.gz', size: archiveStat.size, sha256: await sha256File(archivePath) };
    }
    await writeManifestFiles(partialDir, manifest);
    await fsp.rename(partialDir, finalDir);
    return { dryRun: false, dir: finalDir, vault: vaultReal, manifest };
  } catch (error) {
    error.details = { ...(error.details || {}), partialDir };
    throw error;
  }
}

function detectBackupFormat(backupDir) {
  const manifest = path.join(backupDir, MANIFEST_NAME);
  if (fs.existsSync(manifest) && fs.existsSync(path.join(backupDir, VAULT_DIR))) return 'v2';
  if (fs.existsSync(path.join(backupDir, 'checksums/backup.sha256')) && fs.existsSync(path.join(backupDir, 'MemoFlow-Test'))) {
    return 'legacy-m01';
  }
  throw new VaultSnapshotError('BACKUP_FORMAT', `unrecognized backup format: ${backupDir}`);
}

async function verifyLegacyBackup(backupDir, { strict = true } = {}) {
  const payload = path.join(backupDir, 'MemoFlow-Test');
  const checksums = parseChecksums(await fsp.readFile(path.join(backupDir, 'checksums/backup.sha256'), 'utf8'));
  const tree = await walkVault(payload);
  const actual = new Map();
  for (const file of tree.files) actual.set(file.path, { path: file.path, size: file.size, sha256: await sha256File(file.absolute) });
  const missing = [];
  const changed = [];
  for (const [name, hash] of checksums) {
    const file = actual.get(name);
    if (!file) missing.push(name);
    else if (file.sha256 !== hash) changed.push(name);
  }
  const extra = [];
  if (strict) for (const name of actual.keys()) if (!checksums.has(name)) extra.push(name);
  if (missing.length || changed.length || extra.length) {
    throw new VaultSnapshotError('BACKUP_MISMATCH', 'legacy backup verification failed', { missing, changed, extra });
  }
  const manifest = {
    schemaVersion: 0,
    kind: 'memoflow-test-vault-backup',
    format: 'legacy-m01',
    source: { path: null, realpath: null, vaultId: null, vaultName: 'MemoFlow-Test' },
    counts: {
      files: tree.files.length,
      directories: tree.dirs.length,
      bytes: tree.files.reduce((sum, file) => sum + file.size, 0),
      byCategory: {},
    },
    plugins: null,
    files: tree.files.map(file => ({
      path: file.path,
      size: file.size,
      sha256: actual.get(file.path).sha256,
      mode: file.mode,
      mtimeMs: file.mtimeMs,
      category: categoryFor(file.path),
    })),
    directories: tree.dirs.map(dir => ({ path: dir.path, mode: dir.mode, mtimeMs: dir.mtimeMs })),
    marker: null,
    archive: null,
  };
  return { format: 'legacy-m01', root: payload, manifest, backupDir };
}

function validateManifestPaths(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new VaultSnapshotError('MANIFEST_INVALID', 'manifest.files must be an array');
  }
  for (const file of manifest.files) {
    normalizeRelative(file.path);
  }
  for (const dir of manifest.directories || []) {
    normalizeRelative(typeof dir === 'string' ? dir : dir.path);
  }
}

async function verifyBackup(backupDir, { strict = true } = {}) {
  const dir = await fsp.realpath(backupDir);
  const stat = await fsp.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new VaultSnapshotError('BACKUP_ROOT', 'backup path must be a real directory');
  }
  const format = detectBackupFormat(dir);
  if (format === 'legacy-m01') return verifyLegacyBackup(dir, { strict });
  const manifest = await readJson(path.join(dir, MANIFEST_NAME));
  if (!manifest || manifest.kind !== 'memoflow-test-vault-backup' || manifest.schemaVersion !== MANIFEST_SCHEMA) {
    throw new VaultSnapshotError('MANIFEST_INVALID', 'backup manifest is invalid');
  }
  validateManifestPaths(manifest);
  const payload = path.join(dir, VAULT_DIR);
  const result = await verifyTree(payload, manifestFileMap(manifest), { strict });
  if (manifest.directories) {
    const actualDirs = new Set(result.tree.dirs.map(dirEntry => dirEntry.path));
    const missingDirs = manifest.directories.map(entry => entry.path || entry).filter(name => !actualDirs.has(name));
    if (missingDirs.length) throw new VaultSnapshotError('BACKUP_MISMATCH', 'backup directories are missing', { missing: missingDirs });
  }
  const checksums = await readChecksums(dir);
  if (!checksums) throw new VaultSnapshotError('CHECKSUMS_MISSING', 'checksums.sha256 is missing');
  const manifestHashes = new Map(manifest.files.map(file => [file.path, file.sha256]));
  if (checksums.size !== manifestHashes.size) throw new VaultSnapshotError('CHECKSUMS_MISMATCH', 'checksums count differs from manifest');
  for (const [name, hash] of manifestHashes) {
    if (checksums.get(name) !== hash) throw new VaultSnapshotError('CHECKSUMS_MISMATCH', `checksums differs for ${name}`);
  }
  if (manifest.archive) {
    const archivePath = path.join(dir, manifest.archive.name || 'vault.tar.gz');
    const archiveStat = await fsp.stat(archivePath).catch(() => null);
    if (!archiveStat || archiveStat.size !== manifest.archive.size || await sha256File(archivePath) !== manifest.archive.sha256) {
      throw new VaultSnapshotError('ARCHIVE_MISMATCH', 'backup archive is missing or corrupt');
    }
  }
  return { format: 'v2', root: payload, manifest, backupDir: dir };
}

function targetMarkerEntry(manifest) {
  return (manifest.files || []).find(file => file.path === MARKER_NAME) || null;
}

async function planRestore({ backupDir, target, mode = 'merge', select = [] } = {}) {
  if (!backupDir || !target) throw new VaultSnapshotError('ARGS', '--backup and --vault are required');
  if (!['merge', 'replace'].includes(mode)) throw new VaultSnapshotError('MODE', `unknown restore mode: ${mode}`);
  const backup = await verifyBackup(backupDir, { strict: true });
  const { vault: targetReal } = assertTestVault({ repoRoot: REPO_ROOT, env: { MF_TEST_VAULT: target } });
  await assertOutsidePath(targetReal, backup.backupDir, 'backup');
  const targetManifest = await buildManifest(targetReal);
  const targetMap = manifestFileMap(targetManifest);
  const backupMap = manifestFileMap(backup.manifest);
  backupMap.delete(MARKER_NAME);
  const selectList = (Array.isArray(select) ? select : []).map(normalizeRelative);
  if (selectList.length && mode === 'replace') {
    throw new VaultSnapshotError('MODE', '--select cannot be combined with --mode replace');
  }
  for (const name of selectList) {
    if (name === MARKER_NAME) throw new VaultSnapshotError('MARKER_SELECT', 'the test-vault marker is never restored from a backup');
    if (!backupMap.has(name)) throw new VaultSnapshotError('SELECT_MISSING', `selected path is not in backup: ${name}`);
  }
  const restoreNames = selectList.length ? selectList : [...backupMap.keys()];
  const added = [];
  const replaced = [];
  const unchanged = [];
  for (const name of restoreNames) {
    const source = backupMap.get(name);
    const current = targetMap.get(name);
    if (!current) added.push(name);
    else if (current.size !== source.size || current.sha256 !== source.sha256) replaced.push(name);
    else unchanged.push(name);
  }
  const removed = mode === 'replace'
    ? [...targetMap.keys()].filter(name => name !== MARKER_NAME && !backupMap.has(name))
    : [];
  const filesToRestore = restoreNames.map(name => backupMap.get(name));
  const bytes = filesToRestore.reduce((sum, file) => sum + file.size, 0);
  if (!targetMarkerEntry(targetManifest)) {
    throw new VaultSnapshotError('TARGET_MARKER', 'target vault is missing a test-vault marker');
  }
  return {
    backupDir: backup.backupDir,
    backup,
    backupRoot: path.dirname(backup.backupDir),
    target: targetReal,
    targetManifest,
    targetMarker: targetMarkerEntry(targetManifest),
    mode,
    select: selectList,
    filesToRestore,
    added,
    replaced,
    removed,
    unchanged,
    bytes,
    isDefault: isDefaultVault(targetReal),
  };
}

function expectedFilesForPlan(plan) {
  const expected = new Map();
  if (plan.mode === 'replace') {
    for (const file of plan.backup.manifest.files) {
      if (file.path !== MARKER_NAME) expected.set(file.path, { path: file.path, size: file.size, sha256: file.sha256 });
    }
    expected.set(MARKER_NAME, {
      path: MARKER_NAME,
      size: plan.targetMarker.size,
      sha256: plan.targetMarker.sha256,
    });
  } else {
    for (const file of plan.targetManifest.files) expected.set(file.path, { path: file.path, size: file.size, sha256: file.sha256 });
    for (const file of plan.filesToRestore) expected.set(file.path, { path: file.path, size: file.size, sha256: file.sha256 });
  }
  return expected;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_HEX = /^[0-9a-f]{64}$/i;
const JOURNAL_PHASES = new Set(['staging', 'staging-ready', 'old-renamed', 'swapped', 'verified']);

async function backupProof(backupDir, format) {
  const file = format === 'legacy-m01'
    ? path.join(backupDir, 'checksums/backup.sha256')
    : path.join(backupDir, MANIFEST_NAME);
  if (!fs.existsSync(file)) throw new VaultSnapshotError('JOURNAL_BACKUP', `backup proof file is missing: ${file}`);
  return sha256File(file);
}

async function markerForRecovery(directory, targetReal, journal) {
  const parsed = readMarker(directory);
  if (!parsed || parsed.ok === false || !parsed.marker) {
    throw new VaultSnapshotError('JOURNAL_MARKER', `missing or invalid test-vault marker: ${directory}`);
  }
  const marker = parsed.marker;
  if (marker.kind !== MARKER_KIND || marker.markerVersion !== MARKER_VERSION) {
    throw new VaultSnapshotError('JOURNAL_MARKER', 'marker kind/version is invalid');
  }
  if (marker.vaultName !== 'MemoFlow-Test' || !UUID_V4.test(String(marker.vaultId || ''))) {
    throw new VaultSnapshotError('JOURNAL_MARKER', 'marker vault identity is invalid');
  }
  if (marker.pathHash !== pathHash(targetReal)) {
    throw new VaultSnapshotError('JOURNAL_MARKER_PATH', 'marker path hash does not belong to the restore target');
  }
  if (marker.vaultId !== journal.vaultId) {
    throw new VaultSnapshotError('JOURNAL_VAULT_ID', 'marker vaultId does not match the restore journal');
  }
  const hash = await sha256File(path.join(directory, MARKER_NAME));
  if (hash !== journal.markerSha256) {
    throw new VaultSnapshotError('JOURNAL_MARKER_HASH', 'marker hash does not match the restore journal');
  }
  return marker;
}

async function validateRestoreJournal(journalPath) {
  const file = path.resolve(String(journalPath || ''));
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new VaultSnapshotError('JOURNAL', `restore journal is missing: ${file}`);
  }
  let journal;
  try {
    journal = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    throw new VaultSnapshotError('JOURNAL', 'restore journal is not valid JSON');
  }
  if (!journal || journal.schemaVersion !== JOURNAL_SCHEMA || journal.kind !== 'memoflow-restore-journal') {
    throw new VaultSnapshotError('JOURNAL', 'restore journal is invalid');
  }
  if (!UUID_V4.test(String(journal.journalId || '')) || !UUID_V4.test(String(journal.vaultId || ''))) {
    throw new VaultSnapshotError('JOURNAL_ID', 'restore journal id/vaultId is invalid');
  }
  if (!HASH_HEX.test(String(journal.markerSha256 || '')) || !HASH_HEX.test(String(journal.backupProof || ''))) {
    throw new VaultSnapshotError('JOURNAL_HASH', 'restore journal hashes are invalid');
  }
  if (!JOURNAL_PHASES.has(journal.phase)) throw new VaultSnapshotError('JOURNAL_PHASE', 'restore journal phase is invalid');
  if (!['merge', 'replace'].includes(journal.mode)) throw new VaultSnapshotError('JOURNAL_MODE', 'restore journal mode is invalid');
  if (!journal.backupFormat || !['v2', 'legacy-m01'].includes(journal.backupFormat)) {
    throw new VaultSnapshotError('JOURNAL_BACKUP', 'restore journal backup format is invalid');
  }
  if (!journal.target || !journal.oldTarget || !journal.staging || !journal.backup) {
    throw new VaultSnapshotError('JOURNAL', 'restore journal paths are incomplete');
  }
  if (!path.isAbsolute(journal.target) || !path.isAbsolute(journal.oldTarget) || !path.isAbsolute(journal.staging) || !path.isAbsolute(journal.backup)) {
    throw new VaultSnapshotError('JOURNAL_PATH', 'restore journal paths must be absolute');
  }
  const target = path.resolve(journal.target);
  const oldTarget = path.resolve(journal.oldTarget);
  const staging = path.resolve(journal.staging);
  const backupDir = path.resolve(journal.backup);
  if (path.basename(target) !== 'MemoFlow-Test') {
    throw new VaultSnapshotError('JOURNAL_TARGET', 'restore journal target must be a MemoFlow-Test vault');
  }
  const parent = path.dirname(target);
  if (path.dirname(oldTarget) !== parent || path.dirname(staging) !== parent || path.dirname(file) !== parent) {
    throw new VaultSnapshotError('JOURNAL_PATH', 'restore journal and targets must share the target parent');
  }
  if (!path.basename(file).startsWith('.memoflow-restore-') || !path.basename(file).endsWith('.json')) {
    throw new VaultSnapshotError('JOURNAL_PATH', 'restore journal filename is not recognized');
  }
  if (!oldTarget.startsWith(`${target}.before-restore-`)
      || !path.basename(staging).startsWith(`.${path.basename(target)}.restore-`)) {
    throw new VaultSnapshotError('JOURNAL_PATH', 'restore journal paths are not recognized restore paths');
  }
  await assertOutsidePath(REPO_ROOT, target, 'repository');
  await assertOutsidePath(target, backupDir, 'backup');
  if (!fs.existsSync(backupDir)) throw new VaultSnapshotError('JOURNAL_BACKUP', 'restore journal backup is missing');
  const backup = await verifyBackup(backupDir, { strict: true });
  if (backup.format !== journal.backupFormat) {
    throw new VaultSnapshotError('JOURNAL_BACKUP', 'restore journal backup format does not match the backup');
  }
  const proof = await backupProof(backupDir, backup.format);
  if (proof !== journal.backupProof) {
    throw new VaultSnapshotError('JOURNAL_BACKUP_PROOF', 'restore journal backup proof does not match the backup');
  }

  const targetExists = fs.existsSync(target);
  const oldExists = fs.existsSync(oldTarget);
  if (!targetExists && !oldExists) {
    throw new VaultSnapshotError('JOURNAL_TARGET', 'neither target nor old target exists');
  }
  const canonicalTarget = targetExists
    ? fs.realpathSync(target)
    : path.join(await fsp.realpath(parent), path.basename(target));
  if (canonicalTarget !== target) {
    throw new VaultSnapshotError('JOURNAL_PATH', 'restore journal target is not canonical');
  }
  if (targetExists) {
    const valid = validateTestVault(target, { repoRoot: REPO_ROOT });
    if (!valid.ok) throw new VaultSnapshotError('JOURNAL_TARGET', 'current target is not a valid test vault');
    await markerForRecovery(target, target, journal);
  }
  if (oldExists) {
    const oldStat = await fsp.lstat(oldTarget);
    if (oldStat.isSymbolicLink() || !oldStat.isDirectory()) {
      throw new VaultSnapshotError('JOURNAL_PATH', 'old target must be a real directory');
    }
    await markerForRecovery(oldTarget, target, journal);
  }
  return { file, journal, target, oldTarget, staging, backupDir, targetExists, oldExists };
}

async function writeJournal(journalPath, journal) {
  const temp = `${journalPath}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(journal, null, 2) + '\n', 'utf8');
  await fsp.rename(temp, journalPath);
}

async function applyRestore(plan, {
  yes = false,
  confirmRemoveExtra = false,
  hooks = {},
  now = new Date(),
} = {}) {
  if (!yes) throw new VaultSnapshotError('CONFIRMATION_REQUIRED', 'restore --apply requires --yes');
  if (plan.mode === 'replace' && plan.removed.length && !confirmRemoveExtra) {
    throw new VaultSnapshotError('CONFIRMATION_REQUIRED', 'replace with removals requires --confirm-remove-extra');
  }
  const writes = plan.added.length + plan.replaced.length + plan.removed.length;
  if (!writes) return { noop: true, plan };
  const stamp = nowStamp(now);
  const target = plan.target;
  const parent = path.dirname(target);
  const staging = uniquePath(path.join(parent, `.${path.basename(target)}.restore-${stamp}`));
  const oldTarget = uniquePath(`${target}.before-restore-${stamp}`);
  const journalPath = uniquePath(path.join(parent, `.memoflow-restore-${stamp}.json`));
  const safety = await createBackup({
    vault: target,
    outRoot: plan.backupRoot,
    label: 'pre-restore',
    obsidianRunning: false,
    now,
  });
  const markerMeta = plan.targetManifest.marker;
  if (!markerMeta || !markerMeta.vaultId) {
    throw new VaultSnapshotError('TARGET_MARKER', 'target marker metadata is missing');
  }
  const journal = {
    schemaVersion: JOURNAL_SCHEMA,
    kind: 'memoflow-restore-journal',
    journalId: crypto.randomUUID(),
    vaultId: markerMeta.vaultId,
    markerSha256: plan.targetMarker.sha256,
    backupFormat: plan.backup.format,
    backupProof: await backupProof(plan.backupDir, plan.backup.format),
    createdAt: new Date().toISOString(),
    target,
    staging,
    oldTarget,
    backup: plan.backupDir,
    mode: plan.mode,
    phase: 'staging',
  };
  let phase = 'staging';
  try {
    await writeJournal(journalPath, journal);
    if (plan.mode === 'merge' || plan.select.length) {
      await copyTree(target, staging);
    } else {
      await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
      await copyTree(plan.backup.root, staging, { exclude: [MARKER_NAME] });
    }
    if (plan.mode === 'replace') {
      await copyOneFile(target, MARKER_NAME, staging);
    } else {
      for (const file of plan.filesToRestore) {
        if (file.path === MARKER_NAME) continue;
        await copyOneFile(plan.backup.root, file.path, staging);
      }
    }
    const expected = expectedFilesForPlan(plan);
    await verifyTree(staging, expected, { strict: true });
    const current = await buildManifest(target);
    if (!sameManifest(current, plan.targetManifest)) {
      throw new VaultSnapshotError('TARGET_CHANGED', 'target vault changed after the restore plan was created');
    }
    await hooks.beforeSwap?.({ plan, staging, oldTarget, journalPath });
    journal.phase = 'staging-ready';
    phase = 'staging-ready';
    await writeJournal(journalPath, journal);
    await fsp.rename(target, oldTarget);
    journal.phase = 'old-renamed';
    phase = 'old-renamed';
    await writeJournal(journalPath, journal);
    await hooks.afterOldRename?.({ plan, staging, oldTarget, journalPath });
    await fsp.rename(staging, target);
    journal.phase = 'swapped';
    phase = 'swapped';
    await writeJournal(journalPath, journal);
    await hooks.afterStagingRename?.({ plan, staging, oldTarget, journalPath });
    await verifyTree(target, expected, { strict: true });
    journal.phase = 'verified';
    phase = 'verified';
    await writeJournal(journalPath, journal);
    await hooks.afterVerify?.({ plan, staging, oldTarget, journalPath });
    await fsp.rm(journalPath, { force: true });
    return {
      noop: false,
      plan,
      safetyBackup: safety.dir,
      oldTarget,
      staging,
      added: plan.added,
      replaced: plan.replaced,
      removed: plan.removed,
      unchanged: plan.unchanged,
    };
  } catch (error) {
    let rollbackError = null;
    try {
      if (fs.existsSync(oldTarget)) {
        if (fs.existsSync(target) && (phase === 'swapped' || phase === 'verified')) {
          const failed = uniquePath(`${target}.failed-restore-${stamp}`);
          await fsp.rename(target, failed);
        }
        if (!fs.existsSync(target)) await fsp.rename(oldTarget, target);
      }
      if (fs.existsSync(staging) && fs.existsSync(target)) {
        await fsp.rm(staging, { recursive: true, force: true });
      }
      await fsp.rm(journalPath, { force: true });
      error.details = { ...(error.details || {}), rollback: 'ok', safetyBackup: safety.dir };
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure;
      error.details = {
        ...(error.details || {}),
        rollback: 'failed',
        rollbackError: rollbackFailure.message,
        journal: journalPath,
        safetyBackup: safety.dir,
      };
    }
    if (rollbackError) {
      throw new VaultSnapshotError('ROLLBACK_FAILED', `${error.message}; rollback failed: ${rollbackError.message}`, error.details);
    }
    throw error;
  }
}

async function recoverInterruptedRestore(journalPath, { hooks = {} } = {}) {
  const validated = await validateRestoreJournal(journalPath);
  const { file, journal, target, oldTarget, staging, targetExists, oldExists } = validated;
  await hooks.beforeRecover?.({ journal, target, oldTarget, staging });
  let movedNew = null;
  if (targetExists && oldExists) {
    movedNew = uniquePath(`${target}.recovered-new-${nowStamp()}`);
    await fsp.rename(target, movedNew);
    try {
      await fsp.rename(oldTarget, target);
      const valid = validateTestVault(target, { repoRoot: REPO_ROOT });
      if (!valid.ok) throw new VaultSnapshotError('JOURNAL_TARGET', 'restored old target is not a valid test vault');
    } catch (error) {
      if (fs.existsSync(target)) {
        await fsp.rename(target, uniquePath(`${target}.invalid-recovered-${nowStamp()}`)).catch(() => {});
      }
      if (fs.existsSync(movedNew)) await fsp.rename(movedNew, target).catch(() => {});
      throw new VaultSnapshotError('JOURNAL_RECOVER', `could not restore the old target: ${error.message}`);
    }
  } else if (!targetExists && oldExists) {
    await fsp.rename(oldTarget, target);
    const valid = validateTestVault(target, { repoRoot: REPO_ROOT });
    if (!valid.ok) {
      await fsp.rename(target, oldTarget).catch(() => {});
      throw new VaultSnapshotError('JOURNAL_TARGET', 'restored target is not a valid test vault');
    }
  } else if (targetExists) {
    const valid = validateTestVault(target, { repoRoot: REPO_ROOT });
    if (!valid.ok) throw new VaultSnapshotError('JOURNAL_TARGET', 'current target is not a valid test vault');
  } else {
    throw new VaultSnapshotError('JOURNAL_TARGET', 'neither target nor old target exists');
  }
  await fsp.rm(file, { force: true });
  return { target, oldTarget, staging, phase: journal.phase, recovered: true, movedNew };
}

module.exports = {
  MANIFEST_NAME,
  CHECKSUMS_NAME,
  VAULT_DIR,
  RESTORE_DOC,
  MANIFEST_SCHEMA,
  JOURNAL_SCHEMA,
  DEFAULT_LABEL,
  CATEGORIES,
  VaultSnapshotError,
  sha256File,
  sha256Text,
  normalizeRelative,
  categoryFor,
  formatBytes,
  nowStamp,
  sanitizeLabel,
  defaultBackupRoot,
  isDefaultVault,
  isDefaultVaultPath,
  assertObsidianClosedForTarget,
  isObsidianRunning,
  checkFreeSpace,
  walkVault,
  buildManifest,
  manifestFileMap,
  sameManifest,
  verifyTree,
  copyTree,
  copyOneFile,
  checksumsText,
  parseChecksums,
  createBackup,
  detectBackupFormat,
  verifyBackup,
  planRestore,
  expectedFilesForPlan,
  validateManifestPaths,
  applyRestore,
  recoverInterruptedRestore,
  validateRestoreJournal,
  assertOutsidePath,
};
