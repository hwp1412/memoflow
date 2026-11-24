# P1-REFINE-HISTORY-READ 验收报告

- 基线：`381ffb9`
- 分支：`feat/p1-refine-history-read`
- 测试：**342/342**
- 实机：Obsidian 1.15.1 / macOS / Electron 43.8.9
- 备份：`MemoFlow-Backups/2026-11-25_025228_p1-refine-history-read`

## 自动化

```text
node --test test/*.test.js
# tests 342
# pass 342
# fail 0

npm run check
exit 0

npm run verify:memoflow
exit 0
```

## 实机

- 2 次精简 + 1 次最近恢复；
- 历史中心显示 3 个事件；
- 当前正文独立；
- 选择 #02 精简后，当前 vs 历史 diff 正常；
- 打开历史中心前后 history 文件内容一致；
- 浅色/深色/窄窗口截图完成；
- 清理后 Vault 与备份 diff 为空；
- 未修改既有 Source/Extract/Card。

## 证据

- `Phase1-验收证据/P1-REFINE-HISTORY-READ-acceptance.json`
- `Phase1-验收证据/P1-REFINE-HISTORY-READ-history-hashes.sha256`
- `Phase1-验收证据/P1-REFINE-HISTORY-Screenshots/history-light.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-Screenshots/history-dark.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-Screenshots/history-narrow.png`

## 回滚

revert `feat/p1-refine-history-read` 即可；只读功能无数据迁移，历史文件不受影响。
