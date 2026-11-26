# P3-US1 E2E 手动执行清单（配合 `scripts/e2e-audit.mjs`）

> 用法：每条“点按”由项目负责人在 Obsidian 完成；“审计”由 Agent/脚本完成（只读）。
> 所有命令在仓库根目录执行：`node scripts/e2e-audit.mjs ...`
> 退出码 0=PASS，1=FAIL，2=参数/路径错误；`--json` 输出机器可读结果，作为证据留存。

## 0. 准备（执行前一次性）

```bash
# 三个 Vault 的基线快照（只读，生成 json）
node scripts/e2e-audit.mjs --vault ../E2E-Empty-Vault          --snapshot /tmp/e2e-base-empty.json
node scripts/e2e-audit.mjs --vault ../MemoFlow-Test            --snapshot /tmp/e2e-base-memoflow-test.json
node scripts/e2e-audit.mjs --vault ../E2E-Phase2-Unified-Vault --snapshot /tmp/e2e-base-phase2-unified.json
# 可选：旧格式副本（用于迁移预览/legacy 检查；Unified 激活应被 migration 门禁阻断）
node scripts/e2e-audit.mjs --vault ../E2E-Phase2-Test-Vault    --snapshot /tmp/e2e-base-phase2-legacy.json

# 记录插件构建哈希（应均为 d0ffa599…，E2E 测试构建）
node scripts/e2e-audit.mjs --vault ../E2E-Empty-Vault --json | grep -o '"mainSha": *"[a-f0-9]*"'
```

**停止条件**：任一 Vault 的 `mainSha` 不是 E2E 测试构建哈希，或 Obsidian 未加载 MemoFlow 插件 → 停止，先修环境。

---

## 1. Vault A：`E2E-Empty-Vault`（空库 + Unified 激活）

| # | 操作（Obsidian） | 预期 | 审计命令 | 通过标准 |
|---|---|---|---|---|
| A1 | 打开 Vault；确认 MemoFlow 插件已启用 | 命令面板出现 MemoFlow 命令 | `--vault ../E2E-Empty-Vault --profile empty` | `PASS` + `MIGRATION_NOT_REQUIRED` |
| A2 | 新建 Source `A`，写一段正文 | 文件创建；frontmatter 含 `type: source` | 同上 | `TOPICS_SCANNED` Source 1 |
| A3 | 摘录一段 → 一级 Extract；再从 Extract 摘录 → 二级 Extract | 层级正确 | `--vault ../E2E-Empty-Vault --profile empty --baseline /tmp/e2e-base-empty.json --allow-changes --json` | `DUPLICATE_MF_ID/PARENT_MISSING/ROOT_*` 均不出现；Source 1 / Extract 2 |
| A4 | 检查诊断菜单/`E2E: activation status` | `迁移需求：全新库，无需迁移`；`legacyTopicCount=0` | 同上 | `MIGRATION_NOT_REQUIRED` |
| A5 | 命令面板执行 `E2E: activate Unified (test build)`（两次确认） | 激活成功；模式 Unified；诊断 authorized=true | `--vault ../E2E-Empty-Vault --allow-changes` | `LEDGER_*` 无 FAIL |
| A6 | 对二级 Extract 执行一次评阅（Hold） | 成功提示；修订+1 | `--vault ../E2E-Empty-Vault --allow-changes --json` | Ledger `LEDGER_READABLE`；无 `LEDGER_ORPHAN` |
| A7 | 命令面板执行 `E2E: revoke Unified authorization (test build)` | 撤销提示 | 同 A1 | 仍 PASS |
| A8 | 撤销后立即再执行一次评阅 | **被拒绝**，文件不变 | 注意：先跑一次审计存 `/tmp/before-reject.json`，再点按，再 `--baseline /tmp/before-reject.json`（**不加** `--allow-changes`） | `NO_CHANGES` + PASS |
| A9 | 关闭并重开 Obsidian | 数据仍在、诊断正常 | `--vault ../E2E-Empty-Vault` | PASS |

**停止条件（A 组）**：出现“提示失败但文件被写”；`DUPLICATE_MF_ID`；`PARENT_MISSING/ROOT_*`；审计 `UNEXPECTED_CHANGES`；撤销后仍能写入。

---

## 2. Vault B：`MemoFlow-Test`（Legacy / Shadow / Phase1+2 联合）

| # | 操作 | 预期 | 审计 |
|---|---|---|---|
| B1 | Legacy：评阅/延期/排期/优先级/COMPLETE/DISMISS/REACTIVATE/SKIP | Legacy 行为正常；`mf_*` 不新增；Ledger 不新增 | `--vault ../MemoFlow-Test --baseline /tmp/e2e-base-memoflow-test.json --allow-changes`：无 `LEDGER_*` FAIL |
| B2 | Shadow：模式切 Shadow，执行评阅/延期 | Legacy 写入照常；诊断「Shadow 最近差异」出现；无 Ledger 记录 | 同上；`LEDGER_ABSENT`/`LEDGER_READABLE` 均可，但不得出现 `LEDGER_ORPHAN` |
| B3 | Phase1+2：Source→Extract→二级→树导航→队列→评阅→Postpone→COMPLETE→REACTIVATE | 树/阅读条/队列/Dashboard 同步 | 同上；审计 `TOPICS_SCANNED` 计数与预期一致 |
| B4 | Card/SR：复习一张 Card | SR 正常；Card 不含 `mf_*` | 同上；不得出现 `CARD_MF_FIELDS` |
| B5 | 重启 Obsidian | 状态正确 | `--vault ../MemoFlow-Test`（不带 baseline）PASS |

**停止条件（B 组）**：Legacy 模式出现 MF-US-1 字段；Card 出现 `mf_*`；`LEDGER_ORPHAN`；审计 `PLUGIN_BUILD_CHANGED`。

---

## 3. Vault C：`E2E-Phase2-Unified-Vault`（空库；激活后做批量 / 恢复 / 故障注入）

> 说明：`E2E-Phase2-Test-Vault` 是 MemoFlow-Test 的旧格式副本（16 个旧 Topic），
> 适合迁移预览/回滚演练，但 **Unified 激活会被 migration 门禁正确阻断**；批量/恢复测试用本组空库。

| # | 操作 | 预期 | 审计 |
|---|---|---|---|
| C1 | 创建 Source + 两级 Extract，再激活 Unified（E2E 命令） | authorized=true；`MIGRATION_NOT_REQUIRED` | `--vault ../E2E-Phase2-Unified-Vault --baseline /tmp/e2e-base-phase2-unified.json --allow-changes` |
| C2 | Subtree Postpone（父+子） | 每节点各一条事件；Revision 递增 | 无 `LEDGER_ORPHAN` |
| C3 | Boost 批次（绝对目标） | 批次记录含 `eventIds`；priority=目标 | `BATCH_NO_EVENT_IDS/BATCH_TARGET_MISMATCH` 不得出现 |
| C4 | Mercy：Preview→Confirm→Apply→Undo | Apply 后 `mf_not_before`=目标；Undo 恢复原值 | Mercy applied 批次目标匹配；无 `BATCH_TARGET_MISMATCH` |
| C5 | 同一操作重复执行 | 幂等：无重复事件身份、Revision 不重复增长 | 审计无 FAIL |
| C6 | 重启 Obsidian | Batch Reconcile 正常；无自动重放 | `--vault ../E2E-Phase2-Unified-Vault` PASS |
| C7 | 故障注入（仅此副本）：写入过程中强制退出 Obsidian | 重启后诊断显示 uncertain/blocked；不自动写入 | 审计可 `WARN`，不得出现“值相等即 applied”的假成功（人工核对 Ledger 状态） |
| C8 | 撤销授权后尝试写入 | 被拒绝，文件不变 | 同 A8 方法：先快照，点按，`--baseline`（不加 allow-changes）→ `NO_CHANGES` |

**停止条件（C 组）**：`BATCH_NO_EVENT_IDS`、`BATCH_TARGET_MISMATCH`、批次二次扣减、uncertain 显示成功、`LEDGER_ORPHAN`、撤销后仍写入。

---

## 4. 证据归档

每次审计后保存：

```bash
node scripts/e2e-audit.mjs --vault <vault> [参数] --json > /tmp/audit-<vault>-<step>.json
```

并在报告/PR 中附：命令、退出码、JSON、Obsidian 截图（诊断菜单 + 关键文件 frontmatter）、必要时 `data.json` 的 Ledger/Batch 片段（脱敏，无真实用户数据）。

## 5. 失败处理

- 任一 `FAIL`：停止该 Vault 后续步骤，保留现场（不手工改文件、不删除证据），把 JSON + 截图交回 Agent 定位。
- `WARN`：需人工判断是否符合预期（例如 data.json 变化、旧格式 Topic 需要迁移）。
- 不自动清理故障证据；`E2E-Phase2-Test-Vault` 可整体丢弃后从 `backups/MemoFlow-Test-20261127-032549` 重建。
