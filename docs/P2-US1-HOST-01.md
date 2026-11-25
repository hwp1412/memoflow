# P2-US1-HOST-01 — Host Entrypoint Integration & Durable Storage Boundary (PR-10B)

- 任务 ID：`P2-US1-HOST-01`
- 状态：宿主入口已建立**单一调度门面**（Legacy 保留、Unified fail-closed）；真实 Obsidian 未运行、未验收
- 基线：`main @ 588f285`（PR #27 合并后）
- 分支：`feat/phase2-mf-us-1-host-wiring`
- 规范：`docs/MF-US-1-SPEC.md`、`AGENTS.md`、`docs/GITHUB-WORKFLOW.md`

## 1. 范围与非范围

**已完成**：宿主 Source/Extract 入口接入 `HostSchedulerService`；根 `main.js` 与 `src/main.js` 最小修改（仅方法包装 + 旧实现改名保留）；真实形状的 `Vault.process()` 存储适配器源码；可持久化账本边界；重置/撤销/创建路径的失败关闭；Mock/Fake 测试。

**未完成/未授权**：真实 Vault 读写、真实 `data.json`、启动恢复接线、真实 Unified 启用、真实 UI 视图接线、实机验收。

## 2. 宿主入口接管矩阵（最新 main）

| 入口（当前 main.js 行） | 接线 | Legacy 行为 | Shadow | Unified | 非调度副作用 | 状态 |
|---|---|---|---|---|---|---|
| `_gradeTopic` → `_gradeTopicLegacy` | `ADVANCED` 描述符 | 原评分体 | Legacy 写 + 只在收到可验证观察时对照 | 拒绝（`E_UNIFIED_NOT_AUTHORIZED`） | 弹窗/Notice | 已接线（门面级） |
| `markDone` → `_markDoneLegacy` | `COMPLETE` | 原逻辑 | 同上 | 拒绝 | 会话指针 | 已接线 |
| `dismiss` → `_dismissLegacy` | `DISMISS` | 原逻辑 | 同上 | 拒绝 | Notice | 已接线 |
| `resetCurrent` → `_resetCurrentLegacy` | `RESET_CURRENT` | 原逻辑 | 同上 | **拒绝**（语义未裁决） | 确认框 | 门禁接线，事件映射待裁决 |
| `postpone` → `_postponeLegacy` | `POSTPONE` | 原逻辑 | 同上 | 拒绝 | 选择器 | 门面接线；payload 在旧体内，Unified 前需 UI 前置 |
| `schedule` → `_scheduleLegacy` | `MANUAL_SCHEDULE` | 原逻辑 | 同上 | 拒绝 | 日期选择 | 同上 |
| `setPriority` → `_setPriorityLegacy` | `SET_PRIORITY` | 原逻辑 | 同上 | 拒绝 | 输入框 | 同上 |
| `postponeSubtree` → `_postponeSubtreeLegacy` | `POSTPONE_SUBTREE` | 原逻辑 | 同上 | 拒绝 | 树遍历 | 门面接线 |
| `newSource` → `_newSourceLegacy` | `CREATE_SOURCE` | 原初始化 | 同上 | 拒绝 | 模板/打开 | 门面接线；Unified 初始化未启用 |
| `_createExtract` → `_createExtractLegacy` | `CREATE_EXTRACT` | 原逻辑 | 同上 | 拒绝 | 选区/剪贴板 | 门面接线 |
| `createTimestampExtract` → legacy | `CREATE_EXTRACT` | 原逻辑 | 同上 | 拒绝 | PDF 页码/打开 | 已接线 |
| `spreadOverdue` → legacy | `MERCY_APPLY` | 原逻辑 | 同上 | 拒绝 | 批量选择 | 门面接线 |
| `startLearning` / Dashboard / Review View | 只读 | 原行为 | 只读 | 只读 | 导航 | 未改写入 |
| SR Card 制卡/评分 | 不接管 | SR | SR | SR | 无 | 保持隔离 |

## 3. 单写入门面

`createHostSchedulerService({mode, conditions, shadowObserver})`：

- `legacy`：执行原始实现一次；
- `shadow`：原始实现完成后才调用 observer；observer 失败仅诊断；
- `unified`：**无条件 `E_UNIFIED_NOT_AUTHORIZED`**，不执行 legacy、不调用任何新 writer；
- 同 eventId 并发共享一次 in-flight（请求指纹不同则 `E_EVENT_ID_CONFLICT`）；
- 宿主通过 `_mfUs1RunLegacy(descriptor, legacy)` 调用，返回原实现结果，保证既有调用方语义。

**证据**：`test/mf-us-1-host-service.test.js`（legacy/shadow/unified/in-flight/冲突/resetCurrent）。

## 4. 宿主接线证据

- `main.js` 中 10 个入口新增 `_mfUs1RunLegacy({action}, () => this._<name>Legacy(...))`；
- 原方法体完整保留在 `_<name>Legacy`，未改公式、未改写入顺序；
- `src/main.js` 的 `createTimestampExtract`、`spreadOverdue` 同样包装；
- `schedulerDashboardModel()` 连接 PR-10 Dashboard 模型（只读）；
- 静态验证：`test/mf-us-1-host-wiring.test.js` 断言每个入口都经过门面、默认模式为 legacy、宿主不存在 unified 授权路径。

## 5. Vault.process / processFrontMatter 并发分析

- `Vault.process(file, fn)` 的回调接收**最新完整内容**，被官方描述为单文件原子读改写；本适配器把 hash、mf_id、revision、字段更新全部放在回调**内部**，回调外预读不作为 CAS；
- `FileManager.processFrontMatter` 同样在单文件回调内，但只提供 Frontmatter 对象，无法在同一回调内证明完整正文 hash，因此不作为本方案的写入原语；
- 同进程串行化可避免插件内并发；其他插件调用、外部同步软件（iCloud/Syncthing）仍可能在两次调用之间修改文件；Obsidian 不提供跨文件事务；
- 写后回读失败返回 `E_WRITE_UNVERIFIED`（uncertain），不适配为成功；
- YAML 结构无法安全重写时返回 `E_FRONTMATTER_UNSUPPORTED_STRUCTURE`，不猜测。

## 6. 生产 StorageAdapter 信任模型

`src/integration/obsidian-process-storage.js`：

- 工厂创建并注册于模块私有 WeakSet；`assertTrustedProcessAdapter` 拒绝伪造对象；
- 真实形状，但**未接入真实运行**；宿主门面在 unified 模式先拒绝，因此不会调用它；
- 进程内 Mock 的 `Vault.process` 行为可测；不宣称 Obsidian 真实跨进程 CAS 已验收。

## 7. 持久账本边界

`src/integration/plugin-data-ledger-store.js`：

- 版本化 `{version:1, records}`；
- `loadData/saveData` 注入（测试 Fake；真实 data.json 未授权）；
- 记录校验、损坏诊断、显式 `flush()`（保存失败返回 `E_LEDGER_SAVE_FAILED`，不宣称耐久）；
- 跨重启测试：E1→E2→E1 重载后仍幂等；prepared 记录经 `reconcileUnifiedEvent` 恢复为 applied；
- 账本不含正文/路径。

## 8. 启动恢复与模式门禁

- 模式默认 legacy；`mf_us1_mode` 只在用户已有设置时读取；
- Unified 无条件 fail-closed：无生产授权、无 onload 自动启用、无旧入口回退；
- 启动恢复 API 已具备（加载+校验+flush），但尚未接入插件 `onload`（真实数据未授权）。

## 9. resetCurrent 未裁决

Legacy 保留原行为；Unified 一律拒绝（`E_UNIFIED_NOT_AUTHORIZED`）。未把它伪装成 MANUAL_SCHEDULE。需产品裁决：其真实语义（是否重置 Interval/A-Factor/Review Count）、对应事件或规范修订。

## 10. Mercy / postponeSubtree

宿主入口已在门面后；Unified 拒绝。合成 Mercy/批次可靠性由 PR-09 的 `unified-mercy-writer` 与测试覆盖；真实批量接线未启用。

## 11. Source/Extract 创建

`newSource`、`_createExtract`、`createTimestampExtract` 已进入门面但 Unified 拒绝；Legacy 创建行为不变。`initializeTopic` 的 Fake 初始化/T17 证据见 PR-10；真实 Unified 创建未启用。

## 12. Dashboard / 模式 UI

`schedulerDashboardModel()` 已连接 PR-10 模型（mode/blockers/queue/dates/预算）。真实视图尚未调用（未接线），因此不声明 UI 已集成。

## 13. 测试

```
node --test test/mf-us-1-host*.test.js   tests 24  pass 24  fail 0
node --test test/*.test.js               tests 1076 pass 1076 fail 0
```

覆盖：门面 legacy/shadow/unified fail-closed、in-flight 冲突、Vault.process 回调内校验/外部编辑/revision/身份/YAML/回读、账本版本/损坏/保存失败/重载/恢复、宿主入口静态接线。

## 14. 交付矩阵

`UI-01`、`WRITE-01`、`MODE-01`、`INIT-05`、`MERCY-03` 根据合成证据更新；`ACC-01` 仍 `NOT_STARTED`。

## 15. 未验证 / 阻塞

真实 Obsidian 运行、真实 Vault 读写、真实 data.json、onload 恢复接线、真实 UI 视图、Unified 启用、实机验收：**全部未验证/未授权**。

## 16. 数据安全边界

仅 Mock/Fake；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未写真实 Frontmatter/data.json；未迁移/启用 Unified；Phase 1 工作区未触碰。
