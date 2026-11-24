#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import testVault from './test-vault.js';
import snapshot from './vault-snapshot.js';

const {
  createBackup,
  defaultBackupRoot,
  formatBytes,
  isDefaultVault,
  isObsidianRunning,
  sanitizeLabel,
} = snapshot;
const { defaultVaultPath } = testVault;

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'Usage:',
      '  node scripts/backup-test-vault.mjs [--vault <abs>] [--out <abs>] [--label <text>]',
      '                                      [--archive] [--dry-run] [--json]',
      '                                      [--confirm-obsidian-closed]',
      '',
      'Default vault: <repo>/../MemoFlow-Test',
      'Default out:   <workspace>/MemoFlow-Backups',
    ].join('\n'));
    return;
  }

  const vault = path.resolve(valueOf(argv, '--vault') || defaultVaultPath());
  const outRoot = path.resolve(valueOf(argv, '--out') || process.env.MF_BACKUP_ROOT || defaultBackupRoot());
  const label = sanitizeLabel(valueOf(argv, '--label') || 'manual');
  const dryRun = argv.includes('--dry-run');
  const archive = argv.includes('--archive');
  const json = argv.includes('--json');
  const confirmClosed = argv.includes('--confirm-obsidian-closed');
  const defaultVault = isDefaultVault(vault);
  const obsidian = isObsidianRunning();

  if (defaultVault && obsidian.running) {
    return fail('Obsidian is running. Fully quit Obsidian (Cmd+Q) before backing up the default test vault.');
  }
  if (defaultVault && !obsidian.supported && !confirmClosed) {
    return fail('Cannot verify that Obsidian is closed on this platform. Re-run with --confirm-obsidian-closed after quitting Obsidian.');
  }

  const result = await createBackup({
    vault,
    outRoot,
    label,
    archive,
    dryRun,
    obsidianRunning: false,
  });

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      vault: result.vault,
      backup: result.dryRun ? null : result.dir,
      counts: result.manifest.counts,
      plugins: result.manifest.plugins,
      archive: result.manifest.archive,
    }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(`[backup] dry run: ${result.vault}`);
    console.log(`  files: ${result.manifest.counts.files}, directories: ${result.manifest.counts.directories}, bytes: ${formatBytes(result.manifest.counts.bytes)}`);
    console.log('  no files were written');
    return;
  }

  console.log(`[backup] ${result.dir}`);
  console.log(`  files: ${result.manifest.counts.files}, directories: ${result.manifest.counts.directories}, bytes: ${formatBytes(result.manifest.counts.bytes)}`);
  console.log(`  manifest: ${path.join(result.dir, 'manifest.json')}`);
  console.log(`  checksums: ${path.join(result.dir, 'checksums.sha256')}`);
}

main().catch(error => {
  fail(error.message || String(error));
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
});
