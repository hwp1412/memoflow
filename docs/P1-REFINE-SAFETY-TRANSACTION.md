# P1-REFINE-SAFETY-TRANSACTION — PR A

- 基线：`personal/main` = `526aa6a`
- 分支：`feat/p1-refine-safety-transaction`
- 范围：旧 1B `restoreActive()` 事务安全
- 不改 v1/v2 schema、不改历史状态机、不改 UI

## 1. 修复

旧 1B 恢复现在：

1. 确认前生成 preview plan；
2. 确认后重新 `_snapshot`；
3. 重新 `planRestore`；
4. 目标 operation/目标 body 变化 → `RESTORE_TARGET_CHANGED`；
5. fresh plan 后 `_assertUnchanged`；
6. 写 prepared；
7. `assertRestoreTarget` 重新校验：
   - 历史数量；
   - 目标存在；
   - 目标 state 完成；
   - 整条 restore 引用关系；
   - 其他 unresolved/pending；
   - 本 operation 仍为 prepared；
8. `_assertUnchanged`；
9. 才替换正文。

本次 prepared operation 是唯一允许的 unresolved；不会误判自身，也不会忽略其他异常记录。

## 2. Store

新增通用：

```text
assertRestoreTarget(operation, expectedHistoryCount)
```

覆盖 v1/v2：

- validateOperationIntegrity；
- 历史数量；
- validateHistoryRelationships；
- 其他 entry 必须 completed；
- target 必须 completed；
- validateRestoreRelationship；
- 本 operation state 必须 prepared。

`assertVersionRestoreTarget` 保留为 v2 wrapper。  
`planRestore` 增加 `historyCount` 计划基准。

未修改 schema、operation 字段或状态机。

## 3. 实际验收

专用测试笔记；旧 1B 正常恢复：

- 恢复成功；
- Editor == 磁盘；
- 恢复后正文 == 初始正文；
- Frontmatter hash 前后一致；
- v1 restore operation status restored；
- 无错误成功提示。

目标历史在确认期间删除：

- `restoreActive()` 返回 null；
- Editor/磁盘保持
- 目标删除后不替换正文。

见：

- `Phase1-验收证据/P1-REFINE-SAFETY-TRANSACTION-acceptance.json`
- `Phase1-验收证据/P1-REFINE-SAFETY-TRANSACTION-history-hashes.sha256`

## 4. 测试

- 旧 1B 正常恢复回归；
- 确认期间目标删除；
- prepared 后目标 operation 消失；
- prepared 后目标 state 变化；
- prepared 后历史数量增加；
- prepared 后其他 unresolved；
- prepared 后当前正文变化；
- 现有 RESTORE-2 回归。

全量：**871/871**。

## 5. 回滚

revert 分支；无 schema 迁移，不生成新持久化格式。
