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
| Queue 构建 | **Pass** | `buildSessionQueue` 返回 |
| 重启后安全状态 | **Pass** | 重启后 `authorized=false`；Ledger 8、Batch 2 持久；评阅被拒绝（`async host runtime is not authorized`） |
| Card/SR 真实复习 | **Pass（P3-03 已有证据，正式构建 + SR 1.15.4）** | 见 P3-03 报告 |
| Dashboard/Queue/Session 同步视觉核对 | **Partially Verified**：队列构建与视图刷新已测；Dashboard 屏幕级视觉同步未逐项截图（Not Tested） |
| Shadow / Legacy 不回归 | **Pass（既有自动化 + 本轮未改动调度语义）** |

## 5. 遗留 / Release 阻塞

1. 移动端布局与 Dashboard Card 统计未做真机逐项核对（P2，Not Tested）。
2. 屏幕级截图证据缺失（本轮以 JSON + 命令返回值作为证据；如需 PR 附件可补截图）。
3. 旧库迁移适配器仍不在范围内（发布说明需明示）。
4. 生产 Release 未发布、未访问真实用户 Vault、未执行真实迁移。

## 6. 结论

Phase 1（阅读/层级/评阅）与 Phase 2（MF-US-1 模式/激活/批量）在正式构建中已作为同一系统完成一轮真实工作流验证；UI 入口收敛到设置页 + 单一模式菜单，授权变化后界面刷新；正式构建无 E2E 后门。剩余为 P2 视觉/移动端与文档性事项，不阻塞代码审查。
