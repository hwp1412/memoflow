#!/usr/bin/env node
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const vault = path.resolve(root, '..', 'MemoFlow-Test');
const books = path.resolve(root, '..', '书籍');
const bookName = '被讨厌的勇气.pdf';
const bookPath = path.join(books, bookName);
const targetPdf = path.join(vault, 'test', bookName);
const sourcePath = path.join(vault, 'Sources', 'Incremental Reading', 'Sources', '被讨厌的勇气.md');
const totalPages = 265;

const exists = async file => {
  try { await access(file); return true; } catch { return false; }
};

if (!await exists(bookPath)) {
  console.error(`[seed:book] missing book: ${bookPath}`);
  process.exit(1);
}

await mkdir(path.dirname(targetPdf), { recursive: true });
await mkdir(path.dirname(sourcePath), { recursive: true });
if (!await exists(targetPdf)) {
  await copyFile(bookPath, targetPdf);
  console.log(`[seed:book] copied ${bookName} -> test/${bookName}`);
}

if (await exists(sourcePath)) {
  console.log('[seed:book] source already exists; leaving it untouched');
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
  '# 被讨厌的勇气',
  '',
  '> [!tip] 模拟书籍',
  '> 来自 `插件开发/书籍/被讨厌的勇气.pdf`，用于在测试 Vault 里跑完整的 SuperMemo 工作流。',
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

await writeFile(sourcePath, frontmatter, 'utf8');
console.log(`[seed:book] created ${path.relative(vault, sourcePath)} · ${totalPages} pages`);
console.log('[seed:book] open the test vault and run "构建今日学习队列" or the ribbon dashboard.');
