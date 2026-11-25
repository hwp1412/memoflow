# P1-REFINE-SAFETY — Process-first 条件提交

- 基线：`b71a081`（PR #26 合并）
- 分支：`feat/p1-refine-safety-process-production`
- 范围：Extract 精简、最近恢复、指定版本恢复三条写入路径
- 不修改 v1/v2 schema、Frontmatter、SR、Protected Links、Phase2

## 1. 顺序

```text
fresh plan / trusted checks
→ prepared history
→ prepared 后历史/目标校验
→ Editor 保持未修改
→ Vault.process 条件提交完整文件
   current !== snapshot.text → 冲突，拒绝
→ 校验磁盘 == expected
→ Editor 已是 expected 或仍等于 snapshot.text 时安全同步
→ applied
→ markVerified
→ markRestored
→ 成功提示
```

## 2. 关键行为

- process 前不把目标正文写入 Editor；
- 冲突时 Editor 不会留下本次目标脏缓冲；
- `Vault.process` 回调读取磁盘而非 dirty Editor；
- process 成功后 Editor 若已被外部更新到 expected，不重复覆盖；
- Editor 仍为旧内容才 setValue(expected)；
- 不调用 `view.save()`，避免旧缓冲回写；
- 外部 D1 在 process 前被检测后保留。

## 3. 状态与失败

- prepared：process 未提交；
- conflict：process 拒绝/失败；
- process 成功但 Editor 同步失败：conflict，磁盘已 expected，Editor 旧/外部；
- applied/verified/restored 失败：保留真实最后状态，无成功提示；
- 不自动回滚、不 sidecar、不新增 schema。

## 4. 测试

- 原有 974 基线保留；
- 新增/改写 process 条件提交、冲突、Editor 同步失败；
- 全量 **976/976**；
- check/verify 通过。

## 5. 实机

- D1 在 process 前写入：结果 false；Editor/磁盘 D1；真实 autosave 后 D1；关闭重开后 D1。
- 正常最近恢复：结果 true；Editor/磁盘初始正文；history restored。

证据：

- `Phase1-验收证据/P1-REFINE-SAFETY-PROCESS-FIRST-conflict.json`
- `Phase1-验收证据/P1-REFINE-SAFETY-PROCESS-FIRST-normal.json`

未完成：正常精简/指定版本恢复的单独实机；仅自动化与正常最近恢复实机。

## 6. 回滚

revert 分支；无 schema/持久化变更。
