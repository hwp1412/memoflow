# P4-UIUX-INTEGRATION-01 — 实施报告

## 1. 基线

- `personal/main = 460d54f`（PR #41 合并，`757f634` 已在主线）。
- 分支 `feat/p4-uiux-integration`，未创建/合并 PR、未改写历史。

## 2. 已完成

| 项 | 状态 |
|---|---|
| UI/UX 审计（入口盘点 + P0/P1/P2 分类） | 完成（docs/P4-UIUX-INTEGRATION-AUDIT.md） |
| P1-1 设置页 Unified 状态/激活/撤销/阻断项 | 已修复 |
| P1-2 授权与模式变更后视图刷新 | 已修复 |
| P1-3 阻断原因常驻可见 | 已修复 |
| P1-4 模式菜单文案 | 已修复 |
| P2 移动端、Card 统计对账、视觉统一 | Not Tested / 记录（不扩大重构） |

## 3. 测试与构建

- 全量：**1469 pass / 0 fail**（新增 4 项 P4 测试）
- UTC：**1469 pass / 0 fail**
- validate-release：valid
- build --dry-run：干净
- 正式构建：成功；正式构建 E2E 激活命令 **0** 次；`--e2e` 构建为 1 次。

## 4. 正式构建真实 Obsidian 跨 Phase 工作流（RC 门禁）

使用正式构建（非 `--e2e`），E2E-Empty-Vault（一次性合成库），自动化驱动真实命令/弹窗：

| 流程 | 结果 | 证据 |
|---|---|---|
| 正式激活（确认弹窗） | **Pass** | `e2e-artifacts/p4/e2e-formal.json` |
| Boost（含子孙） | **Pass** | S 60→55、E1/E2 50→45 |
| Postpone | **Pass** | S 最早展示 2026-11-29 |
| Priority | **Pass** | P50→P70 |
| Mercy Apply | **Pass** | `mf_not_before=2026-11-28` |
| Mercy Undo | **Pass** | Undo 后 `null` |
| Subtree Postpone | **Pass** | S/E1/E2 均 2026-11-30 |
| Queue 调用 | **Pass（仅调用成功）** | `buildSessionQueue` 返回对象；内容/排序未逐项核对 |
| 重启后安全状态 | **Pass** | 重启后 `authorized=false`；Ledger 8、Batch 2 持久；评阅被拒绝（`async host runtime is not authorized`） |
| Queue 内容与排序逐项核对 | **Not Tested** | 仅确认调用成功与返回对象，未核对条目/排序 |
| Dashboard / Session 屏幕级同步 | **Not Tested** | 未逐项比对屏幕显示与数据；Dashboard 仅截图 |
| Card/SR 真实复习 | **Pass（P3-03 已有证据，正式构建 + SR 1.15.4）** | 见 P3-03 报告 |
| Dashboard/Queue/Session 同步视觉核对 | **Partially Verified**：队列构建与视图刷新已测；Dashboard 屏幕级视觉同步未逐项截图（Not Tested） |
| Shadow / Legacy 不回归 | **Pass（既有自动化 + 本轮未改动调度语义）** |

## 4b. 审查后 UI 截图验收（真实界面）

| 状态 | 截图 | 结果 |
|---|---|---|
| 设置页·未授权 | `e2e-artifacts/p4/screenshots/p4-settings-unauthorized.png` | 已取得（显示 Unified 区、未授权） |
| 设置页·存在阻断项 | `p4-settings-blocked.png` | 已取得（显示阻断项） |
| 设置页·已授权 | Not Tested | 截图脚本注入 approval 后仍被 `USER_CONFIRMATION_REQUIRED` 拒绝（正式授权必须走确认弹窗），未取得已授权截图 |
| 设置页·撤销后 | `p4-settings-revoked.png` | 已取得（暂停/撤销提示、按钮可用） |
| 多级阅读树 | `p4-tree.png` | 已取得（三级 S→E1→E2 树） |
| 队列视图 | `p4-queue.png` | 已取得（视图打开；条目排序未核对） |
| Dashboard | `p4-dashboard.png` | 已取得（屏幕截图；统计来源未逐项对账） |
| 移动端/窄屏 | Not Tested | 当前环境无法可靠调整窗口宽度；RC 步骤：设置窗口宽度 375px 后依次打开设置/队列/树/Dashboard，检查横向滚动与按钮可点性 |

> 说明：截图使用正式构建；设置页最终截图验证的是 `src/views/settings-tab.js` 的真实 SettingTab（P4 首轮发现的重复类问题已修复）。

## 5. 遗留 / Release 阻塞

1. 移动端/窄屏布局未验证（Not Tested，RC 步骤见 §4b）。
2. Queue 条目/排序、Dashboard-Unified Topic 与 SR Card 统计来源未逐项对账（Not Tested）。
3. 已授权状态截图未取得（截图脚本无法绕过正式确认；需人工点击一次确认后补图）。
3. 旧库迁移适配器仍不在范围内（发布说明需明示）。
4. 生产 Release 未发布、未访问真实用户 Vault、未执行真实迁移。

## 6. 结论

Phase 1（阅读/层级/评阅）与 Phase 2（MF-US-1 模式/激活/批量）在正式构建中已作为同一系统完成一轮真实工作流验证；UI 入口收敛到设置页 + 单一模式菜单，授权变化后界面刷新；正式构建无 E2E 后门。剩余为 P2 视觉/移动端与文档性事项，不阻塞代码审查。
