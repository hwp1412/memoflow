# 完整 SuperMemo 工作流复现（测试 Vault）

> 只在 `<repo>/../MemoFlow-Test` 上执行。不要用日常 Vault，也不要改真实学习库。
> 本文档中的 `<book>` 指本机用于测试的 PDF，公开仓库不记录具体书名或路径。
> 安全规则见 [M01-TEST-VAULT-SAFETY.md](M01-TEST-VAULT-SAFETY.md)。

## 0. 准备与安全前置

```bash
cd <repo>

# 1. 确认测试库标记与路径
node scripts/test-vault.js --check

# 2. 退出 Obsidian 后，先备份测试库（详见 M01 文档）
#    备份位置：<workspace>/MemoFlow-Backups/<timestamp>_pre-<task>/

# 3. 先 dry-run，确认不会覆盖已有笔记
node scripts/seed-test-vault.mjs --dry-run
MF_BOOK_PDF="<book>.pdf" node scripts/seed-book-workflow.mjs --dry-run
node scripts/build.mjs --install-test --dry-run

# 4. 只有确认计划后，才执行实际写入
node scripts/seed-test-vault.mjs
MF_BOOK_PDF="<book>.pdf" node scripts/seed-book-workflow.mjs
node scripts/build.mjs --install-test
```

- `seed-test-vault.mjs` 生成 4 个来源、8 条摘录、2 张卡片、2 个分类和 Review Log；
- `seed-book-workflow.mjs` 把 `MF_BOOK_PDF` 指向的 PDF 复制到测试库 `test/`，并创建
  265 页来源（`read_point: 1`、`priority: 25`）；不设置 `MF_BOOK_PDF` 时使用
  `<repo>/../书籍/<book>.pdf` 的默认位置；
- `seed-test-vault.mjs` 会保留已安装的 Spaced Repetition，并把它合并进
  `community-plugins.json`；
- 默认不覆盖已有笔记；覆盖必须 `--force --approve-overwrite`，且需要项目所有者明确批准；
- `build.mjs --install-test` 只安装 `main.js`、`manifest.json`、`styles.css`，不碰 `data.json`。

打开 `MemoFlow-Test/`，确认 MemoFlow 与 Spaced Repetition 都已启用。

## 1. 走完主链路

### 1.1 导入与每日流

1. 点左侧 ribbon 的 MemoFlow 图标；
2. 看今日待读/逾期/卡片；测试来源应在队列里；
3. 点「开始今日学习」，session 混合阅读主题和卡片。

### 1.2 阅读 + 阅读点

1. 打开测试来源（或从 session 里点开）；
2. 顶部阅读条应显示 `P…` 和 `p.5 / 265`（示例状态；新来源是 `p.1 / 265`）；
3. 点「评阅并下一项」：
   - 先选 `Hold (no change)` / `Speed up` / `Slow down`；
   - 再输入读到的页码（例：`5`）；
   - 确认 `read_point` 变成 5，`review_count`、`interval`、`next_review` 更新；
4. 点页码 chip 可打开 PDF 阅读点（Toolkit viewer；移动端走 Vault 内 PDF）。

### 1.3 摘录

1. 回到来源，选中一段文字，或在命令面板执行「生成时间戳摘录（选中 / 剪贴板）」；
2. 新摘录文件名是 `YYYY-MM-DD HH-mm-ss.md`；
3. 页脚应有：
   ```markdown
   **来源**：[[test/<book>.pdf#page=5|<book> · p.5]]
   ```
   `page` 优先来自剪贴板 `#page=` / PDF 注释链接，其次当前 PDF 页，最后回退 `read_point`。

### 1.4 制卡 + 复习

1. 打开新摘录，阅读条点「制卡」；
2. 基础问答：填写问题和答案；Cloze：用 `==关键词==` 包住填空；
3. 卡片落到 `Cards/`，带 `source` 与 `flashcards/incremental-reading`；
4. 卡片阅读条点「复习此卡」→ 显示答案 → 评分；
5. 卡片正文应出现 `<!--SR:...-->`，总览页「卡片待复习」更新。

### 1.5 优先级

1. 在来源/摘录阅读条点 `P…`；
2. 可输入 1–100，或点「提升 5 / 15 / 30」；
3. 保存后 frontmatter 的 `priority` 变化，chip 立即更新；队列下次刷新按新优先级排序。

### 1.6 过载

1. 回到总览，点「过载处理」；
2. 选「未来 3 / 7 / 14 / 30 天」；
3. Mercy 把当前逾期阅读主题均匀摊到窗口内，卡片不参与；
4. 预期：总览「逾期」归零，通知显示 `Mercy：N 个逾期主题摊平到未来 X 天。`

### 1.7 队列内优先级 / 子集复习 / 自动过载

1. 总览队列每行点 `P…`，改优先级并保存；
2. 按「摘录」或搜索筛选，点底部「复习筛选（N）」；
3. 设置 → 阅读排程 → 打开「自动过载（Mercy）」并设阈值，再开始学习；
4. 预期：逾期主题在构建 session 前被摊平，session 仍能正常打开。

### 1.8 开始学习 / 卡片复习 / 剪贴摘录

0. 在 PDF 中复制文字 → 点「剪贴摘录」→ 选择「留在当前」或「在新标签页打开」。

1. 总览 →「开始今日学习」（或命令「开始学习」）；PDF 来源直接用 Obsidian 原生阅读器打开，顶部有 MemoFlow 横向功能栏。
2. 点顶部「完成阅读」→ 输入页码/质量；
3. 总览 →「卡片复习」，只看到期卡片；
4. 总览 →「卡片复习」点「显示答案」→ 选「记得」；
5. 预期：PDF 原生阅读/页码保存/下一项正常；卡片复习只含卡片；卡片注释更新。

## 2. 本机已验证

以下是在隔离 Obsidian 1.15.1 + `MemoFlow-Test` 上实际跑过的：

- 测试 PDF 复制与 265 页来源创建；
- 来源 `read_point` 从 1 评阅到 5，`next_review` / `interval` / `review_count` 更新；
- 从该书生成时间戳摘录，页脚指向 `<book>.pdf#page=5`；
- 从该摘录制卡，SR 评分后写入 `<!--SR:!YYYY-MM-DD,...-->`；
- 优先级 chip 从 P25 改到 P10（评阅后 scheduler 调到 P11）；
- Mercy 7 天把 3 个逾期主题摊平，逾期计数从 3 → 0；
- 总览「卡片待复习」与 SR deck 一致。

测试库当前保留这本书、生成的摘录和卡片，方便直接打开检查；`workspace.json` 与
MemoFlow session data 已清除，打开后从 ribbon 重新开始即可。当前规模是 5 个来源、10 条摘录、5 张卡片（含用于 C1/C2 多挖空验证的卡片）。

中文化范围：设置页、命令、菜单、阅读/评阅提示、确认框、选择项、使用指南和正常 Notice；控制台异常与第三方 SR 界面仍为英文。

## 3. 真实库

不要在日常生活/真实学习库直接重复这套测试。确认要安装 SR 时，按
[SR-SETUP.md](SR-SETUP.md) 先备份 `.obsidian/plugins/` 与卡片，再安装。
