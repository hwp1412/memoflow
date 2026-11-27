# P3-US1-PRODUCTION-ACTIVATION-01 — 正式安全激活与发布构建验收报告

任务：P3-US1-PRODUCTION-ACTIVATION-01（P3-03）
基线：`personal/main = d1bbc50`（PR #40 已合并；`93a6660` 已确认是祖先）
分支：`feat/p3-us1-production-activation`（本轮，未创建/合并 PR）

---

## 1. 合并基线与回归

| 项 | 值 |
|---|---|
| `personal/main` | `d1bbc50 Merge pull request #40 ...` |
| PR #40 头 | `93a6660`（`git merge-base --is-ancestor` = true） |
| 全量测试 | **1465 pass / 0 fail** |
| UTC 回归 | **1465 pass / 0 fail** |
| validate-release | valid |
| build --dry-run | 干净 |
| 正式构建 | 成功（`main.js` sha256 `da7fd59e…`） |
| 正式构建 E2E 命令字符串 | **0 次**（`--e2e` 构建为 1 次） |
| 正式构建运行时命令注册 | 实测 `app.commands.commands['memoflow:e2e-activate-unified']` **不存在** |

---

## 2. 正式 Unified 激活入口

实现于 `main.js`：

- `mfUs1ProductionActivate()`：显示当前模式、Topic 统计（含旧格式数量与索引完整性）、恢复/批次状态、阻断项 → 用户确认后才继续；
  - 确认后设置**一次性** `mfUs1ProductionApproval`，调用既有 `mfUs1ActivateUnified()`（完整六条件 + 原子能力签发），结束后立即复位；
  - 阻断项存在时明确提示并拒绝，不显示虚假成功；
  - 不使用 `__mfUs1ActivationApproval` 等测试注入，也不需要 E2E 命令。
- `mfUs1ProductionRevoke()`：二次确认后调用既有即时撤销（token 从 WeakSet 删除、旧 Writer/Creation/Resume 引用全部失效、保持暂停、不回退 Legacy 写入）。
- 入口：Advanced tools 菜单「MF-US-1: 激活 Unified（需确认）…」「MF-US-1: 暂停/撤销 Unified 授权…」；`MF-US-1 mode…` 选择 Unified 也走该正式入口。
- 默认仍为 Legacy；重启后会话 token 不持久化，必须再次确认激活。

---

## 3. 测试证据（新增专项）

`test/mf-us-1-production-activation.test.js`（4 项）：

1. 正式入口只在用户确认后激活；取消 → `E_CANCELLED`、模式不变、未授权；确认 → 成功且一次性审批标志复位。
2. 存在旧格式 Topic 时正式入口被阻断（`MIGRATION_INCOMPLETE`），不签发授权。
3. 模拟重启：授权不跨重启；再次激活必须重新确认（取消则失败）。
4. 正式撤销入口需确认；取消保持会话；确认后 `authorized=false/suspended=true`，旧 Writer 写入被 blocked。

同时更新了模式菜单相关测试以匹配“Unified 需显式确认”的正式语义。

---

## 4. 正式构建真实 Obsidian E2E（E2E-Empty-Vault，正式构建）

安装**正式构建**（非 `--e2e`）后执行；Harness 仅用于无 GUI 控制环境下的自动化，不改变产品逻辑。

| 项 | 结果 |
|---|---|
| 正式构建包含 E2E 命令 | **否**（运行时命令注册检查 false） |
| 正式激活（用户确认弹窗） | **Pass**：`ok=true`，六条件全满足，`authorized=true` |
| 真实评阅（ADVANCED） | **Pass**：`status=applied`，Revision 0→1，`mf_last_event_id` 写入，Ledger 记录 |
| Card 隔离 | **Pass**：Card `type=card`、无 `mf_id`，不进入 Unified Topic 计数 |
| 正式撤销（确认后） | **Pass**：`authorized=false`、`suspended=true` |
| 撤销后再次评阅 | **Pass（拒绝）**：`Unified authorization was revoked`，Revision 保持 1（零写入） |

---

## 4b. 正式构建批量流程复核（未完成）

- 已在正式构建验证：激活、真实评阅、Card 隔离、撤销、撤销后拒写（§4）。
- **未在正式构建复核**：Boost / Mercy Apply+Undo / Subtree Postpone / Postpone / Schedule / Priority / Dashboard / Queue / Session 同步。这些流程此前在 `--e2e` 测试构建中全部 Pass（见 P3-US1-OBSIDIAN-E2E-REPORT.md）。
- 本轮尝试用正式构建复跑批量 Harness 未产出结果（脚本状态/重复创建冲突），已如实标记为未完成，不作为 Pass 证据；建议 RC 前用真实 UI 补一次。

## 5. Card / SR 验收状态

- **Card 隔离：Pass**（正式构建真机验证：无 `mf_*`、不进入 MF-US-1）。
- **真实 SR 复习交互：Pass（正式构建 + SR 1.15.4 环境）**（2026-11-27，`MemoFlow-Test`，先备份 45 文件）：
  - 识别 Card：`type: card`，带 SR 备注；MF-US-1 诊断中 Card 不计入 Topic；
  - 打开真实 SR 复习 UI（`srs-review-flashcards-in-note`，按钮「显示答案 / Again / 较难 / 记得」）；
  - 点击评分后 Card 的 SR 备注由 `<!--SR:!2026-11-25,3,250-->` 更新为 `<!--SR:!2026-11-27,0,130-->`（due/interval/ease 真实变化）；
  - Card 始终无 `mf_*` 字段，Ledger 0、Batch 0，未进入 MF-US-1 写入路径。
  - 未验证项：Dashboard 中 SR 卡片统计来源的独立比对（Dashboard 本轮未在 SR 环境逐项截图），列入 RC 前 UI 验收。

---

## 6. 迁移边界

- 全新库（无旧格式 Topic）可正常激活（本轮正式构建验证，`migration-not-required`）。
- 检测到旧格式 Topic 时，正式入口明确阻断（`MIGRATION_INCOMPLETE`），不做静默转换。
- 真实 Obsidian 旧库迁移适配器**不在本轮范围**；发布说明需明确“旧库升级暂不支持无缝迁移，需等待受控迁移工具”。

---

## 7. 剩余 P0/P1 与 RC 前事项

- P0：无（本轮未发现数据损坏级问题）。
- P1：无（SR 真实复习已在正式构建 + SR 1.15.4 环境通过）。
- P2：正式构建下的 Boost/Mercy/Undo/Subtree/Postpone/Schedule 批量流程本轮仅用 `--e2e` 测试构建验证；正式构建仅复核了激活/评阅/Card/撤销链路（正式构建批量 Harness 复跑因自动化脚本状态问题未产出结果，未作为通过证据）。建议在正式构建上用真实 UI 再点一次批量流程作为 RC 前复核。
- RC 前：UI/UX 整体审查与优化、旧库迁移适配器决策、发布说明与安装文档更新、正式 Release 产物重建与签名流程。

---

## 8. 安全边界确认

- 未访问任何真实用户 Vault；未执行真实迁移；未在生产 Vault 激活 Unified；未创建/合并 PR、未改写历史。
- 正式激活使用真实用户确认 + 完整安全条件；测试构建的 E2E 命令与 approval 机制在正式构建中不存在/不可由普通 UI 触发。
- 撤销后旧 Writer/Creation/Resume 引用均已失效（WeakSet 删除 + 每次调用复检），行为测试覆盖零写入。
