# P2-US1-INTEGRATION-01 — Obsidian Integration, Unified Entrypoints & Dashboard

- 任务 ID：`P2-US1-INTEGRATION-01`
- 状态：独立集成模块 + Fake Vault 测试完成；真实宿主接线**未授权、未执行**
- 基线：`main @ 42b7b18`（PR #24 合并后）
- 分支：`feat/phase2-mf-us-1-runtime-integration`
- 本地 commit：见验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A1、A2、A8、A9、A10、A11、A13）

## 1. 范围与非范围

**已交付**：入口静态审计、运行时模式门禁、单写入者路由、Fake Obsidian StorageAdapter 契约、阅读动作映射与去重、Dashboard 数据模型、`explainSchedule()`、T17–T20 Fake 覆盖。

**未执行**：根 `main.js`、`src/main.js` 的任何修改；真实 Vault 读写；真实 Obsidian 启动；Unified 启用；真实迁移。相关入口在 §11 标记为待授权。

## 2. Source/Extract 写入入口接管矩阵（只读审计）

| 入口 / 源码位置 | 调用方 | 改调度字段 | Legacy | Shadow | Unified 预期 | SR Card 风险 | 保留的非调度副作用 | 接管条件 | 测试证据 |
|---|---|---|---|---|---|---|---|---|---|
| `_gradeTopic()` `main.js:3737` | 阅读页评分 `src/main.js:483` | 是（next_review/interval/revision） | 旧公式写入 | 旧写入 + 只读对照 | `ADVANCED/HOLD/SOON` → Writer | 排除 card | 弹窗、Notice | 需真实 StorageAdapter + 入口接线（BLOCKED） | 路由测试 |
| 新建 Source `main.js:4970` | 菜单 `main.js:3053`、`src/main.js:150` | 是（初始化排期） | 旧初始化 | 旧初始化 + 只读 | `initializeTopic` + 新 ID | 否 | 模板、标签、打开文件 | 创建路径初始化（PR-10 纯层已备） | T17 |
| `_createExtract` `main.js:4571` | 剪贴板入口 `main.js:4545` | 是（新节点排期） | 旧初始化 | 旧 + 只读 | 初始化 + 父子 ID | 否 | 剪贴板、光标位置 | 同上 | T17 |
| `createTimestampExtract` `src/main.js:1316` | 选区/PDF `src/main.js:51,866` | 是（interval/a_factor/next_review） | 旧 | 旧 + 只读 | 初始化 + 父子 ID | 否 | 页码、选区、打开文件 | 同上 | T17 |
| `postpone()` `main.js:4289` | 命令/菜单 | 是（next_review/interval） | 旧 | 旧 + 只读 | `POSTPONE` | 排除 card | Notice | 需接线（BLOCKED） | 映射测试 |
| `postponeSubtree()` `main.js:4496` | 批量菜单 | 是 | 旧 | 旧 + 只读 | 逐 Topic `POSTPONE` | 排除 card | 树遍历 | 需批量事务设计 | 路由测试 |
| `schedule()` `main.js:4307` | 命令 | 是（next_review/interval） | 旧 | 旧 + 只读 | `MANUAL_SCHEDULE` | 排除 card | 日期选择器 | 需接线 | 映射测试 |
| `setPriority()` `main.js:4337` | 菜单 `main.js:3069` | 是（priority/next_review） | 旧 | 旧 + 只读 | `SET_PRIORITY` | 排除 card | 输入框 | 需接线 | 映射测试 |
| `resetCurrent()` `main.js:4271` | 命令 | 是（排期重置） | 旧 | 旧 + 只读 | 需明确事件（暂 `MANUAL_SCHEDULE`） | 排除 card | 确认框 | 待规范裁决 | 审计 |
| `markDone()` `main.js:4263` | 菜单/阅读页 `src/main.js:161` | 是（status） | 旧 | 旧 + 只读 | `COMPLETE` | 排除 card | 会话指针、通知 | 需接线 | 映射测试 |
| `dismiss()` `main.js:4277` | 命令 | 是（status） | 旧 | 旧 + 只读 | `DISMISS` | 排除 card | Notice | 需接线 | 映射测试 |
| `spreadOverdue()` / Mercy `src/main.js:1042`、`main.js:4490` | 逾期批量 | 是（next_review/interval） | 旧 | 旧 + 只读 | `unified-mercy-writer` | 排除 card | 选择器 | 需 UI 确认 + 接线 | Mercy 测试 |
| `startLearning()` `src/main.js:936` | Dashboard | 队列/会话（可能触发评分） | 旧 | 旧 | 队列来源改为 `selectDailyQueue` | 排除 card | 打开笔记 | 需接线 | Dashboard 测试 |
| Review View 渲染（`src/ui`/view） | 阅读页 | 否（只读） | 只读 | 只读 | 显示 Ideal/NotBefore/Effective | card 不显示 | 无 | 已可用模型 | Dashboard 测试 |
| Card 制卡/评分（SR 桥接） | SR | **不接管** | SR | SR | SR | 本体 | 无 | 保持隔离 | T18 mock |

所有 `next_review` / `interval` 写入点：`main.js:3853,4254,4301,4329,4490,4532,5136,5585`、`src/main.js:409,1061`；`src/data/extract.js:81-82` 仅创建时写一次。**没有发现未列入本表的 Source/Extract 调度旁路。**

## 3. 运行时模式门禁

`evaluateRuntimeMode(config, conditions)`：默认 `legacy`；`shadow` 只读；`unified` 需要全部条件：

- `migrationComplete`、`pendingRecovery===false`、`singleWriterReady`、`backupVerified`、`userConfirmed`、`storageSupportsCas`；
- **不可伪造的合成运行时授权**（WeakSet）；`{authorized:true}` 或伪造对象无效；
- 即使全部满足，`canCommitUnified` 仍为 `false`（PR-07 契约），本 PR 不启用真实 Unified。

## 4. 单写入者路由

`createReadingSchedulerRouter({config, conditions, legacyScheduler, shadowComparator, unifiedExecutor})`：

| 模式 | Legacy 调用 | Shadow 对照 | Unified Executor | 失败行为 |
|---|---|---|---|---|
| legacy | 1 次 | 不调用 | 不调用 | 原样返回 |
| shadow | 1 次 | 1 次（Legacy 完成后，只读） | 不调用 | Shadow 异常隔离，不影响 Legacy 结果 |
| unified | **0 次** | 不调用 | 1 次（全部条件满足时） | 条件/执行失败 → 拒绝，不回落 legacy |

`route()` 为 async：支持同步返回值与 Promise；同 `eventId` 的并发调用只有在**请求指纹一致**时才共享一次 in-flight 执行（第二次标记 duplicate）；topicId/操作类型/payload/revision/today/calendarDate/dateFormat 任一不同 → `E_EVENT_ID_CONFLICT`，冲突请求不触发任何写入，也不收到首个请求的结果。

**异常后的写入状态**：Legacy/Unified 抛出或 reject 时，默认返回 `status:'uncertain'`、`writesPerformed:null`、`writeOutcome:'uncertain'`、`requiresManualRecovery:true`，并保留原始错误码。只有通过 `markPreWriteFailure()` 由集成代码显式登记（不可伪造）的错误才可报告 `failed / writesPerformed:false / none`；普通错误名或调用方布尔字段不被信任。已 resolve 的 `failed` 结果仍为失败。

Shadow 只接受 `status === 'applied'` 的 Legacy 观察；failed/rejected/conflict/uncertain/no-op/duplicate 一律 `not-comparable`，Comparator 不执行。Legacy 写入后状态不明（`uncertain`）时，Router 传播 `writeOutcome:'uncertain'` 与 `requiresManualRecovery`，`writesPerformed` 仅在确证 true 时为 true，否则为 null，绝不武断报 false。

## 5. Fake Obsidian StorageAdapter 与并发限制

`src/integration/obsidian-storage-adapter.js`：

- `locateByTopicId` 按持久 `mf_id` 大小写无关扫描（跟随重命名），大小写变体也报告重复，不改写原始 UUID；
- `readSnapshot` 返回 `{path, frontmatter, body, content, hash, revision, mfId}`，非法 ID 拒绝；
- `verifySnapshot` 校验内容 hash + revision；
- `writeFrontMatterLegacy` 明确标记 `atomic:false` 与 `NON_ATOMIC_FRONTMATTER_WRITE`；
- **`supportsAtomicCas=false`**：`processFrontMatter()` 是 read-modify-write，不能冒充 CAS；
- `assertUnifiedStorageReady()` 只信任模块私有 WeakSet 注册、且实际具备 `compareAndSwap` 的 Atomic Adapter；伪造 `supportsAtomicCas=true` 字段/方法被 fail-closed（`E_STORAGE_WITHOUT_CAS`）；
- 缺失/非法 `mf_id` 的 Topic 不能作为写入目标（`E_ID_NOT_PERSISTED`）；
- 仅测试用 `createFakeAtomicVaultAdapter` 提供真实 CAS 契约。

**结论**：真实 Obsidian 存储无法保证跨进程原子性；Unified 必须保持关闭，直到有独立审核的串行化/恢复方案（PR-12 实机验证）。

## 6. 持久账本运行时接口（规划）

- 启动时从受控存储加载 event 索引，逐条校验 hash/版本/状态；
- `prepared → applied` 只在 Topic 回读校验通过后提交；
- 写入成功但账本确认失败：用 intent 的 expectedAfterHash + revision 恢复；
- 跨重启重复 eventId 直接返回历史结果；
- 账本损坏/缺失 → `requires-manual-recovery`，不重放；
- 审计不含正文/绝对路径。
- 真实 `data.json` 写入策略与耐久性未实现，不得以内存 dump/reload 等同真实磁盘恢复。

## 7. 阅读动作映射与去重

`mapReadingAction` 覆盖 10 类事件；`source.open` / `pdf.scroll` / `pdf.locate` / `extract.create` / `extract.refine` 明确**不是**调度事件。`ReadingEventCoordinator` 复用 PR-09 指纹：同 eventId 且语义相同才 duplicate；topicId/type/payload/expectedRevision/today/calendarDate/dateFormat 任一不同 → `E_EVENT_ID_CONFLICT`。仅 `applied/duplicate/no-op` 进入缓存；failed/uncertain/pending 可安全重试；异步 in-flight 共享一次提交。

## 8. 创建初始化

`initializeTopic` 仍是唯一初始化入口：新 Topic 使用 MF-US-1 首次间隔；父节点不被修改；父子/根 ID 由调用方提供并校验。本 PR 仅在 Fake 环境验证，真实创建入口保持 Legacy 行为。

## 9. Dashboard / 今日队列 / 解释

`buildDashboardModel`：

- `selectDailyQueue` + 预算；区分 selected/deferred/postponed/notYetDue/invalid；
- 积压口径：`overdueCount` 只统计 active 且 Effective Due 已过；done/dismissed、Card、非法 Topic、未来行政延期不计入；另给出 `idealOverdueCount` 与 `postponedOverdueCount` 区分“理想已过但尚未到可展示日”；
- Topic 详情分别展示 Priority/Interval/A-Factor/Ideal Due/Not Before/Effective Due/Mode/身份；
- 卡片排除、`writeEnabled:false`（真实写入始终关闭）；
- 迁移/恢复/Mercy 摘要；
- 未知日期格式 → `projectionWarning`，不猜测。
- `explainSchedule` 仅当 `mf_not_before > mf_ideal_due` 时才说明行政延期决定 Effective Due；早于或等于时明确“不构成延期”。

`explainSchedule(topic)` 复用已验收的 `initialIntervalDays` / `explainNextInterval` / `effectiveDue`：解释首次排期、后续 `I×A`、行政延期、Skip/Postpone/Mercy 不计评阅、旧数据限制。

## 10. 模式切换与 UI 门禁

Dashboard 展示当前模式、迁移计数、阻塞原因（迁移未完成、待恢复、备份未验证、旧写入未退场、无 CAS、未授权）。没有绕过按钮；真实 Unified 激活仍需独立授权与实机验收。

## 11. 尚未接线的真实入口（需单独批准）

根 `main.js`、`src/main.js` 属高风险文件，**本 PR 未修改**。建议的最小接线：

1. `onload` 创建 `ObsidianStorageAdapter` + 持久账本 + router；
2. 将 `_gradeTopic`、`postpone`、`postponeSubtree`、`schedule`、`setPriority`、`markDone`、`dismiss`、`resetCurrent`、`spreadOverdue` 的写入段替换为 `router.route(action)`；
3. Legacy 分支调用原方法；Unified 分支调用 `executeUnifiedEvent` 并禁止调用旧公式；
4. 用 `next_review = formatForVault(effectiveDue)` 取代旧写入；
5. 在 `src/main.js:483`（阅读页评分）等 UI 入口复用同一 router。

**阻塞原因**：真实 Obsidian 无 CAS，Unified 分支必须 fail-closed；旧入口退场与模式切换需要真实宿主回归。以上均标记 `BLOCKED`，未执行修改。

## 12. T17–T20（Fake 层）

- T17：`initializeTopic` 创建子 Extract 不改父对象；独立间隔。
- T18：Card 不进入队列，SR mock 零调用。
- T19：Shadow 路由只经 Legacy 写入；对照不写回；异常隔离。
- T20：Fake Vault 重命名后 `mf_id` 不变，队列顺序按稳定 ID 不变。

## 13. 测试

```
node --test test/mf-us-1-runtime-mode.test.js test/mf-us-1-runtime-router.test.js \
  test/mf-us-1-obsidian-adapter.test.js test/mf-us-1-reading-integration.test.js \
  test/mf-us-1-explain.test.js test/mf-us-1-dashboard.test.js \
  test/mf-us-1-integration-properties.test.js
  tests 78  pass 78  fail 0
```

## 14. 交付矩阵

- `UI-01`：模型/解释/Fake 入口测试 `TESTED`；真实 UI 接线未完成
- `API-01`：`explainSchedule` 已补齐
- `MODE-01`：运行时门禁（合成）
- `WRITE-01`：真实存储适配边界（fail-closed）
- `INIT-05`：创建初始化纯层/Fake
- `TEST-01`：T17/T18/T19/T20 Fake 证据
- `ACC-01`：仍未执行

## 15. 未验证 / 阻塞

真实 Obsidian 启动、真实 Vault 读写、真实 `processFrontMatter` 并发、真实账本持久化、真实创建入口接管、真实 UI 交互、SR 实机、Unified 激活：全部 `UNVERIFIED`/`BLOCKED`。

## 16. 安全边界

仅合成 Markdown/Fake Vault；未修改根 `main.js`/`src/main.js`；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未写 Frontmatter/`data.json`；未迁移/启用 Unified；未创建 PR/合并；Phase 1 并行工作区未触碰。
