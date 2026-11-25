# P2-US1-SR-01 — SR Card Boundary & Host Regression Audit

- 任务 ID：`P2-US1-SR-01`（PR-11）
- 基线：`main @ 6b8ed19`（PR #29 合并后）
- 分支：`feat/phase2-mf-us-1-sr-boundary`
- 结论：**未发现 SR 调度被 MF-US-1 侵入**；发现并最小修复 1 处 Dashboard 计入 Card 的显示缺陷
- 证据分级：源码证明 / Mock Obsidian 合成执行 / 仍需真实 Obsidian 验收

## 1. SR 调用链与覆盖矩阵

| 入口 | 实际函数（当前 main.js） | 写入者 | 写入字段 | 与 MF-US-1 关系 | 证据 |
|---|---|---|---|---|---|
| 阅读页制卡 | `create-card` 动作 → `_createSpacedRepetitionCard()` `main.js:3135` | MemoFlow 仅创建 Markdown | `type: card`、`ir_spaced_repetition`、deck tag、`card_format`；**无** interval/next_review/review_count/priority/a_factor/mf_* | 不进入队列/Writer/Mercy/迁移；不评阅父节点 | Mock 执行 |
| 剪贴板制卡 | `flashcardClipboard()` → 卡片 Modal → 同一创建函数 | 同上 | 同上 | 同上 | 源码 + Mock |
| 图片遮挡制卡 | `occlusionCreate()` → 多个同一创建函数 | 同上 | 同上 | 同上 | 源码 |
| Inline cards 导出 | `seedInlineCards()` / 解析 `Q::A`、`{{c1::}}`、`==c==` | 创建 Card notes | SR 语法 | 不进入 MF-US-1 | 源码 + card-core 测试 |
| 全库卡片复习 | `reviewCards()` → `obsidian-spaced-repetition:srs-review-flashcards` | **SR 插件** | SR 自有调度/历史 | MemoFlow 不写 | Mock 命令 |
| 单卡复习 | `reviewCardsInNote()` → `srs-review-flashcards-in-note` | **SR 插件** | SR 自有 | 仅只读 `spacedRepetitionScheduleSignature` 做完成确认 | Mock 命令 |
| 阅读「下一项」遇 Card | `if (type === 'card') this.reviewCardsInNote(file)` `main.js:3647` | SR | SR | 不调用 `_gradeTopic` | 源码 |
| Dashboard 旧统计 | 行过滤 `type === 'card'` 单独计数 `main.js:2249` | 只读 | — | Card 与阅读分开 | 源码 |
| MF-US-1 Dashboard | `buildDashboardModel()` | 只读 | `cardsExcluded` | 本轮修复：Card 不再进入 `queue.invalid` | Mock |
| 宿主门面 | `_mfUs1Run` 仅用于 Source/Extract 入口 | — | — | 制卡/复习路径无 `_mfUs1Run` | 源码切片断言 |
| SR 缺失 | `src/main.js isSpacedRepetitionReady()` + Notice | 不写 | — | 不触发 MF-US-1 | 源码 + Mock |

## 2. 七项结论

1. **Card 不进入 MF-US-1 队列/Writer/Mercy/迁移**：`validateTopicType` 拒绝 card；`selectDailyQueue` 报 `E_TOPIC_TYPE`；`buildDashboardModel` 现先过滤 Card；Writer schema 同样拒绝。证据：源码 + Mock。
2. **Card 调度与历史仍由 SR 维护**：Card 创建不写 IR 调度字段；复习只调用 SR 命令；MemoFlow 仅读取签名判断完成。证据：源码 + Mock。
3. **制卡不构成父 Source/Extract 有效评阅**：父文件内容与 Frontmatter 在制卡前后逐字节一致；无 `review_count`/`next_review` 写入。证据：Mock 执行。
4. **Source/Extract 事件不能修改 Card**：Card 无 `mf_id`，Writer 拒绝；合成存储中的 Card 内容保持不变。证据：Mock/合成 Writer。
5. **Legacy 阅读与 SR 复习各自正常**：Card 路径不经过宿主门面；阅读入口仍走 Legacy/门面。证据：源码 + Mock。
6. **Shadow/Unified 门禁不误伤 Card**：即使设置 `mf_us1_mode=shadow/unified`，单卡复习仍调用 SR 命令；门面只包 Source/Extract 方法。证据：Mock + 源码。
7. **Phase 1 Refine/History/Restore 不受影响**：本 PR 未修改 Refine 模块/视图；全仓回归包含 Phase 1 测试。证据：全仓测试。

## 3. 实际发现的缺陷与最小修复

**Dashboard 将 Card 报为非法 Topic**：`buildDashboardModel` 先构造 Card 独立计数，却把全部 topics 交给 `selectDailyQueue`，导致 Card 落入 `queue.invalid`，UI 可能显示“非法/未迁移 1”。修复：在入队前过滤 `type === 'card'`；新增断言 `queue.invalid.length === 0`。未改动任何调度算法。

## 4. 测试

```
node --test test/mf-us-1-sr-boundary.test.js   tests   9  pass   9
node --test test/mf-us-1-*.test.js             tests 703 pass 703
node --test test/*.test.js                     tests 1098 pass 1098
node scripts/validate-release.mjs              valid
node scripts/build.mjs --dry-run               no files written
```

Mock 覆盖：实际宿主类（Mock Obsidian TFile/TFolder/vault/commands）执行制卡、Cloze C1/C2/C3、父节点不变、SR 命令调用、SR 缺失 Notice、shadow/unified 设置下 Card 复习不受影响；纯层覆盖队列/Writer/Dashboard 排除。

## 5. 仍需真实 Obsidian 验收

- SR 插件真实版本下的命令执行与完成确认；
- 真实 SR 调度字段/历史落盘；
- 真实阅读页「下一项」在混合队列中的切换；
- 真实 Dashboard 渲染；
- Card 创建在真实 Vault 的模板/标签行为；
- Phase 1 Refine 实机回归。

## 6. MemoFlow 1.0 剩余阻塞（集中清单）

1. Unified 真实激活与旧写入者最终退出（含单写入覆盖证明）。
2. 真实 UI 事件 payload 接入（`postpone/schedule/setPriority/_gradeTopic` 的 UI 前置）。
3. 生产账本启动恢复与持久化门禁（真实 `data.json`、崩溃顺序）。
4. Obsidian 并发与崩溃恢复实机验证（`Vault.process` 跨插件/同步软件）。
5. `resetCurrent` 事件语义裁决（禁止伪装为 MANUAL_SCHEDULE）。
6. 用户授权后的迁移、备份、回滚与实机验收。

以上均为 1.0 交付项，不推迟到 1.1。

## 7. 安全边界

仅 Mock/Fake；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR 数据；未写真实 Frontmatter/data.json；未启用 Unified、未迁移；Phase 1 工作区未触碰。
