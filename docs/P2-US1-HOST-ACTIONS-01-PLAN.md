# P2-US1-HOST-ACTIONS-01 — 三操作宿主接线：只读入口审查与实施方案

- 基线：`personal/main @ 12c2bcd`（PR #35 已合并；`a32ced1` 为祖先）
- 拟用分支 / worktree（已创建，暂无业务代码提交）：`feat/phase2-mf-us-1-host-actions` / `memoflow-phase2-actions`
- 本轮：**只读审查 + 实施方案**，未改业务代码
- Phase 1 工作区（`memoflow`）未访问、未修改

---

## 1. 入口矩阵（实际源码）

`✅` = 已过 HostSchedulerService；`❌` = 直接写 Frontmatter，绕过 Runtime。

### 1.1 POSTPONE

| # | 用户面 | 调用链 | 写入 | 走 Runtime | 说明 |
|---|---|---|---|---|---|
| P1 | 命令 `current-actions` → 菜单「Postpone」 | `currentElementActions()` → `postpone()` → `_mfUs1RunLegacy('POSTPONE', …)` | Legacy: `next_review` + `interval` | ✅ | 但 Unified 目前 fail-closed |
| P2 | 中文菜单（`src/main.js:165`） | 同上 | 同上 | ✅ | |
| P3 | 阅读操作条「延后」按钮（md 视图） | `_openReadingPopover({delayOnly:true})` → 1/3/7 天 → `_runReadingAction('postpone')` | `_postponeReadingFile`：直接 `processFrontMatter(next_review, interval)` | ❌ | **主要使用面绕过** |
| P4 | 右键/更多菜单（popover）「延后 N 天」 | 同 P3 | 同上 | ❌ | |
| P5 | PDF 阅读条「更多」→ popover | 同 P3 | 同上 | ❌ | |
| P6 | `postponeSubtree` | 独立（子树延期） | 批量 | ✅（Legacy 包装） | 属下一阶段 |

### 1.2 MANUAL_SCHEDULE

| # | 用户面 | 调用链 | 写入 | 走 Runtime | 说明 |
|---|---|---|---|---|---|
| S1 | 菜单「Schedule (manual date)」 | `schedule()` → `_mfUs1RunLegacy('MANUAL_SCHEDULE', …)` | Legacy: `next_review` + 重算 `interval` | ✅ | Unified fail-closed |
| S2 | 中文菜单 | 同上 | 同上 | ✅ | |
| S3 | 阅读操作条 / popover | **不存在手动排期入口** | — | — | 功能缺口，不是绕过 |
| S4 | Dashboard | **不存在** | — | — | |
| S5 | `resetCurrent` | 独立 | 重置 | 显式阻断 | 不映射为 MANUAL_SCHEDULE（正确） |

### 1.3 SET_PRIORITY

| # | 用户面 | 调用链 | 写入 | 走 Runtime | 说明 |
|---|---|---|---|---|---|
| R1 | 菜单「Set priority」 | `setPriority()` → `_mfUs1RunLegacy('SET_PRIORITY', …)` | Legacy: `priority` | ✅ | |
| R2 | 阅读条 P 徽标按钮（`src/main.js:679`） | `openPriorityDialog(file)` | `processFrontMatter(priority[, boost_from])` | ❌ | **绕过** |
| R3 | popover「设置优先级…」（`src/main.js:471`） | `openPriorityDialog(file)` | 同上 | ❌ | |
| R4 | Dashboard 队列行「queue-priority」（`dashboard-view.js:191`） | `plugin.openPriorityDialog(file, {onApplied})` | 同上 | ❌ | **Dashboard 唯一优先级入口** |
| R5 | 菜单「Boost priority」/ 级联子树（`main.js:4613`） | `boost()` 直接 `processFrontMatter` 逐节点 | `priority` | ❌ | 批量增量语义，非 A5.4 单点 |

---

## 2. 与 MF-US-1 事件语义的冲突

### POSTPONE（A5.2）

`mf_not_before = max(mf_not_before?, mf_ideal_due, today+N)`；只改行政限制与版本；**不改**间隔、A-Factor、评阅次数、`mf_ideal_due`；不得提前已有延期。

- Legacy 入口（P1/P2 的 `_postponeLegacyWrite` 与 P3 的 `_postponeReadingFile`）都写 `interval = N` —— **直接违反 A5.2**（间隔被延期值覆盖）。
- 两者都写 `next_review`（兼容字段），而不是 `mf_not_before`。
- 没有任何"未进一步推迟"的反馈。

### MANUAL_SCHEDULE（A5.3）

写 `mf_ideal_due`；清除不再适用的 `mf_not_before`；保留间隔与评阅次数；记录人工覆盖原因；不视为有效评阅。

- Legacy `_scheduleLegacyWrite` 用「目标日期 − 今天」**重算 interval** —— 违反"保留真实学习间隔"。
- 没有 `mf_not_before` 清除、没有原因记录（Legacy 无字段）。
- `resetCurrent` 未被错误映射（保持阻断）。

### SET_PRIORITY（A5.4）

改 1–100 的 Priority；立即影响队列；不改间隔、A-Factor、到期日。

- `openPriorityDialog` 直接写 `priority`（+ `boost_from` 兼容字段）并手动改 `fm.priority` 让 UI 立刻刷新 —— 绕过了 Runtime，也没有 revision/ledger 记录。
- 队列/仪表盘读取的是 `metadataCache`，绕过写入时不会留下 `mf_revision`/`mf_last_event_id`，Unified 下会造成"界面已变、权威状态未变"。
- `boost()` 是批量增量语义（A5.4 未定义），本轮不复用它。

---

## 3. 可直接复用的模块

| 模块 | 复用方式 |
|---|---|
| `src/integration/host-scheduler-service.js` | 三个动作的统一入口（已有，含 eventId 指纹与 in-flight 冲突检测） |
| `main.js#_mfUs1EventDescriptor` | 生成显式 eventId / expectedRevision / today / calendarDate |
| `main.js#_mfUs1RunLegacy` / `_mfUs1HostService` | Legacy/Shadow/Unified 路由，Unified 走注入的异步 transport |
| `src/scheduling/reading-integration.js` | `mapReadingAction()` 已有 postpone / set-priority / manual-schedule 的 payload 映射，可对齐（不再新建映射表） |
| `applyEvent`（A5.2/A5.3/A5.4 已实现） | Unified 语义唯一权威，不重写 |
| `host-async-runtime` / ledger / coordinator | 已验收，不改 |

---

## 4. 建议的新增/修改文件

### 4.1 新增（1）

`src/integration/reading-actions-host.js`：

```js
applyPostpone({ run, file, fm, days, today })
applyManualSchedule({ run, file, fm, idealDue, reason, today })
applySetPriority({ run, file, fm, priority, today })
// run = (descriptor, legacyCallback) => outcome   // 由 main.js 注入 _mfUs1RunLegacy
// 返回 { status, reason, message, writesPerformed }，含 UI 文案映射
```

职责：构造 descriptor（唯一 eventId、expectedRevision、本地日历日）、调用注入的 `run`、
把 applied / duplicate / conflict / uncertain / failed 映射为可直接展示的结果。
**不写 Frontmatter，不做算法。**

### 4.2 修改 `main.js`（高风险，需单独批准）

| # | 函数 | 最小改动 | 理由 |
|---|---|---|---|
| A1 | `_postponeReadingFile`（`src/main.js:403`） | 改为调用新的 `postponeFile(file, days)` | 消除 P3–P5 绕过 |
| A2 | `openPriorityDialog().onApply`（`src/main.js:994-1010`） | 改为调用 `setPriorityFile(file, next, { boostFrom })` | 消除 R2–R4 绕过 |
| A3 | 新增 `postponeFile / scheduleFile / setPriorityFile`（root `main.js`） | 程序化入口：build descriptor → `_mfUs1RunLegacy(descriptor, legacyWriter)`；Legacy 分支**复用现有 `_*LegacyWrite`**，保证 Legacy 输出不变 | 提供非交互入口给 popover/dashboard |
| A4 | `postpone() / schedule() / setPriority()` | 收集参数后转调 A3，去掉重复的 descriptor 构造 | 单一事件构造点，避免两套 fingerprint |
| A5 | `boost()`（`main.js:4613`） | Unified 模式下显式阻断（`E_BOOST_REQUIRES_BATCH_EVENTS`），Legacy 不变 | 防止批量增量写入继续绕过单一 Writer |

约 80–110 行，集中在上述 5 处；不触碰调度公式、SR、Phase 1、Mercy。

### 4.3 是否必须改 `main.js`

**是。** P3–P5 与 R2–R4 是用户实际点击的主要面（阅读条延后按钮、P 徽标、Dashboard 优先级），
它们直接 `processFrontMatter`，HostSchedulerService 拿不到事件。若不改，Unified 下这三处仍是双写。

---

## 5. 行为契约（实施后）

| 动作 | Legacy（默认，不变） | Unified（仍不可用于生产） |
|---|---|---|
| POSTPONE | 现有 `next_review + interval`（保持 0.1 行为） | A5.2：只写 `mf_not_before`，间隔/A-Factor/评阅次数/`mf_ideal_due` 不变；无进一步推迟时返回提示 |
| MANUAL_SCHEDULE | 现有 `next_review` + 重算 interval | A5.3：写 `mf_ideal_due`、清 `mf_not_before`、保留间隔/评阅次数、原因入 ledger audit |
| SET_PRIORITY | 现有 `priority`（+`boost_from`） | A5.4：写 `priority`，不动间隔/A-Factor/到期日 |

UI 只在 `applied / duplicate / no-op` 显示成功；`conflict` 提示刷新；`uncertain` 明确"结果未确认，
请核对"；`failed` 显示原因。Legacy 保留原 Notice。

---

## 6. 离线集成测试计划（12 项）

1. 阅读条「延后」popover → 真实 `_runReadingAction` → descriptor → Unified 应用；断言 `mf_not_before` 正确，`mf_interval_days / a_factor / review_count / mf_ideal_due / last_reviewed` 不变。
2. 菜单 `postpone()` 走同一条 descriptor 路径（同一 eventId 重放 → duplicate）。
3. 手动排期（程序化入口）→ `mf_ideal_due` 更新、`mf_not_before` 清空、间隔保留、ledger `reason` 记录。
4. Dashboard `queue-priority` → `openPriorityDialog` → Unified SET_PRIORITY；断言 priority 生效、其余调度字段不变，且次日队列排序按新 P 变化。
5. Source 与 Extract 各跑一遍上述三类。
6. 同一 eventId 重复提交 → duplicate，`review_count` 不增。
7. Revision 冲突 / 外部编辑 → conflict，文件不被覆盖。
8. Intent 保存失败 → 返回 failed、零字节变化（复用 coordinator 故障注入）。
9. 写成功但结果确认失败 → uncertain，UI 不显示成功。
10. 模拟重启后 recover → applied，`review_count` 不重复。
11. Legacy / Shadow / Unified 隔离：Legacy 仍写旧字段；Shadow 只比较不写；Unified 不调用 Legacy Writer。
12. Card：`_runReadingAction` 对 card 的 postpone/priority 入口仍不进入 MF-US-1（SR 不受影响）。

全部使用 Mock Obsidian + 合成 Topic + 隔离 data store；无真实 Vault。

---

## 7. 本阶段完成后仍未接线的入口

- `postponeSubtree`（子树批量延期，需逐 Topic 事件与部分成功）。
- Mercy Preview / Confirm / Apply / Undo 宿主入口。
- Dashboard / 队列的「延后」「排期」快捷按钮（当前不存在，属新 UI，不在本阶段）。
- `boost()` 批量优先级（需要批量事件协议）。
- `resetCurrent` 语义（仍显式阻断）。
- 每日队列 / Dashboard 的 Unified 数据源切换。

---

## 8. 请你裁决

1. **批准 A1–A5 的 `main.js` / `src/main.js` 修改**（约 80–110 行，5 处）。
2. **Boost 策略**：本阶段选择"Unified 下显式阻断、Legacy 不变"（推荐），还是要求本轮把 boost 拆成批量 SET_PRIORITY 事件（工作量明显更大）。
3. **popover 是否补「手动排期」入口**：当前阅读条只有延后，没有排期；补入口属于新 UI，可与本阶段一起做或留待 UI 阶段。

## 9. 安全边界

未改业务代码；未启用 Unified；未访问真实 Vault / `MemoFlow-Test` / `phase2 test`；未启动 Obsidian；
未迁移；未创建 PR/Merge；Phase 1 未触碰。
