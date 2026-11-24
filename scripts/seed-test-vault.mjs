#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import testVault from './test-vault.js';

const { assertTestVault, assertInside } = testVault;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run');
const force = argv.has('--force');
const approveOverwrite = argv.has('--approve-overwrite');
if (force && !approveOverwrite) {
  console.error('[seed] --force requires --approve-overwrite (explicit owner approval).');
  process.exit(2);
}

let vault;
try {
  ({ vault } = assertTestVault({ repoRoot: root }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const sourceDir = path.join(vault, 'Sources', 'Incremental Reading');
const dirs = {
  sources: path.join(sourceDir, 'Sources'),
  extracts: path.join(sourceDir, 'Extracts'),
  cards: path.join(sourceDir, 'Cards'),
  categories: path.join(sourceDir, 'Categories'),
};

const stats = { created: [], skipped: [], overwritten: [] };
const exists = async target => { try { await access(target); return true; } catch { return false; } };
const vaultPath = relative => assertInside(vault, path.join(vault, relative));

if (!dryRun) {
  for (const dir of Object.values(dirs)) await mkdir(assertInside(vault, dir), { recursive: true });
  await mkdir(assertInside(vault, path.join(vault, '.obsidian', 'plugins', 'memoflow')), { recursive: true });
}

function dmy(offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function frontmatter(values) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

async function note(relativePath, values, body) {
  const full = vaultPath(relativePath);
  const present = await exists(full);
  if (present) {
    if (!force) { stats.skipped.push(relativePath); return; }
    stats.overwritten.push(relativePath);
  } else {
    stats.created.push(relativePath);
  }
  if (dryRun) return;
  await mkdir(assertInside(vault, path.dirname(full)), { recursive: true });
  await writeFile(full, frontmatter(values) + body.trim() + '\n', 'utf8');
}

let hasPdf = false;
let pdfRel = null;
const samplePdf = process.env.MF_SAMPLE_PDF ? path.resolve(process.env.MF_SAMPLE_PDF) : '';
if (samplePdf) {
  try {
    await access(samplePdf);
    pdfRel = `test/${path.basename(samplePdf)}`;
    const targetPdf = vaultPath(pdfRel);
    const present = await exists(targetPdf);
    if (present && !force) stats.skipped.push(pdfRel);
    else {
      if (present) stats.overwritten.push(pdfRel); else stats.created.push(pdfRel);
      hasPdf = true;
      if (!dryRun) {
        await mkdir(assertInside(vault, path.dirname(targetPdf)), { recursive: true });
        await copyFile(samplePdf, targetPdf);
      }
    }
    if (present && !force) hasPdf = true;
  } catch {
    hasPdf = false;
    pdfRel = null;
  }
}

const sourceBase = {
  status: 'active',
  source_type: 'pdf',
  date_added: dmy(-12),
  tags: ['incremental-reading', 'ir/source'],
};

await note('Sources/Incremental Reading/Categories/阅读主题.md', {
  type: 'category',
  status: 'active',
  tree_root: true,
  tree_order: 10,
  date_added: dmy(-20),
  tags: ['incremental-reading', 'ir/category'],
}, `# 阅读主题

长期阅读与理解类书籍。`);

await note('Sources/Incremental Reading/Categories/认知科学.md', {
  type: 'category',
  status: 'active',
  tree_root: true,
  tree_order: 20,
  date_added: dmy(-20),
  tags: ['incremental-reading', 'ir/category'],
}, `# 认知科学

注意力、判断与学习机制。`);

await note('Sources/Incremental Reading/Sources/学会提问.md', {
  ...sourceBase,
  type: 'source',
  parent: '[[阅读主题]]',
  priority: 51,
  next_review: dmy(-4),
  interval: 8,
  a_factor: 1.33,
  review_count: 3,
  last_reviewed: dmy(-4),
  read_point: 96,
  total_pages: 308,
  ...(pdfRel ? { pdf_path: pdfRel, pdf_vault_path: pdfRel } : {}),
}, `# 学会提问

> [!tip] 测试 Vault
> 这是 MemoFlow 测试库的示例来源。${hasPdf ? 'Vault 内已放入示例 PDF，可用于页码跳转测试。' : '未复制 PDF，页码进度仍可显示。'}

## 阅读笔记

- 批判性思维不是反对一切，而是先问事实、概念与推理。
- 淘金式思维要求主动提问，而不是被动吸收。

## 摘录

- [[学会提问 - Extract 1]]
- [[学会提问 - Extract 2]]
- [[学会提问 - Extract 3]]`);

await note('Sources/Incremental Reading/Sources/如何阅读一本书.md', {
  ...sourceBase,
  type: 'source',
  parent: '[[阅读主题]]',
  priority: 40,
  next_review: dmy(0),
  interval: 6,
  a_factor: 1.62,
  review_count: 2,
  last_reviewed: dmy(-2),
  read_point: 87,
  total_pages: 424,
}, `# 如何阅读一本书

## 阅读笔记

- 检视阅读先看骨架，分析阅读再问四个问题。
- 主题阅读围绕同一个问题，让作者们对话。

## 摘录

- [[如何阅读一本书 - Extract 1]]
- [[如何阅读一本书 - Extract 2]]`);

await note('Sources/Incremental Reading/Sources/深度工作.md', {
  ...sourceBase,
  type: 'source',
  parent: '[[认知科学]]',
  priority: 30,
  next_review: dmy(1),
  interval: 9,
  a_factor: 1.45,
  review_count: 1,
  last_reviewed: dmy(-1),
  read_point: 42,
  total_pages: 296,
}, `# 深度工作

## 阅读笔记

- 注意力残留让任务切换变得昂贵。
- 把注意力当作稀缺资源来管理。

## 摘录

- [[深度工作 - Extract 1]]
- [[深度工作 - Extract 2]]`);

await note('Sources/Incremental Reading/Sources/思考，快与慢.md', {
  ...sourceBase,
  type: 'source',
  parent: '[[认知科学]]',
  priority: 65,
  next_review: dmy(4),
  interval: 10,
  a_factor: 1.5,
  review_count: 1,
  last_reviewed: dmy(-3),
  read_point: 160,
  total_pages: 418,
}, `# 思考，快与慢

## 阅读笔记

- 系统 1 快速自动，系统 2 缓慢费力。
- 锚定效应与后见之明偏差。

## 摘录

- [[思考，快与慢 - Extract 1]]
- [[思考，快与慢 - Extract 2]]`);

const extractBase = {
  type: 'extract',
  status: 'active',
  date_added: dmy(-2),
  tags: ['incremental-reading', 'ir/extract'],
};

await note('Sources/Incremental Reading/Extracts/学会提问 - Extract 1.md', {
  ...extractBase,
  source: '[[学会提问]]',
  parent: '[[学会提问]]',
  priority: 8,
  next_review: dmy(-2),
  interval: 3,
  a_factor: 2.0,
  review_count: 1,
  last_reviewed: dmy(-2),
}, `有一种常见的思维方式因为类似于海绵被放到水中的反应——充分吸收水分，而被称为“海绵式思维”。这种思维方式相对被动，它并不需要你绞尽脑汁，但它的致命缺陷是：对哪些信息可以相信、哪些应该摒弃，提供不了任何判断方法。`);

await note('Sources/Incremental Reading/Extracts/学会提问 - Extract 2.md', {
  ...extractBase,
  source: '[[学会提问]]',
  parent: '[[学会提问]]',
  priority: 22,
  next_review: dmy(2),
  interval: 3,
  a_factor: 1.9,
  review_count: 0,
}, `一个论证由结论和理由构成。要评价一个论证，先找到作者的结论，再看他给出的理由能不能支撑这个结论。描述性假设是作者没有明说、但论证必须成立的前提。`);

await note('Sources/Incremental Reading/Extracts/学会提问 - Extract 3.md', {
  ...extractBase,
  status: 'pending',
  source: '[[学会提问]]',
  parent: '[[学会提问]]',
  priority: 28,
  date_added: dmy(0),
}, `淘金式思维要求读者主动提问、与作者互动，而不是像海绵一样被动吸收。它把阅读变成一场与作者的对话。`);

await note('Sources/Incremental Reading/Extracts/如何阅读一本书 - Extract 1.md', {
  ...extractBase,
  source: '[[如何阅读一本书]]',
  parent: '[[如何阅读一本书]]',
  priority: 45,
  next_review: dmy(3),
  interval: 5,
  a_factor: 2.2,
  review_count: 0,
}, `检视阅读的任务是在有限时间里抓住一本书的骨架：先看标题、序言、目录和索引，再快速通读，不要被细节拖住。`);

await note('Sources/Incremental Reading/Extracts/如何阅读一本书 - Extract 2.md', {
  ...extractBase,
  source: '[[如何阅读一本书]]',
  parent: '[[如何阅读一本书]]',
  priority: 12,
  next_review: dmy(-1),
  interval: 4,
  a_factor: 2.1,
  review_count: 1,
  last_reviewed: dmy(-1),
}, `分析阅读的四个问题：这本书在谈什么？作者细部说了什么、怎么说的？这本书说得有道理吗？这本书跟我有什么关系？`);

await note('Sources/Incremental Reading/Extracts/深度工作 - Extract 1.md', {
  ...extractBase,
  source: '[[深度工作]]',
  parent: '[[深度工作]]',
  priority: 18,
  next_review: dmy(0),
  interval: 6,
  a_factor: 1.8,
  review_count: 0,
}, `深度工作是在无干扰状态下专注进行职业活动，使个人的认知能力达到极限。这种努力能够创造新价值，提升技能，而且难以复制。`);

await note('Sources/Incremental Reading/Extracts/深度工作 - Extract 2.md', {
  ...extractBase,
  source: '[[深度工作]]',
  parent: '[[深度工作]]',
  priority: 55,
  next_review: dmy(5),
  interval: 7,
  a_factor: 1.7,
  review_count: 0,
}, `与其追求长时间工作，不如把注意力当成稀缺资源来管理：设定固定的深度工作时段，并像对待会议一样保护它。`);

await note('Sources/Incremental Reading/Extracts/思考，快与慢 - Extract 1.md', {
  ...extractBase,
  source: '[[思考，快与慢]]',
  parent: '[[思考，快与慢]]',
  priority: 25,
  next_review: dmy(0),
  interval: 5,
  a_factor: 2.3,
  review_count: 0,
}, `系统 1 的运行是自动且快速的，几乎不需要努力；系统 2 则调动注意力来分析和解决问题，它比较慢，也更可靠。`);

await note('Sources/Incremental Reading/Extracts/思考，快与慢 - Extract 2.md', {
  ...extractBase,
  source: '[[思考，快与慢]]',
  parent: '[[思考，快与慢]]',
  priority: 35,
  next_review: dmy(2),
  interval: 4,
  a_factor: 2.0,
  review_count: 0,
}, `锚定效应：人们在做判断时，会不自觉地过度依赖最初接触到的信息，即使这个信息与当前问题毫无关系。`);

await note('Sources/Incremental Reading/Cards/学会提问 - Card 1.md', {
  type: 'card',
  status: 'active',
  source: '[[学会提问]]',
  parent: '[[学会提问]]',
  priority: 60,
  date_added: dmy(-1),
  tags: ['incremental-reading', 'ir/card', 'flashcards/incremental-reading'],
}, `# 学会提问 - Card 1

海绵式思维与淘金式思维的区别是什么？
?
海绵式思维被动吸收信息；淘金式思维主动提问、评价论证，并与作者对话。`);

await note('Sources/Incremental Reading/Cards/深度工作 - Card 1.md', {
  type: 'card',
  status: 'active',
  source: '[[深度工作]]',
  parent: '[[深度工作]]',
  priority: 70,
  date_added: dmy(-1),
  tags: ['incremental-reading', 'ir/card', 'flashcards/incremental-reading'],
}, `# 深度工作 - Card 1

什么是注意力残留？
?
任务切换后，一部分注意力仍停留在上一件事上，使新任务的表现下降。`);

const logLines = [
  '# Review Log',
  '',
  '| Date | Element | Type | Grade | Interval |',
  '| --- | --- | --- | --- | --- |',
];
const logElements = ['学会提问 - Extract 1', '如何阅读一本书 - Extract 2', '深度工作 - Extract 1', '学会提问', '思考，快与慢 - Extract 1'];
for (let offset = 13; offset >= 0; offset--) {
  const count = offset === 0 ? 2 : 1 + (offset % 3);
  for (let index = 0; index < count; index++) {
    logLines.push(`| ${dmy(-offset)} | [[${logElements[(offset + index) % logElements.length]}]] | ${index === 0 ? 'extract' : 'source'} | — | 3 |`);
  }
}
const reviewLog = vaultPath('Sources/Incremental Reading/Review Log.md');
const reviewLogExists = await exists(reviewLog);
if (reviewLogExists && !force) {
  stats.skipped.push('Sources/Incremental Reading/Review Log.md');
} else {
  if (reviewLogExists) stats.overwritten.push('Sources/Incremental Reading/Review Log.md');
  else stats.created.push('Sources/Incremental Reading/Review Log.md');
  if (!dryRun) await writeFile(reviewLog, logLines.join('\n') + '\n', 'utf8');
}

await note('欢迎使用 MemoFlow.md', {
  date_added: dmy(0),
}, `# 欢迎使用 MemoFlow（测试 Vault）

这个 Vault 只用于验收 MemoFlow 第一阶段页面，**不影响**你的真实学习库。

## 打开页面

1. 用 Obsidian 打开这个文件夹作为 Vault。
2. 如果提示受限模式，进入「设置 → 第三方插件」，关闭受限模式并启用 **MemoFlow**。
3. 点击左侧 ribbon 的清单图标，或命令面板搜索「MemoFlow」，打开「MemoFlow 学习面板」。

## 这个库里有什么

- 4 个来源、8 条摘录、2 张卡片、2 个分类，日期相对今天生成。
- 可选的示例 PDF（通过 \`MF_SAMPLE_PDF\` 指定）用于测试 Vault 内 PDF 页码跳转。
- 页面右上角 \`⋯\` 可以切换示例数据 / 真实数据。

## 注意

- **不要同时启用**原来的 Incremental Reading Toolkit 和 MemoFlow，两者注册的视图类型会冲突；测试 Vault 里只启用了 MemoFlow。
- 本阶段不做评分、改期或优先级写回。页面只读 frontmatter。
- 移动端只支持 Vault 内 PDF + 页码跳转；选区级摘录留到后续阶段。

## 重建测试数据

在插件仓库执行：

\`\`\`bash
node scripts/seed-test-vault.mjs
node scripts/build.mjs --install-test
\`\`\`
`);

const enabledPlugins = ['memoflow'];
const srManifest = path.join(vault, '.obsidian', 'plugins', 'obsidian-spaced-repetition', 'manifest.json');
if (await exists(srManifest)) enabledPlugins.push('obsidian-spaced-repetition');

const communityPath = vaultPath('.obsidian/community-plugins.json');
if (dryRun) {
  console.log('[dry-run] merge .obsidian/community-plugins.json (preserve existing entries)');
} else {
  let current = [];
  try { current = JSON.parse(await readFile(communityPath, 'utf8')); } catch { current = []; }
  if (!Array.isArray(current)) current = [];
  const merged = current.slice();
  for (const plugin of enabledPlugins) if (!merged.includes(plugin)) merged.push(plugin);
  const next = JSON.stringify(merged, null, 2) + '\n';
  let existingText = null;
  try { existingText = await readFile(communityPath, 'utf8'); } catch { existingText = null; }
  if (existingText !== next) await writeFile(communityPath, next, 'utf8');
}

// Only the three build artifacts are installed. data.json and other user data
// are never touched by the seed script.
const dist = path.join(root, 'dist', 'memoflow');
const pluginDir = path.join(vault, '.obsidian', 'plugins', 'memoflow');
let distManifest = null;
try { distManifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8')); } catch { distManifest = null; }
if (!distManifest) {
  console.log('[seed] dist/memoflow not found yet; run: node scripts/build.mjs --install-test');
} else {
  const installed = await exists(path.join(pluginDir, 'main.js'));
  if (installed && !force) {
    stats.skipped.push('.obsidian/plugins/memoflow/{main.js,manifest.json,styles.css}');
  } else {
    if (installed) stats.overwritten.push('plugin artifacts'); else stats.created.push('plugin artifacts');
    if (!dryRun) {
      await mkdir(assertInside(vault, pluginDir), { recursive: true });
      for (const name of ['main.js', 'manifest.json', 'styles.css']) {
        await copyFile(path.join(dist, name), assertInside(vault, path.join(pluginDir, name)));
      }
    }
  }
}

const verb = dryRun ? 'dry run' : 'seed';
console.log(`[seed] ${verb}: created ${stats.created.length}, skipped ${stats.skipped.length}, overwritten ${stats.overwritten.length}`);
for (const item of stats.created.slice(0, 20)) console.log(`  + ${item}`);
for (const item of stats.skipped.slice(0, 20)) console.log(`  = ${item}`);
if (dryRun) console.log('[seed] dry run: no files were written.');
console.log(`[seed] test vault -> ${vault}`);
console.log('[seed] open it in Obsidian: Open folder as vault');
