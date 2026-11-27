# P4-UIUX-INTEGRATION-01 — 跨 Phase UI/UX 审计

基线：`personal/main = 460d54f`（PR #41 已合并，`757f634` 在主线）
分支：`feat/p4-uiux-integration`
方法：源码入口盘点 + 既有自动化测试 + 正式构建真实 Obsidian 工作流。未重写 Scheduler/Runtime/Phase 1/SR。

## 1. 入口盘点（源码位置：`main.js`）

| 功能 | 入口 |
|---|---|
| Source/Extract 创建 | 命令 `capture-more` (`captureOrCreate`)、`extract-selection`、Toolkit 菜单 |
| 多级阅读树 | `KnowledgeTreeView`、`ir-tree-view` / sidebar、`_activateKnowledgeTree*` |
| 阅读评阅 | `end-session` (`gradeCurrent`)、Queue `Next`、`build-session-queue` |
| Postpone / Schedule / Priority / Complete / Dismiss / Reactivate | `current-actions`（`currentElementActions`）、Advanced tools「Reactivate current…」、行内操作函数 `postponeFile`/`setPriorityFile`/`completeCurrent`/`dismissCurrent` |
| Boost / Mercy / Subtree | `boost`（无独立命令，读命令/菜单经 `advancedTools` 内 Mercy/Subtree）；Mercy Apply/Undo、`postponeSubtreeHost`、`mercyUndoLast` |
| Queue / Dashboard / Session | `IRQueueView`、`MainDashboardView`、`buildSessionQueue`、`nextElement`、`openDashboard`/`openToolkitView` |
| 模式/激活/撤销 | 设置页 Unified 区（**P4 新增**）、Advanced tools「MF-US-1 模式切换…」、`mfUs1ProductionActivate/Revoke` |
| Card/SR | `flashcard-clipboard`、`seedInlineCards`、`migrateLegacyCards`、Dashboard stats |
| 设置页 | `IncrementalReadingSettingTab`（About/Scheduling/Queue/Inline cards/SR/Tree/Paths/Misc + **Unified Scheduler 区**） |

## 2. 审计发现

### P0
- 无（未发现数据损坏/双写/错误授权/错误显示成功）。

### P1（已修复）
1. **Unified 激活入口重复且设置页缺失**：Advanced tools 原同时有「MF-US-1 mode…」「激活 Unified」「暂停/撤销」三项，设置页却无任何 Unified 状态/入口；用户无法在设置中查看阻断原因。
   - 修复：设置页新增「Unified Scheduler (MF-US-1)」区（模式、本次会话授权/暂停、Topic/旧格式/索引完整性、阻断项、激活/撤销/刷新按钮、重启需重新确认与旧库迁移边界提示）；Advanced tools 收敛为单一「MF-US-1 模式切换…（Unified 需在设置中确认激活）」+ 诊断，删除重复的激活/撤销项。
2. **授权/模式变更后界面不刷新**：激活、撤销、Legacy/Shadow 切换只发 Notice，不刷新 Queue/Tree/Excerpt 视图，Dashboard 与队列可能显示旧状态。
   - 修复：以上三处成功后调用 `_refreshExcerptViews()` 与 `_refreshTreeViews()`。
3. **Unified 阻断原因不可见**：阻断项只在命令执行时 Notice 出现。设置页现在常驻显示 `activationBlockers`、索引完整性、旧格式 Topic 数，便于用户处理。
4. **模式菜单文案误导**：``Unified（需要激活条件）`` 改为 ``Unified（需确认激活）``，与正式确认流程一致。

### P2（记录，未在扩大范围前提下修复）
1. 移动端布局未在真机/不同宽度做系统审计（Not Tested）。
2. Dashboard 的 Card/SR 统计来源未与 SR 数据逐项对账（Not Tested）。
3. Legacy/Shadow 与 Unified 的按钮禁用态/颜色未统一（记录）。
4. 菜单层级：高级功能仍集中在 Advanced tools，未分组（记录）。

## 3. 修改文件

- `main.js`：设置页 `_unifiedScheduler`；`display()` 加入该区；Advanced tools 收敛；模式菜单文案；激活/撤销/模式切换后刷新视图。
- `test/p4-uiux-integration.test.js`（新增 4 项）：设置页入口唯一性、菜单不重复、刷新行为、文案。
