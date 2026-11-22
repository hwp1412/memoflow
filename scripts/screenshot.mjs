#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const outDir = path.join(root, 'preview', 'screenshots');
const previewHtml = path.join(root, 'preview', 'index.html');
const appJs = path.join(root, 'preview', 'app.js');

if (!existsSync(edge)) {
  console.error('Microsoft Edge is required for screenshots.');
  process.exit(1);
}
if (!existsSync(appJs)) {
  console.error('preview/app.js is missing. Run: node scripts/build.mjs --preview');
  process.exit(1);
}

const shots = [
  { name: 'light-1440.png', width: 1440, height: 1600, query: 'bare=1&theme=light' },
  { name: 'dark-1440.png', width: 1440, height: 1600, query: 'bare=1&theme=dark' },
  { name: 'light-820.png', width: 820, height: 1900, query: 'bare=1&theme=light' },
  // Edge clamps a headless window to ~492 CSS px; render a 390px app inside it,
  // then crop the screenshot down to the app.
  { name: 'light-390.png', width: 492, height: 2200, query: 'bare=1&theme=light&w=390', cropWidth: 780 },
];

const pythonCandidates = [
  process.env.MF_PYTHON,
  '/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3',
  'python3',
].filter(Boolean);
const python = pythonCandidates.find(candidate => candidate === 'python3' || existsSync(candidate));

function cropToWidth(input, output, width) {
  if (!python) return false;
  const script = [
    'import sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1])',
    'w, h = im.size',
    'target = int(sys.argv[3])',
    'left = max(0, (w - target) // 2)',
    'im.crop((left, 0, left + target, h)).save(sys.argv[2])',
  ].join('\n');
  try {
    execFileSync(python, ['-c', script, input, output, String(width)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'memoflow-edge-'));
const results = [];

try {
  for (const shot of shots) {
    const output = path.join(outDir, shot.name);
    const rawOutput = shot.cropWidth ? path.join(outDir, `.raw-${shot.name}`) : output;
    const url = `${pathToFileURL(previewHtml).href}?${shot.query}`;
    execFileSync(edge, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--allow-file-access-from-files',
      '--force-device-scale-factor=2',
      `--window-size=${shot.width},${shot.height}`,
      '--virtual-time-budget=5000',
      `--user-data-dir=${profile}`,
      `--screenshot=${rawOutput}`,
      url,
    ], { stdio: 'ignore', timeout: 60_000 });
    if (shot.cropWidth) {
      const cropped = cropToWidth(rawOutput, output, shot.cropWidth);
      if (!cropped) await copyFile(rawOutput, output);
      await rm(rawOutput, { force: true });
    }
    const info = await stat(output);
    results.push(`${shot.name} (${Math.round(info.size / 1024)} KB)`);
  }
} finally {
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

for (const line of results) console.log(`[screenshot] ${line}`);
console.log(`[screenshot] output -> ${path.relative(root, outDir)}`);
