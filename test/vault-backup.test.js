'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const snapshot = require('../scripts/vault-snapshot.js');
const guard = require('../scripts/test-vault.js');

const REPO = path.resolve(__dirname, '..');

async function makeVault(t, { marker = true, fixture = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mf-m02-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'MemoFlow-Test');
  await fsp.mkdir(path.join(vault, '.obsidian/plugins/memoflow'), { recursive: true });
  await fsp.mkdir(path.join(vault, '.obsidian/plugins/obsidian-spaced-repetition'), { recursive: true });
  if (fixture) {
    await fsp.mkdir(path.join(vault, 'test'), { recursive: true });
    await fsp.mkdir(path.join(vault, 'empty'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'note.md'), '# note\n');
    await fsp.writeFile(path.join(vault, 'test/book.pdf'), Buffer.from('%PDF-1.4\nbinary\n'));
    await fsp.writeFile(path.join(vault, 'attachment.bin'), Buffer.from([0, 1, 2, 3]));
    await fsp.writeFile(path.join(vault, '.obsidian/community-plugins.json'), '["memoflow"]\n');
    await fsp.writeFile(path.join(vault, '.obsidian/workspace.json'), '{"active":"note.md"}\n');
    await fsp.writeFile(path.join(vault, '.obsidian/plugins/memoflow/data.json'), '{"memoflow":true}\n');
    await fsp.writeFile(path.join(vault, '.obsidian/plugins/memoflow/manifest.json'), '{"id":"memoflow","version":"0.1.0"}\n');
    await fsp.writeFile(path.join(vault, '.obsidian/plugins/obsidian-spaced-repetition/data.json'), '{"sr":true}\n');
    await fsp.writeFile(path.join(vault, '.obsidian/plugins/obsidian-spaced-repetition/manifest.json'), '{"id":"obsidian-spaced-repetition","version":"1.15.4"}\n');
  }
  if (marker) guard.initMarker(vault);
  return { root, vault, out: path.join(root, 'backups') };
}

async function makeTarget(t, { extra = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mf-m02-target-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'MemoFlow-Test');
  await fsp.mkdir(path.join(target, '.obsidian'), { recursive: true });
  guard.initMarker(target);
  if (extra) await fsp.writeFile(path.join(target, 'extra.md'), '# extra\n');
  return { root, target };
}

async function fingerprint(root) {
  const tree = await snapshot.walkVault(root);
  const files = [];
  for (const file of tree.files) {
    files.push([file.path, file.size, await snapshot.sha256File(file.absolute)]);
  }
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return { files, dirs: tree.dirs.map(dir => dir.path).sort() };
}

async function backup(vault, out, options = {}) {
  return snapshot.createBackup({ vault, outRoot: out, label: 'test', ...options });
}

function assertCode(code) {
  return error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  };
}

test('backup captures categories and verifies', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  assert.equal(result.manifest.counts.files, 10);
  assert.equal(result.manifest.counts.byCategory.notes, 1);
  assert.equal(result.manifest.counts.byCategory.pdf, 1);
  assert.equal(result.manifest.counts.byCategory.attachments, 1);
  assert.equal(result.manifest.counts.byCategory.memoflow, 2);
  assert.equal(result.manifest.counts.byCategory['spaced-repetition'], 2);
  assert.equal(result.manifest.counts.byCategory.marker, 1);
  assert.equal(result.manifest.counts.byCategory['obsidian-config'], 2);
  const verified = await snapshot.verifyBackup(result.dir);
  assert.equal(verified.format, 'v2');
  assert.equal(verified.manifest.counts.files, 10);
  assert.ok(fs.existsSync(path.join(result.dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(result.dir, 'checksums.sha256')));
  assert.ok(fs.existsSync(path.join(result.dir, 'RESTORE.md')));
});

test('backup dry-run writes nothing', async (t) => {
  const { vault, out } = await makeVault(t);
  const before = await fingerprint(vault);
  const result = await backup(vault, out, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(await fingerprint(vault), before);
});

test('backup aborts when the source changes during copy', async (t) => {
  const { vault, out } = await makeVault(t);
  await assert.rejects(
    backup(vault, out, {
      hooks: {
        afterCopy: async () => {
          await fsp.appendFile(path.join(vault, 'note.md'), 'changed\n');
        },
      },
    }),
    assertCode('SOURCE_CHANGED'),
  );
  const entries = fs.existsSync(out) ? fs.readdirSync(out) : [];
  assert.ok(entries.some(name => name.endsWith('.partial')), 'an incomplete backup must not be a valid backup');
  assert.ok(!entries.some(name => !name.endsWith('.partial')));
});

test('backup rejects symlinks in the source vault', async (t) => {
  const { vault, out } = await makeVault(t);
  if (process.platform === 'win32') return t.skip('symlink creation needs extra privileges on Windows');
  await fsp.symlink(os.tmpdir(), path.join(vault, 'linked'));
  await assert.rejects(backup(vault, out), assertCode('SYMLINK_FOUND'));
});

test('backup root inside the vault or repository is rejected', async (t) => {
  const { vault } = await makeVault(t);
  await assert.rejects(
    backup(vault, path.join(vault, 'backups')),
    assertCode('PATH_ESCAPE'),
  );
  await assert.rejects(
    backup(vault, path.join(REPO, 'm02-backups-not-created')),
    assertCode('PATH_ESCAPE'),
  );
});

test('backup refuses to run when Obsidian is marked as running', async (t) => {
  const { vault, out } = await makeVault(t);
  await assert.rejects(
    backup(vault, out, { obsidianRunning: true }),
    assertCode('OBSIDIAN_RUNNING'),
  );
});

test('verify detects modified, missing and extra files', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const payload = path.join(result.dir, 'vault');

  await fsp.appendFile(path.join(payload, 'note.md'), 'corrupt\n');
  await assert.rejects(snapshot.verifyBackup(result.dir), assertCode('BACKUP_MISMATCH'));
  await fsp.writeFile(path.join(payload, 'note.md'), '# note\n');

  await fsp.rm(path.join(payload, 'attachment.bin'));
  await assert.rejects(snapshot.verifyBackup(result.dir), assertCode('BACKUP_MISMATCH'));
  await fsp.writeFile(path.join(payload, 'attachment.bin'), Buffer.from([0, 1, 2, 3]));

  await fsp.writeFile(path.join(payload, 'extra.bin'), 'extra');
  await assert.rejects(snapshot.verifyBackup(result.dir), assertCode('BACKUP_MISMATCH'));
  const relaxed = await snapshot.verifyBackup(result.dir, { strict: false });
  assert.equal(relaxed.format, 'v2');
});

test('verify rejects a manifest path traversal', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const manifestPath = path.join(result.dir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  manifest.files.push({ path: '../escape', size: 1, sha256: '0'.repeat(64), category: 'other' });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(snapshot.verifyBackup(result.dir), assertCode('PATH_TRAVERSAL'));
});

test('legacy M01 layout can be verified and planned', async (t) => {
  const { vault, out, root } = await makeVault(t);
  const result = await backup(vault, out);
  const legacy = path.join(root, 'legacy');
  await fsp.mkdir(legacy, { recursive: true });
  await fsp.cp(path.join(result.dir, 'vault'), path.join(legacy, 'MemoFlow-Test'), { recursive: true });
  const checksums = result.manifest.files
    .map(file => `${file.sha256}  ./${file.path}`)
    .join('\n') + '\n';
  await fsp.mkdir(path.join(legacy, 'checksums'), { recursive: true });
  await fsp.writeFile(path.join(legacy, 'checksums/backup.sha256'), checksums);
  const verified = await snapshot.verifyBackup(legacy);
  assert.equal(verified.format, 'legacy-m01');
  assert.equal(verified.manifest.counts.files, 10);
  const target = await makeTarget(t);
  const plan = await snapshot.planRestore({ backupDir: legacy, target: target.target, mode: 'merge' });
  assert.equal(plan.backup.format, 'legacy-m01');
  assert.ok(plan.added.length >= 1);
});

test('restore dry-run and confirmation do not write', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t);
  const before = await fingerprint(target.target);
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'merge' });
  assert.ok(plan.added.length > 0);
  await assert.rejects(
    snapshot.applyRestore(plan, { yes: false }),
    assertCode('CONFIRMATION_REQUIRED'),
  );
  assert.deepEqual(await fingerprint(target.target), before);
});

test('merge restore keeps target extras and preserves the target marker', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  const markerBefore = JSON.parse(await fsp.readFile(path.join(target.target, '.memoflow-test-vault'), 'utf8'));
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'merge' });
  const applied = await snapshot.applyRestore(plan, { yes: true });
  assert.equal(applied.noop, false);
  assert.ok(fs.existsSync(path.join(target.target, 'note.md')));
  assert.ok(fs.existsSync(path.join(target.target, 'extra.md')));
  assert.ok(fs.existsSync(applied.oldTarget));
  assert.ok(fs.existsSync(applied.safetyBackup));
  const markerAfter = JSON.parse(await fsp.readFile(path.join(target.target, '.memoflow-test-vault'), 'utf8'));
  assert.equal(markerAfter.vaultId, markerBefore.vaultId);
  const verified = await snapshot.verifyBackup(result.dir);
  assert.equal(verified.format, 'v2');
});

test('replace restore removes extras only after explicit confirmation', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'replace' });
  assert.deepEqual(plan.removed, ['extra.md']);
  await assert.rejects(
    snapshot.applyRestore(plan, { yes: true, confirmRemoveExtra: false }),
    assertCode('CONFIRMATION_REQUIRED'),
  );
  await snapshot.applyRestore(plan, { yes: true, confirmRemoveExtra: true });
  assert.equal(fs.existsSync(path.join(target.target, 'extra.md')), false);
  assert.ok(fs.existsSync(path.join(target.target, 'note.md')));
});

test('selective restore changes only the selected file', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  await fsp.writeFile(path.join(target.target, 'note.md'), '# changed\n');
  const beforeExtra = await snapshot.sha256File(path.join(target.target, 'extra.md'));
  const plan = await snapshot.planRestore({
    backupDir: result.dir,
    target: target.target,
    mode: 'merge',
    select: ['note.md'],
  });
  assert.deepEqual(plan.replaced, ['note.md']);
  await snapshot.applyRestore(plan, { yes: true });
  assert.equal(await fsp.readFile(path.join(target.target, 'note.md'), 'utf8'), '# note\n');
  assert.equal(await snapshot.sha256File(path.join(target.target, 'extra.md')), beforeExtra);
  assert.equal(fs.existsSync(path.join(target.target, 'test/book.pdf')), false);
});

test('failure before swap leaves the target untouched', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  const before = await fingerprint(target.target);
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'merge' });
  await assert.rejects(
    snapshot.applyRestore(plan, { yes: true, hooks: { beforeSwap: () => { throw new Error('stop before swap'); } } }),
    /stop before swap/,
  );
  assert.deepEqual(await fingerprint(target.target), before);
  const names = fs.readdirSync(path.dirname(target.target));
  assert.equal(names.some(name => name.includes('.restore-')), false);
  assert.equal(names.some(name => name.includes('.json')), false);
});

test('failure after old rename rolls the target back', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  const before = await fingerprint(target.target);
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'merge' });
  await assert.rejects(
    snapshot.applyRestore(plan, { yes: true, hooks: { afterOldRename: () => { throw new Error('stop after old rename'); } } }),
    /stop after old rename/,
  );
  assert.deepEqual(await fingerprint(target.target), before);
  assert.equal(fs.existsSync(`${target.target}.before-restore-test`), false);
});

test('failure after swap rolls the target back and keeps the failed tree', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  const before = await fingerprint(target.target);
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'merge' });
  await assert.rejects(
    snapshot.applyRestore(plan, { yes: true, hooks: { afterStagingRename: () => { throw new Error('stop after swap'); } } }),
    /stop after swap/,
  );
  assert.deepEqual(await fingerprint(target.target), before);
  const names = fs.readdirSync(path.dirname(target.target));
  assert.ok(names.some(name => name.includes('.failed-restore-')));
});

test('failure after verification rolls the target back', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t, { extra: true });
  const before = await fingerprint(target.target);
  const plan = await snapshot.planRestore({ backupDir: result.dir, target: target.target, mode: 'merge' });
  await assert.rejects(
    snapshot.applyRestore(plan, { yes: true, hooks: { afterVerify: () => { throw new Error('stop after verify'); } } }),
    /stop after verify/,
  );
  assert.deepEqual(await fingerprint(target.target), before);
});

test('interrupted restore recovery puts the old target back', async (t) => {
  const target = await makeTarget(t, { extra: true });
  const before = await fingerprint(target.target);
  const parent = path.dirname(target.target);
  const oldTarget = path.join(parent, 'MemoFlow-Test.before-restore-fixed');
  const staging = path.join(parent, '.MemoFlow-Test.restore-fixed');
  const journalPath = path.join(parent, '.memoflow-restore-fixed.json');
  await fsp.mkdir(staging, { recursive: true });
  await fsp.rename(target.target, oldTarget);
  await fsp.writeFile(journalPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'memoflow-restore-journal',
    createdAt: new Date().toISOString(),
    target: target.target,
    staging,
    oldTarget,
    backup: path.join(parent, 'backup'),
    mode: 'merge',
    phase: 'old-renamed',
  }));
  const result = await snapshot.recoverInterruptedRestore(journalPath);
  assert.equal(result.recovered, true);
  assert.deepEqual(await fingerprint(target.target), before);
  assert.equal(fs.existsSync(journalPath), false);
  assert.ok(fs.existsSync(staging));
});

test('interrupted swap recovery prefers the old target', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mf-m02-swap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'MemoFlow-Test');
  const oldTarget = path.join(root, 'MemoFlow-Test.before-restore-fixed');
  const staging = path.join(root, '.MemoFlow-Test.restore-fixed');
  const journalPath = path.join(root, '.memoflow-restore-fixed.json');
  await fsp.mkdir(path.join(target, '.obsidian'), { recursive: true });
  guard.initMarker(target);
  await fsp.writeFile(path.join(target, 'old.md'), 'old\n');
  await fsp.cp(target, oldTarget, { recursive: true });
  await fsp.rm(path.join(target, 'old.md'));
  await fsp.writeFile(path.join(target, 'new.md'), 'new\n');
  await fsp.mkdir(staging, { recursive: true });
  await fsp.writeFile(journalPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'memoflow-restore-journal',
    createdAt: new Date().toISOString(),
    target,
    staging,
    oldTarget,
    backup: path.join(root, 'backup'),
    mode: 'merge',
    phase: 'swapped',
  }));
  await snapshot.recoverInterruptedRestore(journalPath);
  assert.equal(await fsp.readFile(path.join(target, 'old.md'), 'utf8'), 'old\n');
  assert.equal(fs.existsSync(path.join(target, 'new.md')), false);
  const names = fs.readdirSync(root);
  assert.ok(names.some(name => name.includes('.recovered-new-')));
});

test('restore CLI --recover restores the old target', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mf-m02-cli-recover-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'MemoFlow-Test');
  const oldTarget = path.join(root, 'MemoFlow-Test.before-restore-fixed');
  const staging = path.join(root, '.MemoFlow-Test.restore-fixed');
  const journalPath = path.join(root, '.memoflow-restore-fixed.json');
  await fsp.mkdir(path.join(target, '.obsidian'), { recursive: true });
  guard.initMarker(target);
  await fsp.writeFile(path.join(target, 'old.md'), 'old\n');
  await fsp.cp(target, oldTarget, { recursive: true });
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  await fsp.writeFile(journalPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'memoflow-restore-journal',
    createdAt: new Date().toISOString(),
    target,
    staging,
    oldTarget,
    backup: path.join(root, 'backup'),
    mode: 'merge',
    phase: 'old-renamed',
  }));
  const stdout = execFileSync(process.execPath, [
    path.join(REPO, 'scripts/restore-test-vault.mjs'),
    '--recover',
    '--journal', journalPath,
    '--json',
  ], { encoding: 'utf8', cwd: REPO });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(await fsp.readFile(path.join(target, 'old.md'), 'utf8'), 'old\n');
  assert.equal(fs.existsSync(journalPath), false);
});

test('Obsidian detector uses injected process results', () => {
  const run = status => snapshot.isObsidianRunning({
    platform: 'darwin',
    exec: () => ({ status, error: null, stdout: '' }),
  });
  assert.deepEqual(run(0), { running: true, supported: true });
  assert.deepEqual(run(1), { running: false, supported: true });
  assert.deepEqual(run(null), { running: false, supported: false });
});

test('backup CLI --dry-run writes nothing', async (t) => {
  const { vault, out } = await makeVault(t);
  const before = await fingerprint(vault);
  const stdout = execFileSync(process.execPath, [
    path.join(REPO, 'scripts/backup-test-vault.mjs'),
    '--vault', vault,
    '--out', out,
    '--dry-run',
    '--json',
  ], { encoding: 'utf8', cwd: REPO });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(await fingerprint(vault), before);
});

test('restore CLI --dry-run writes nothing', async (t) => {
  const { vault, out } = await makeVault(t);
  const result = await backup(vault, out);
  const target = await makeTarget(t);
  const before = await fingerprint(target.target);
  const stdout = execFileSync(process.execPath, [
    path.join(REPO, 'scripts/restore-test-vault.mjs'),
    '--backup', result.dir,
    '--vault', target.target,
    '--dry-run',
    '--json',
  ], { encoding: 'utf8', cwd: REPO });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(await fingerprint(target.target), before);
});
