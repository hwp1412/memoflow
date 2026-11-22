# MemoFlow 页面实现说明

> 对应版本：MemoFlow 0.1.0（可用阶段）。总览、阅读条、时间戳摘录、中文化、摘录制卡与 SR 复习闭环均已落地。

## 1. 分层

```
plugin.getIRRows() / buildTreeIndex() / reviewLogPath()
        │
        ▼
src/data/model.js         异步模型：计数、队列、树、负荷、来源、最近摘录、cardsDue
src/data/extract.js       时间戳摘录 / PDF 引用纯函数
src/data/card.js          卡片输入校验 / 摘录预填纯函数
src/data/priority.js      优先级校验 / 提升纯函数
        │
        ▼
src/ui/dashboard.js       静态壳 + 分区重建 + 事件委托
        │
        ├── src/ui/components.js / icons.js / copy.js
        ├── src/ui/dashboard.css / reading-bar.css / card-modal.css
        └── src/i18n/zh.js   命令名 / 顶层菜单文案
        │
        ▼
src/views/dashboard-view.js   ItemView 生命周期、Obsidian 动作、刷新
src/views/settings-tab.js    中文设置页（7 个分区）
src/views/card-modal.js      制卡弹窗（基础问答 / Cloze）
src/views/priority-modal.js  优先级弹窗
src/views/overload-modal.js  Mercy 过载弹窗
        │
        ▼
src/main.js                 MemoFlowPlugin extends 上游插件
```

- 渲染层不 import `obsidian`，因此 `preview/preview.js` 可以复用同一份 UI 与数据代码。
- 总览页本身只读，不直接写 frontmatter；阅读操作条调用上游方法（markPathsDone / gradeCurrent / nextElement / dismiss / consumeSessionItem），时间戳摘录通过 `vault.create` 新建笔记并更新来源优先级。
- 移动端 PDF 守卫在 `src/platform/pdf.js`，纯函数，测试覆盖。

## 2. 设计 token

| 用途 | 亮色 | 暗色 |
|---|---|---|
| 页面底色 | `#F5F1E8` | `#171613` |
| 卡片面 | `#FBF8F1` | `#1F1D19` |
| 次级面 | `#F0EBDD` | `#26231D` |
| 主文字 | `#2A251D` | `#EDE6D6` |
| 次文字 | `#7B7263` | `#A79D8C` |
| 细线 | `rgba(42,37,29,.10)` | `rgba(237,230,214,.10)` |
| 墨蓝主色 | `#3E5C76` | `#9DB8CE` |
| 琥珀高亮 | `#C98F2E` | `#E3B968` |
| 逾期珊瑚 | `#B8563F` | `#E0876E` |
| 成功绿 | `#4E7357` | `#93BE9C` |
| 深色聚焦卡片 | `#2F3B44` | `#24211C` |

- 字体：UI 继承 `--font-interface`；摘录用 `Songti SC / Noto Serif SC / Source Han Serif SC / Georgia`。
- 间距：4/8/12/16/20/24/32；卡片圆角 18px，内层 10–12px。
- 容器查询断点：1180 / 980 / 760 / 520（见 `dashboard.css` 末尾）。
- 动效：淡入 220ms、环 700ms、柱子 500ms；`prefers-reduced-motion` 全关。
- 图标：`src/ui/icons.js` 内联 SVG，不用 emoji。

## 2.5 阅读操作条与时间戳摘录

- `src/ui/reading-bar.css`：阅读条 + 弹出操作菜单的样式。
- `MemoFlowPlugin._syncReadingSurface()`：按当前 session 给每个打开的 source/extract/card 视图注入阅读条（主入口开始学习按项打开实际 PDF/笔记；阅读条用于来源/摘录笔记）；直接挂在 `.view-content` 顶部，实时预览和阅读视图都可见。卡片使用「下一项 / 复习此卡」。
- `MemoFlowPlugin._syncReadingHeaderActions()`：给正文视图标题栏加「MemoFlow 阅读操作」图标。
- 操作：`complete` / `skip` / `postpone` / `dismiss` / `mark-done` / `dashboard`；全部走上游已有方法（`markPathsDone`、`gradeCurrent`、`nextElement`、`dismiss`、`consumeSessionItem`、`_openLearningFile`）。
- 时间戳摘录：`src/data/extract.js` 生成 `YYYY-MM-DD HH-mm-ss` 标题、`page` 字段和 `[[PDF#page=N]]` 引用页脚；主类负责读选区/剪贴板、解析 PDF 页码、创建笔记并刷新队列；提取正文会去掉复制来源的 callout 外壳，页脚改为纯 `**来源**` 行。

## 2.6 中文化

- **设置页**：`src/views/settings-tab.js` 重写上游 7 个分区（关于/阅读排程/队列/内联卡片/SR/知识树/路径/通用）；`MemoFlowPlugin.addSettingTab()` 在 `super.onload()` 时丢弃上游英文 tab，只挂中文 tab。
- **命令**：`src/i18n/zh.js` 的 `COMMAND_NAMES` 覆盖上游 9 个命令；`_applyChineseCommandNames()` 在 super.onload 后改 `app.commands.commands[id].name`，ID 不变，快捷键保留。
- **顶层菜单**：覆盖 `captureOrCreate` / `currentElementActions` / `openToolkitView` / `advancedTools`，用 `MENU_LABELS` 的中文文案调用原方法。
- **环境检查**：设置页内实现中文检查（SR、四个文件夹、日期格式、正则），不调用上游英文 Notice。
- 仍保留英文的范围：上游操作 Notice、页码输入、使用指南正文、第三方 SR 界面。

## 2.7 卡片闭环

- 入口：阅读条「制卡」、标题栏 popover「从当前摘录制卡」、命令「从当前摘录制卡」。
- `src/views/card-modal.js` 收集基础问答/Cloze；`src/data/card.js` 负责预填与校验（Cloze 必须有 `==...==`，基础问答必须有答案）。
- 创建调用上游 `_createSpacedRepetitionCard(parentFile, {format, question, answer})`，生成带 `source` 和 `flashcards/incremental-reading` 的 Markdown；不复制 SR 格式或调度逻辑。
- **SR 就绪判断**：覆盖 `isSpacedRepetitionReady()`，直接检查两个 SR 命令是否存在。上游用 `listCommands()`，会在没有活动卡片时把 `srs-review-flashcards-in-note` 过滤掉，导致误报未就绪。
- 总览 `counts.cardsDue`：SR 就绪时逐张调用上游 `_cardIsDue`（最多 500 张）；未就绪为 0。Hero 显示「卡片待复习」和「卡片复习」按钮。
- SR 评分由 SR 写 `<!--SR:...-->`；MemoFlow 不解析、不改写。

## 2.8 优先级、阅读点与过载

- **优先级 chip**：阅读条 `P…`（`src/data/priority.js` 校验）；点开 `priority-modal`，支持 P1–P100、快速提升 5/15/30；`processFrontMatter` 写 `priority`，保留 `boost_from`。
- **阅读点 chip**：PDF 来源显示 `p.{read_point} / {total_pages}`，点击调用 `openPdfForSource()`；页码更新仍走上游「评阅并下一项」的 `gradeCurrent`，避免复制 A-Factor 调度。
- **过载处理**：总览页「过载处理」→ `overload-modal` 选择 3/7/14/30 天；`spreadOverdue()` 按优先级排序，把逾期主题均匀摊到窗口内，卡片不参与。此实现与上游 Mercy 语义一致，但使用中文弹窗。
- **测试书籍**：`scripts/seed-book-workflow.mjs` 复制 `被讨厌的勇气.pdf` 到测试库并创建 265 页来源；只用于测试 Vault。

## 2.9 队列优先级 / 子集复习 / 自动过载

- **队列内优先级**：`renderQueueRow()` 把 `P…` 渲染成可点击/可键盘触发的 chip；`dashboard-view` 的 `queue-priority` 调 `openPriorityDialog(file, { onApplied })`，保存后刷新总览。卡片不参与主题优先级。
- **子集复习**：筛选/搜索后，队列底部的「复习筛选（N）」把当前 `filtered` 的路径通过 `data.paths` 传给 `MemoFlowPlugin.buildSubsetSession(paths)`；它复用 `persistSessionSnapshot`/`nextElement`，不会改上游调度算法。
- **自动过载**：设置 → 阅读排程 →「自动过载（Mercy）」；`buildSessionQueue()` 覆盖层在构建前调用 `_maybeAutoOverload()`，逾期超过阈值时按 7 天调用 `spreadOverdue()`。默认关闭。
- **测试**：`npm run seed:book` 提供 265 页书籍；队列优先级/筛选复习/自动 Mercy 已在测试库实测。

## 2.10 完整 i18n

- `src/i18n/zh.js`：命令名/顶层菜单。
- `src/i18n/base-zh.json`：上游用户可见字符串映射（提示、确认、选择项、正常 Notice、遮挡 UI 等，260+ 条）。
- `src/i18n/base-zh.js`：`localizeBaseSource()` 按精确字符串字面量替换；`scripts/build.mjs` 的 esbuild 插件只对上游 `main.js` 应用，源文件与调度逻辑不变。
- `src/views/settings-tab.js`：中文设置页；`src/views/user-guide-modal.js`：中文使用指南；命令/顶层菜单由子类覆盖。
- 保留英文：开发者控制台、异常堆栈、第三方 SR 界面、Obsidian 核心 UI。构建后可用 `grep` 检查 `Topic quality?` 等英文提示不在 dist。

## 2.11 开始学习 / 卡片复习

- 开始学习不再使用独立页面：`startLearning()` 构建/复用 session 后调用 `nextElement()`；`_openLearningFile()` 对 PDF 来源改用 Obsidian 原生 PDF（`openLinkText(pdf#page=N)`），Markdown 来源/摘录仍打开笔记和阅读条。
- `memoflow-review` 视图只服务「卡片复习」：`mode=cards`，路径来自 SR 到期卡片。
- 卡片复习 shell 按传入的 paths 顺序渲染卡片：
    - 卡片：通过隐藏的 SR 会话取 `currentCard.front/back`，显示答案后调 `contentManager._processReview(response)`；同一笔记多张卡时留在当前项继续，直到 SR 队列走完；评分仍写 SR 的注释。
- 卡片桥接流程：`reviewCardsInNote(file)` → 等待 `uiManager.contentManager.reviewSequencer.currentCard` → 隐藏 `.modal-container` → 立刻 detach 临时笔记标签 → 重新激活 shell → 评分后 `contentManager.close()`/移除隐藏 modal。
- PDF 顶栏：`_syncPdfHeaderActions()` 给原生 PDF 视图注入横向 `.mf-pdf-bar`；阅读阶段显示「剪贴摘录 / 制卡（灰）/ 完成阅读 / 下一项 / 更多」。所有动作使用来源笔记上下文，评阅时直接调 `_gradeTopic(sourceFile, fm)`，当前活动文件是 PDF 也能保存页码。
- 剪贴摘录：`clipboard-extract` 动作/命令读取剪贴板，后台生成摘录；页面来源仍是原生 PDF；页码优先级：剪贴板 `#page=` > 当前 PDF 页（`pdfViewer.currentPageNumber`）> `read_point`；生成后 `ExtractOpenModal` 询问「留在当前 / 在新标签页打开」。
- 锁定 SR `1.15.4` 的内部接口；失败时 shell 降级为「打开原笔记」，不崩。
- 视图 CSS：`src/ui/review.css`。
- 挖空：`card.js` 把 `{{c1::答案}}` 转成 SR 的 `==1;;答案==`；`countClozeCards` 驱动弹窗计数。

## 3. 模型形状

```js
{
  today, dateLabel, counts: { due, overdue, todayDue, newItems, cards, cardsDue, reviewedToday },
  srReady,
  progress, estimatedMinutes,
  hero: { primary: queueItem|null },
  queue: [{
    path, basename, type, sourceTitle, priority, interval, aFactor, status,
    dueDate, dueTime, dueLabel, dueTitle, dueTone, isOverdue, hasPdf,
    urgency, excerpt, tfile, fm
  }],
  tree: [{ path, basename, type, dueCount, children, hasChildren, hiddenCount, tfile, fm }],
  forecast: [{ label, shortLabel, count, isToday }],
  activity: [{ key, label, count, isToday }],
  streak, reviews14d,
  sources: [{ path, basename, readPoint, totalPages, progress, extractCount, hasPdf, tfile, fm }],
  recent: [{ path, title, sourceTitle, page, text, tfile, fm }],
  demo, isMobile
}
```

- `buildModel()` 里读取 Review Log 尾部 5000 行；`parseReviewLog` 只取日期，不伪造正确率。
- 卡片只计算到期数（不计算留存/正确率）；评分与下次日期由 Spaced Repetition 管理。
- 任何 async 读取失败都会降级为空数组/空字符串，不阻塞页面主结构。

## 4. UI 组件

| 函数 | 用途 |
|---|---|
| `createDashboard(container, opts)` | 构建静态壳，返回 `update / updateLists / setLoading / setError / scrollToAnalytics / setSearchValue / destroy` |
| `ring(value)` | 今日进度环 |
| `barChart(items)` | 14 天活动 / 7 天负荷 |
| `progressBar(value)` | 来源页码进度 |
| `emptyState({...})` | 空队列、无匹配、错误 |
| `dashboardSkeleton()` | 首屏骨架 |
| `icon(name)` | 内联 SVG |
| `.mf-reading-bar` | 笔记顶部阅读条（contentEl 直挂） |
| `.mf-reading-popover` | 阅读操作弹出菜单 |
| `.mf-card-modal` | 从摘录制卡弹窗 |
| `.mf-priority-modal` | 优先级弹窗 |
| `.mf-overload-modal` | Mercy 过载弹窗 |

事件委托：所有可点元素带 `data-action`；UI 统一收集 `dataset` 交给 view/preview 的 `onAction`。

## 5. 下一阶段接口建议

- 优先级已接到阅读条/标题栏；下一步可把优先级编辑也放到队列行。
- 复习专注界面：目前复用 SR 的复习 UI；若以后要做 MemoFlow 自己的复习壳，先确定是否仍由 SR 持有调度数据。
- 阅读条可以补「撤销上一次评分」「跳到指定页」等细动作。
- 完整 i18n 已覆盖设置页、提示、确认、选择项、正常 Notice 与使用指南；控制台/第三方 SR 除外。
- 移动端：把 `openPdfForSource` 扩展到 `pdf_path` 的 Vault 后缀匹配；选区级链路单独做实验开关。
- 同步：Review Log 分设备、session 移出 data.json、ISO 日期迁移，按计划评审 §9 执行。
- 主题：若要“跟随 Obsidian 主题”，把 `.mf-view` 的颜色 token 改为 `var(--background-*)` 派生，保留琥珀/珊瑚语义色。

## 6. 预览

```bash
node scripts/build.mjs --preview
# preview/index.html 或本地静态服务
```

- `?theme=dark` 暗色
- `?empty=1` 空状态
- `?w=390` 固定 390px 模拟手机（Edge headless 窗口最小值 492px，截图会居中裁剪）
- `?bare=1` 隐藏预览控制条
- `?debug=1` 输出布局宽度到页面左上角

截图脚本：`node scripts/screenshot.mjs`；产物在 `preview/screenshots/`。
