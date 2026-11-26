# P2-US1-HOST-CLOSURE — 残余调度写入入口矩阵（实时快照）

> 基线：`a865a0e` + HOST-CLOSURE 集成分支。状态以源码为准；本表随实施更新。
> 记号：**H**=HostSchedulerService；**G**=Unified 下 guard 阻断（旧写入不执行）；**open**=尚未收编。

| # | 入口 | 触发面 | 处置 | Legacy | Shadow | Unified | 证据 |
|---:|---|---|---|---|---|---|---|
| 1 | ADVANCED 评阅 | 菜单/Review | H | 旧写 | H+观测 | fail closed | `_gradeTopic` |
| 2 | POSTPONE | 菜单/阅读条/浮层 | H | 旧写 | H | fail closed | `postponeFile` |
| 3 | MANUAL_SCHEDULE | 菜单/阅读条 | H | 旧写 | H | fail closed | `scheduleFile` |
| 4 | SET_PRIORITY | 菜单/仪表盘/弹窗 | H | 旧写 | H | fail closed | `setPriorityFile` |
| 5 | 子树 POSTPONE | 高级菜单 | H（分流） | 旧写 | H（legacy） | 逐节点事件 | `postponeSubtreeHost` |
| 6 | COMPLETE（菜单） | 菜单 | H | 旧写 | H | fail closed | `markDone` |
| 7 | COMPLETE（树/阅读条/Review/批量） | 多处 | **G** | 旧写 | 旧写 | 阻断 | `markPathsDone` |
| 8 | DISMISS（菜单） | 菜单 | H | 旧写 | H | fail closed | `dismiss` |
| 9 | DISMISS（树/阅读条非活动） | 树/阅读条 | **G** | 旧写 | 旧写 | 阻断 | `dismissTreeNode` |
| 10 | RESET（菜单） | 菜单 | 显式阻断 | 旧写 | H | `E_RESET_CURRENT_UNDECIDED` | `resetCurrent` |
| 11 | RESET（树/批量） | 树 | **G** | 旧写 | 旧写 | 阻断 | `resetPaths` |
| 12 | Boost / 级联 | 菜单 | **G** + 旧实现保留 | 旧写 | 旧写 | 阻断（E_BOOST_REQUIRES_BATCH_EVENTS） | `boost` |
| 13 | Mercy（旧菜单） | 高级菜单 | **G** | 旧写 | 旧写 | 阻断 | `mercy` |
| 14 | Mercy（仪表盘/自动） | 仪表盘/自动 | **G** | 旧写 | 旧写 | 阻断（返回 blocked） | `spreadOverdue` |
| 15 | 检查点 | 菜单/仪表盘组件 | **G** | 旧写 | 旧写 | 阻断 | `addCheckpoint` |
| 16 | 划词摘录 | 命令 | **G** | 旧写 | 旧写 | 阻断 | `extractSelection` |
| 17 | 图片摘录 | 采集菜单 | **G** | 旧写 | 旧写 | 阻断 | `imageExtractClipboard` |
| 18 | 导入剪藏 | 高级菜单 | **G** | 旧写 | 旧写 | 阻断 | `importClipping` |
| 19 | 拆分文章/书 | 高级菜单 | **G** | 旧写 | 旧写 | 阻断 | `splitArticle`/`splitBook` |
| 20 | 父级 A-Factor 奖励 | 建摘录内部 | **G** | 旧写 | 旧写 | 阻断 | `_bumpAFactor` |
| 21 | 日期格式迁移 | 设置页 | **G** | 旧写 | 旧写 | 阻断 | `migrateDateFormat` |
| 22 | REACTIVATE | 无 UI | **open** | — | — | — | 缺宿主入口 |
| 23 | SKIP | 阅读条/Review | open（无事件） | 无写 | 无写 | 无写 | 会话指针 |
| 24 | 新建 Source/摘录 | 采集/命令 | H（创建网关） | 旧建 | 旧建 | synthetic token 才创建 | `topic-creation-host` |
| 25 | Card 评阅 | SR | 不涉及 | SR | SR | SR | SR 独立 |

## 说明

- **G** 表示 Unified 模式下旧写入被 `_mfUs1GuardLegacyWrite()` 阻断（首次提示，后续静默）；
  Legacy/Shadow 行为不变。这是安全兜底，**不是 1.0 最终形态**：对应能力仍须在后续实现为
  统一事件（第 7/9/11/12/15/16/17/18/19/20/21 条）。
- 第 13/14 条 Mercy 的宿主化（preview/confirm/apply/undo）为独立模块开发目标；
  在完成前，Unified 下保持阻断，避免污染 interval。
- 第 22 条 REACTIVATE 为 1.0 必需入口，当前缺失。
- 第 23 条 SKIP 只影响会话，不产生调度写入；会话指针记录仍待接线。
- 生产 Unified 仍双重门禁锁定；本表不含生产激活。
