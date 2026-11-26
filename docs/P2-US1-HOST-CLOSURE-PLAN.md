# P2-US1-HOST-CLOSURE-PLAN — 剩余宿主接口统一规划

- 计划 ID：P2-US1-HOST-CLOSURE-PLAN
- 基线：`personal/main @ a865a0e`（PR #37 已合并；`851308e` 为祖先）；基线全量测试 `1263 pass / 0 fail`
- 本次：**只读审查 + 统一方案**，未改业务代码
- 审查方式：主 Agent + 4 个只读 Subagent 并行（Mercy / Boost+状态操作 / Queue+Dashboard / 集成与安全），
  主 Agent 对矛盾结论做了源码复核与去重，不拼接四份报告
- 仓库事实优先于文档：交付矩阵、CLOSURE、HOST-ACTIONS 文档均存在历史滞后，已按源码修正（见 §2.4）

---

## 1. 当前基线与已完成阶段

| # | 阶段 | PR | 交付物 | 目录 |
|---|---|---|---|---|
| 1 | 纯算法（PR-01～05） | #14～#19 | 日期/首次/后续/队列/Mercy/模拟/性能 | `src/scheduling/*` |
| 2 | Legacy 适配、Shadow、迁移、Writer | #20～#24 | 适配器、事件账本、单一 Writer | `src/scheduling/*` |
| 3 | 运行时集成、宿主门面、SR 边界 | #27～#29 | `host-scheduler-service`、dashboard 模型、SR 证明 | `src/integration/*` |
| 4 | 1.0 闭环、生产接线、创建入口 | #30～#33 | 异步 runtime、WAL、创建网关、onload lifecycle | `src/integration/*` |
| 5 | 持久化协调 | #35 | `plugin-data-coordinator`、设置/会话/账本统一队列 | `src/integration/plugin-data-coordinator.js` |
| 6 | 阅读三操作 | #36 | `postponeFile/scheduleFile/setPriorityFile`、读取操作面板接线 | `main.js`、`src/main.js` |
| 7 | 子树延期 | #37 | `postponeSubtreeHost`、逐节点事件、写前关系 CAS | `src/integration/subtree-postpone-host.js` |

### 1.1 环境事实（影响并行开发）

- 已存在 6 个 Phase 2 worktree；Phase 1 工作区 `memoflow` 干净且**不得触碰**。
- `dist/memoflow/main.js` 是旧构建（`d965cb8`），**不含任何 MF-US-1 代码**（`mf_ideal_due` 出现 0 次）；
  验收前必须重新构建，不能拿旧 dist 做人工验收。
- 生产 Unified **双重门禁**：`host-runtime.js:26-43` 的 WeakSet 授权 + `runtime-mode-guard.js:26-45` 的 6 项条件；
  onload 传 `conditions:{}`（`main.js:2895`）→ `writeEnabled=false`。任何设置都无法开启生产统一写。
- `mf_us1_mode` **不在 `DEFAULT_SETTINGS`**（`main.js:363-427`），设置页无此项 → 模式只能手改 data.json。

---

## 2. 审查结论（四路去重后）

### 2.1 已完成、不需要修改（只接线或直接复用）

| 能力 | 证据 | 结论 |
|---|---|---|
| A5.x 事件状态机、A4 评阅、COMPLETE/DISMISS/REACTIVATE/SKIP 纯语义 | `src/scheduling/events.js` | 不改 |
| 单 Topic 异步执行链：Intent→CAS→回读→Ledger→恢复 | `host-async-executor.js`、`host-async-runtime.js` | 不改，批量复用 |
| Topic 串行锁、启动恢复门、uncertain 锁 | `host-async-runtime.js:55-160` | 不改 |
| data.json 单队列 + 读回校验 + owner 故障 | `plugin-data-coordinator.js` | 不改 |
| 真实字节 CAS、关系前置条件、嵌套 YAML 容错 | `obsidian-process-storage.js` | 不改 |
| 子树批量编排（plan/verify/run/aggregate） | `subtree-postpone-host.js` | **抽出通用批次执行器**复用 |
| 创建幂等网关、三入口 | `topic-creation-host.js`、`main.js` | 不改，仅补授权发放路径（生产仍锁定） |
| Mercy 纯分配/预览/内存批/PR-09 持久 writer | `mercy.js`、`mercy-batch.js`、`unified-mercy-writer.js` | 公式与协议不改，**只接真实存储与宿主 UI** |

### 2.2 需要接线（底层齐备、宿主缺失）

| 能力 | 现状 | 缺口 |
|---|---|---|
| Mercy Preview/Confirm/Apply/Undo | 纯层 + 合成 writer 齐备；宿主两条链都直写 `next_review+interval`（`main.js:4894`、`src/main.js:1102-1105`） | 真实 preview UI、confirm 绑定、批次持久化、逐 Topic CAS、部分成功、undo、启动恢复、模式隔离 |
| REACTIVATE | 纯事件 + ACTION_MAP 映射存在；**零宿主入口、零 UI** | 完成/移出后无法通过 UI 恢复；只有 `resetPaths`（清空历史）可用 |
| COMPLETE / DISMISS 直写面 | `markPathsDone`（`main.js:4476`）、`dismissTreeNode`（4461）、阅读条非活动分支（`src/main.js:523`） | 绕过 host，Unified 下仍写 legacy 字段 |
| Boost 批量优先级 | Unified 下早退阻断（`main.js:4751`）；Legacy 直写 + 级联 | 批量事件协议、逐 Topic revision、部分成功、恢复 |
| 队列/仪表盘数据源 | 真实 UI 100% 走 legacy `next_review/interval`（`main.js:3521-3553`、`src/data/model.js`） | Unified 读侧：`mf_ideal_due/mf_not_before/mf_revision`、预算、负荷、explain |
| 生产恢复 | `initializeHostLifecycle` 未传 `storage`（`main.js:2891`）→ `recover()` 从不执行 | 传入真实异步 storage；接线 `initializeAsyncHostLifecycle` |
| 迁移激活、模式切换 | 纯模块/模型存在、无 UI/命令；`buildHostModeView` 仅测试引用 | 迁移预览→执行→备份 UI、模式条件生产者、blocked topics 诊断 |
| Shadow 对照 | `_mfUs1HostService` 未传 `shadowObserver`（`main.js:3831`） | shadow 永远 `SHADOW_OBSERVER_MISSING` |

### 2.3 明确缺失、需要开发

1. **通用批次执行器**（从 subtree 抽出）：plan/verify/run/aggregate + 部分成功 + 报告；Mercy、Boost、子树共用。
2. **Mercy 真实批次宿主层**：真实 topic storage 适配（现 writer 只认 `SyntheticUnifiedStorage`）、
   持久 batch store（pluginData 保留键 + 损坏校验 + 启动恢复）、跨日预览新鲜度（writer 无 today 参数）。
3. **Boost 批量事件**：把 "根 + 级联后代" 的 priority delta 转成逐 Topic SET_PRIORITY（或独立管理事件，见裁决 Q3）。
4. **状态操作宿主层**：COMPLETE/DISMISS/REACTIVATE 的逐 Topic 入口 + UI 日期选择 + 直写面收编。
5. **统一队列数据源**：`mf_*` → 队列/仪表盘/会话的读侧投影（含 `interval` 显示策略，见裁决 Q4）。
6. **迁移与模式 UI**：迁移预览/执行/备份入口、模式切换条件与诊断面板（生产激活仍锁定）。

### 2.4 文档滞后（本轮已按源码修正，实施时同步更新）

- `docs/P2-US1-1.0-CLOSURE.md:32-61` 仍称 postpone/schedule/setPriority BLOCKED、启动 recover 生效 —— 实际已接线且生产不执行 recover。
- `docs/MF-US-1-DELIVERY-MATRIX.md` 的 `TESTED` 多为纯算法/合成，`UI-01 NOT_STARTED` 与已接线入口混杂；
  同文件 MERCY 行标 `TESTED`，末尾却写 "Mercy 预览/撤销 NOT_STARTED"。
- `docs/P2-US1-HOST-ACTIONS-01.md:81` 仍写 boost/子树 "待后续"（子树已完成）。
- `docs/P2-US1-WRITE-01.md:23` 称 `spreadOverdue` 接 `unified-mercy-writer` —— 源码从未调用。

---

## 3. 真实入口审计矩阵（Legacy / Shadow / Unified）

记号：**H**=经 HostSchedulerService；**B**=绕过宿主直写；**—**=无写入。

| 入口（触发面） | 实现 | Legacy | Shadow | Unified | 风险 |
|---|---|---|---|---|---|
| 评阅 ADVANCED（菜单/Review 视图） | `_gradeTopic`→H | H（写 interval/next_review/a_factor） | H+观测（观测未接） | fail closed | Shadow 对照缺失 |
| COMPLETE（菜单） | `markDone`→H | H | H | fail closed（card 也会被误拒） | 描述符允许 card（`main.js:4645`） |
| COMPLETE（树 ✓、阅读条、Review、批量） | `markPathsDone` | **B** | **B** | **B（仍写 legacy）** | 绕过单写入者 |
| DISMISS（菜单） | `dismiss`→H | H | H | fail closed | — |
| DISMISS（树 ✕、阅读条非活动文件） | `dismissTreeNode`/直写 | **B** | **B** | **B** | 绕过 |
| REACTIVATE | 无宿主 | — | — | — | **1.0 缺失入口** |
| SKIP（阅读条/浮层/Review） | 仅会话指针（不写 events） | 无调度写 | 同 | 同 | 不产生 SKIP 事件、不 consume 会话项 |
| resetCurrent（菜单） | H `RESET_CURRENT` | H→`resetPaths` | H | `E_RESET_CURRENT_UNDECIDED` | 语义未裁决；菜单无 Notice |
| resetPaths（树 ↺、批量） | 直写 | **B** | **B** | **B（含卡片 SR 注释）** | 绕过 + SR 风险 |
| POSTPONE（菜单/阅读条/浮层） | `postponeFile`→H | H | H | fail closed | 已验收 |
| 子树延期（菜单） | 分流 | H legacy | H legacy | H 新链路（需 transport） | 非原子，已验收 |
| MANUAL_SCHEDULE（菜单/阅读条） | `scheduleFile`→H | H | H | fail closed | 已验收 |
| SET_PRIORITY（菜单/仪表盘/弹窗） | `setPriorityFile`→H | H | H | fail closed | 已验收 |
| Boost / 级联（菜单） | `boost()` 直写 | **B** | **B** | 早退阻断（无写入） | 无事件/账本；级联不跳 done/dismissed |
| Mercy（高级工具 `mercy()`） | 直写 | **B（不看 mode）** | **B** | **B（U 下仍写）** | 最严重：Unified 下仍重排 + 覆盖 interval |
| Mercy（仪表盘/自动过载 `spreadOverdue`） | H `MERCY_APPLY` | H legacy | H legacy | fail closed | 批量协议未接；异常可中断开始学习 |
| 新建 Source / 摘录 / 时间戳摘录 | H 创建网关 | H | H | 需 synthetic token，否则 fail closed | 新主题无 mf_id 时不可调度 |
| 划词摘录 / 图片摘录 | `_writeExtract` 直写 | **B** | **B** | **B** | 新摘录初始排期 + 父节点 reward 直写 |
| 导入剪藏 | 直写 | **B** | **B** | **B** | 可把 card 改写为 source |
| 拆分文章/书 | 直写 | **B** | **B** | **B** | 批量创建无账本；父 status/next_review |
| 检查点 / 父级 A-Factor 奖励 / 日期格式迁移 | 直写 | **B** | **B** | **B** | 绕过 + 不同步 mf_* |
| Card 评阅（SR） | SR 插件 | 不写 IR 字段 | 同 | 同 | 安全（除 COMPLETE/reset 的 SR 数据操作） |

**结论**：宿主链（门面/异步运行时/存储/账本/协调器）在 Mock 下闭环且**无 legacy 回退**；
但 Unified **不是全局写锁** —— 至少 13 条入口不看 mode，实测可绕过；模式本身不可达（无设置项）。

---

## 4. 全局接口依赖图

```
              ┌──────────────────────────────┐
              │ 共享契约层（主 Agent 冻结）    │
              │ event descriptor / mode /     │
              │ batch runner / queue source   │
              └───────────┬──────────────────┘
      ┌───────────────────┼────────────────────┐
      ▼                   ▼                    ▼
  Mercy 宿主层       状态/Boost 宿主层      Queue/Dashboard 数据源
 (batch host +      (COMPLETE/DISMISS/     (mf_* 投影、预算、
  batch store)       REACTIVATE/Boost)      explain、刷新)
      └───────────────────┼────────────────────┘
                          ▼
              主 Agent 集成（main.js / src/main.js /
              host-lifecycle / settings / views / docs）
                          ▼
              联合离线验收（Mock Vault + 故障注入 + 纵向链路）
```

硬依赖：共享契约 → 三个模块并行；模块接口稳定后 → 集成；集成后 → 联合 E2E。
反向依赖（阻塞）：Mercy 的真实 topic storage 与 batch store 必须先于 Mercy UI；
队列数据源必须与「单写入者退场」同步，否则出现读新写旧。

---

## 5. 多 Agent 职责与文件所有权

| 角色 | 负责 | 独占可写文件 | 交付方式 |
|---|---|---|---|
| **Lead / 集成 Agent** | 契约冻结、共享接线、最终集成、回归、文档 | `main.js`、`src/main.js`、`src/integration/host-*`、`host-lifecycle`、`host-scheduler-service`、`plugin-data-*`、`src/scheduling/index.js`、`src/ui/scheduler-dashboard-model.js`、`src/views/*`、`docs/*` | 直接提交集成分支 |
| **Mercy Agent** | Mercy 真实批次宿主层 + batch store + preview/confirm/apply/undo 编排 + 专项测试 | `src/scheduling/mercy*.js`、`unified-mercy-writer.js`、新增 `src/integration/mercy-batch-host.js`、`test/mf-us-1-mercy-host*.test.js` | 独立 worktree/分支，Commit + 测试报告；不改 main.js |
| **Actions Agent** | COMPLETE/DISMISS/REACTIVATE/Boost 的宿主层与批量协议 + 专项测试 | 新增 `src/integration/state-actions-host.js`、`boost-batch-host.js`、对应测试 | 独立 worktree/分支；不改 main.js |
| **Queue Agent** | Unified 队列/仪表盘/会话数据源与刷新 | 新增 `src/integration/unified-queue-source.js`、`src/ui/unified-*.js`、对应测试 | 独立 worktree/分支；不改 main.js |
| **Review Agent（可选）** | 集成后只读复核（契约一致性、Card、模式隔离） | 无写权限 | 报告 |

**硬规则**：
- 共享文件（上表 Lead 列）只有 Lead 能改；模块 Agent 若需要新增钩子，先在契约里提出，由 Lead 实现。
- 每个 Agent 的 worktree 与分支互不重叠；模块分支不改 `main.js`/`src/main.js`。
- 集成顺序固定：Mercy → Actions → Queue（Queue 最后，因为它要读其它两类产生的新字段/状态）。

---

## 6. 共享事件与状态数据契约（冻结）

### 6.1 模式与权威源

| 模式 | 权威写入 | 读源 | UI 允许 |
|---|---|---|---|
| Legacy | 旧字段（`next_review/interval/a_factor/review_count`） | 旧字段 | 现有行为 |
| Shadow | 旧字段（唯一写入）+ 只读观测 | 旧字段 | 不新增权威写；对照结果只诊断 |
| Unified | 仅 `mf_*`（加 `next_review` 兼容投影） | `mf_*`（缺失时经 legacy-adapter 只读映射，不写回） | 需 confirmed 结果 |

- 生产 Unified 继续锁定；所有模块只在注入的 synthetic transport 下测试。
- 任何入口在 Unified 下**不得**回退 Legacy Writer；不可用时 fail closed 并给出错误码。

### 6.2 事件

- 单 Topic 事件沿用 A8 事件类型 + `_mfUs1EventDescriptor`（含 eventId/expectedRevision/today/calendarDate）。
- `payload` 必须通过 `reading-integration.mapReadingAction` 的既有键；不新增第二张映射表。
- 批次（Mercy/Boost/子树）：**不新增批次事件类型、不新增批次 WAL**；
  - `batchId`（digest）仅用于报告/审计关联，不落盘为事务状态；
  - 每节点独立事件 + 独立账本记录；
  - 幂等由事件语义保证（POSTPONE 的 `max`；SET_PRIORITY 的同值 no-op；Mercy 的意图/确认绑定）。
- 若确需管理事件（如 MERCY_APPLY / RESET_CURRENT / BOOST），必须单独裁决（§10 Q3）。

### 6.3 批量执行协议（通用 runner）

`plan → verify(每节点) → run(逐节点, 串行) → aggregate → report`

- 计划阶段固定：节点集合、排序（stableId）、`today`、批次 id、跳过规则；
- 写前检查：重复 id（整批拒绝）、根 id 缺失（整批拒绝）、节点身份/关系（逐节点 blocked）；
- 结果状态：`applied / duplicate / no-op / skipped / blocked / conflict / failed / uncertain`
  （uncertain 吸收 requires-manual-recovery，但报告需保留原因）；
- 聚合：全 no-op → `no-op`；有成功+有问题 → `partial`；uncertain 必须突出；
  提示固定包含"非原子、已修改不回滚"；
- 恢复：不保存批次进度；重启后按节点账本 reconcile；重跑幂等。

### 6.4 UI 成功规则

仅 `applied / duplicate` 可显示成功；`no-op` 显示"无进一步变化"；`conflict / uncertain / failed / blocked`
显示对应错误且**不推进会话、不刷新为成功态**；Legacy 保留原有 Notice。

### 6.5 队列数据契约

规范 Topic 视图（只读投影）：`{type, status, priority, mf_ideal_due, mf_not_before, mf_revision, mf_scheduler_version, mf_interval_days, a_factor, review_count, mf_id, path}`。
- Unified 队列/仪表盘/会话只读该投影，再交给 `selectDailyQueue` / `buildDashboardModel`；
- 旧字段仅用于 Legacy 模式与迁移预览；
- 缺 `mf_*` 的旧笔记：只读映射（临时 id）用于展示，不进入 Unified 写入；需迁移后才能调度。
- `interval` 显示：仪表盘改读 `mf_interval_days`（推荐，无需写 interval），详见 Q4。

### 6.6 持久化

- 所有 data.json 写入经 coordinator；新批次存储必须是 coordinator 的保留键（新增键需 Lead 批准并登记所有权）。
- Intent 必须先 `verified` 落盘才允许 CAS（既有语义不变）。

---

## 7. 分阶段实施计划

| 阶段 | 内容 | 产出 | 并行度 |
|---|---|---|---|
| **P0 契约冻结**（Lead，1 轮） | 冻结 §6；建立三个模块的空接口 + 契约测试骨架；确定批次 runner 抽取方式 | `src/integration/batch-runner.js` 设计 + 契约测试 | 串行 |
| **P1 模块并行**（3 Agent） | Mercy 宿主层；状态/Boost 宿主层；Queue 数据源 | 各自分支 Commit + 专项测试 + 接口说明 | **3 路并行** |
| **P2 集成接线**（Lead） | main.js/src/main.js 路由、异步 transport/lifecycle/recover、模式 UI、迁移激活、单写入者退场、视图数据源 | 集成 Commit | 串行（依赖 P1） |
| **P3 联合验收**（Lead + Review） | Mock 纵向链路、故障注入、Card 隔离、模式隔离、重启恢复 | E2E 测试 + 报告 | 串行 |
| **P4 交付** | 回归、validate、build dry-run、PR | 1 个 PR（见 §11） | 串行 |

**实际可并行度评估**：3 个模块 Agent 真正独立（文件不重叠、接口在 P0 冻结）；D 类审计不单独设实现 Agent，
由 Lead 吸收为契约与集成检查。不建议再拆更多 Agent（共享文件冲突成本高于收益）。

---

## 8. 高风险宿主文件与理由

| 文件 | 计划修改 | 理由/风险 |
|---|---|---|
| `main.js` | 路由所有状态/Boost/Mercy/队列入口；接入 async lifecycle、模式 UI、迁移激活 | 上游高风险文件；入口多、回归面广 |
| `src/main.js` | 阅读条/覆盖层/Review/会话数据源；Mercy 直写面收编 | 同上 |
| `src/integration/host-lifecycle.js` | 传入真实 storage、触发 recover、暴露 blocked 诊断 | 影响启动行为，必须 fail-closed |
| `src/integration/host-async-runtime.js` | 仅在必要时加 batch 友好的恢复入口（不改锁语义） | 已验收模块，改动需最小化 |
| `src/scheduling/unified-mercy-writer.js` | 接入真实存储/批次存储；补 today 新鲜度 | 已验收协议，需谨慎扩展 |
| `src/integration/plugin-data-ledger-store.js` | 新增 Mercy 批次保留键的加载/校验/flush | 持久化边界 |
| `src/views/settings-tab.js`、`src/views/dashboard-view.js`、`src/views/review-view.js` | 模式/迁移/预算/Mercy UI；数据源 | UI 面广，需手工验收 |
| `src/scheduling/events.js` | **原则上不改**；仅当 Q3 裁决需要新管理事件时改动 | 核心状态机 |

---

## 9. 测试计划

- **模块级**（各 Agent）：接口契约测试 + 故障注入；不重复纯数学测试。
- **集成级**（Lead）：真实宿主入口 → descriptor → runtime → CAS → ledger → 重启恢复，全部 Mock。
- **安全失败矩阵**（每个至少一条从宿主入口开始的确定性测试）：
  Intent 保存失败零写；写后结果确认失败 → uncertain 且不显示成功；
  外部编辑/关系变化 → conflict 且不覆盖；重复 id → 整批拒绝；根缺 id → 整批拒绝；
  Card 永不进入；Legacy/Shadow/Unified 隔离；恢复后重跑 no-op；
  批次部分成功不谎报成功；data.json 损坏 fail closed。
- **联合 E2E**：Source → 多级 Extract → 统一队列 → 评阅/延期/优先级/子树/Mercy/完成/恢复 → 仪表盘。
- **构建**：`node --test test/*.test.js`、`validate-release.mjs`、`build.mjs --dry-run`；
  重新构建 `dist` 后才可做人工验收（当前 dist 过期）。

---

## 10. 需要项目负责人技术裁决（阻塞项）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| Q1 | Legacy Mercy 覆盖 `interval`（`main.js:4894`、`src/main.js:1103`）与 A7.2 冲突，但被回归测试固化为 0.1 行为 | (a) 保持 Legacy 原样、仅 Unified 合规；(b) 修 Legacy（回归测试需更新） | (a) 本阶段；Legacy 行为不改，但文档标注为已知偏差 |
| Q2 | Legacy COMPLETE 清 `next_review/interval` 并写 `last_reviewed`（`status-core.js:34-49`）与纯 COMPLETE 冲突 | (a) Legacy 保持；(b) 对齐 | (a)，但 Unified 必须走纯事件 |
| Q3 | `MERCY_APPLY` / `RESET_CURRENT` / Boost 批量不是 A8 事件 | (a) 保持"管理操作"，不进 events.js；(b) 新增事件类型 | (a) 复用批量 runner + 管理操作，不改 events.js；`RESET_CURRENT` 继续阻断，另行裁决 |
| Q4 | Unified 后 `interval` 不更新，仪表盘仍读 `interval` | (a) 仪表盘改读 `mf_interval_days`；(b) Writer 补写 interval | (a)：读侧切换，避免写非规范字段 |
| Q5 | 未迁移旧笔记（无 `mf_*`、inbox/pending/container）在 Unified 不可写 | (a) 迁移激活前置；(b) 运行时兼容映射 | (a)：Unified 只接受已迁移 `active`；迁移 UI 为激活前置 |
| Q6 | 13 条直写入口（划词/图片摘录、导入、拆分、检查点、A-Factor 奖励、日期迁移等）是否全部收编 | (a) 全部经 host；(b) 分批：本轮收编状态/优先级/队列相关，其余列 Phase 5 | (b)+明确清单；未收编的入口在 Unified 下直接阻断 |
| Q7 | 「更新路径」（Releases 检查/安装）属 Phase 6，不在 MF-US-1 宿主范围 | 确认排除 | 排除，但写入计划 backlog |

> 除上述裁决外，其余实现细节由 Lead 在共享契约内决定，不再逐项请示。

---

## 11. Git / 分支 / PR 组织

- **集成分支**：`feat/phase2-mf-us-1-host-closure`，worktree `memoflow-phase2-closure`（从 `a865a0e` 创建）。
- **模块分支**（各自 worktree，从同一基线）：
  - `feat/phase2-mf-us-1-mercy-host`
  - `feat/phase2-mf-us-1-state-actions-host`
  - `feat/phase2-mf-us-1-queue-source`
- 模块 Commit 由 Lead cherry-pick/合并到集成分支（不改写已推送历史）。
- **PR 组织**：**1 个 PR 到 main**，按 P0→P1→P2→P3 顺序提交（Commit 分段清晰）。
  仅在 Mercy 风险显著高于预期时，才拆成 2 个 PR（先基础接线、后 Mercy）。
- 计划文档本身：`docs/P2-US1-HOST-CLOSURE-PLAN.md`，独立提交到集成分支（本轮即可）。

---

## 12. 残余风险、离线不可验证项与验收标准

**残余风险**
1. 真实 Obsidian 的 `Vault.process`、MetadataCache 时序、`data.json` 耐久性均未实机验证。
2. 大数据量（数千 Topic、扫描回退 500 文件上限）性能未验证。
3. 旧库迁移后 `interval`/`next_review` 兼容投影的一致性需实机确认。
4. 多设备/同步盘并发不在单进程锁覆盖范围内。
5. Phase 1 仍在并行开发，集成时需 rebase 检查；`walkSubtree`、Phase 1 关系约定不得改。

**离线不可验证（需单独授权）**：生产 Unified 激活、真实库迁移、Obsidian 实机验收、Release 发布。

**验收标准（1.0 宿主闭环）**
1. 所有 Source/Extract 调度写入入口在 Unified 下**只有**单一 Writer（静态矩阵 + 动态测试双证）。
2. 真实 UI 的队列/仪表盘/会话在 Unified 下读 `mf_*`，与队列纯算法结果一致。
3. Mercy/Boost/状态操作具备 preview/失败/uncertain/部分成功/恢复语义，且 Card 零进入。
4. 重启恢复、模式切换、迁移激活、账本损坏诊断均可复现（Mock）。
5. 全量回归 + validate + build dry-run 通过；重新构建的 dist 可用于人工验收（实机阶段另批）。

---

# 实施进展（P0 → P2 第一轮）

> 本节记录实际落地内容；未完成项在末尾明确列出，不视为已验收。

## 已落地

### P0 共享契约（Lead）
- `src/integration/batch-runner.js`：批次 plan/校验/串行执行/八态汇总/报告；重复 id 整批拒绝。
- `src/integration/topic-projection.js`：唯一读侧投影（Unified 权威 `mf_*`、Legacy 只读映射、Card 不可写、done/dismissed 对 REACTIVATE 可读）。
- `src/integration/host-write-guard.js`：Unified 下残余旧写入的统一阻断（每功能只提示一次）。
- 契约测试 9 项。

### P1 三路并行（子 Agent 在独立 worktree 完成，Lead 集成）
| 模块 | 文件 | 测试 |
|---|---|---|
| Mercy 宿主编排 | `src/integration/mercy-host.js`（preview→confirm digest→apply→undo，intent 先行、final 失败降级 uncertain） | 14 |
| 状态/Boost | `src/integration/state-actions-host.js`、`boost-batch-host.js`（REACTIVATE 显式日期、SKIP 零写、Boost 目标绝对值防二次递减） | 34 |
| Unified 队列源 | `src/integration/unified-queue-source.js`（`mf_*` 权威、legacy 行诊断排除、预算/排序/会话投影/仪表盘模型） | 14 |

### P2 首轮集成（Lead）
- 12 条残余直写入口在 Unified 下被 guard 阻断（COMPLETE/RESET/DISMISS 直写面、检查点、A-Factor、摘录、导入、拆分、日期迁移、旧 Mercy 两链路）。
- onload 接通真实异步 lifecycle 与启动 `recover()`，暴露 `mfUs1Recovery`（blocked topics / healthy / recovered）。
- `buildDuePool` 在 Unified 下改用统一队列源（Card 仍走 SR 路径）；会话快照重读改用投影校验，不再用 `next_review`。
- 新增 REACTIVATE 宿主入口与菜单（Legacy 写 status/next_review；Unified 走 A4.3 事件，缺 transport 时失败关闭）。
- 新增只读诊断菜单（模式/写入锁定/账本健康/阻断 Topic/队列源）。
- `docs/P2-US1-HOST-CLOSURE-MATRIX.md`：25 条入口实时矩阵。

## 仍未完成（不视为已验收）

1. **Mercy 生产接线**：`mercy-host` 需要真实的逐 Topic `applyItem`（受保护 CAS）与持久 batch store；
   现有 PR-09 writer 只接受 synthetic storage。Unified 下 Mercy 目前被显式阻断。
2. **Boost Unified 执行**：`boost-batch-host` 就绪，但未接 `main.js`（缺少受保护逐 Topic 写入与 batch store 依赖注入）。
3. **COMPLETE/DISMISS 的 Unified 执行**：菜单入口仍 fail closed；直写面已阻断。需把状态操作统一到 `runStateAction` + 真实 transport。
4. **Dashboard 视图数据源**：队列/会话已切换；`src/views/dashboard-view.js` 与 `src/data/model.js` 仍读 legacy 字段
   （`buildUnifiedDashboardModel` 已就绪，尚未接 UI）。
5. **迁移激活 UI/命令、模式切换 UI、Shadow observer、账本诊断面板**：均未接线。
6. **交付矩阵文件**：尚未逐行更新（当前以 `HOST-CLOSURE-MATRIX.md` 为准）。

## 验证

```
node --test test/mf-us-1-host-contracts.test.js      9 pass
node --test test/mf-us-1-mercy-host.test.js         14 pass
node --test test/mf-us-1-state-actions.test.js      17 pass
node --test test/mf-us-1-boost-host.test.js         17 pass
node --test test/mf-us-1-unified-queue-source.test.js 14 pass
node --test test/mf-us-1-host-guards.test.js         6 pass
node --test test/mf-us-1-reactivate-host.test.js     4 pass
test/*.test.js                                      见最终交付报告
```

## 第二轮进展（执行链闭合）

- **共享基础设施**：`batch-store.js`（data.json 保留键 `mfUs1Batches`，经协调器原子合并）、
  `protected-topic-writer.js`（真实字节 CAS，只允许 `mf_not_before`+`mf_revision`，需宿主授权 token）。
- **Mercy**：`mercy()` 在 Unified 下走 preview→confirm→apply（受保护写入 + 批次记录），
  新增「撤销上次 Mercy」菜单；Legacy 原行为不变；无授权时零写入。
- **Boost**：`boost()` 在 Unified 下按 strict 子树规划绝对目标优先级，逐节点 SET_PRIORITY 事件，
  批次意图/结果落盘，重试不再二次递减；Legacy 原行为不变。
- **COMPLETE / DISMISS 直写面**：`markPathsDone` / `dismissTreeNode` 在 Unified 下改为逐项事件，
  Card 跳过；无授权时零写入。
- **REACTIVATE**：宿主入口 + 菜单（首轮已加），本轮验证与事件链路一致。
- **启动恢复**：真实异步 lifecycle 的 recover 已接入（首轮），本轮执行链复用同一 runtime。
- **facade 修复**：`host-scheduler-service` 原先在模式判断前强制要求 legacy 回调，
  导致 Unified 事件永远不可达；已改为仅在非 Unified 时要求。
- 回归：`1356 pass / 0 fail`；新增执行链测试 6 项、批次/写入器测试 6 项。

### 仍未完成
- Dashboard 视图数据源（`buildUnifiedDashboardModel` 未接 `dashboard-view`）。
- Mercy 的 Dashboard/自动过载入口（`spreadOverdue`）仍阻断。
- 检查点、划词/图片摘录、导入、拆分、A-Factor、日期迁移仍被 guard 阻断（需 1.0 决策）。
- 迁移激活 UI、模式切换 UI、Shadow observer、账本诊断面板。


## 第三轮进展（恢复与 Dashboard）

- **批次启动 reconcile**：`src/integration/batch-recovery.js`。启动顺序：单 Topic ledger recover → 扫描
  `mfUs1Batches` 未终结批次 → 以真实 Topic 状态（`mf_not_before` / `priority`）对照**持久绝对目标**判定
  每项 applied / pending / conflict / unknown → 仅持久化批次元数据并阻断冲突 Topic，**绝不写 Topic**。
  Boost 使用持久 `to` 值，不会按新当前值重算增量；Mercy 使用持久 `notBefore/currentNotBefore`。
  已接 onload，诊断菜单显示"批次恢复：检查 N · 需人工 M"。
- **Dashboard 数据源**：`src/data/model.js` 在 Unified 下改用 `buildUnifiedQueue`
  （`mf_*` 权威投影），Legacy/Shadow 保持原 selector。Card 计数继续走 SR。
- 新增测试：batch-recovery 7 项、dashboard-unified 3 项；全量 1366 pass。

### 仍未完成
- 剩余 guard 入口（reset/检查点/摘录/导入/拆分/A-Factor/日期迁移/Mercy 过载入口）。
- 迁移激活 UI、模式 UI、Shadow observer、账本诊断面板。
- 批次恢复的"安全重放"（当前只判定、不补写；需要授权后的显式恢复命令）。

## 第四轮进展（证据恢复、显式恢复命令、Dashboard View）

- **批次判定证据**：`reconcileBatches` 现在要求 `batch.results` 的 applied 记录（Mercy）或
  已确认的 Event Ledger 记录（Boost，`SET_PRIORITY` 且 `audit.after.priority === 目标`）才能判为 applied。
  仅"当前值恰好等于目标"→ `unknown / E_NO_LEDGER_EVIDENCE`（Mercy 为 `E_NO_BATCH_EVIDENCE`），
  保持人工恢复并阻断 Topic。
- **显式恢复**：`src/integration/batch-resume.js`（需 `issueSyntheticBatchResumeAuthorization()` 令牌）。
  Mercy 只补写仍等于 `currentNotBefore` 的项；Boost 使用持久绝对目标 `to`；已达标项不重写；
  结果落盘失败 → uncertain。菜单「Resume pending batches…」只有在 Unified 且持有授权令牌时才会真正写入。
- **Dashboard View**：新增真实 `MemoFlowDashboardView.refresh()` 测试（ui 渲染层打桩，模型/数据链路真实）：
  权威 `mf_ideal_due` 决定候选、优先级排序、外部写入后 refresh 反映新顺序、legacy 模式保持原队列。
- 测试：`1379 pass / 0 fail`（新增 batch-resume 5、dashboard-view 3、证据规则 2）。

### 仍需裁决（一次集中提出）

| # | 入口 | 原语义 | 影响 | 最小可行方案 |
|---|---|---|---|---|
| R1 | `resetPaths` / `resetCurrent` | 清空排期并恢复 active（卡片还清 SR 注释） | 会改写全部调度历史，无 A8 等价事件 | 定义为"管理/迁移操作"，在 Unified 下继续阻断，另起迁移流程（需产品裁决） |
| R2 | 父级 A-Factor bump | 建摘录后奖励父节点 | A3.4 未定义、属隐式调度写 | Unified 创建路径去掉 bump（需裁决是否保留 Legacy） |
| R3 | 检查点 | 写 `interval` + `next_review`（阅读元数据） | 不是 A8 事件，但会改调度字段 | 拆为"阅读位置元数据"（不写调度）或新增事件（需裁决） |
| R4 | Dashboard / 自动过载 Mercy | 直接摊平并覆盖 interval | 与 A7.2 冲突 | 接入统一 Mercy 前继续阻断；自动路径需显式确认 |
| R5 | 日期格式迁移 | 全库改写日期字段 | 与 `mf_*` 不同步 | 并入受控迁移流程，禁止直接运行 |
| R6 | 摘录创建/划词/图片/导入/拆分 | 创建文件与初始排期 | 非 A8 事件，但产生新 Topic | 复用创建网关（需支持真实 token 的授权路径），当前 Unified 阻断 |


## 第五轮进展（R1–R6 裁决实施）

| 裁决 | 实施结果 |
|---|---|
| R1 Reset | Unified 继续阻断（`resetPaths` guard / `resetCurrent` 显式错误），Legacy 不变；列为 1.0 待裁决功能。 |
| R2 父级 A-Factor | Unified 创建路径**直接跳过** bump（不再隐式写父级），Legacy/Shadow 不变。 |
| R3 Checkpoint | 仍阻断：该操作同时写 interval/a_factor/review_count，缺少规范事件映射；元数据拆分方案已记录，未实现。 |
| R4 Dashboard/自动 Mercy | Dashboard 过载入口改为 `mercyUnified({windowDays})`（preview→confirm→apply，受保护写入）；自动过载只发建议 Notice，绝不写。 |
| R5 日期迁移 | 仍阻断；纳入受控迁移流程的前置条件已记录，未实现迁移 UI。 |
| R6 创建入口 | 划词/图片摘录走创建网关：Unified 无 token 时 fail-closed（不再退回 Legacy 创建）；导入/拆分仍需接创建网关。 |

新增测试：R2/R4/R6 更新的 guard 行为、自动过载建议、Dashboard Mercy 路径、创建网关 fail-closed。


## 第六轮进展（最终入口与 Shadow）

- **R3 Checkpoint**：Unified 下只追加 `checkpoints` 阅读元数据；`Nd::` 间隔覆盖被拒绝；
  写入后校验 `mf_revision` 未变，若检测到并发调度修改则提示核对。
- **SKIP**：阅读条/浮层改为消费会话指针（`consumeSessionItem`）并进入下一项，零调度写。
- **Shadow observer**：`_mfUs1HostService` 注入只读 observer；Legacy 仍唯一 Writer，
  observer 用 legacy 字段映射 + `applyEvent` 计算差异，写入 `plugin.mfUs1ShadowLast`，
  失败包裹为 `not-comparable`，不写 Topic/Ledger。服务层对任意 legacy 结果都执行观察（只读）。
- 测试：`1384 pass`（新增 final-entries 5；更新 shadow/guard 契约 2）。

### 仍未完成
- 剪藏导入、文章拆分、书籍拆分接创建网关（当前 Unified 阻断）。
- 迁移预检/预览、模式切换 UI、Ledger/Batch 诊断面板。
- R1 Reset 与 R5 日期迁移保持阻断（已裁决为 Unified 1.0 不支持/并入迁移）。


## 第七轮进展（迁移预检 / 模式与诊断 UI）

- **迁移预检（只读）**：菜单「Migration preview (read-only)…」用 `previewMigration()` 生成
  只读计划（总数/可迁移/需人工/冲突/已迁移 + 示例），不写 Topic、不创建文件；
  结果缓存供诊断使用。
- **模式状态与安全切换**：菜单「MF-US-1 mode…」可在 Legacy/Shadow 间切换；
  选择 Unified 时先计算激活阻断项（transport/recovery/batch/migration/blocked topics），
  **永远拒绝并说明原因**，不发放 token，不绕过双重门禁。
- **诊断增强**：诊断菜单新增 Shadow 最近差异、迁移预检摘要。
- 测试：`1387 pass`（新增 migration-mode-ui 3）。

### 仍未完成（唯一代码缺口）
- 剪藏导入、文章拆分、书籍拆分仍未接创建网关（Unified 下继续阻断）。
  - 导入剪藏本质是"已有笔记的 Identity 迁移"，应按 R5 受控迁移流程处理，而不是创建网关。
  - 文章/书籍拆分需要把 legacy 拆分子笔记的内容构建接到创建网关（含 parent/source/root），未实现。


## 第八轮进展（三个剩余入口闭合）

- **文章/书籍拆分**：Unified 下子笔记全部经 `_mfUs1CreateSplitNote` → `_mfUs1CreateTopicFromHost` 创建；
  子 Source 获得 `mf_id`、`mf_root_id=自身`、`mf_revision=0`、`mf_scheduler_version`；正文与顺序保留；
  无授权时零创建并如实报告部分失败；已存在路径跳过（重复执行不重复创建）；
  父来源 `status=container` 在 Unified 不直接改写（Legacy 保持）。
- **剪藏导入**：核实其为"已有笔记原地身份接管"，Unified 明确阻断并指向迁移工具，
  不隐式迁移、不先 Legacy 建后补 ID。
- **创建网关**：Source 创建时补 `mf_root_id = mf_id`，修复 standalone source 根关系。
- 测试：`1393 pass`（新增 split-import 6：未授权零写、文章拆分身份、重复执行、Legacy 回归、导入阻断、书籍拆分身份/根）。

## PR #38 审查修复（相对 7bcd40f）

1. **Resume 证据规则**：`batch-resume.js` 对"当前值=目标值"的节点不再直接 applied；
   Mercy 需 `batch.results` applied 证据，Boost 需本批次归属的 Ledger 证据；缺失 → uncertain + `E_NO_*_EVIDENCE`，
   零 Topic 写入且不持久化成功；pending 项恢复时携带原始 revision 供受保护写入 CAS。
2. **Boost Ledger 归属**：`hasLedgerEvidence` 要求 `type=SET_PRIORITY`、`status=applied`、
   `after.priority=持久目标`，且 `eventId` 属于批次记录的 `eventIds`（apply 时持久化）；
   无关 ADVANCED / 无关批次 SET_PRIORITY 均判 unknown。
3. **Mercy Undo Revision**：Apply 成功时把每项写入后的 `mf_revision` 持久化到批次记录 `revisions`；
   Undo 用该 revision 做真实 CAS，外部调度写入（revision 变、not_before 未变）→ conflict 零写入；
   缺证据的旧批次拒绝 Undo。
4. **拆分身份校验**：目标路径已存在时，只有具备 `mf_id` + `type=source` + `parent` 指向当前父级的文件
   才视为本次创建结果；否则 `E_IDENTITY_CONFLICT`，不添加链接、不静默跳过。splitBook 同步处理。
