# P3-02A — 安全激活与迁移宿主接线（实施记录）

任务：P3-02A｜基线：`personal/main = 4bba262`（PR #38 已合并）
分支：`feat/p3-us1-activation`
范围：G1 激活协调层、G2 模式管理、G3 迁移宿主接线、G4 激活诊断一致性；未重写 Runtime/CAS/Ledger/Batch/调度算法。

---

## 1. Phase 1 + Phase 2 基线核实

| 项 | 证据 |
|---|---|
| Phase 1 分支已合并 | `git branch -r --merged personal/main` 包含 `personal/feat/phase1-child-extract`、`personal/fix/p1-nav-1` |
| 多级 Extract 代码在基线 | `main.js` 含 `_writeExtract` / `extractSelection`；`mf_parent_id` 在 `main.js` 与 `topic-creation-host.js` 中用于父子/根关系 |
| Phase 2 宿主接线同一基线 | `4bba262` 是 PR #38 merge，1af865f 祖先；26 条入口矩阵与 1413 测试为合并后基线 |
| 结论 | Phase 1 与 Phase 2 已在同一代码基线，无未合并冲突 |

---

## 2. G1 — 受控激活协调层

新增 `src/integration/activation-coordinator.js`：

- **六项条件由真实证据推导**：`migrationComplete`（迁移计划 summary 全清）、`pendingRecovery`（恢复待处理事件）、
  `singleWriterReady`、`backupVerified`、`userConfirmed`、`storageSupportsCas`。
- **阻断项覆盖**：`MIGRATION_INCOMPLETE`、`PENDING_RECOVERY`、`RECOVERY_UNHEALTHY`、`BATCH_RECOVERY_UNKNOWN`、
  `BLOCKED_TOPICS`、`TOPIC_ID_CONFLICT`、`BACKUP_NOT_VERIFIED`、`USER_CONFIRMATION_REQUIRED`、`STORAGE_WITHOUT_CAS`。
- **会话级授权默认拒绝**：`authorize()` 只有在全部条件满足**且**注入的 `approvalProvider` 返回 true 时才签发 token。
  生产环境不注入 approval provider → 永远 `ACTIVATION_NOT_APPROVED`，**本轮无任何生产 Token 签发路径**。
- **撤销与失败关闭**：`revoke()` 清空会话 token，`isAuthorized()` 立即为 false；token 不可复用。
- **合成环境**：测试通过 `plugin.__mfUs1ActivationApproval` 注入受控审批，激活时额外签发 `issueSyntheticUnifiedCapability()` 供隔离 harness 写入。

宿主接线（`main.js`）：

- `_mfUs1RebuildAsyncLifecycle({ mode, conditions, authorization, capability })`：按激活结果重建真实异步 lifecycle；
- `mfUs1ActivateUnified()`：推导证据 → 协调器授权 → 重建 runtime → 写入 `mf_us1_mode='unified'`；
- `mfUs1RevokeActivation()`：存在未决事件/批次或阻断 Topic 时**拒绝撤销并保留现场**；否则撤销 token、重建 legacy runtime、回到 Legacy（先核对权威状态）。

## 3. G2 — 模式管理

- `DEFAULT_SETTINGS` 新增 `mf_us1_mode: 'legacy'`（默认 Legacy，旧数据零迁移）。
- 设置菜单：Legacy / Shadow 直接切换；Unified 走 `mfUs1ActivateUnified()`（显示真实阻断原因，不显示为可选已启用）。
- UI / Host Service / Runtime 共用同一状态源：`_mfUs1EffectiveMode()`；Host Service 在激活后由新 runtime 提供 transport。
- **无法通过修改 settings 绕过授权**：即使手工把 `mf_us1_mode` 写成 `unified`，Runtime 仍因缺条件/授权 token 拒绝写入。

## 4. G3 — 迁移宿主接线（合成环境）

新增 `src/integration/migration-host.js`，复用既有纯模块，不重写算法：

```
previewMigration → createMigrationBackup → verifyMigrationBackup + verifyPlanBackupCorrespondence
→ executeMigration → reconcileMigrationBatch → previewRollback → rollbackMigration
```

- 仅接受模块注册的 `MemoryStorage` / `MemoryBackupStore`（底层 `assertTrustedStorage` 强制），**物理上不可能写真实 Vault**。
- 授权为 `{ environment:'memory', authorized:true, batchId }`；缺失即 `E_MIGRATION_UNAUTHORIZED`。
- 宿主入口 `mfUs1SyntheticMigrationDrill({ snapshots })`：生产无 `__mfUs1MigrationAuthorization` → `E_MIGRATION_NOT_OPEN`；
  只接受显式合成快照，**不读取真实 Vault**。
- 支持部分失败（写入异常 → 批次失败/阻断，不报告成功）、重复执行（不产生第二个身份）、备份校验与回滚。

## 5. G4 — 激活诊断一致性

`main.js#mfUs1ActivationDiagnostics()` 现在准确区分：

- `transportSource`: `test-injected` / `lifecycle-runtime` / `none`；
- `runtime`: `{present, mode, allowed, writeEnabled, blockers}`；
- `activationBlockers`（条件类）与 `migrationPreviewed` / `recoveryHealthy` / `batchRecoveryError` / `duplicateIds` / `blockedTopicIds` 分开呈现。

诊断菜单新增一行「激活状态：transport=… · runtime=… · blockers=…」。

---

## 6. 文档安全规则修正

1. **Unified 异常时不得简单切回 Legacy 继续旧字段写入。**
   撤销/异常处理必须：停止写入 → 保留 Ledger/Batch/文件现场 → 核对权威状态（recovery/batch reconcile）→
   确认无未决项后才允许切回 Legacy。本实现中 `mfUs1RevokeActivation()` 在存在未决事件、未决批次或阻断 Topic 时直接拒绝撤销。
2. **迁移回滚是跨文件非原子操作。**
   部分回滚失败必须保持阻断、保留日志与备份，不得报告"完全回滚成功"。
   `rollbackMigrationBatch()` 返回逐项结果；宿主报告只能按实际 `counts` 陈述，失败项必须显式列出。

---

## 7. 测试与构建（实际执行）

```
node --test test/*.test.js                       1426 pass / 0 fail
新增 test/mf-us-1-activation.test.js              8 pass
  - 条件缺失逐项阻断 / 生产无 approval 无法签发 / 撤销后不可复用
  - 宿主无 approval 拒绝激活；批准后 runtime 授权并成功执行一次 Unified 事件（Ledger 1 条）
  - 撤销：无未决时成功回 Legacy；有未决时拒绝且不静默降级
  - 诊断区分 transport 缺失 vs runtime 未授权
新增 test/mf-us-1-migration-host.test.js          5 pass
  - preview→backup→verify→apply→reconcile→rollback（回滚恢复原始字节）
  - 二次 apply 不产生第二个 mf_id
  - 注入写入失败 → 硬停止，不虚假成功
  - 缺授权回滚拒绝
  - 宿主入口无合成能力拒绝、无快照拒绝、有快照成功
scripts/validate-release.mjs                      valid
scripts/build.mjs --dry-run                       no files written
scripts/build.mjs                                 成功；dist 含 ACTIVATION_NOT_APPROVED / mfUs1ActivateUnified /
                                                  runSyntheticMigration / RUNTIME_AUTHORIZATION_REQUIRED
```

---

## 8. 未完成 / 生产激活仍缺的代码

| 项 | 说明 |
|---|---|
| 真实 Obsidian 迁移存储适配器 | 现有迁移执行只接受 `MemoryStorage`；真实 Vault 迁移需要单独授权的适配器 + 备份存储（本轮禁止） |
| 生产审批路径 | 当前 approval provider 只能测试注入；生产需要所有者明确开关 + UI 确认（本轮禁止签发） |
| 激活 UI/UX | 本阶段仅菜单与诊断；正式 Release Candidate 前需专门 UI 阶段 |
| 实机验收 | 未启动 Obsidian，未创建/写入测试 Vault；按 P3-US1-READINESS-PLAN §4/§5 执行 |

## 9. 安全边界确认

未启动 Obsidian 实机；未访问/创建真实 Vault、`MemoFlow-Test`、`phase2 test`；未执行真实迁移；
未启用生产 Unified（无 approval provider，无 token 签发）；未创建或合并 PR；未改写历史。


## 10. 审查修复（f90da41 之后）：撤销与回退分离

原实现把「撤销授权」与「切回 Legacy」合并，存在安全缺陷：出现 uncertain/未决批次时拒绝撤销会让已签发 Token 继续有效。

现已拆分为两个动作：

1. **`mfUs1RevokeUnifiedAuthorization()`（立即撤销能力）**
   - 立即 `coordinator.revoke()` 使会话 Token 失效，设置 `mfUs1Suspended=true`；
   - 不重建 lifecycle、不写 Topic、不写 Ledger、不写 Batch（现场完全保持）；
   - Host Service 的 unified transport 在暂停态直接抛 `E_UNIFIED_NOT_AUTHORIZED`；
   - Mercy / 创建网关 / 批次 Resume 等独立 Unified 入口同样在暂停态拒绝；
   - 模式保持 `unified`（不会静默回退 Legacy）。
2. **`mfUs1SwitchToLegacy()`（回退）**
   - 先计算未决状态（未决事件 / 未决批次 / 阻断 Topic）；
   - 存在未决项：**拒绝回退**，保持 `mfUs1Suspended`，Legacy 调度写入由 guard 阻断（保留现场，等待恢复核验）；
   - 无未决项：撤销 Token、解除暂停、重建 legacy lifecycle、写 `mf_us1_mode='legacy'`。
3. `mfUs1RevokeActivation()` 保留为 `mfUs1SwitchToLegacy()` 的兼容别名。

重新激活必须重新审批：协调器 `revoke()` 后会话为空，`mfUs1ActivateUnified()` 会再次调用 approval provider；
测试用一次性 approval 证明撤销后的 Token 不可复用、恢复健康也不会自动重新激活。

合成能力签发审计：`issueSyntheticUnifiedCapability()` 只在 `mfUs1ActivateUnified()` 的批准分支内调用；
模式菜单/设置路径不包含任何 token 或 approval provider 赋值（静态测试断言）。

新增测试（3 项）：紧急撤销后 Token 失效、Topic/Ledger 零修改、Legacy 写入阻断；
恢复后必须重新审批且不复用旧 Token；菜单无法绕过审批签发合成能力。
