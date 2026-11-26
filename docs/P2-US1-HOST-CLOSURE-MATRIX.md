# P2-US1-HOST-CLOSURE — 残余调度写入入口矩阵

> 基线：`a865a0e` + HOST-CLOSURE 分支（`e711df3` P0、`ea9bf77` 首轮、本轮执行链）。
> 编号共 **26 条**（此前报告写 25，为漏计 `Dashboard/队列数据源` 一条；已修正）。
> 记号：**H**=HostSchedulerService（含 Unified 事件）；**B**=批次执行（batch-runner + 受保护写入或事件）；
> **G**=Unified 下 guard 阻断；**open**=未收编；**blocked**=显式阻断。

| # | 源码入口 | Legacy | Shadow | Unified | 处置 | 负责人 | 测试 | UI→Runtime E2E | 1.0 阻塞 |
|---:|---|---|---|---|---|---|---|---|---|
| 1 | `_gradeTopic` | 旧评阅 | 旧写+观测 | 事件 | H | Lead | host-actions | 部分（宿主入口） | 否 |
| 2 | `postponeFile` | 旧写 | 旧写 | 事件 | H | Lead | host-actions | 是 | 否 |
| 3 | `scheduleFile` | 旧写 | 旧写 | 事件 | H | Lead | host-actions | 是 | 否 |
| 4 | `setPriorityFile` | 旧写 | 旧写 | 事件 | H | Lead | host-actions | 是 | 否 |
| 5 | `postponeSubtreeHost` | 旧写 | 旧写 | 逐节点事件 | H | Lead | host-subtree | 是 | 否 |
| 6 | `markDone`（菜单） | 旧写 | 旧写 | 事件 | H | Lead | host-wiring | 否 | 否 |
| 7 | `markPathsDone`（树/阅读条/Review/批量） | 旧写 | 旧写 | 逐项 COMPLETE 事件 | B | Lead | host-execution | 是 | 否 |
| 8 | `dismiss`（菜单） | 旧写 | 旧写 | 事件 | H | Lead | host-wiring | 否 | 否 |
| 9 | `dismissTreeNode`（树） | 旧写 | 旧写 | DISMISS 事件 | B | Lead | host-execution | 是 | 否 |
| 10 | `resetCurrent`（菜单） | 旧写 | 旧写 | 显式阻断 | blocked | Lead | host-service | — | 是（语义待裁决） |
| 11 | `resetPaths`（树/批量） | 旧写 | 旧写 | guard 阻断（R1：Unified 不支持） | G | Lead | host-guards | — | 是 |
| 12 | `boost`（含级联） | 旧写 | 旧写 | 批量 SET_PRIORITY | B | Lead | host-execution / boost-host | 是 | 否 |
| 13 | `mercy`（菜单） | 旧写 | 旧写 | preview→confirm→apply（unified） | B | Lead | host-execution / mercy-host | 是 | 否 |
| 14 | `spreadOverdue` / 自动过载 | 旧写 | 旧写 | Dashboard → 统一 Mercy（需确认）；自动仅建议 | H | Lead | host-guards / mercy-host | 是 | 否 |
| 15 | `addCheckpoint` | 旧写 | 旧写 | R3：仅阅读元数据（调度不写） | H | Lead | final-entries | 是 | 否 |
| 16 | `extractSelection` | 旧写 | 旧写 | 创建网关（无授权 fail-closed） | H | Lead | host-guards / creation | 是 | 否 |
| 17 | `imageExtractClipboard` | 旧写 | 旧写 | 创建网关（无授权 fail-closed） | H | Lead | host-guards / creation | 是 | 否 |
| 18 | `importClipping` | 原地改写 | 原地改写 | Unified 明确阻断：已有笔记身份迁移归迁移工具 | 独立处理 | Lead | split-import | 是 | 否（迁移域） |
| 19 | `splitArticle` / `splitBook` | 旧建 | 旧建 | 创建网关（mf_id/root，需授权） | H | Lead | split-import | 是 | 否 |
| 20 | `_bumpAFactor` | 旧写 | 旧写 | R2：Unified 直接跳过（不奖励父级） | 独立处理 | Lead | host-guards | 是 | 否 |
| 21 | `migrateDateFormat` | 旧写 | 旧写 | guard（R5：并入迁移流程，未实现） | G | Lead | host-guards | — | 是 |
| 22 | `reactivateCurrent`（新增） | 新写 status/next_review | 同 Legacy | REACTIVATE 事件 | H | Lead | reactivate-host | 是 | 否 |
| 23 | SKIP（阅读条/Review） | 仅会话 | 仅会话 | 消费会话指针，零调度写 | H | Lead | final-entries | 是 | 否 |
| 24 | 新建 Source / 摘录 | 旧建 | 旧建 | 创建网关（synthetic token） | H | Lead | creation-host | 部分 | 否 |
| 25 | Card 评阅（SR） | SR | SR | SR | 不涉及 | — | sr-boundary | — | 否 |
| 26 | Dashboard / 队列 / Session 数据源 | legacy 字段 | legacy 字段 | 全部切权威投影（Dashboard 模型已用 `buildUnifiedQueue`） | H | Lead | dashboard-unified / host-execution | 是（Dashboard 模型 + 会话） | 否 |

## 累计

- 已接线/批次执行：**20**（1–9、12–17、19、22–24、26）
- 独立安全处理：**2**（18 导入=迁移域、20 A-Factor 跳过）
- Unified 阻断：**3**（10 resetCurrent、11 resetPaths 已裁决不支持；21 日期迁移归迁移工具）
- 不涉及：1（25）

> 26 条入口全部有唯一最终状态，无"仅 Guard 却标完成"的必需创建流程。

> Shadow observer（只读对照）已接线，属生命周期能力，不在入口计数内。

> 批次启动 reconcile（`batch-recovery.js`）是生命周期能力，不在入口计数内。

## 说明

- `G` 是安全兜底，不是 1.0 终态；对应入口仍需以统一事件或受保护写入恢复功能。
- Mercy 的 Dashboard 过载入口（14）尚未接入新批次执行；菜单入口（13）已接。
- Dashboard 视图（26）仍需切换到 `buildUnifiedDashboardModel`；会话队列已切。


## 迁移/模式 UI（第七轮）

- 迁移预检：`mfUs1MigrationPreview()`（只读计划，`previewMigration`）。
- 模式切换：`mfUs1ModeMenu()`（Legacy/Shadow 可切；Unified 仅显示阻断原因，fail-closed）。
- 诊断：`mfUs1Diagnostics()` 增加 Shadow 差异与迁移预检摘要。
- 仍未接线：`importClipping`（Identity 迁移类）、`splitArticle` / `splitBook`（创建网关类）。
