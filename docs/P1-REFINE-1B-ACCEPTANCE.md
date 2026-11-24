# P1-REFINE-1B 验收报告

- 基线：`60aa4b9`
- 分支：`feat/p1-refine-1b`
- 测试：**321/321**
- 实机：Obsidian `1.15.1`，macOS `darwin`，Electron `43.8.9`

## 自动化

```text
node --test test/memoflow-refine-flow.test.js
# tests 26
# pass 26
# fail 0

node --test test/refine-history.test.js
# tests 14
# pass 14
# fail 0

node --test test/refine-store.test.js
# tests 30
# pass 30
# fail 0

node --test test/*.test.js
# tests 321
# pass 321
# fail 0

npm run check
通过

npm run verify:memoflow
通过
```

## 实机

- 完整备份：`2026-11-25_014324_p1-refine-1b-gui`
- 专用测试 Extract：`Refine-Test-1B.md`
- 真实命令 ID / 真实 Modal 点击：
  - 精简 `Alpha beta` → `Alpha`；
  - 恢复 `Alpha` → `Alpha beta`；
  - Frontmatter 未变；
  - history prepared/applied/verified/restored 链正确；
  - `view.save` 可用，`posToOffset`/`offsetToPos` 可用。
- 自动保存实测：未调用 `view.save`，5 秒后磁盘已自动变化（`autoSaved: true`）。
- `view.save`、`posToOffset`、`offsetToPos` 均可用。
- 清理后与备份 `diff -qr` 为空。

证据：

- `Phase1-验收证据/P1-REFINE-1B-gui-probe.json`
- `Phase1-验收证据/P1-REFINE-1B-history-hashes.sha256`
- `Phase1-验收证据/P1-REFINE-1B-autosave-probe.json`

## 剩余风险

- 移动端未实测。
- 多窗口一律拒绝。
- 未自动修复未完成状态。
- 新增诊断：history 状态、Editor matches/differs、磁盘 matches/unchanged/differs。
- invalid inline Card/SR 正则与无首尾竖线表格均安全拒绝。
- 历史状态文件累积，尚无清理 UI。
