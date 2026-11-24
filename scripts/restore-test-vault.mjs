#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import testVault from './test-vault.js';
import snapshot from './vault-snapshot.js';

const {
  applyRestore,
  assertObsidianClosedForTarget,
  formatBytes,
  isDefaultVault,
  isObsidianRunning,
  planRestore,
  recoverInterruptedRestore,
} = snapshot;
const { defaultVaultPath } = testVault;

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function valuesOf(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      values.push(argv[index + 1]);
    }
  }
  return values;
}

function planSummary(plan) {
  return {
    backup: plan.backupDir,
    target: plan.target,
    mode: plan.mode,
    select: plan.select,
    counts: {
      added: plan.added.length,
      replaced: plan.replaced.length,
      removed: plan.removed.length,
      unchanged: plan.unchanged,
    },
    bytes: plan.bytes,
    added: plan.added,
    replaced: plan.replaced,
    removed: plan.removed,
  };
}

function printPlan(plan, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...planSummary(plan) }, null, 2));
    return;
  }
  console.log(`Restore plan: ${plan.backupDir}`);
  console.log(`  target: ${plan.target}`);
  console.log(`  mode: ${plan.mode}`);
  console.log(`  added: ${plan.added.length}, replaced: ${plan.replaced.length}, removed: ${plan.removed.length}, unchanged: ${plan.unchanged}`);
  console.log(`  bytes to write: ${formatBytes(plan.bytes)}`);
  for (const name of plan.added.slice(0, 20)) console.log(`  + ${name}`);
  for (const name of plan.replaced.slice(0, 20)) console.log(`  ~ ${name}`);
  for (const name of plan.removed.slice(0, 20)) console.log(`  - ${name}`);
  console.log('  no files were written (dry run)');
}

async function handleRecover(argv) {
  const journal = valueOf(argv, '--journal');
  if (!journal) {
    console.error('--recover requires --journal <path>');
    process.exitCode = 2;
    return;
  }
  const result = await recoverInterruptedRestore(path.resolve(journal), {
    hooks: {
      beforeRecover: ({ journal: restoreJournal }) => assertObsidianClosedForTarget(restoreJournal.target, {
        confirmed: argv.includes('--confirm-obsidian-closed'),
      }),
    },
  });
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  console.log(`Recovery complete: ${result.target}`);
  console.log(`  phase: ${result.phase}`);
  console.log(`  old target: ${result.oldTarget}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'Usage:',
      '  node scripts/restore-test-vault.mjs --backup <abs> [--vault <abs>] [--dry-run | --apply]',
      '                                      [--mode merge|replace] [--select <path> ...]',
      '                                      [--yes] [--confirm-remove-extra] [--json]',
      '                                      [--confirm-obsidian-closed]',
      '  node scripts/restore-test-vault.mjs --recover --journal <path> [--confirm-obsidian-closed]',
    ].join('\n'));
    return;
  }
  if (argv.includes('--recover')) return handleRecover(argv);
  if (argv.includes('--apply') && argv.includes('--dry-run')) {
    console.error('--apply and --dry-run cannot be combined');
    process.exitCode = 2;
    return;
  }
  const backupArg = valueOf(argv, '--backup');
  if (!backupArg) {
    console.error('--backup is required');
    process.exitCode = 2;
    return;
  }
  const target = path.resolve(valueOf(argv, '--vault') || defaultVaultPath());
  const mode = valueOf(argv, '--mode') || 'merge';
  if (!['merge', 'replace'].includes(mode)) {
    console.error(`unknown mode: ${mode}`);
    process.exitCode = 2;
    return;
  }
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  const plan = await planRestore({
    backupDir: path.resolve(backupArg),
    target,
    mode,
    select: valuesOf(argv, '--select'),
  });

  if (!apply) {
    printPlan(plan, { json });
    return;
  }
  if (!argv.includes('--yes')) {
    console.error('--apply requires --yes after reviewing the dry-run plan');
    process.exitCode = 2;
    return;
  }
  if (plan.mode === 'replace' && plan.removed.length && !argv.includes('--confirm-remove-extra')) {
    console.error('replace with removals requires --confirm-remove-extra');
    process.exitCode = 2;
    return;
  }
  if (isDefaultVault(plan.target)) {
    const obsidian = isObsidianRunning();
    if (obsidian.running) {
      console.error('Obsidian is running. Fully quit Obsidian before restoring the default test vault.');
      process.exitCode = 1;
      return;
    }
    if (!obsidian.supported && !argv.includes('--confirm-obsidian-closed')) {
      console.error('Cannot verify that Obsidian is closed on this platform. Re-run with --confirm-obsidian-closed after quitting Obsidian.');
      process.exitCode = 1;
      return;
    }
  }

  const result = await applyRestore(plan, {
    yes: true,
    confirmRemoveExtra: argv.includes('--confirm-remove-extra'),
  });
  if (result.noop) {
    if (json) console.log(JSON.stringify({ ok: true, noop: true, target: plan.target }, null, 2));
    else console.log('Nothing to restore; target already matches the backup.');
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: false,
      target: plan.target,
      safetyBackup: result.safetyBackup,
      oldTarget: result.oldTarget,
      added: result.added,
      replaced: result.replaced,
      removed: result.removed,
      unchanged: result.unchanged,
    }, null, 2));
    return;
  }
  console.log(`Restore complete: ${plan.target}`);
  console.log(`  safety backup: ${result.safetyBackup}`);
  console.log(`  old target: ${result.oldTarget}`);
  console.log(`  added: ${result.added.length}, replaced: ${result.replaced.length}, removed: ${result.removed.length}`);
}

main().catch(error => {
  console.error(error.message || String(error));
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
