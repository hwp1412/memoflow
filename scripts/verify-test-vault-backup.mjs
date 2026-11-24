#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import snapshot from './vault-snapshot.js';

const { verifyBackup, formatBytes } = snapshot;

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'Usage:',
      '  node scripts/verify-test-vault-backup.mjs --backup <abs> [--allow-extra] [--json]',
    ].join('\n'));
    return;
  }
  const backupArg = valueOf(argv, '--backup');
  if (!backupArg) {
    console.error('--backup is required');
    process.exitCode = 2;
    return;
  }
  const backup = path.resolve(backupArg);
  const strict = !argv.includes('--allow-extra');
  const result = await verifyBackup(backup, { strict });
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: true,
      format: result.format,
      backup: result.backupDir,
      counts: result.manifest.counts,
      archive: result.manifest.archive,
    }, null, 2));
    return;
  }
  console.log(`Backup OK: ${result.backupDir}`);
  console.log(`  format: ${result.format}`);
  console.log(`  files: ${result.manifest.counts.files}, directories: ${result.manifest.counts.directories}, bytes: ${formatBytes(result.manifest.counts.bytes)}`);
  if (result.manifest.archive) console.log(`  archive: ${result.manifest.archive.name} (${formatBytes(result.manifest.archive.size)})`);
}

main().catch(error => {
  console.error(error.message || String(error));
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
