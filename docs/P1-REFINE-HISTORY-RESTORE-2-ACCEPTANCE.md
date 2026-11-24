# P1-REFINE-HISTORY-RESTORE-2 验收报告

- 基线：`cff090d`
- 测试：**378/378**
- 实际恢复：成功，v2 状态 `restored`
- Frontmatter hash 恢复前后一致
- Editor/磁盘一致
- 清理后测试 Vault 与备份 diff 为空

## 测试

```text
node --test test/*.test.js
# tests 378
# pass 378
# fail 0

npm run check
exit 0

npm run verify:memoflow
exit 0
```

## 证据

- `P1-REFINE-HISTORY-RESTORE-2-acceptance.json`
- `P1-REFINE-HISTORY-RESTORE-2-history-hashes.sha256`
- `P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-light.png`
- `P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-dark.png`
- `P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-narrow.png`
- `P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-dirty.png`

## 失败注入

已在自动化覆盖：operation/prepared state/editor replace/save/applied/markVerified/markRestored 失败，以及确认后正文/目标历史变化。

## 回滚

revert `feat/p1-refine-history-restore-2`；不自动删除 v2 历史。
