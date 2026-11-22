#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dist = path.join(root, 'dist', 'memoflow');
const failures = [];

function fail(message) {
  failures.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

const required = ['main.js', 'manifest.json', 'styles.css'];
for (const name of required) {
  const size = await fileSize(path.join(dist, name));
  expect(size > 0, `dist/memoflow/${name} is missing or empty`);
}

let manifest = null;
try {
  manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
} catch (error) {
  fail(`manifest.json is not valid JSON: ${error.message}`);
}

if (manifest) {
  expect(manifest.id === 'memoflow', 'manifest id must be memoflow');
  expect(manifest.name === 'MemoFlow', 'manifest name must be MemoFlow');
  expect(/^\d+\.\d+\.\d+$/.test(manifest.version || ''), 'manifest version must be semver');
  expect(manifest.version === '0.1.0', 'manifest version must be 0.1.0 for this stage');
  expect(/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion || ''), 'manifest minAppVersion must be semver');
  expect(manifest.isDesktopOnly === false, 'manifest isDesktopOnly must be false for the multi-platform build');
  expect(typeof manifest.description === 'string' && manifest.description.endsWith('.'), 'manifest description must end with a period');
  expect((manifest.description || '').length <= 250, 'manifest description must be <= 250 characters');
  expect(/^[a-z-]+$/.test(manifest.id || ''), 'manifest id may only contain lowercase letters and hyphens');
  expect(/^[\x20-\x7e]+$/.test(manifest.name || ''), 'manifest name must use Basic Latin characters');
}

const mainSize = await fileSize(path.join(dist, 'main.js'));
expect(mainSize > 50_000, 'bundled main.js looks too small');
expect(mainSize < 1_500_000, 'bundled main.js is unexpectedly large');

let main = '';
try {
  main = await readFile(path.join(dist, 'main.js'), 'utf8');
} catch {
  fail('dist/memoflow/main.js is unreadable');
}

for (const forbidden of ['window.app', 'this.app.plugins', '.innerHTML', '.outerHTML', 'insertAdjacentHTML', "require('child_process')", 'require("child_process")', 'node:child_process']) {
  expect(!main.includes(forbidden), `main.js contains forbidden API usage: ${forbidden}`);
}
for (const forbidden of ['getFiles()', 'getMarkdownFiles()']) {
  expect(!main.includes(forbidden), `main.js enumerates the whole vault: ${forbidden}`);
}
expect(main.includes('memoflow-dashboard'), 'main.js does not register the memoflow-dashboard view');
expect(main.includes('移动端仅支持 Vault 内 PDF'), 'main.js is missing the mobile PDF guard message');
expect(main.includes('mf-reading-bar'), 'main.js is missing the reading-session bar');
expect(main.includes('timestampTitle'), 'main.js is missing the timestamped extract flow');
expect(main.includes('构建今日学习队列'), 'main.js is missing the Chinese command names');
expect(main.includes('从当前摘录制卡'), 'main.js is missing the card-creation command');
expect(main.includes('cardsDue'), 'main.js is missing the card due count');
expect(main.includes('设置优先级'), 'main.js is missing the priority dialog copy');
expect(main.includes('过载处理'), 'main.js is missing the overload action');
expect(main.includes('memoflow-review'), 'main.js is missing the unified review view');
expect(main.includes('openUnifiedReview'), 'main.js is missing the unified review opener');
expect(main.includes('startLearning'), 'main.js is missing Start Learning');
expect(main.includes('openCardReview'), 'main.js is missing the card-only review opener');
expect(main.includes('_syncPdfHeaderActions'), 'main.js is missing native PDF actions');
expect(main.includes('_activePdfPageNumber'), 'main.js is missing current PDF page fallback');
expect(main.includes('ConfirmActionModal'), 'main.js is missing destructive-action confirmation');
expect(main.includes('_buildPdfActionBar'), 'main.js is missing the PDF horizontal action bar');
expect(main.includes('clipboard-extract'), 'main.js is missing the clipboard extract fallback');
expect(main.includes('memoflow-card-review'), 'main.js is missing the card review command');
expect(main.includes('countClozeCards'), 'main.js is missing multi-cloze support');
expect(main.includes('review-filtered'), 'main.js is missing filtered subset review');
expect(main.includes('auto_overload'), 'main.js is missing automatic overload');
expect(main.includes('这次阅读感觉如何'), 'main.js is missing localized quality prompt');
expect(main.includes('读到的页码'), 'main.js is missing localized page prompt');
expect(main.includes('检查点备注'), 'main.js is missing localized checkpoint prompt');
expect(!main.includes('Topic quality?'), 'main.js still contains the English quality prompt');

let css = '';
try {
  css = await readFile(path.join(dist, 'styles.css'), 'utf8');
} catch {
  fail('dist/memoflow/styles.css is unreadable');
}
expect(css.includes('.mf-view'), 'styles.css is missing the .mf-view scope');
expect(css.includes('.mf-hero-grid'), 'styles.css is missing the hero layout');
expect(css.includes('@container memoflow'), 'styles.css is missing container queries');
expect(css.includes('.mf-reading-bar'), 'styles.css is missing the reading-session bar');
expect(css.includes('.mf-reading-popover'), 'styles.css is missing the reading action popover');
expect(css.includes('.mf-card-modal'), 'styles.css is missing the card-creation modal');
expect(css.includes('.mf-review-view'), 'styles.css is missing the unified review shell');
expect(css.includes('.mf-rb-btn.is-disabled'), 'styles.css is missing disabled card topic controls');
expect(css.includes('.mf-pdf-bar'), 'styles.css is missing the PDF action bar');
expect(css.includes('.mf-highlight-confirm'), 'styles.css is missing the highlight confirmation modal');
expect(css.includes('.mf-cloze-tools'), 'styles.css is missing the C1/C2/C3 cloze tools');
expect(css.includes('.memoflow-extract'), 'styles.css is missing the clean extract style');
expect(css.includes('.mf-priority-modal'), 'styles.css is missing the priority modal');
expect(css.includes('.mf-overload-modal'), 'styles.css is missing the overload modal');
expect(css.includes('.mf-rb-priority'), 'styles.css is missing the priority chip');
expect(css.includes('.mf-prio.is-editable'), 'styles.css is missing the editable queue priority chip');

if (failures.length) {
  console.error('MemoFlow validation failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`MemoFlow validation passed (${Math.round(mainSize / 1024)} KB main.js).`);
}
