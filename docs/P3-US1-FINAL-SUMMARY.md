# MemoFlow 1.0 — 阶段总结报告（Phase 2 收尾 ~ P3-02B 实机 E2E）

> 整理时间：2026-11-27
> 整理范围：Phase 2 HOST-CLOSURE（已合并 PR #38）→ P3-01 就绪审计 → P3-02A 安全激活（已合并 PR #39）→ P3-02B 真实 Obsidian E2E（当前分支）
> 当前分支：`feat/p3-us1-empty-vault-activation`，HEAD `30452de`（未创建/合并 PR）
> 基线：`personal/main = 7c2cf9b`（PR #39 已合并）

---

## 0. 一句话结论

MF-US-1 的宿主集成、受控激活、迁移宿主、只读审计与真实 Obsidian 核心 E2E 已基本闭合：
激活 → 真实评阅写入（Revision/Ledger）→ Boost/Mercy/Subtree → Legacy/Shadow → 重启恢复 → 创建网关 → Card 隔离 全部在真实 Obsidian 1.15.1 中验证通过；
剩余未验证项只有“真实 SR 复习交互”与“真实 Vault 迁移适配器/生产激活”等需要单独授权或独立阶段的事项。

---

## 1. 阶段与提交时间线

| 阶段 | 内容 | 结果 |
|---|---|---|
| Phase 2 HOST-CLOSURE | 统一调度宿主接线：P0 契约、Mercy/状态/队列三模块、执行链、批次恢复、Dashboard、R1–R6、Shadow、迁移预览、E2E 工具 | PR #38 合并为 `4bba262` |
| P3-US1-READINESS-01 | 合并基线核验、激活链路审计、隔离 Vault 验收与迁移演练方案 | `docs/P3-US1-READINESS-PLAN.md`（分支 `docs/p3-us1-readiness`，`2b567f8`） |
| P3-02A 安全激活 | G1 激活协调层、G2 模式管理、G3 迁移宿主接线、G4 诊断一致性；撤销与回退分离 | PR #39 合并为 `7c2cf9b`（`f90da41`、`031f461`） |
| P3-02B 实机 E2E | 真实 Obsidian 自动化验收、缺陷修复、审计脚本 | 当前分支 `9469135` → `30452de` |

### 当前分支提交（13 个）

```
30452de feat: activation grants creation/resume capabilities; real-device creation & card isolation pass
3967ce6 fix: normalise persisted mode so restart lifecycle initialises
a1717d5 docs: subtree real-device pass; restart/shadow findings
80b0a99 test: E2E-only subtree plan diagnostic
04ea5d2 test: archive latest real-Obsidian harness
590ee12 feat: activation grants mercy writer token; deepest-first subtree writes
6f2c68e fix: wait for IR collection and block with a clear reason
ed941ce fix: refresh topic index before boost/subtree batch planning
41e350f docs: second real-Obsidian automation batch and new finding
026e0d3 fix: unified events use ISO today; real Obsidian E2E evidence
9458d6b feat: read-only vault audit script and manual checklist
5456937 feat: test-build-only activation commands and E2E environment
9469135 fix: brand-new vault is migration-not-required
```

---

## 2. 已交付能力清单

### 2.1 Phase 2（已合并）

- **共享契约**：`batch-runner.js`、`topic-projection.js`、`host-write-guard.js`
- **批处理**：Mercy 宿主编排、状态操作、Boost 批次、批次存储/恢复/续跑/撤销证据
- **读侧**：Unified 队列源、Dashboard 模型、会话联动
- **安全**：`activation-coordinator`（P3-02A 前身）、Shadow 只读 observer、迁移预检、模式菜单与诊断
- **文档**：HOST-CLOSURE 计划、26 条入口矩阵

### 2.2 P3-02A（已合并）

- `src/integration/activation-coordinator.js`：六条件推导、审批注入、会话级授权、撤销
- `src/integration/migration-host.js`：合成环境 Preview→Backup→Verify→Apply→Reconcile→Rollback（仅 MemoryStorage）
- `main.js`：G1–G4 接线、诊断、模式菜单、迁移演练入口
- 撤销/回退分离：立即撤销（零写入）+ 有条件切回 Legacy

### 2.3 P3-02B（当前分支）

- `--e2e` 测试构建：仅测试构建存在的激活命令，正式构建物理剔除
- `scripts/e2e-audit.mjs`：只读 Vault 审计（身份/关系/Ledger/Batch/Card/迁移/基线 diff）
- 真实 Obsidian Harness（`e2e-artifacts/harness-plugin`）：在 Obsidian 内部驱动命令与弹窗
- 一批真实缺陷修复（见 §3）

---

## 3. 真实 Obsidian E2E 中发现的缺陷与修复

| # | 缺陷（真实设备暴露） | 影响 | 修复 |
|---|---|---|---|
| 1 | 评阅用显示格式日期（DD-MM-YYYY）进入 Unified 描述符 | 真实 Vault 中所有 Unified 评阅失败（`explicit valid today is required`） | `_mfUs1IsoToday/From`，统一路径全部 ISO；`026e0d3` |
| 2 | 激活只给 runtime token，Mercy 受保护 Writer 无授权 | 激活后 Mercy 全部 `E_UNIFIED_NOT_AUTHORIZED` | 激活时把会话 token 交给 `mfUs1AdminWriter`；`590ee12` |
| 3 | 激活未签发 creation/resume 能力 | 激活后无法创建 Source/Extract、无法续跑批次 | 激活时签发 creation/resume 会话能力，撤权清空；`30452de` |
| 4 | 持久化的 `mf_us1_mode` 被写成 char-map 对象 | 重启后 lifecycle 初始化 `E_MODE_INVALID`，运行时缺失 | `_mfUs1NormalizeMode` 修复损坏值并 fail-closed；`3967ce6` |
| 5 | 子树批处理顺序 | 根先写导致子节点 `E_SUBTREE_CHANGED` | 按父级深度“最深先写”；`590ee12` |
| 6 | 批量规划时 IR 集合为空 | Boost/Subtree 静默返回 null | 等待 IR 索引并显式 `E_INDEX_NOT_READY`；`6f2c68e` |

> 归因更正：早期把 Boost 失败归因为“索引缓存陈旧”并不完整，首因是 Harness 种子目录/写法错误；已在本报告中按实际证据修正，不保留错误结论。

---

## 4. 真实 Obsidian 验收矩阵（Obsidian 1.15.1）

| 项 | 状态 | 证据 |
|---|---|---|
| 插件加载、空库识别、迁移门禁 | **Pass** | harness/audit JSON |
| Unified 安全激活（真实门禁 + 确认弹窗） | **Pass** | `authorized=true, writeEnabled=true, blockers=[]` |
| 真实评阅写入（Event→Intent→CAS→Readback→Ledger） | **Pass** | Revision 0→1、Ledger 1、hash/audit 完整 |
| Boost（批次 + 绝对目标） | **Pass** | 批次落盘；S 60→55、E1/E2 50→45 |
| Mercy Apply + Undo | **Pass** | 3/3 applied；Undo 恢复 3 项 |
| Subtree Postpone | **Pass** | E2/E1/S 全部 applied，notBefore 2026-11-30 |
| Legacy 评阅 | **Pass** | legacy 字段更新，无 `mf_*` |
| Shadow 只读对照 | **Pass** | Legacy 写入正常；`mfUs1ShadowLast` 记录差异；Ledger 不变 |
| 重启恢复 | **Pass** | lifecycle=true、recovery healthy、Ledger/Batch 持久 |
| 创建网关（Source+Extract） | **Pass** | mf_id/parent/root 正确；未授权 fail-closed |
| Card 隔离 | **Pass** | 无 `mf_*`，不计入 MF-US-1 topicCount |
| 紧急撤销后写入被拒 | **Pass** | `E_UNIFIED_NOT_AUTHORIZED`，Revision/Ledger 不变 |
| 只读审计脚本 | **Pass** | `PLUGIN_OK/LEDGER_READABLE/...` |
| 真实 SR 复习交互 | **未验证** | 需 SR 插件环境（Card 隔离已单独验证） |
| 真实 Vault 迁移 | **未执行（禁止）** | 只有 MemoryStorage 演练 |

---

## 5. 测试与构建

```
node --test test/*.test.js        1452 pass / 0 fail
TZ=UTC node --test test/*.test.js 1452 pass / 0 fail
validate-release                  valid
build --dry-run                   干净
正式构建                          成功
E2E 测试构建（--e2e）             含 3 个测试构建命令；正式构建中 0 个
```

新增测试覆盖：激活/撤销/条件阻断、空库迁移豁免、vault 审计（9 项）、E2E 构建门控、模式损坏修复、创建/恢复能力签发、子树深度排序等。

---

## 6. 测试环境与安全操作记录

| 项 | 状态 |
|---|---|
| `MemoFlow-Test` | 已完整备份（`插件开发/backups/MemoFlow-Test-20261127-032549`，45 文件，哈希校验）；已安装 E2E 测试构建；`data.json` 未覆盖 |
| `E2E-Empty-Vault` | 一次性空库，用于激活/写入/创建/批量 E2E |
| `E2E-Phase2-Unified-Vault` | 一次性空库，批量/恢复测试 |
| `E2E-Phase2-Test-Vault` | MemoFlow-Test 备份副本（旧格式），用于迁移/回滚演练 |
| `phase2 test` | 未在 Obsidian 注册/未找到（已用一次性副本替代） |
| Hermes/真实用户 Vault | **未访问**（`supermemo`、`HWP的知识仓库` 均未触碰） |
| Obsidian 全局配置 | `obsidian.json` 修改前已备份；仅注册一次性测试库 |
| Harness | 仅测试 Vault 使用，运行后从启用列表移除；正式构建不含 |

---

## 7. 仍未完成 / 需单独决策

| 项 | 说明 | 归属 |
|---|---|---|
| 真实 SR 复习交互 | 需在装 SR 插件的测试库执行一次复习；Card 隔离已验证 | 下一轮 E2E |
| 真实 Obsidian 迁移适配器 | 迁移执行只接受 Module-trusted MemoryStorage；旧库升级需要适配器 | 1.0 发布决策 |
| 生产 Unified 激活审批 | 目前 activation 只能测试注入 approval；生产需所有者明确开关 + UI 确认 | 单独授权 |
| 激活/模式 UI、迁移 UI 完整化 | 当前为菜单 + 诊断；正式 UI/UX 阶段统一做 | RC 前独立阶段 |
| 故障注入（崩溃/断电） | 部分由内存测试覆盖，未做真实进程崩溃注入 | 可选增强 |

---

## 8. 建议的下一步（供所有者决定）

1. **审查当前分支**：`feat/p3-us1-empty-vault-activation`（13 个提交），确认可以创建 PR；
2. 若接受，创建 PR 并合并（本轮未自行创建/合并）；
3. 合并后按需补两项：真实 SR 复习 E2E、生产激活审批流程设计（含真实迁移适配器是否进入 1.0）；
4. 进入 UI/UX 整体审查与 Release Candidate 阶段。

---

## 9. 相关文档索引

| 文档 | 位置 |
|---|---|
| 本总结 | `docs/P3-US1-FINAL-SUMMARY.md` |
| 详细实机 E2E 记录（含逐步证据） | `docs/P3-US1-OBSIDIAN-E2E-REPORT.md` |
| 手动验收清单 | `docs/P3-US1-E2E-CHECKLIST.md` |
| 只读审计脚本 | `scripts/e2e-audit.mjs` |
| E2E Harness 与证据 | `e2e-artifacts/` |
| Phase 2 计划与入口矩阵 | `docs/P2-US1-HOST-CLOSURE-PLAN.md`、`docs/P2-US1-HOST-CLOSURE-MATRIX.md` |
| P3 就绪计划 | 分支 `docs/p3-us1-readiness`：`docs/P3-US1-READINESS-PLAN.md` |
