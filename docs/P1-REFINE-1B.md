# P1-REFINE-1B — Extract 原位精简与恢复交互

- 基线：`personal/main` = `60aa4b9`（PR #9 合并）
- 分支：`feat/p1-refine-1b`
- 范围：仅 Extract；原位精简 + 最近一次恢复
- 不做：Source、Redo、版本浏览、AI 摘要、调度/SR 修改

## 1. 实现

新增：

- `src/data/refine-editor.js`
  - 编辑器/磁盘快照；
  - 保存屏障；
  - 单窗口、单选区；
  - 选区/Context 安全检查；
  - Editor 替换、保存、磁盘验证；
  - 1A `prepareRefine` / `markVerified` / `planRestore` / `markRestored` 调用；
  - 失败时保留历史和诊断状态。
- `src/views/refine-modal.js`
  - 原文只读 + 可编辑替换文本；
  - 确认/取消。

`src/main.js` 注册：

```text
memoflow-refine-extract    原位精简当前摘录
memoflow-restore-refine    恢复上次精简
```

## 2. 安全流程

### 精简

```text
active Extract
→ Editor 与磁盘全文必须一致；不一致直接拒绝（不主动保存初始脏内容）
→ 单窗口、单连续选区、body-only
→ 预览原文/替换文本
→ 确认时按原始 offset 重新校验全文/选区文本/type
→ 确认替换文本有变化
→ 检查 SR/card/readpoint/code/table/embed 等保护结构
→ store.prepareRefine → prepared
→ 再次校验
→ editor.replaceRange
→ 校验 Editor 全文
→ store.setStatus(applied)
→ view.save
→ 读回磁盘，验证完整文件与 Frontmatter 逐字节一致
→ store.markVerified
```

不使用 `vault.process` 写正文；不调用 `processFrontMatter`。

### 恢复

```text
active Extract
→ Editor 与磁盘一致、单窗口
→ store.planRestore
→ 确认
→ 再次校验
→ store.writeRestorePlan → prepared
→ 仅替换 body（保留当前 Frontmatter）
→ editor.replaceRange
→ 校验 Editor/保存/读回
→ markVerified → markRestored
```

重复恢复：

- 已 restored → `ALREADY_RESTORED`；
- restore 已 verified 未 restored → `RESTORE_PENDING`；
- 新精简后恢复重新可用。

## 3. 失败处理

- 历史写失败：正文不变；
- history 快照已写、state 初始化失败：报告“快照已写入但状态初始化失败”，不误称操作未开始；正文不变；
- Editor 替换失败/内容不符：不主动保存；分别检查 Editor/磁盘，历史保留；
- `setStatus(applied)` 失败：不主动保存；分别检查 Editor/磁盘；可能已被自动保存；
- `view.save` 失败：state applied，历史保留，不宣称 verified；分别检查 Editor/磁盘；
- 保存后完整文件不一致：conflict；
- `markVerified` 失败：state applied，历史保留；不自动标记 verified；
- 崩溃后：不自动恢复/重放，不自动 verified；命令因 unresolved 拒绝新操作；
- 所有异常通知用户“操作未完成，历史已保留”。

## 4. 测试

- 1A 专项：14 + 30
- 1B 专项：**26**
- 全量：**321/321**
- `npm run check`、`npm run verify:memoflow` 通过。

覆盖：

- 正常精简/恢复；
- 取消/无变化；
- 未保存 Editor；
- 多窗口；
- Modal 失焦/选区变化；
- 预览期间 Editor/磁盘变化；
- 历史写失败；
- history 快照 + state 初始化失败；
- applied 状态写失败；
- autosave + applied 状态写失败同时发生；
- save 失败；
- 保存后磁盘不一致；
- markVerified 失败；
- 自动保存；
- CRLF/Unicode；
- SR/card/readpoint/code/table（含无首尾竖线的表格、表格内部选区）；
- invalid inline Card/SR 正则安全拒绝；
- Frontmatter/调度字段不变；
- 重复恢复/恢复冲突；
- 不调用 `vault.process` / `processFrontMatter`。

## 4.1 异常诊断

Editor 修改开始后，异常不再声称“正文一定未保存”。控制器分别读取：

- 1A state：prepared / applied / verified / conflict / unknown；
- Editor 当前内容：matches / differs / unknown；
- 磁盘当前内容：matches / unchanged / differs / unknown。

通知示例：

`状态更新失败；正文修改已在 Editor 中发生，磁盘状态需检查。历史状态=prepared；Editor=matches；磁盘=matches。历史已保留，操作未完成。`

不自动覆盖、恢复或标记 verified。

## 5. 实机 Obsidian 验收

环境：

- Obsidian：`1.15.1`
- macOS `darwin`
- Electron：`43.8.9`
- 真实 Editor：`viewSaveAvailable: true`
- `editor.posToOffset: true`
- `editor.offsetToPos: true`

使用已授权 MemoFlow-Test：

1. 完整备份并校验；
2. 专用 `Refine-Test-1B.md`，不改现有 Source/Extract/Card；
3. 通过真实命令 ID 执行精简/恢复，真实 Modal DOM 点击；
4. 结果：
   - 精简：`Alpha beta` → `Alpha`；
   - 恢复：`Alpha` → `Alpha beta`；
   - Frontmatter 逐字节一致；
   - history 初始 + applied + verified + restored 状态链正确；
5. 自动保存实测：
   - 在真实 Editor 中修改后**不调用** `view.save`；
   - 5 秒后磁盘已自动变化（`autoSaved: true`）；
   - 证明不能假设“没有主动保存就没有磁盘写入”。
6. 清理测试文件/历史/插件；
7. 与备份 `diff -qr` 为空。

证据：

- `Phase1-验收证据/P1-REFINE-1B-gui-probe.json`
- `Phase1-验收证据/P1-REFINE-1B-history-hashes.sha256`
- `Phase1-验收证据/P1-REFINE-1B-autosave-probe.json`

备份：

`MemoFlow-Backups/2026-11-25_014324_p1-refine-1b-gui`

## 6. 剩余风险

- 实机验收为桌面 macOS；移动端尚未验证。
- 多窗口策略为保守拒绝。
- 1B 不自动修复 applied/verified 中间态，只阻止新操作并提示。
- 历史 append-only 状态文件会累积，暂无清理 UI。
- 选区保护较保守，可能拒绝部分合法 Markdown。
- 未实现通用 Redo/版本浏览。
