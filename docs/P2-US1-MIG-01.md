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

## 3. 分类

| 状态 | 含义 |
|---|---|
| `migratable` | 字段/身份/关系安全，可加入执行集合 |
| `already-migrated` | 没有需要新增的现代字段 |
| `manual-review` | 需要人工裁决（临时身份未分配 UUID、关系未验证、UUID 冲突等） |
| `blocked` | 数据非法或不支持（坏日期、缺失 Priority、`inbox/pending/container`、Card） |
| `conflict` | 新旧字段矛盾或重复身份 |

不合法、歧义、重复 ID、关系不明的记录**不会**进入执行集合；单条异常不影响其他记录。

## 4. 字段映射（严格 A10.2）

- 合法旧 `next_review` → `mf_ideal_due`；旧 `interval` → `mf_interval_days`；`a_factor`、`review_count` 原样保留；
- `review_count=0` 但已有合法 interval 的旧数据**不重算**首次间隔；
- 旧 `next_review` 与现代字段冲突 → `conflict` 并阻塞；
- `mf_not_before = null` + `NOT_BEFORE_NOT_RECOVERABLE`；旧 interval 可能含行政操作 → `LEGACY_INTERVAL_MAY_INCLUDE_ADMINISTRATIVE_VALUE`；
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
- 备份前校验：文件存在、preview 内容 hash 一致、revision 一致；失败即拒绝；
- 备份后再次校验所有 hash；`verified=false` 的批次不能执行；
- 未知 Frontmatter、来源信息、阅读历史、正文、换行等均保留。

## 7. 执行事务模型

- 校验计划完整性（`planId` 重算）、授权环境、备份存在且 hash 正确；
- 逐文件：当前 hash 必须等于备份前 hash；有 revision 时还须匹配；发现外部编辑 → `conflict` 并跳过；
- 只更新批准字段（`mergeFrontmatter`），其他行与正文逐字节保留；
- 单文件写入后回读校验；记录 before/after hash；
- 不假设跨文件原子性：允许部分完成，批次状态 `applied` / `partially-applied` / `failed`；
- 已写入的文件再次执行 → `already-applied`（幂等）。

## 8. 回滚与恢复

状态：`pending` / `applied` / `failed` / `rolled-back` / `conflict` / `requires-manual-recovery`。

- `previewRollback`：根据当前内容 hash 判断 `rollback-ready` / `already-rolled-back` / `conflict` / `requires-manual-recovery`；
- `rollbackMigration`：只回滚当前仍等于 after hash 的文件；用户后续编辑 → 拒绝覆盖；
- 精确恢复原始内容与原始 revision，不使用“清空新字段”；
- 部分回滚、重复回滚幂等；已恢复文件不再次损坏；
- `reconcileMigrationBatch`：根据 before/after hash 重新核实中断后的真实状态。

## 9. 已验证的故障注入

备份前失败、备份后写入前失败、首条写入失败、部分成功部分失败、写入成功但状态未记录（reconcile）、回滚前用户编辑、备份损坏/缺失、计划被篡改、重复执行、重复回滚。

## 10. 测试与性能

```
node --test test/mf-us-1-migration*.test.js   tests 42  pass 42  fail 0
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

全部测试使用合成数据与注入式内存存储；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未修改 Frontmatter/`data.json`；未生成或落盘真实 UUID；未执行真实迁移；未启用 Unified；未修改 PR-01～07 已验收算法；未创建 PR/合并。
