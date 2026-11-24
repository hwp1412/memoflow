# P1-REFINE-HISTORY-RESTORE-1 — 数据契约与恢复计划

- 基线：`personal/main` = `8f79e70`（PR #12 合并）
- 分支：`feat/p1-refine-history-restore-1`
- 范围：纯数据契约、目标校验、计划生成、旧历史兼容
- 不包含：Editor/磁盘写入、持久化恢复事件、恢复 UI、RESTORE-2

## 1. 版本范围

- 新任意版本恢复 operation 使用 `schemaVersion: 2`；
- 旧 v1 operation 保持 `schemaVersion: 1`；
- 普通精简和旧最近恢复仍使用 v1；
- 不迁移旧历史；
- state schema 保持 v1。

v2 目的：旧插件看到新记录时直接拒绝，不会误按旧恢复关系执行。

## 2. v2 operation

新增字段：

```json
"restoreTarget": {
  "operationId": "目标 operationId",
  "side": "before|after",
  "bodyHash": "目标 body SHA-256",
  "bodyBytes": 123
}
```

- `restoreOf` 必须与 `restoreTarget.operationId` 一致；
- `before` 保存当前完整正文；
- `after` 保存目标 body；
- `restoreTarget.bodyHash` 必须等于 after body hash；
- `bodyBytes` 使用 `utf8Bytes`；
- 目标可以来自 v1 或 v2 operation；
- 未知扩展字段不改变已验证核心语义。

## 3. 完整性

`validateOperationIntegrity`：

- 接受 v1/v2；
- v1 出现 `restoreTarget` → 拒绝；
- v2 缺少/非法 `restoreTarget` → 拒绝；
- target 自引用 → `RESTORE_CYCLE`；
- target id / hash / bytes 不一致 → 拒绝；
- v2 after body 必须等于目标 side 的 body；
- 目标必须同 note，不能是未来操作。

## 4. latestTrustedState

不取最后一个列表事件，按状态机判断：

1. 任一 prepared/applied/failed/conflict/缺失 state → `UNRESOLVED_HISTORY`；
2. 任一 restore 仍 `verified` → `RESTORE_PENDING`；
3. 普通精简 `restored` → `INVALID_HISTORY_STATE`；
4. 最后一个真正完成的事件：
   - 普通精简 `verified`；
   - restore `restored`；
5. 没有完成事件 → `NO_TRUSTED_STATE`；
6. 当前 body hash 必须等于该事件 after body hash，否则 `CURRENT_BODY_NOT_TRUSTED`；
7. Editor 内容与传入当前正文不一致 → `EDITOR_NOT_SAVED`。

当前 Frontmatter 可以变化；body 必须匹配。

## 5. planVersionRestore

纯计划：

```text
planVersionRestore({notePath,currentContent,editorContent,targetOperationId,targetSide})
```

输出：

```json
{
  "status": "ok",
  "current": {"operationId": "...", "bodyHash": "...", "bodyBytes": 123},
  "target": {"operationId": "...", "side": "before", "bodyHash": "...", "bodyBytes": 123, "status": "verified"},
  "operation": { "schemaVersion": 2, "...": "..." }
}
```

no-op：

```json
{"status":"noop","reason":"TARGET_EQUALS_CURRENT","current":{...},"target":{...}}
```

错误通过明确 `RefineError.code` 返回/抛出：

- `RESTORE_TARGET_NOT_FOUND`
- `RESTORE_TARGET_NOT_EARLIER`
- `RESTORE_TARGET_STATE_INVALID`
- `RESTORE_CROSS_NOTE`
- `CURRENT_BODY_NOT_TRUSTED`
- `EDITOR_NOT_SAVED`
- `UNRESOLVED_HISTORY`
- `RESTORE_PENDING`
- `RESTORE_CYCLE`

计划不写任何文件，不保存 operation，不追加 state。

## 6. 旧历史兼容

- v1 精简读取正常；
- v1 最近恢复读取正常；
- `latestRestorable` / `latestVerified` 不变；
- v2 reader 支持 v1/v2；
- 旧插件遇到 v2 `UNSUPPORTED_SCHEMA`，安全拒绝；这是明确降级限制；
- 旧插件不应跳过 v2 后误把较早事件当最新可信状态：其读取会因 schema 失败而停止，而不是过滤后继续。

## 7. 测试

- 新增 13 项 RESTORE-1 测试；
- 全量 **355/355**；
- `npm run check`、`npm run verify:memoflow` 通过。

覆盖：

- v1 读取；
- v2 字段/完整性；
- before/after；
- 首次精简前正文；
- 目标损坏/缺失/状态；
- 跨笔记；
- restoreOf 不一致；
- 自引用/循环；
- 未完成/缺失 state；
- 当前 body 不匹配；
- restore 后再恢复；
- no-op；
- 混合 v1/v2；
- 旧插件 schema 拒绝；
- plan 零写入；
- 失败不改历史；
- 342 旧回归。

## 8. 零写入

计划使用内存 Adapter 测试：

- `adapter.writes` 在 plan 前后不变；
- 不调用 `writeOperation`；
- 不调用 `setStatus`；
- 不调用 `markVerified` / `markRestored`；
- 不访问 Editor/Vault 正文。

## 9. 回滚

revert RESTORE-1；旧 v1 历史不迁移，不生成持久化恢复事件，无数据删除。

## 10. 剩余限制

- 受保护 Markdown/SR 结构签名检查留给 RESTORE-2 真正写入前；
- RESTORE-1 不执行恢复；
- 旧插件不能使用 v2 恢复记录；
- 路径重命名仍不支持自动关联。
