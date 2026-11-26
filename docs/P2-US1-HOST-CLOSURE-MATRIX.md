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
| 11 | `resetPaths`（树/批量） | 旧写 | 旧写 | guard 阻断 | G | Lead | host-guards | — | 是 |
| 12 | `boost`（含级联） | 旧写 | 旧写 | 批量 SET_PRIORITY | B | Lead | host-execution / boost-host | 是 | 否 |
| 13 | `mercy`（菜单） | 旧写 | 旧写 | preview→confirm→apply（unified） | B | Lead | host-execution / mercy-host | 是 | 否 |
| 14 | `spreadOverdue` / 自动过载 | 旧写 | 旧写 | 阻断（待接统一 Mercy） | G | Lead | host-guards | — | 是 |
| 15 | `addCheckpoint` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 16 | `extractSelection` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 17 | `imageExtractClipboard` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 18 | `importClipping` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 19 | `splitArticle` / `splitBook` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 20 | `_bumpAFactor` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 21 | `migrateDateFormat` | 旧写 | 旧写 | guard | G | Lead | host-guards | — | 是 |
| 22 | `reactivateCurrent`（新增） | 新写 status/next_review | 同 Legacy | REACTIVATE 事件 | H | Lead | reactivate-host | 是 | 否 |
| 23 | SKIP（阅读条/Review） | 仅会话 | 仅会话 | 仅会话（无事件） | open | Lead | — | 否 | 是（会话指针） |
| 24 | 新建 Source / 摘录 | 旧建 | 旧建 | 创建网关（synthetic token） | H | Lead | creation-host | 部分 | 否 |
| 25 | Card 评阅（SR） | SR | SR | SR | 不涉及 | — | sr-boundary | — | 否 |
| 26 | Dashboard / 队列 / Session 数据源 | legacy 字段 | legacy 字段 | 队列+会话已切权威投影；Dashboard 视图仍 legacy | 部分 | Lead | unified-queue-source / host-execution | 会话是，Dashboard 否 | 是 |

## 累计

- 已接线/批次执行：**13**（1–9、12、13、22、24）
- Unified 阻断待收编：**9**（10、11、14–21，其中 10 为显式语义阻断）
- 部分完成：**2**（23、26）
- 不涉及：1（25）

## 说明

- `G` 是安全兜底，不是 1.0 终态；对应入口仍需以统一事件或受保护写入恢复功能。
- Mercy 的 Dashboard 过载入口（14）尚未接入新批次执行；菜单入口（13）已接。
- Dashboard 视图（26）仍需切换到 `buildUnifiedDashboardModel`；会话队列已切。
