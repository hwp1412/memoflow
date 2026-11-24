# P1-REFINE-UX — Extract 原位精简界面统一

- 基线：`personal/main` = `350e3c9`（PR #10 合并）
- 分支：`feat/p1-refine-ux`
- 范围：仅改善已实现的 Extract 精简 UI；不新增历史中心、指定版本恢复或 Source
- 数据契约：不变；operation/state、1A/1B 安全流程保持原样

## 1. 实现

- `src/views/refine-modal.js`
  - 双栏原文/替换文本；
  - 窄窗口上下排列；
  - 原文只读，替换文本可编辑；
  - 独立可滚动的正文区域；
  - 行级前后差异；
  - 安全说明、字数、差异统计；
  - 无变化时禁用确认；
  - 安全校验失败在 Modal 内显示原因，不关闭弹窗；
  - 确认前不显示“历史已保存”。
- `src/ui/refine.css`
  - 复用 MemoFlow 纸墨 token、琥珀安全色、Obsidian Modal；
  - 深浅色变量；
  - 760 / 520 窄窗口适配；
  - 固定底部操作区，正文独立滚动。
- `src/data/refine-diff.js`
  - 轻量行级 diff；
  - 纯文本节点，无 HTML 注入；
  - 大文本有界降级；
  - 后续历史中心可直接复用。
- `src/main.js`
  - Extract 阅读栏增加“精简”；
  - Extract 操作菜单增加“原位精简…”；
  - 命令面板入口保留；
  - Source/Card 不显示入口，且执行时仍校验 fm.type。
- `src/data/refine-editor.js`
  - 仅向 modal 传入 `validate` 回调（复用 `_assertSafe` 与 `_assertUnchanged`），不改变底层安全检查。
- `scripts/build.mjs`
  - 打包 `src/ui/refine.css`。

## 2. 安全

- 打开 Modal 不写任何数据；
- 取消不创建历史/不改正文；
- 替换文本未变化不创建历史；
- 安全拒绝在 Modal 内显示；
- 确认后仍走 1A/1B：历史 prepared → Editor 替换 → save → 磁盘完整文件校验 → markVerified；
- Frontmatter、parent/source、调度/SR 不修改；
- 不修改 1A history/store。

## 3. 测试

- 1B flow：29
- 1A history/store：44
- diff：5
- modal：3
- 全量：**332/332**
- `npm run check`、`npm run verify:memoflow` 通过。

## 4. 实机 UI

环境：Obsidian 1.15.1 / macOS / Electron 43.8.9。

截图：

- 旧版 1B：[refine-ux-before-1b.png](../../Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-before-1b.png)
- 新版浅色：[refine-ux-light.png](../../Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-light.png)
- 新版深色：[refine-ux-dark.png](../../Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-dark.png)
- 新版窄窗口：[refine-ux-narrow.png](../../Phase1-验收证据/P1-REFINE-UX-Screenshots/refine-ux-narrow.png)

可交互原型：[P1-REFINE-UX-prototype.html](../../Phase1-验收证据/P1-REFINE-UX-prototype.html)

实机只打开 modal 并填入替换文本，未点击确认，因此未产生精简历史、未修改测试 Extract。截图后清理探针插件/测试笔记，Vault 与启动前备份 `diff -qr` 为空。

## 5. 剩余问题

- 移动端仅通过窄窗口验证，未做真机触摸验收。
- 历史中心、指定版本恢复仍未实现。
- 行级 diff 不是词级/三方合并。
- 入口只覆盖 Extract 阅读栏/操作菜单/命令面板，不覆盖 Source/Card。
