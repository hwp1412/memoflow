# P1-REFINE-HISTORY-RESTORE-2 — 历史快照恢复 UI 与写入

- 基线：`personal/main` = `cff090d`（PR #13 合并）
- 分支：`feat/p1-refine-history-restore-2`
- 范围：Extract 指定历史快照恢复、确认 UI、v2 历史持久化、受保护结构保护
- 不包含：Source、独立 SR Card、MF-US-1、历史清理、自动修复

## 1. 用户流程

1. 打开 Extract；
2. 查看精简历史；
3. 选择 before/after 快照；
4. 点击“恢复此快照…”；
5. 确认 Modal 展示当前/目标差异；
6. 确认；
7. 重新读取 Editor/磁盘/历史并生成新 plan；
8. 写 prepared 历史；
9. 替换 body；
10. applied → verified → restored；
11. 刷新历史中心。

同一目标与当前正文相同：no-op，不写历史。

## 2. UI

- 历史中心默认 target = 最新事件 after；
- before 需显式选择；
- 恢复按钮以实际 target 为准，不使用 diff base；
- 禁用原因：
  - 当前正文不是历史快照；
  - 当前正文与目标相同；
  - Editor dirty；
  - unresolved/pending；
  - 目标状态不可恢复；
- 禁用只是提示，提交阶段仍重新校验；
- 确认 Modal：
  - 路径；
  - 目标快照标签/时间；
  - 当前/目标 diff；
  - 覆盖说明；
  - Frontmatter/SR 不变；
  - 取消/确认；
- 成功：新增恢复事件，重开历史中心；
- 失败：Notice + 诊断；不冒充成功。

## 3. 提交前重新校验

确认后不重用旧 plan：

1. 重新 `_snapshot(false)`；
2. 重新 `planVersionRestore`；
3. latestTrustedState/current body；
4. Editor/磁盘一致；
5. 目标 operation 仍存在且完整；
6. target side/hash/bytes；
7. 整条 restores 关系；
8. unresolved/pending；
9. 当前 Frontmatter 与 fresh snapshot 一致；
10. 受保护结构签名；
11. `_assertUnchanged`；
12. 才写 prepared 历史。

## 4. 受保护结构

`refine-editor.js` 新增纯签名：

- fenced code；
- 块级数学；
- Markdown 表格；
- `[[链接]]` / `![[嵌入]]` / `[text](url)`；
- `![[...]]`；
- `<!--SR:...-->`；
- inline Card 配置正则；
- `{{c::...}}`；
- `==cloze==`；
- readpoint / 📍。

规则：

- 当前与目标签名完全一致才允许；
- 签名包含精确文本，不是数量；
- 未闭合代码块/块级公式 → 歧义拒绝；
- 不自动改写/修复/格式化；
- 链接目标、SR 内容、inline Card 内容变化 → 拒绝；
- 表格/代码/公式块内容变化 → 拒绝。

## 5. 写入事务

沿用 1B：

```text
validate
→ create v2 operation
→ write prepared (operation + state)
→ revalidate
→ replace full body (Frontmatter preserved)
→ verify editor
→ applied
→ save
→ verify disk/full content
→ verified
→ restored
```

失败语义：

- operation 写入失败：无正文写入；
- prepared state 失败：operation 已存在，正文未写；
- replace 失败：prepared，正文未写；
- save 失败：applied，磁盘未变；
- 保存后不一致：conflict；
- applied 状态失败：正文/Editor 修改，历史 prepared；
- markVerified 失败：正文已保存，历史 applied；
- markRestored 失败：正文已保存/验证，历史 verified；
- 不自动回滚，不宣称成功。

## 6. 测试

新增：

- protection 6；
- restore flow 11；
- history modal restore state 2；
- 全量 **378/378**；
- 原有 357 保留。

覆盖：

- 正常 before 恢复；
- no-op；
- dirty；
- 结构变化；
- 确认时正文变化；
- operation/prepared/state/replace/save/verify/restore 失败；
- mark 失败；
- 目标历史中途变化；
- 旧 1A/1B/UX/HISTORY-READ/RESTORE-1 回归。

## 7. 实际验收

- Obsidian 1.15.1 / macOS / Electron 43.8.9；
- 专用 `test/Restore-Version-Test.md`；
- 两次精简；
- 从历史中心选第一次精简前的 before；
- 确认并恢复；
- 当前正文/磁盘回到原始正文；
- Frontmatter hash 不变；
- 新 v2 restore operation status=restored；
- 历史中心显示恢复事件；
- dirty 拒绝：按钮禁用并提示“Editor 有未保存修改”；
- 截图：light/dark/narrow/dirty；
- 清理后 Vault 与备份 `diff -qr` 为空。

证据：

- `Phase1-验收证据/P1-REFINE-HISTORY-RESTORE-2-acceptance.json`
- `Phase1-验收证据/P1-REFINE-HISTORY-RESTORE-2-history-hashes.sha256`
- `Phase1-验收证据/P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-light.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-dark.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-narrow.png`
- `Phase1-验收证据/P1-REFINE-HISTORY-RESTORE-Screenshots/restore2-dirty.png`

## 8. 回滚

revert RESTORE-2；已产生的 v2 恢复历史可保留只读。
不自动删除历史，不迁移。

## 9. 已知限制

- 结构签名保守，结构内容变化一律拒绝；
- 不自动冲突合并；
- 不自动修复历史；
- 旧插件不能使用 v2；
- 路径重命名仍不自动关联；
- 移动端未真机验证。
