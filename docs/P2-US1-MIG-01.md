# P2-US1-MIG-01 — Migration Preview, Backup, Recovery & Stable UUID Initialization

- 任务 ID：`P2-US1-MIG-01`
- 状态：本地实现 + 合成测试完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ bf5c98c`（PR #21 合并后）
- 分支：`feat/phase2-mf-us-1-migration`
- 本地 commit：见验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A2、A10.2、A11、A13）

## 1. 范围与非范围

**范围**：只读迁移预览、固定 UUID 初始化计划、精确内容备份、注入式内存存储上的迁移执行、失败恢复与回滚。

**非范围**：真实 Vault 扫描/写入、Obsidian 集成、真实 UUID 落盘、Unified 接管、发布。所有执行只针对 `MemoryStorage`；真实存储适配器需后续 PR 单独评审。

## 2. 输入 / 输出契约

```js
previewMigration(snapshots, context, options)   // 纯预览，writesPerformed:false
createMigrationBackup(plan, storage, backupStore, {batchId})
executeMigration(plan, storage, authorization, backupStore)
previewRollback(batch, currentSnapshots)
rollbackMigration(batch, storage, authorization)
reconcileMigrationBatch(batch, storage)
```

- `snapshots`：调用方提供的原始元数据快照（可含 `content` 原文、`path`、`basename`、`mf_*`）；解析复用 PR-06 适配器与关系模块。
- `context`：必须显式提供 `dateFormat`；不读系统时钟、不读文件系统。
- `options`：`snapshotId`、`uuidAllocator`（注入式确定性分配器）、`createdAt`（显式审计时间，可选）。
- 迁移执行必须提供 `authorization = {environment:'memory', authorized:true, batchId}`；其他环境、`authorized!==true`、`mode:'unified'` 一律拒绝。
- **存储可信性**：只接受本模块通过私有 `WeakSet` 注册的 `MemoryStorage` 与 `MemoryBackupStore`。带 `getFile/write`、`environment='memory'`、`authorized=true` 的普通对象在读取前即被 `E_STORAGE_UNTRUSTED` / `E_BACKUP_STORE_UNTRUSTED` 拒绝（测试用 spy 证明零读取/零写入）。

## 3. 分类

| 状态 | 含义 |
|---|---|
| `migratable` | 字段/身份/关系安全，可加入执行集合 |
| `already-migrated` | 没有需要新增的现代字段 |
| `manual-review` | 需要人工裁决（临时身份未分配 UUID、关系未验证、UUID 冲突等） |
| `blocked` | 数据非法或不支持（坏日期、缺失 Priority、`inbox/pending/container`、Card） |
| `conflict` | 新旧字段矛盾或重复身份 |

不合法、歧义、重复 ID、关系不明的记录**不会**进入执行集合；单条异常不影响其他记录。要执行 `migratable` 的记录还必须携带精确 `content`（预览时计算 hash）；缺内容/无法合并 Frontmatter 的记录降为 `manual-review`/`blocked`。

## 4. 字段映射（严格 A10.2）

- 合法旧 `next_review` → `mf_ideal_due`；旧 `interval` → `mf_interval_days`；`a_factor`、`review_count` 原样保留；
- `review_count=0` 但已有合法 interval 的旧数据**不重算**首次间隔；
- 旧 `next_review` 与现代字段冲突 → `conflict` 并阻塞；
- 已有合法 `mf_not_before` 原样保留（before/after 都使用实际值，Effective Due 取 max）；仅当历史没有该字段时才写 `null` + `NOT_BEFORE_NOT_RECOVERABLE`；
- 旧 interval 可能含行政操作 → `LEGACY_INTERVAL_MAY_INCLUDE_ADMINISTRATIVE_VALUE`；
- 不推测恢复被旧 Mercy/postpone 污染的间隔；
- 每条记录给出 Before/After 的 Ideal Due、Not Before、Effective Due 与 Interval/A-Factor/Priority/review_count，并断言 Effective Due 前后一致；不一致 → `blocked`；
- 只新增缺失字段，不静默覆盖现存合法现代字段。

## 5. 稳定 UUID 初始化

- 已有合法 `mf_id` 保持不变；
- 缺失正式 ID 的记录通过注入式 `uuidAllocator` 生成 RFC 4122 UUIDv4（实际执行须使用可靠随机源；路径哈希永不作永久 ID）；
- 分配结果固定写入计划并被 `planId` 哈希覆盖：重试执行同一计划不会产生第二组身份；
- 检测与既有 ID、本批其他分配的冲突（大小写不敏感）；
- 临时身份 `temp-<hash>` 仅用于只读定位，绝不写为 `mf_id`；
- 多级 Parent/Root：先分配全部临时身份，再把 parent/root 引用映射为新 UUID；5 级合成链验证。

## 6. 备份格式与完整性

备份保存**完整原始文件内容**（非仅调度字段）：

```
{ kind:'mf-us-1-migration-backup', batchId, planId, entries:[
  { operationId, index, path, content, contentHash, revision, planRevision, fields }
], verified }
```

- `contentHash` 使用纯 JS SHA-256（测试与 Node `crypto` 逐字节比对）；
- 备份前校验：文件存在、preview 内容 hash **必须存在且一致**、revision 一致（预览有 revision 而存储无 revision → `E_REVISION_UNAVAILABLE`）、Frontmatter 可安全合并；失败即拒绝；
- 备份后再次校验所有 hash；`verified=false` 的批次不能执行；
- **计划/备份双向对应**：执行前比较 `plan.executableEntries ↔ backup.entries` 的路径集合、数量、每条 `contentHash` 与 `fields`；缺失、额外、重复路径/operationId、被替换内容或字段、空备份全部拒绝（`E_BACKUP_PLAN_MISMATCH`），不执行任何写入；
- 未知 Frontmatter、来源信息、阅读历史、正文、换行等均保留。

## 7. 执行事务模型

- 校验计划完整性（`planId` 重算）、授权环境、备份存在且 hash 正确；
- 每个条目在写入前固定**写入意图** `{expectedContent, expectedAfterHash, fields}`，即使崩溃后状态仍为 `pending`，也能用当前 hash 与意图判断是否已应用；
- 逐文件：当前 hash 必须等于备份前 hash；有 revision 时还须匹配；发现外部编辑 → `conflict` 并跳过；
- 只更新批准字段（`mergeFrontmatter`），支持 LF/CRLF、UTF-8 BOM，保留未知字段、注释、正文与尾部空行；无 Frontmatter/未闭合/替换字符 → 明确错误，不插入新头部；
- **add-only 保护**：迁移计划只允许新增字段；若计划认为缺失、但原文 Frontmatter 已存在同名字段（即使值相同）→ `conflict / E_FIELD_ALREADY_PRESENT`，绝不覆盖；重复 YAML 键或缩进结构 → 保守拒绝；
- 单文件写入后回读校验；记录 before/after hash；
- 不假设跨文件原子性：允许部分完成；
- `writesPerformed` 仅在有真实成功写入时为 true；全部冲突/仅确认/重复执行为 false；写入后无法回读 → `uncertain` + `writeOutcome:'uncertain'`，批次进入 `requires-manual-recovery`，不谎报成功；
- 已写入的文件再次执行 → `already-applied`（幂等）。

## 8. 回滚与恢复

状态：`pending` / `applied` / `failed` / `rolled-back` / `conflict` / `requires-manual-recovery`。

- 回滚必须提供**可信备份库**；先验证 `authorization.batchId === batch.batchId`、备份 `batchId/planId`、备份 hash，以及每条 `operationId/path/beforeHash/fields/originalContent` 与备份一致；被篡改或错配的批次在任何写入前拒绝（`E_BATCH_TAMPERED` / `E_BACKUP_*`）；
- `previewRollback`：根据写入意图的 `expectedAfterHash`（无 afterHash 也可）判断 `rollback-ready` / `already-rolled-back` / `conflict` / `requires-manual-recovery`；存在 revision 时还要求当前 revision = 迁移前 + 1，否则拒绝；
- `rollbackMigration`：写入前再次验证 `originalContent` 的 hash 等于 `beforeHash`；只回滚当前仍等于 after hash 的文件；用户后续编辑或 revision 漂移 → 拒绝覆盖；写入/回读异常 → `uncertain`；`writesPerformed` 同样只在真实恢复成功时为 true；
- 精确恢复原始内容与原始 revision，不使用“清空新字段”；
- 部分回滚、重复回滚幂等；已恢复文件不再次损坏；
- `reconcileMigrationBatch`：根据 before/after hash 重新核实中断后的真实状态。

## 9. 已验证的故障注入

备份前失败、备份后写入前失败、首条写入失败、部分成功部分失败、**写入成功但 applied/afterHash 未记录**（pending 批次 + intent → reconcile/rollback）、写入成功但回读失败（`uncertain`）、回滚成功但确认失败、回滚前用户编辑、备份损坏/缺失、计划被篡改、重复执行、重复回滚；另含备份缺条目/多条目/重复路径/改字段/替换内容、add-only 冲突、重复 YAML 键、回滚原文篡改、beforeHash 篡改、批次错配、operationId/path 替换、同内容 revision 漂移。

## 10. 测试与性能

```
node --test test/mf-us-1-migration*.test.js   tests 80  pass 80  fail 0
```

10,000 个合成 Source 的迁移预览：**约 177ms**（Apple M4 / Node v24.21.0）。仅为迁移规划观测，**不是** A14 队列基准。

## 11. 交付矩阵

- `MIG-02`：`TESTED`（合成存储；真实 Vault 写入未实现）
- `MIG-03`：`TESTED`（UUID 初始化 + 固定批次清单 + 重试；真实落盘待 09）
- `TEST-02`：迁移前后 Effective Due 一致性在计划/执行层已验证（合成数据）
- `TEST-01`：T11 保持 PASS；T17/T20 纯层证据补充 5 级链
- `WRITE-01` / `ACC-01`：保持未完成

## 12. 未实现 / 待后续

- 真实存储适配器与 Obsidian 写入（PR-09/10）；
- 真实备份位置、保留策略与用户确认流程；
- 真实崩溃耐久性与文件系统原子性（PR-12 实机验收）；
- Q26/Q27/Q28 语义未改；Card/SR 仍排除。

## 13. 安全边界

全部测试使用合成数据与模块注册的内存存储；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未修改 Frontmatter/`data.json`；未生成或落盘真实 UUID；未执行真实迁移；未启用 Unified；未修改 PR-01～07 已验收算法；未创建 PR/合并。
