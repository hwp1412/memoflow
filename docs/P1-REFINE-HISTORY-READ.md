# P1-REFINE-HISTORY-READ — Extract 精简历史只读中心

- 基线：`personal/main` = `381ffb9`（PR #11 合并）
- 分支：`feat/p1-refine-history-read`
- 范围：只读历史列表、快照预览、差异对比
- 不做：指定版本恢复、自动修复、历史清理、Source

## 1. 数据模型

- 每个历史事件保留 `before` / `after` 正文快照；
- 精简事件不是单一版本；
- 恢复事件有 `restoreOf`，独立显示为“恢复”；
- 当前正文单独显示，不伪装成历史事件；
- 只使用 `entry.operation.before.body` / `after.body`；
- 不修改 1A operation/state。

## 2. UI

大 Modal：

- 左侧：当前正文 + 事件列表（时间、类型、状态、字符变化）；
- 右侧：基准/对比 select、正文预览、只读行级 diff；
- 支持当前 vs 历史、历史快照 vs 历史快照、交换；
- 无历史显示空状态；
- unresolved 显示警示；
- 软限制显示容量提示；
- 历史缺失/损坏显示错误，不伪造正文；
- 空状态提示重命名/移动可能导致历史仍关联旧路径；
- 无恢复按钮。

## 3. 实现

- `src/data/refine-history-read.js`
  - 纯视图模型；
  - current、events、snapshots、容量/状态；
  - 无 Vault 写入。
- `src/views/refine-history-modal.js`
  - 只读历史中心；
  - 安全文本节点；
  - 复用 `refine-diff.js`。
- `src/ui/refine.css`
  - 历史中心样式，复用纸墨 token、深色和窄窗口。
- `src/main.js`
  - `memoflow-refine-history` 命令；
  - Extract 操作菜单“查看精简历史…”；
  - 仅 Extract。
- `src/i18n/zh.js` 命令名。

## 4. 安全

- 打开历史中心只读：`listEntries` / `read`；
- 切换版本不写；
- 不修改正文、Frontmatter、operation、state；
- 不自动验证/恢复/修复；
- 损坏时显示错误，不回退猜测；
- 没有恢复按钮。

## 5. 测试

- 1A history/store：44
- 1B flow：29
- UX diff/modal：8
- HISTORY-READ：10
- 全量：**342/342**
- `npm run check`、`npm run verify:memoflow` 通过。

覆盖：

- 无历史；
- 单次/多次精简；
- 精简+恢复混合；
- before/after 快照分离；
- 当前正文 dirty；
- unresolved；
- 容量软限制；
- 损坏/错误；
- 大文本 diff 降级；
- 无 HTML 注入；
- 只读零写入。

## 6. 实机验收

Obsidian 1.15.1 / macOS / Electron 43.8.9。

- 从 Extract 操作菜单打开历史中心；
- 2 次精简 + 1 次最近恢复，显示 3 个事件；
- 列表、当前行、类型、状态、时间、字符变化正确；
- 当前 vs #02 精简后 diff 正常；
- 打开历史中心前后 history 内容完全一致；
- 截图：浅色、深色、窄窗口；
- Vault 与备份 `diff -qr` 为空；
- 未修改 Source/Extract/Card 的既有内容。

证据：

- `Phase1-验收证据/P1-REFINE-HISTORY-READ-acceptance.json`
- `Phase1-验收证据/P1-REFINE-HISTORY-READ-history-hashes.sha256`
- `Phase1-验收证据/P1-REFINE-HISTORY-Screenshots/history-light.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-Screenshots/history-dark.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-Screenshots/history-narrow.png`

## 7. 剩余风险

- 移动端真机未验证；
- 历史中心只读，指定版本恢复仍未实现；
- 行级 diff 有上限降级；
- 路径重命名仍无法自动关联；
- 无历史清理/导出 UI。
