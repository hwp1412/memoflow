# P1-REFINE-UX 验收报告

- 基线：`350e3c9`
- 测试：**332/332**
- 实机：Obsidian 1.15.1 / macOS / Electron 43.8.9
- 备份：`MemoFlow-Backups/2026-11-25_023927_p1-refine-ux-acceptance`

## 验收

- 原文/替换双栏，窄窗口堆叠；
- 正文独立滚动；
- 行级 diff；无变化禁用确认；
- 安全拒绝在 Modal 内显示；
- 取消/未确认零写入；
- 阅读栏/操作菜单仅 Extract 显示入口；
- 命令面板旧入口保留；
- 实际确认精简 `Alpha beta` → `Alpha`，Editor/磁盘一致；
- 最近恢复 `Alpha` → `Alpha beta`，history 出现 restored；
- Frontmatter hash 精简前后/恢复后一致；
- 表格内部选区安全拒绝：Modal 保持打开、history 未增加、正文不变；
- 深/浅色与窄窗口截图完成；
- 旧版 1B 对比截图完成。

## 测试

```text
node --test test/*.test.js
# tests 332
# pass 332
# fail 0

npm run check
exit 0

npm run verify:memoflow
exit 0
```

## 实机证据

- `Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-before-1b.png`
- `Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-light.png`
- `Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-dark.png`
- `Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-narrow.png`
- `Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-reject.png`
- `Phase1-验收证据/P1-REFINE-UX-acceptance.json`
- `Phase1-验收证据/P1-REFINE-UX-history-hashes.sha256`
- `Phase1-验收证据/P1-REFINE-UX-prototype.html`
- 精简前/后/恢复后文件 SHA-256：`fedf0e...` → `b64ffc...` → `fedf0e...`
- Frontmatter SHA-256：`b984ae...` 三阶段一致

清理后与备份 `diff -qr` 为空；未修改现有 Source/Extract/Card。

## 回滚

revert `feat/p1-refine-ux` 即可；不涉及历史 schema、不迁移数据。
