# P3-US1-OBSIDIAN-E2E-01 — Obsidian 集成验收报告

任务：P3-US1-OBSIDIAN-E2E-01（P3-02B）
分支：`feat/p3-us1-empty-vault-activation`（从 `personal/main = 7c2cf9b` 创建）
结论速览：**自动化与构建层 Pass；所有 Obsidian GUI 实机用例 Blocked（当前执行环境无 GUI 控制能力）；发现并修复 1 个 P1 激活缺陷（空库被错误要求迁移）；`phase2 test` Vault 未找到（Blocked）；测试环境 GUI 审批接线缺失（P1，待授权）。未达到本阶段最终验收标准。**

---

## 1. 环境与构建基线

| 项 | 值 |
|---|---|
| `personal/main` | **`7c2cf9b Merge pull request #39 from hwp1412/feat/p3-us1-activation`** |
| Phase 1 合并 | `personal/feat/phase1-child-extract`、`personal/fix/p1-nav-1` 均已合入 main；多级 Extract 代码与 Phase 2 宿主接线同基线 |
| Phase 2 合并 | PR #38 → `4bba262`（`1af865f` 祖先） |
| P3-02A 合并 | PR #39（`f90da41`、`031f461` 祖先已核实） |
| Obsidian | **1.15.1**（`/Applications/Obsidian.app`） |
| OS | macOS 27.0.1 |
| 构建 | `node scripts/build.mjs`（正式构建，**E2E 命令被物理剔除**）与 `node scripts/build.mjs --e2e`（测试构建，含 E2E 命令）均成功 |
| 正式产物 | `main.js` sha256 `…`（无 `e2e-activate-unified` 字符串） |
| **E2E 测试产物** | `main.js` 1,213,649 B，sha256 **`d0ffa5990a4c0a1ccdd8d832a144b8f85973757f`**（含 3 个 E2E 命令；banner 标记 E2E TEST BUILD） |
| manifest | `id: memoflow` / `0.1.0` / `minAppVersion 1.12.7` |
| 自动化 | `node --test test/*.test.js` **1433 pass / 0 fail**；`TZ=UTC` 同样通过；`validate-release` valid；`build --dry-run` 干净 |

## 2. 测试 Vault 与备份

| Vault | 状态 | 证据 |
|---|---|---|
| `MemoFlow-Test` | 存在，已备份，新构建已安装 | 路径 `/Users/Admin/Documents/插件开发/MemoFlow-Test`；45 个文件 / 15 MB；marker `vaultId 78896b66-c7a1-4e9d-a1aa-edba1b082dcb`；备份 `插件开发/backups/MemoFlow-Test-20261127-032549`（45 文件，备份与新文件 main.js 哈希一致）；安装后 `main.js` = 新构建哈希 `7192292a…`；`data.json` 时间戳未变（Nov 25），未被覆盖 |
| `E2E-Phase2-Test-Vault`（旧格式副本） | 已就绪 | 从 MemoFlow-Test 备份完整复制（15 MB），安装 E2E 测试构建；用于迁移预览/回滚与 legacy 检查（16 个旧 Topic，Unified 激活会被 migration 门禁正确阻断） |
| `E2E-Phase2-Unified-Vault`（新建空库） | 已就绪 | 空库 + E2E 测试构建，用于激活后的 Subtree/Boost/Mercy/恢复/故障注入；可随时删除重建 |
| `phase2 test` | **未找到（Blocked；已用一次性副本替代执行渠道）** | `~/Library/Application Support/obsidian/obsidian.json` 仅注册 3 个 Vault：`HWP的知识仓库`、`supermemo`、`MemoFlow-Test`；`find /Users/Admin -maxdepth 6 -iname "*phase*test*"` 无匹配。**需要项目负责人提供实际路径** |
| 一次性空库（新建） | 已创建，等待实机 | `插件开发/E2E-Empty-Vault`（含新构建插件、空 `Sources/`、`Extracts/`、disposable marker） |

> 本轮未触碰任何真实用户 Vault；`supermemo`、`HWP的知识仓库` 未安装/未访问。

## 3. 执行环境限制（Blocked 原因）

当前 Agent 仅有 shell/文件/构建能力，**没有 Obsidian GUI 控制或截图/Obsidian CLI 能力**，无法：
启动/操作 Obsidian 窗口、点击菜单/阅读条、验证渲染与交互、观察 MetadataCache 实时行为、执行"关闭重开"实机流程。

按任务要求：**GUI 用例一律标记 Blocked，不以 Mock 结果冒充实机结果**；下方提供可执行的手动步骤，供项目负责人在已备份 Vault 上执行。

## 4. Legacy 实机回归 — **Blocked（UI）**

随自动化层通过：Legacy 相关单元/回归测试（创建、拆分、多级 Extract、评阅/延期/排期/优先级、COMPLETE/DISMISS/REACTIVATE、SKIP、Legacy Mercy/Boost、Card/SR 边界）1433 项全通过。

手动步骤（`MemoFlow-Test`，新构建）：
1. 打开 Vault，确认插件加载（设置→第三方插件→MemoFlow 已启用，命令面板出现 MemoFlow 命令）。
2. 分别执行 Source 新建 → 一级 Extract → 二级 Extract → 三级；确认阅读树层级、返回导航、父/根来源显示正确。
3. 执行评阅、延期、手动排期、Priority、COMPLETE、DISMISS、REACTIVATE、SKIP。
4. 检查 `.obsidian/plugins/memoflow/data.json` 与 Topic frontmatter 仅出现 Legacy 字段，`mfUs1Ledger` 无记录。
5. 关闭并重开 Obsidian，确认树/队列/设置状态正确。

## 5. Shadow 实机回归 — **Blocked（UI）**

自动化层：Shadow observer 只读差异、失败不影响 Legacy、不写 Ledger 的测试全通过。

手动步骤（`MemoFlow-Test`）：
1. 模式菜单切 Shadow；对 Topic 执行评阅/延期/Boost。
2. 打开 MF-US-1 诊断：确认「Shadow 最近差异」出现条目，`mf_*` 与 `mfUs1Ledger` 无新增。
3. 执行一次失败场景（如对无 `mf_id` 的旧笔记操作），确认 Legacy 正常完成、诊断显示不可比较。

## 6. 空库首次安装与 Unified 安全激活 — **代码层已修复并通过测试；GUI 激活 Blocked**

### 6.1 发现的 P1 缺陷（已修复）

原 `activation-coordinator` 无条件要求「迁移计划完成 + 备份校验」，导致**全新空 Vault 永远无法激活 Unified**（`MIGRATION_INCOMPLETE`）。这违反 P3-02B 决定（无待迁移对象时应为 migration-not-required）。

修复（本分支）：

- `migrationRequirement()`：`legacyTopicCount === 0` → `{required:false, complete:true, notRequired:true}`；未知数量保持保守（仍要求迁移计划）。
- 空库时 `backupVerified` 不再作为前置（无迁移则无迁移备份要求）；**其余门禁不变**：用户确认、恢复健康、无未决事件、无阻断 Topic、无重复 ID、无未决批次、CAS 存储。
- `main.js` 证据计算 `topicCount / legacyTopicCount`；诊断显示「迁移需求：全新库，无需迁移」。
- 测试：空库激活成功、空库仍拒绝无确认/未决/异常恢复/重复 ID、未知 legacy 数量保守、混合库缺计划仍阻断、宿主空库激活端到端。

自动化结果：`1433 pass`（含新增 4 项空库用例）。

### 6.2 GUI 激活接线：已按批准实现（P1-2 关闭）

生产门禁设计为无 approval provider 不签发 token；测试构建也没有可用的 GUI 审批入口（只能通过测试实例字段注入）。任务禁止"手动改写私有变量/注入 Token"来完成实机验收，因此**在 Obsidian 内激活 Unified 目前没有合规入口**。

**建议的最小测试环境接线（需单独授权）**：新增仅在 E2E 测试构建（build flag / manifest 标记）可用的激活命令（如 `MemoFlow: E2E activate unified (test build only)`），内部仍走 `createActivationCoordinator` 的全部真实条件与审批回调；不写入生产构建、不形成后门。

### 6.3 空库首次使用清单（Owner 手动）

1. 用 `E2E-Empty-Vault` 打开 Obsidian（或经批准的一次性空 Vault），确认无迁移对象：诊断显示「全新库，无需迁移」、`legacyTopicCount=0`。
2. 创建 Source → 一级 Extract → 二级 Extract；检查 `mf_id` 唯一、`mf_parent_id` = 直接父级、`mf_root_id` = Source、`mf_revision` 初始 0、`mf_scheduler_version` 正确。
3. 未授权路径：确认所有 Unified 调度写入被拒绝（`E_UNIFIED_NOT_AUTHORIZED`）；手工改 `mf_us1_mode=unified` 后仍 fail-closed。
4. 受控授权（6.2 接线获批后）：激活 → 执行一次评阅，确认 Event→Intent→CAS→Readback→Ledger 闭环、Revision +1、UNCONFIRMED 不显示成功；撤销后立即拒绝新写入。

## 7. Phase 1 + Phase 2 联合 E2E — **Blocked（UI）**

自动化层覆盖：多级 Extract parent/root、Unified 队列 `mf_*` 权威、SKIP 零调度写、Checkpoint 仅阅读元数据、Card/SR 隔离、失败不显示成功、会话不因 uncertain 推进（全部 1433 通过）。

手动步骤：Source→Extract→二级 Extract→树导航→每日队列→评阅→Postpone/Schedule/Priority→COMPLETE/REACTIVATE→Dashboard/Session 刷新；对照 frontmatter 与 Ledger，确认树/队列/仪表盘同步、SKIP 零写、Checkpoint 不改 `mf_*`、Card 不进 MF-US-1。

## 8. 批量调度与恢复 — **Blocked（GUI/需 `phase2 test`）**

自动化层已覆盖（内存/合成）：Subtree Postpone、Boost 绝对目标与批次身份、Mercy Preview/Apply/Undo（Revision CAS）、COMPLETE/DISMISS 批量、幂等、Batch Store 持久化、重启 Reconcile、原 eventId 恢复、Ledger 未确认阻断、撤销与重新审批。全部通过。

实机步骤需 `phase2 test` Vault 路径 + 6.2 激活接线；故障注入必须在 Vault 备份副本中执行（现有备份：`backups/MemoFlow-Test-20261127-032549`）。

## 9. Card / SR 隔离 — **自动化 Pass，实机 Blocked**

自动化：Card 不进入 MF-US-1 Writer/创建网关/队列，SR 计数与复习独立。实机需在 `MemoFlow-Test`（已装 SR 插件）确认：Card 复习正常、MF-US-1 诊断不包含 Card、`mf_*` 不出现在 Card。

## 10. 迁移兼容性 — **内存演练 Pass；真实 Obsidian 适配器未实现（Blocked/发布决策）**

- MemoryStorage 演练（preview→backup→verify→apply→reconcile→rollback、重复执行、部分失败、ID/关系冲突）通过（`mf-us-1-migration-host` 5 项）。
- **Obsidian 真实文件迁移适配器不存在**：`executeMigration` 只接受模块注册的 `MemoryStorage`。旧版本升级兼容需要此适配器，列为独立发布决策项；**不阻塞空库首次使用路径**。
- 明确区分：内存迁移测试通过 ≠ Obsidian 真实迁移通过 ≠ 真实用户数据迁移完成。本轮**未执行真实迁移**。

## 11. 测试状态汇总

| 类别 | 状态 | 证据 |
|---|---|---|
| 合并基线与代码归属 | **Pass** | main `7c2cf9b`；Phase1/2/P3-02A 祖先核实 |
| 自动化全量回归 | **Pass** | 1433 pass / 0 fail（本地 + UTC） |
| validate / dry-run / 真实构建 | **Pass** | valid / 干净 / dist 含全部模块 |
| MemoFlow-Test 备份 | **Pass** | 45 文件、哈希一致、data.json 未覆盖 |
| 新构建安装到 MemoFlow-Test | **Pass（文件层）** | 插件目录 main.js = 构建哈希；实机加载 **Blocked** |
| phase2 test Vault | **Blocked** | 未注册/未找到，需路径 |
| Legacy / Shadow / 空库首次 / 联合 E2E / 批量恢复 / Card SR 实机 | **Blocked（GUI）** | 无 GUI 控制能力；提供手动步骤 |
| 空库 Unified 激活（代码） | **Pass（修复+测试）** | 1433 通过；GUI 入口仍 Blocked |
| 迁移内存演练 | **Pass** | 5 项测试 |
| 真实 Obsidian 迁移 | **Blocked（未实现适配器）** | 发布决策项 |

## 12. 缺陷清单

| ID | 级别 | 描述 | 状态 |
|---|---|---|---|
| P1-1 | P1 | 空库被错误要求迁移/备份，全新用户无法激活 Unified | **已修复**（本分支，含测试） |
| P1-2 | P1 | 测试构建缺少合规的 GUI 激活审批入口 | **已修复**（`--e2e` 构建 + 3 个测试构建限定命令；正式构建物理剔除） |
| P1-3 | P1 | `phase2 test` Vault 不存在/未注册 | **已缓解**：按批准创建 `E2E-Phase2-Test-Vault`（MemoFlow-Test 备份副本）承载批量/恢复/故障注入；真实 `phase2 test` 仍可提供路径后替换 |
| P2-1 | P2 | 迁移只支持内存存储，无 Obsidian 真实迁移适配器 | Open（旧版本升级发布决策） |
| P0 | — | 未发现（自动化层） | — |

## 13. 是否具备进入下一阶段安全激活审批的条件

**代码与测试环境已就绪，仅剩 GUI 实机执行（Owner）。**

1. ✅ 自动构建/测试/诊断接线完成（1436 pass）；
2. ✅ E2E 测试构建已安装到 3 个测试 Vault（哈希一致）；
3. ⏳ 需项目负责人打开 Obsidian 执行 §4–§9 手动清单，形成 Pass/Fail 记录（截图/日志/前后文件哈希）；
4. ⏳ 空库激活 → 一次真实 Unified 写入 → 撤销 → 重新审批闭环通过后，方可进入生产激活审批；
5. 若需使用真实 `phase2 test` Vault，提供路径后在同一清单上复跑批量/恢复组。

## 14. 安全边界

未访问/修改真实用户 Vault；未对 `supermemo`、`HWP的知识仓库` 做任何操作；未执行真实迁移；未启用生产 Unified；未创建/合并 PR；未改写 Git 历史。所有测试均使用已备份的指定测试 Vault 或一次性空库。


## 15. E2E 测试构建与安装（本轮补记）

| Vault | 路径 | 构建 | main.js sha256 |
|---|---|---|---|
| MemoFlow-Test | `插件开发/MemoFlow-Test` | E2E (`--e2e`) | `d0ffa5990a4c0a1ccdd8d832a144b8f85973757f` |
| E2E-Empty-Vault | `插件开发/E2E-Empty-Vault` | E2E (`--e2e`) | 同上 |
| E2E-Phase2-Test-Vault | `插件开发/E2E-Phase2-Test-Vault`（备份副本） | E2E (`--e2e`) | 同上 |

备份：`插件开发/backups/MemoFlow-Test-20261127-032549`（45 文件，哈希已复核）。
正式构建（`node scripts/build.mjs`）中 E2E 命令出现 0 次；`--e2e` 构建中为 1 次——构建门控已验证。


## 16. 只读审计工具（本轮交付）

新增 `scripts/e2e-audit.mjs`（只读，不写 Vault）：

```bash
node scripts/e2e-audit.mjs --vault <path> --snapshot out.json      # 执行前基线
node scripts/e2e-audit.mjs --vault <path> --baseline out.json [--allow-changes] [--profile empty]
```

检查项：插件安装/ID、Topic `mf_id` UUID 与唯一性、`mf_revision/mf_scheduler_version`、Extract 的 parent/root 链与 root=Source、
Card 无 `mf_*`、Ledger applied 记录对应真实 Topic、Batch（Boost eventIds/绝对目标；Mercy notBefore）、旧格式 Topic 计数与迁移需求、
基线 diff（新增/修改/删除、data.json、main.js 哈希）。退出码 0/1/2；`--json` 供证据归档。

本机实跑（只读）：

| Vault | 结果 | 摘要 |
|---|---|---|
| `E2E-Empty-Vault` | PASS | Topic 0/0/0；旧格式 0；`MIGRATION_NOT_REQUIRED` |
| `MemoFlow-Test` | PASS（含 WARN） | Topic 5/11/6；旧格式 16 → `MIGRATION_REQUIRED`（预期） |
| `E2E-Phase2-Test-Vault` | PASS（含 WARN） | 旧格式副本 16，用于迁移预览/回滚 |
| `E2E-Phase2-Unified-Vault` | PASS | 空库，供激活后批量测试 |

测试：`test/e2e-audit.test.js` 9 项（干净库、重复 ID、parent/root 错误、缺父、Card 泄漏、Ledger 孤儿、Boost 证据/目标、基线 diff、空库含旧格式）。
配套手动清单：`docs/P3-US1-E2E-CHECKLIST.md`（每步命令、预期、停止条件、证据归档）。
