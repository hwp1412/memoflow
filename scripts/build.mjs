#!/usr/bin/env node
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import testVault from './test-vault.js';

const { assertTestVault, assertInside } = testVault;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'memoflow');
const withPreview = process.argv.includes('--preview');
const withInstall = process.argv.includes('--install-test');
const dryRun = process.argv.includes('--dry-run');
const require = createRequire(import.meta.url);
const { localizeBaseSource } = require(path.join(root, 'src', 'i18n', 'base-zh.js'));
const localizeBasePlugin = {
  name: 'memoflow-base-zh',
  setup(buildApi) {
    buildApi.onLoad({ filter: /main\.js$/ }, async args => {
      if (path.resolve(args.path) !== path.join(root, 'main.js')) return undefined;
      const source = await readFile(args.path, 'utf8');
      return { contents: localizeBaseSource(source), loader: 'js' };
    });
  },
};

async function ensureEmpty(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function buildPlugin() {
  await ensureEmpty(distDir);
  await build({
    entryPoints: [path.join(root, 'src', 'main.js')],
    outfile: path.join(distDir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['es2022'],
    charset: 'utf8',
    external: ['obsidian', 'fs', 'url'],
    plugins: [localizeBasePlugin],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    banner: {
      js: '/* MemoFlow 0.1.0 — paper-and-ink study console. Forked from Incremental Reading Toolkit 1.1.8 (MIT). */',
    },
  });

  const upstreamCss = await readFile(path.join(root, 'styles.css'), 'utf8');
  const memoCss = await readFile(path.join(root, 'src', 'ui', 'dashboard.css'), 'utf8');
  const readingCss = await readFile(path.join(root, 'src', 'ui', 'reading-bar.css'), 'utf8');
  const cardCss = await readFile(path.join(root, 'src', 'ui', 'card-modal.css'), 'utf8');
  const reviewCss = await readFile(path.join(root, 'src', 'ui', 'review.css'), 'utf8');
  const combined = `/* MemoFlow 0.1.0 — styles: upstream Incremental Reading Toolkit 1.1.8 + MemoFlow dashboard + reading bar + card modal. */\n\n${upstreamCss.trimEnd()}\n\n/* ===== MemoFlow dashboard ===== */\n\n${memoCss.trimEnd()}\n\n/* ===== MemoFlow reading bar ===== */\n\n${readingCss.trimEnd()}\n\n/* ===== MemoFlow card modal ===== */\n\n${cardCss.trimEnd()}\n\n/* ===== MemoFlow unified review ===== */\n\n${reviewCss.trimEnd()}\n`;
  await writeFile(path.join(distDir, 'styles.css'), combined, 'utf8');

  await cp(path.join(root, 'plugin', 'manifest.json'), path.join(distDir, 'manifest.json'));
  console.log(`[build] plugin -> ${path.relative(root, distDir)}`);
}

async function buildPreview() {
  await build({
    entryPoints: [path.join(root, 'preview', 'preview.js')],
    outfile: path.join(root, 'preview', 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    charset: 'utf8',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  });
  console.log('[build] preview -> preview/app.js');
}

async function installTestVault() {
  const { vault } = assertTestVault({ repoRoot: root });
  const pluginDir = path.join(vault, '.obsidian', 'plugins', 'memoflow');
  // Only the three build artifacts are installed. data.json is never touched.
  const artifacts = ['main.js', 'manifest.json', 'styles.css'];
  if (dryRun) {
    console.log(`[dry-run] would install ${artifacts.join(', ')} -> ${path.relative(root, pluginDir)}`);
    return;
  }
  await mkdir(assertInside(vault, pluginDir), { recursive: true });
  for (const name of artifacts) {
    await cp(path.join(distDir, name), assertInside(vault, path.join(pluginDir, name)));
  }
  console.log(`[build] installed 3 artifacts -> ${path.relative(root, pluginDir)}`);
}

if (dryRun) {
  if (withInstall) {
    try {
      const { vault } = assertTestVault({ repoRoot: root });
      const pluginDir = path.join(vault, '.obsidian', 'plugins', 'memoflow');
      console.log(`[dry-run] test vault OK`);
      console.log(`[dry-run] would install main.js, manifest.json, styles.css -> ${path.relative(root, pluginDir)}`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
  if (withPreview) console.log('[dry-run] preview build skipped');
  console.log('[dry-run] no files were written.');
} else {
  if (withInstall) {
    try {
      assertTestVault({ repoRoot: root });
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
  await buildPlugin();
  if (withPreview) await buildPreview();
  if (withInstall) await installTestVault();
}
