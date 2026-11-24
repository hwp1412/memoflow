#!/usr/bin/env node
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { fileURLToPath } from 'node:url';
import testVault from './test-vault.js';

const { assertTestVault, assertInside } = testVault;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const force = argv.has('--force');
const approveOverwrite = argv.has('--approve-overwrite');
if (force && !approveOverwrite) {
  console.error('[seed:book] --force requires --approve-overwrite (explicit owner approval).');
  process.exit(2);
}

let vault;
try {
  ({ vault } = assertTestVault({ repoRoot: root }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const books = path.resolve(root, '..', '书籍');
const defaultBookName = '被讨厌的勇气.pdf';
const bookPath = process.env.MF_BOOK_PDF ? path.resolve(process.env.MF_BOOK_PDF) : path.join(books, defaultBookName);
const bookName = path.basename(bookPath);
const bookTitle = path.basename(bookPath, path.extname(bookPath));
const targetPdf = assertInside(vault, path.join(vault, 'test', bookName));
const sourcePath = assertInside(vault, path.join(vault, 'Sources', 'Incremental Reading', 'Sources', `${bookTitle}.md`));
const totalPages = 265;

const exists = async file => {
  try { await access(file); return true; } catch { return false; }
};

if (!await exists(bookPath)) {
  console.error(`[seed:book] missing book: ${bookPath}`);
  process.exit(1);
}

const pdfExists = await exists(targetPdf);
const sourceExists = await exists(sourcePath);
if (pdfExists && !force) {
  console.log('[seed:book] PDF already exists; skipped');
} else if (!dryRun) {
  await mkdir(assertInside(vault, path.dirname(targetPdf)), { recursive: true });
  await copyFile(bookPath, targetPdf);
  console.log(`[seed:book] ${pdfExists ? 'overwrote' : 'copied'} ${bookName} -> test/${bookName}`);
} else {
  console.log('[dry-run] would copy PDF into test/');
}

if (sourceExists && !force) {
  console.log('[seed:book] source already exists; leaving it untouched');
  if (dryRun) console.log('[seed:book] dry run: no files were written.');
  process.exit(0);
}

const now = new Date();
const pad = n => String(n).padStart(2, '0');
const today = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
const frontmatter = [
  '---',
  'type: source',
  'source_type: pdf',
  'status: active',
  'date_added: ' + today,
  'tags:',
  '  - incremental-reading',
  '  - ir/source',
  'parent: "[[阅读主题]]"',
  'priority: 25',
  'next_review: ' + today,
  'interval: 3',
  'a_factor: 1.5',
  'review_count: 0',
  'last_reviewed:',
  'read_point: 1',
  `total_pages: ${totalPages}`,
  `pdf_path: "test/${bookName}"`,
  `pdf_vault_path: "test/${bookName}"`,
  '---',
  '',
  `# ${bookTitle}`,
  '',
  '> [!tip] 模拟书籍',
  '> 来自本机测试 PDF，用于在测试 Vault 里跑完整的 SuperMemo 工作流。',
  '> 打开 PDF 后，用阅读条「评阅并下一项」记录页码；摘录会带上 PDF 页码引用。',
  '',
  '## 阅读笔记',
  '',
  '- 目的论：不是过去决定现在，而是现在的目的解释过去。',
  '- 课题分离：区分自己的课题与他人的课题。',
  '',
  '## 摘录',
  '',
  '',
].join('\n');

if (!dryRun) {
  await mkdir(assertInside(vault, path.dirname(sourcePath)), { recursive: true });
  await writeFile(sourcePath, frontmatter, 'utf8');
}
console.log(`[seed:book] created ${path.relative(vault, sourcePath)} · ${totalPages} pages`);
if (dryRun) console.log('[seed:book] dry run: no files were written.');
console.log('[seed:book] open the test vault and run "构建今日学习队列" or the ribbon dashboard.');
