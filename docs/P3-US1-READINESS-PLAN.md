# MemoFlow 1.0 — Phase 3 就绪审计与安全激活计划

任务：P3-US1-READINESS-01
基线：`personal/main` = `4bba262`（Merge pull request #38）
本轮范围：只读审计、离线回归与构建、方案文档。**未启动 Obsidian、未访问任何真实 Vault、未执行迁移、未激活 Unified。**

---

## 0. 结论摘要

1. PR #38 已合并：`4bba262`，`1af865f` 已确认是其祖先；合并后全量 **1413 pass / 0 fail**，`validate-release` valid，`build --dry-run` 干净。
2. **仓库内 `dist/memoflow/main.js` 是陈旧产物**：tracked 版本 473,410 字节、`mf_ideal_due` 出现 0 次；本地真实构建产物 1,191,740 字节，包含全部 MF-US-1 宿主模块。**任何实机验收/发布前必须用合并后基线重新构建 dist。**
3. 生产 Unified 写入**在代码层面仍不可达**：授权 token 只存在于测试用 instance 字段（`__mfUs1UnifiedTransport` / `__mfUs1CreationAuthorization` / `__mfUs1ResumeAuthorization` / `__mfUs1AdminAuthorization`），生命周期固定传 `conditions: {}`，因此运行时永远返回 `RUNTIME_AUTHORIZATION_REQUIRED` 等阻断项。
4. 迁移模块**不止 preview**：`migration-execute.js` 已实现 `executeMigration / previewRollback / rollbackMigration / reconcileMigrationBatch`，`migration-backup.js` 已实现备份/校验/计划对应性校验；但宿主只接入了 `previewMigration`，**apply / verify / rollback 未接线到 UI 或命令**。
5. 最小代码缺口是**一层受控激活与迁移接线**（约 5 个具体改动，见 §3），不是重写 Runtime/Writer/Batch。
6. 下一步在一次性隔离 Vault 中按 §4/§5 执行验收；需项目负责人授权清单见 §6。

---

## 1. Git 与测试基线

### 1.1 Git

| 项 | 值 |
|---|---|
| 远程 | `ssh://git@ssh.github.com:443/hwp1412/memoflow.git`（`personal`） |
| `personal/main` | `4bba262 Merge pull request #38 ...` |
| PR #38 头 | `1af865f`（`git merge-base --is-ancestor 1af865f personal/main` = true） |
| Phase 2 关键提交 | `e711df3`(P0) → `ea9bf77` → `1c7a1b3` → `0ebf289` → `f152ec4` → `874e07e` → `6c06e32` → `61f7648` → `7bcd40f` → `dffcfd9` → `648b069` → `a6446e0` → `1af865f` → `4bba262`(merge) |
| 工作区 | 合并后工作树干净（`git status` 无输出） |

### 1.2 自动化回归（在 4bba262 上实际执行）

```
node --test test/*.test.js        1413 pass / 0 fail
TZ=UTC node --test test/*.test.js 1413 pass / 0 fail
scripts/validate-release.mjs      Release metadata and assets are valid.
scripts/build.mjs --dry-run       [dry-run] no files were written.
scripts/build.mjs                 成功（dist/memoflow/main.js 1,191,740 bytes）
```

### 1.3 构建产物与部署路径

| 项 | 值 |
|---|---|
| 构建入口 | `src/main.js`（esbuild bundle → `dist/memoflow/main.js`） |
| 产物 | `dist/memoflow/main.js`、`dist/memoflow/manifest.json`、`dist/memoflow/styles.css` |
| 部署路径 | `<vault>/.obsidian/plugins/memoflow/`（复制上述三个文件，`data.json` 保留） |
| 根 `manifest.json` | 上游 fork 元数据：`incremental-reading-toolkit` / `1.1.8`（不用于 MemoFlow 发布） |
| `dist/memoflow/manifest.json` | `id: memoflow` / `version: 0.1.0` / `isDesktopOnly: false` |
| tracked dist 来源 | `d965cb8 Publish chunk: built plugin dist`（Phase 2 之前） |
| tracked dist 内容 | 473,410 bytes；`mf_ideal_due` 出现 **0** 次 |
| 新构建内容 | 1,191,740 bytes；`mfUs1Batches`、`buildUnifiedQueue`、`mf-split:`、`mfUs1ShadowLast`、`mfUs1MigrationPreview`、`E_BOOST_EVENT_ID_REQUIRED` 等均在 dist 中 |

> **结论**：旧 dist 不能用于实机验收；发布前必须执行一次 `node scripts/build.mjs` 并提交/发布新 dist（属发布动作，需授权）。

---

## 2. 生产激活链路（现状）

```
用户操作（菜单/命令）
  → _mfUs1EffectiveMode()  ← settings.mf_us1_mode（默认无此键 → legacy）
  → _mfUs1HostService()
       mode 判断 → HostSchedulerService.execute(descriptor, legacy)
  ┌───────────────┬───────────────────────────────┬──────────────────────────────┐
  │ legacy        │ shadow                        │ unified                      │
  │ 旧 Writer 直接写 │ 旧 Writer 写 + 只读 observer   │ transport 必须存在：           │
  │               │ （mfUs1ShadowLast 差异诊断）    │  __mfUs1UnifiedTransport     │
  │               │                               │  || asyncLifecycle.runtime   │
  │               │                               │ → AsyncHostRuntime.execute   │
  │               │                               │ → evaluateHostRuntime 门禁    │
  └───────────────┴───────────────────────────────┴──────────────────────────────┘
                                                        │
                                     6 条件 + 合成授权 token（WeakSet）
                                                        │
                                        per-Topic lock → intent → CAS → readback → ledger
```

### 2.1 授权与门禁的真实来源

| 环节 | 生产是否可达 | 依据 |
|---|---|---|
| `settings.mf_us1_mode='unified'` | 否（无默认值、无设置 UI；模式菜单拒绝 Unified） | `main.js:4403` 模式菜单；未在默认设置中定义 |
| Host 授权 token | 否（仅 `issueSyntheticHostAuthorization()` 可签发，WeakSet） | `src/integration/host-runtime.js:16-30` |
| Runtime 6 条件 | 否（onload 固定 `conditions: {}`） | `main.js:2932`；条件项见 `runtime-mode-guard.js:29-37` |
| Unified transport | 测试字段优先；否则取 `mfUs1AsyncLifecycle.runtime`（该 runtime 仍会因缺 token 拒绝） | `main.js:3931` |
| 受保护 admin writer（Mercy） | 否（需 `__mfUs1AdminAuthorization`） | `main.js:2928` |
| 创建网关（Source/Extract） | 否（需 `__mfUs1CreationAuthorization`） | `main.js:4706` |
| Resume（批次继续） | 否（需 `__mfUs1ResumeAuthorization`） | `main.js:4441` |
| 批次 Reconcile | 是（只读、仅写批次元数据，不需 token） | `main.js` onload reconcile；`batch-recovery.js` |
| 迁移 preview | 是（只读） | `main.js:4358` |

### 2.2 迁移能力现状

| 能力 | 代码 | 宿主接线 |
|---|---|---|
| 计划/字段 Diff/preview | `migration-plan.js#previewMigration` | ✅ 菜单「Migration preview (read-only)」 |
| 备份创建/校验/计划对应性 | `migration-backup.js`（`createMigrationBackup`、`verifyMigrationBackup`、`verifyPlanBackupCorrespondence`） | ❌ 未接线 |
| 执行 | `migration-execute.js#executeMigration` | ❌ 未接线 |
| 回滚 | `previewRollback`、`rollbackMigration` | ❌ 未接线 |
| 批次恢复核对 | `reconcileMigrationBatch` | ❌ 未接线 |
| 真实 Vault 迁移 | 禁止 | — |

### 2.3 恢复与健康检查

- onload 顺序：`initializeHostLifecycle`（legacy facade，记账共用协调器）→ 真实 Async Storage/Ledger → `initializeAsyncHostLifecycle(... conditions:{})` → `mfUs1Recovery{healthy,recovered,blockedTopicIds}` → `reconcileBatches()` → 合并 blocked topics → 诊断菜单显示。
- 单 Topic ledger recover 与 Batch Reconcile 均**只读恢复判定**；冲突/未知状态会阻断对应 Topic（`mfUs1Recovery.blockedTopicIds`）。
- 未实现：启动时若发现未决批次，仅提示 + 手动「Resume pending batches…」（需 token，生产不可用）。

---

## 3. 已完成 vs 真实缺口（最小改动）

### 3.1 已实现、仅缺授权（不需新代码或极小接线）

| 能力 | 证据 |
|---|---|
| Unified 事件执行链（lock/intent/CAS/readback/ledger/persist） | `host-async-runtime.js`、`host-async-executor.js`、`host-async-storage.js` |
| Host facade 统一入口与 6 条件门禁 | `host-scheduler-service.js`、`host-runtime.js`、`runtime-mode-guard.js` |
| 受保护 Mercy 写入（CAS + revision + 授权） | `protected-topic-writer.js` |
| 创建网关（Source/Extract/Card 隔离） | `topic-creation-host.js` |
| 批次存储 / Reconcile / Resume / Undo 凭证 | `batch-store.js`、`batch-recovery.js`、`batch-resume.js` |
| 拆分经创建网关、导入归迁移域 | `main.js#splitArticle/splitBook/importClipping` |
| Shadow 只读 observer | `main.js#_mfUs1ShadowObserve` |
| Unified Dashboard/Queue/Session 数据源 | `src/data/model.js`、`unified-queue-source.js` |
| Legacy/Shadow 回归与 26 入口矩阵 | `docs/P2-US1-HOST-CLOSURE-MATRIX.md` |

### 3.2 真实代码缺口与最小改动

| 编号 | 缺口 | 最小改动 | 测试 |
|---|---|---|---|
| **G1** | 无生产授权签发层：6 条件无法由真实数据推导，token 无持久/撤销机制 | 新增 `activation-authorization.js`：从迁移报告/备份校验/恢复健康/CAS 探测计算 6 条件；token 仅内存持有、会话级、可在模式切换时撤销；**默认不签发** | 单测：条件缺失→阻断；全部满足+显式 owner 开关→放行；撤销后 fail-closed |
| **G2** | `mf_us1_mode` 无默认值/无设置 UI，模式菜单不联动条件 | 在默认设置中加入 `mf_us1_mode:'legacy'`；设置页加入模式选择（Legacy/Shadow/Unified(disabled+原因)）；菜单读取同一 `activationBlockers` | 设置/菜单单测；切换后 host service 重建 |
| **G3** | 迁移 apply/verify/rollback 未接线 | 新增命令：备份→执行→校验→失败回滚（全部要求 owner 显式确认 + 备份 SHA）；接线 `migration-execute.js` 已有 API，不重写算法 | 合成 Vault/Mock：happy path、部分失败、幂等、回滚 |
| **G4** | `mfUs1ActivationBlockers` 与实际 transport 来源不一致（只查 `__mfUs1UnifiedTransport`） | 改为检查 `_mfUs1HostServiceTransport()`（与运行期同源） | 单测：lifecycle 存在但无授权 → `RUNTIME_AUTHORIZATION_REQUIRED` 而非 `E_NO_HOST_TRANSPORT` |
| **G5** | tracked dist 陈旧（Phase2 前） | 发布流程：合并后重建 dist 并作为发布附件；测试 Vault 只安装新 dist | 构建后 grep 全部 MF-US-1 标记（已脚本化） |
| **G6** | `__mfUs1AdminAuthorization` 等测试字段是唯一授权注入点 | 由 G1 的 activation 层在激活后持有并注入，测试字段保留但不再唯一 | 同上 G1 |
| **G7** | 未决批次启动时无自动处理入口（生产 token 缺失） | 保持手动：诊断显示 + 阻断；激活后由 G1 注入 resume token 后可用 | 恢复演练（§4-10） |

> 明确**不需要**：新 Runtime、新 Writer、第二套 Ledger/Batch WAL、SR/Phase1 算法改动。

---

## 4. 隔离 Obsidian 验收清单（一次性合成 Vault）

**每个用例的前置**：全新 Vault（不含真实数据）、仅安装本轮新构建的 `dist/memoflow/{main.js,manifest.json,styles.css}`、`data.json` 由测试初始化、关闭 Obsidian SR 同步类插件（Card 用例除外）。
**日志证据**：`data.json` 快照、`mfUs1Ledger` 与 `mfUs1Batches` dump、诊断菜单文本、Vault 文件 hash、Obsidian 控制台输出。

### V1. Legacy 回归
- 前置：legacy 模式（默认）。
- 动作：导入剪藏→创建 Source/Extract→评阅→延期→排期→优先级→完成→移出→REACTIVATE→Mercy（legacy Writer）→Boost。
- 预期：与 1.1.8 行为一致；文件出现 `next_review/interval/a_factor/review_count`；`mf_*` 不被写入；无 Unified Ledger 记录。
- 停止：任何 Unified 字段出现 / ledger 出现记录。
- 证据：前后 frontmatter diff、`mfUs1Ledger` 为空、诊断模式=legacy。

### V2. Shadow 只读
- 前置：设置 `mf_us1_mode=shadow`（菜单切换）；准备已迁移与未迁移混合数据。
- 动作：执行评阅/延期/完成/Boost。
- 预期：Legacy 写入照常；诊断显示「Shadow 最近差异」；`mf_*`/Ledger 不新增。
- 停止：出现任何 `mf_*` 变更或 Ledger 记录。
- 证据：`mfUs1ShadowLast` 快照 + 文件 diff。

### V3. 合成授权 Unified 写入演练（仅隔离环境）
- 前置：owner 明确授权；注入合成 token（仅测试构建/测试入口），`mf_us1_mode=unified`。
- 动作：对已迁移 Topic 执行 ADVANCED/POSTPONE/MANUAL_SCHEDULE/SET_PRIORITY/COMPLETE/DISMISS/REACTIVATE。
- 预期：每事件恰好一条 Ledger 记录（applied）；`mf_revision+1`；interval/A-Factor/review_count 按规范；失败时 fail-closed 零写入。
- 停止：任一无 Ledger 的 `mf_*` 变更 / 双写。
- 证据：Ledger dump、revision 序列、`data.json` 队列/会话状态。

### V4. Source / 多级 Extract / Card 混合
- 动作：Source→Extract→Extract(二级)→Card；分别触发各操作。
- 预期：Extract 的 `mf_parent_id` 指向直接父级、`mf_root_id` 指向 Source；Card 完全走 SR、不进 MF-US-1 Writer。
- 停止：关系错误 / Card 出现 `mf_*`。
- 证据：层级 dump、Card 文件 diff。

### V5. 操作事件全集
按 V3 事件逐项确认；额外确认 SKIP 只动会话指针。

### V6. Subtree Postpone / Boost / Mercy Apply+Undo
- 动作：子树延期（父+子）；Boost（绝对目标）；Mercy（预览→确认→应用→撤销）。
- 预期：Boost 批次 `eventIds` 在写入前持久化；重复提交不重复写；Mercy 撤销使用持久 revision CAS，外部改 revision 后撤销 conflict。
- 停止：批次记录缺失 eventIds / 二次递减 / 撤销售后文件被改。
- 证据：`mfUs1Batches` dump（targets/eventIds/revisions）、Ledger。

### V7. Dashboard / Queue / Session 刷新
- 动作：改优先级、Mercy、Postpone、COMPLETE 后观察 Dashboard 队列与会话。
- 预期：刷新后顺序/到期由 `mf_*` 决定；未迁移 Topic 显示诊断排除；Card 计数走 SR。
- 停止：出现 `next_review` 驱动排序。
- 证据：模型快照/截图、诊断文本。

### V8. MetadataCache 与 Vault.process 一致性
- 动作：连续快速写入 + 立即读 metadataCache；与文件真实内容比对。
- 预期：CAS 校验通过；readback hash 一致；无「metadata 与 bytes 不一致」。
- 停止：CAS 通过但读回不一致（数据损坏级）。
- 证据：hash 前后值、日志。

### V9. Intent / CAS / Ledger / Batch Store 持久化
- 动作：写入过程中强制结束 Obsidian（模拟崩溃：关闭进程/断网可复现项）。
- 预期：重启后单 Topic recover + Batch Reconcile 给出 applied/pending/conflict/unknown；不重复执行。
- 停止：自动重放增量 / uncertain 被报成功。
- 证据：重启前后 dump、诊断菜单。

### V10. 关闭重开恢复
- 动作：正常关闭→重开→再次诊断+队列。
- 预期：`mfUs1Recovery.healthy` 正常；未决批次进入手动恢复入口且不自动写。

### V11. 迁移预检/备份/转换/验证/失败恢复/重复执行
见 §5；在隔离 Vault 中逐阶段执行，禁止在真实 Vault 运行。

### V12. 未授权/冲突/未知状态零写入
- 动作：无 token 尝试 Unified 操作；制造 revision 冲突、损坏批次记录、重复 mf_id。
- 预期：全部 fail-closed；Notice 说明原因；文件 hash 不变。
- 停止：任何一次「提示失败但发生写入」。
- 证据：hash 对比 + 错误码。

---

## 5. 迁移演练（合成 Vault）

### 5.1 阶段

1. **预检（只读）**：`previewMigration` → 生成 `summary`（total/migratable/manualReview/conflict/alreadyMigrated）+ 字段级 `fieldsToAdd` Diff。
2. **备份**：`createMigrationBackup` → 记录 backupId/planHash/SHA-256；`verifyMigrationBackup` + `verifyPlanBackupCorrespondence` 必须通过。
3. **唯一性与关系校验**：`mf_id` 不得重复（与现有 persistent id 冲突 → conflict）；Extract `parent/root` 必须能解析到同一 Source；Card 一律跳过。
4. **执行**：`executeMigration` 仅处理 `migratable` 条目；`next_review` **不得**无条件覆盖 `mf_ideal_due`——只在规范允许的初始映射下生成，已有 `mf_*` 的 Topic 不重算、不覆盖。
5. **验证**：逐条 readback（hash、revision、relation、interval/ideal_due）；`reconcileMigrationBatch` 核对。
6. **失败恢复**：任一条失败 → 停止后续批次；`previewRollback` 生成回滚计划；在备份校验通过后 `rollbackMigration`；不允许部分回滚留下半迁移 Topic。
7. **幂等**：同一 plan 重复执行必须全部 already-migrated/skipped，不生成第二身份。
8. **回滚**：恢复备份内容 + 清理由本批次产生的临时账本条目（仅限迁移域），文件 hash 回到迁移前。

### 5.2 禁止事项

- 不得在真实 Vault / MemoFlow-Test / `phase2 test` 执行。
- 不得把旧 `next_review` 同步覆盖 `mf_ideal_due` 或 `mf_not_before`。
- 不得覆盖既有 Ledger 身份/Revision。
- 迁移 apply 必须由 owner 显式确认（G3 接线后）。

---

## 6. 必须由项目负责人授权的操作清单

1. 创建一次性隔离 Obsidian Vault（合成数据）。
2. 在隔离 Vault 安装本轮新构建的 dist（`dist/memoflow/*`）。
3. 启动 Obsidian 实机（仅该隔离 Vault）。
4. 在隔离环境注入合成授权 token（测试构建/测试入口）。
5. 在隔离 Vault 执行迁移备份→apply→verify（含回滚演练）。
6. 生产 Vault 的 Unified 激活（需 G1–G4 完成后另行审批）。
7. 重建并发布 dist/Release 附件（版本号、changelog、tag）。
8. 任何真实 Vault 的读写或真实迁移（本阶段一律禁止）。

---

## 7. 失败停止与回滚规则

### 停止条件（立即停止本轮验收并保留现场）

- 任何「提示失败但文件被写入」或「无 Ledger 的 `mf_*` 变更」。
- CAS 通过但 readback 与文件 bytes 不一致。
- 重复 mf_id 写入成功、关系错挂（Extract 指向错误 root）。
- 批次重复执行/二次递减、uncertain 被显示为成功。
- 迁移中途出现无法对应备份的 hash。
- Obsidian 崩溃后重启出现自动重放增量。

### 回滚

| 场景 | 回滚 |
|---|---|
| 单次事件写入异常 | 停止操作；用诊断显示 blocked topic；不手工改 mf_*；按台账恢复 |
| 批次未决 | 不进自动重放；等 owner 决定；必要时从 `mfUs1Batches` 与 Ledger 判定后手动恢复 |
| 迁移失败 | 停止；`previewRollback`→`rollbackMigration`；校验备份 SHA 与文件 hash |
| 测试 Vault 污染 | 丢弃该一次性 Vault，重新创建（不尝试清理） |
| 生产环境异常（未来） | 立即切回 `mf_us1_mode=legacy`（设置级），停止 Unified 写入，保留 ledger/batch 现场供审计 |

---

## 8. MemoFlow 1.0 发布验收标准

### A. 代码/离线（当前已满足）

- [x] 全量测试 1413 pass、UTC 同样通过
- [x] `validate-release` valid、`build --dry-run` 干净
- [x] 真实构建 dist 包含 MF-US-1 宿主模块
- [x] 26 条入口矩阵全部有最终状态（无「仅 Guard 标完成」）
- [x] 无已知数据损坏级缺陷

### B. 激活层（未满足，需 G1–G4）

- [ ] 生产授权层可计算 6 条件、签发/撤销会话级 token、default=拒绝
- [ ] 模式设置在 UI 可见，Unified 显示不可激活原因
- [ ] 迁移 apply/verify/rollback 在隔离 Vault 全流程通过
- [ ] `mfUs1ActivationBlockers` 与运行期 transport 同源

### C. 实机验收（需授权，未执行）

- [ ] §4 全部 12 组在一次性隔离 Vault 通过，证据归档
- [ ] §5 迁移演练通过（含失败恢复、幂等、回滚）
- [ ] 关闭/重开 Obsidian 后恢复行为正确
- [ ] 生产激活前完成一次「备份→迁移→验证→激活→回滚演练」彩排

### D. 发布（需授权）

- [ ] 重建 dist 并核对 manifest/version/tag
- [ ] Release 附件（main.js/manifest.json/styles.css）与构建一致
- [ ] 更新 CHANGELOG 与安装说明

---

## 9. 附录：本轮审计证据（可复现命令）

```bash
# Git 基线
git log --oneline -3 personal/main
git merge-base --is-ancestor 1af865f personal/main && echo ancestor-ok

# 回归与构建
node --test test/*.test.js
TZ=UTC node --test test/*.test.js
node scripts/validate-release.mjs
node scripts/build.mjs --dry-run
node scripts/build.mjs

# 陈旧 dist 证据
git show HEAD:dist/memoflow/main.js | wc -c          # 473410
git show HEAD:dist/memoflow/main.js | grep -c mf_ideal_due  # 0
grep -c mf_ideal_due dist/memoflow/main.js           # 新构建 >0

# 授权 token 仅测试字段
grep -rn "__mfUs1UnifiedTransport\|__mfUs1CreationAuthorization\|__mfUs1ResumeAuthorization\|__mfUs1AdminAuthorization" src/ main.js

# 迁移能力
grep -n "module.exports" -A 8 src/scheduling/migration-execute.js
grep -n "module.exports" -A 6 src/scheduling/migration-backup.js
grep -n "previewMigration\|executeMigration" main.js

# 6 条件
sed -n '25,40p' src/scheduling/runtime-mode-guard.js
```

### 关键源码位置

| 主题 | 位置 |
|---|---|
| 模式判断 | `main.js#_mfUs1EffectiveMode`（约 3976） |
| Host service 与 transport | `main.js#_mfUs1HostService`（约 3925-3945） |
| 激活阻断项 | `main.js#mfUs1ActivationBlockers`（约 4391） |
| 模式菜单 | `main.js#mfUs1ModeMenu`（约 4403） |
| 生命周期初始化 | `main.js:2896-2945` |
| 迁移预览 | `main.js#mfUs1MigrationPreview`（约 4355） |
| Runtime 门禁 | `src/scheduling/runtime-mode-guard.js#evaluateRuntimeMode` |
| 迁移执行/回滚 | `src/scheduling/migration-execute.js` |
| 迁移备份 | `src/scheduling/migration-backup.js` |
| 批次恢复 | `src/integration/batch-recovery.js`、`batch-resume.js`、`batch-store.js` |
| Shadow observer | `main.js#_mfUs1ShadowObserve`（约 4100） |
