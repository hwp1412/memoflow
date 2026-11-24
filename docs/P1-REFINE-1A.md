# P1-REFINE-1A — Safe refinement history foundation

- 分支：`feat/p1-refine-1a`
- 基线：`personal/main` = `b25c0e1`
- 范围：1A 历史存储、完整性校验、冲突检测、状态机、恢复计划
- 不包含：编辑器选区、预览 UI、真实正文替换（这些属于 1B）

## 1. 历史格式

不可变快照与可变状态分离：

```text
MemoFlow History/refine/
  <operationId>.json          # 不可变快照
  <operationId>.state.json    # 状态/恢复事件
```

不可变快照包含：

- `schemaVersion`、`operationId`、`createdAt`、`toolVersion`；
- `note`: path/type/bodyStart、body/frontmatter/full 的 UTF-8 字节数、SHA-256；
- `before`: 完整原文、Frontmatter prefix、body；
- `after`: expected body、body/full 字节数、SHA-256；
- `selection`: body-relative start/end、selectedText、replacementText；
- `restoreOf`: null 或原 operationId。

状态文件包含：

- `status`：`prepared | applied | verified | restored | failed | conflict`；
- `updatedAt`；
- `recovery[]` 记录。

不可变快照不包含可变 `status`，避免状态更新损坏原文历史。

## 2. 完整性

- 每次写入 history 后读回校验，确认成功前不授权正文修改。
- 读取 operation 时重新计算：
  - frontmatter/body/full SHA-256；
  - selection 与 before body 一致；
  - after body 等于 selection replacement 的结果；
  - 容量/字节数。
- 损坏、缺失、hash 不一致 → 明确错误，不猜测、不自动修复。

## 3. 状态机

```text
prepared -> applied -> verified -> restored
prepared/applied -> failed | conflict
```

- `prepared/applied/conflict/failed` 视为未解决，阻止 `latestVerified`/恢复。
- 初始写入只能是 `prepared`；调用者不能把“写入成功”直接声明为 `verified`。
- 状态更新失败保留既有状态与不可变历史，不删除、不截断。
- 1A 不拥有“正文写入成功”的事实；1B 必须在真实编辑器/磁盘校验后推进状态。

## 4. 未解决历史 / 验证约束

- 同一笔记存在 `prepared`、`applied`、`failed`、`conflict` 或缺失 state 时：
  - `prepareRefine`、`writeOperation`、`writeRestorePlan` 全部拒绝；
  - 返回 `UNRESOLVED_HISTORY`；
  - 不删除、不截断既有历史或诊断文件。
- `setStatus()` **不能**设置 `verified`/`restored`，会返回 `VERIFICATION_REQUIRED`。
- `markVerified(id, currentContent)`：
  - 要求当前状态为 `applied`；
  - 从当前 Frontmatter 原文解析 `type`，必须是 `extract`；
  - 当前 body hash 必须等于历史 `after.bodyHash`；
  - 只比较 body，恢复/验证保留当前 Frontmatter。
- `markRestored(id, currentContent)`：
  - 要求当前状态为 `verified`；
  - 当前 type/body 同样校验后进入 `restored`。
- 1A 只证明“调用者提供的内容”匹配；真实 Editor/disk 读取由 1B 负责，1B 不可绕过 `markVerified`。

## 5. 存储 Adapter

`RefineHistoryStore` 注入：

```text
exists(path)
read(path)
write(path, text)
mkdir(path)
rename(from, to)
list(path)
```

默认 `historyRoot`：`MemoFlow History/refine/`，可注入替换。

- 临时文件 + 读回 + rename 只用于降低风险，**不宣称原子事务或 fsync 保证**。
- 失败时保留 temp/已提交 history 供诊断，不静默清理。
- 文件路径不是稳定笔记 ID；重命名后不自动匹配历史。

## 6. 容量

- 原始笔记 UTF-8 ≤ **1 MiB**；
- 单条序列化 history ≤ **4 MiB**；
- 超限直接拒绝，不生成不完整 history。
- 每笔记超过 **20** 条时返回 `softLimitExceeded`，但**不自动删除、不永久禁止**后续精简。
- 1A 不提供清理 UI。

## 7. 恢复计划

- 只使用最近 `verified`/`restored` 历史；
- 有未解决操作 → 拒绝；
- 当前笔记必须仍为 Extract；
- 当前 body hash 必须等于目标历史的 `after.bodyHash`；
- 当前 Frontmatter 的原始 prefix 保留，只恢复 body；
- 生成新的 restore operation/history；不覆盖原历史；
- 只返回 plan，不修改真实正文（1B 负责实际写入）。

## 8. API

`src/data/refine-history.js`：

- `splitContent`（BOM/CRLF/空正文/无 Frontmatter/异常分隔符）；
- `createRefineOperation`；
- `validateOperationIntegrity`；
- `createRestoreOperation` / `planRestore`；
- `makeState` / `canTransition` / `validateState`。

`src/data/refine-store.js`：

- `writeOperation`（初始 prepared）；
- `prepareRefine`；
- `readOperation` / `readState` / `readEntry`；
- `setStatus`；
- `listEntries` / `historyCount`；
- `latestVerified` / `latestRestorable`；
- `planRestore` / `writeRestorePlan`。

## 9. 1B 边界

1B 必须重新校验：

- active editor 与磁盘内容；
- 当前 selection/offset；
- 当前文件 hash；
- 用户确认；
- 真实替换后的磁盘 hash。

1A 不执行正文替换、不打开 Obsidian 编辑器、不写真实 Vault。

## 10. 已知风险

- 无跨实例锁；1A 在本地 `writeOperation` 前做未解决检查，但不同实例仍可能竞态；1B 必须串行化 UI/写入。
- `setStatus` 不允许直接 verified/restored；调用方必须提供当前内容通过 `markVerified`/`markRestored`，但 1A 无法证明内容来自真实磁盘，信任边界由 1B 重新读取。
- 路径不是稳定 ID，重命名后历史安全停止但不自动跟随。
- 临时文件/rename 不具备事务保证；崩溃后需诊断/恢复。
- 4 MiB 上限与 1 MiB note 上限需真实笔记大小样本验证。
- Adapter `rename` 覆盖语义未由 Obsidian 文档保证；已用不覆盖目标 Adapter 验证“rename 失败时旧 state 保留”，但仍不宣称跨平台事务/fsync。
- 1A 不实现历史清理，长期容量策略未定。
