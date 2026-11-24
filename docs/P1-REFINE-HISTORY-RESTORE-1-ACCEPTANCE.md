# P1-REFINE-HISTORY-RESTORE-1 验收报告

- 基线：`8f79e70`
- 测试：**356/356**
- 范围：v2 数据契约、latestTrustedState、planVersionRestore
- 未执行正文写入、未创建持久化恢复事件、未增加 UI

## 测试

```text
node --test test/*.test.js
# tests 356
# pass 356
# fail 0

npm run check
exit 0

npm run verify:memoflow
exit 0
```

## 零写入

- plan 使用纯数据/内存 Adapter；
- plan 前后 `adapter.writes` 数量一致；
- 不调用历史写入、state 写入或正文写入。

## 回滚

revert `feat/p1-refine-history-restore-1`；不迁移旧历史，不删除历史文件。
