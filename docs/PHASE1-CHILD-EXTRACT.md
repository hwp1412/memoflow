# Phase 1 子摘录创建 — 任务范围与验收标准

- 任务：Phase 1 第一项最小功能 — 从已有 Extract 创建子 Extract
- 分支：`feat/phase1-child-extract`
- 基线：`efb901f`（P1-SAFETY-1 合并后的 main）
- 状态：已同步 P1-SAFETY-1，234 项自动化测试通过；待人工验收

## 1. 范围

### 本轮实现

- 仅 MemoFlow 自身创建路径：
  - `createTimestampExtract()`
  - `clipboardExtract()`（内部调用 timestamp 路径）
- 新子摘录写入：
  - `parent: "[[直接父 Extract]]"`
  - `source: "[[原始根 Source]]"`
- 根解析兼容旧数据：旧 `source` 指向直接父 Extract 时继续向上解析。
- 创建前校验：缺失根、同名歧义、循环、超深、覆盖冲突。
- 新建文件名避免与其他 IR 文件 basename 冲突。
- 父级 bump 失败时明确报告“摘录已创建、父级更新失败”，不删除笔记。
- 只读/隔离 Mock 测试记录：
  - 多级 Extract 的“打开父节点”当前行为；
  - 跨来源移动后树索引与 `walkSubtree()` 的差异；
  - 子树延期/级联优先级操作的波及范围。

### 本轮不实现

- **不修改根 `main.js`**。
- 不支持上游 `extractSelection()` / `extractClipboard()` / `_writeExtract()` 的多级创建；留待后续独立 PR。
- 不引入 `mf_*` / UUID。
- 不修改 `reparent`、删除、级联逻辑。
- 不修改 MF-US-1 调度算法、priority/A-Factor/interval/review_count 现有逻辑。
- 不修改 SR 集成、发布流程。
- 不做旧数据批量迁移。

## 2. 数据与兼容

- `parent` = 当前直接父节点。
- `source` = 创建时的原始 Source；移动时不改写。
- Source→第一层 Extract 的旧输出保持逐字节兼容：`source` 为 Source，无 `parent`。
- 旧数据只读兼容，不补字段、不重写。
- M03 现有 24 项测试断言不得修改。

## 3. 验收标准

| 编号 | 验收项 |
|---|---|
| P1-1 | Source→E1 旧 Frontmatter/正文与 M03 一致 |
| P1-2 | E1→E2、E2→E3、E3→E4、E4→E5 的 parent/source 正确 |
| P1-3 | 每级 parent=直接父，source=原始 Source；树索引 5 级正确 |
| P1-4 | 旧数据（source 指向直接父、仅 source）继续可读，未被改写 |
| P1-5 | 缺失根/同名/循环/超深/覆盖冲突时拒绝创建，零写入 |
| P1-6 | 新文件名避开其他 IR basename |
| P1-7 | 父级 bump 失败时笔记保留，并明确报告部分成功 |
| P1-8 | 创建子摘录不自动完成父节点、不增加 review_count |
| P1-9 | M03 24 项不变；全量 234 项通过；`npm run verify:memoflow` 通过 |
| P1-10 | 临时 Obsidian Vault 完成 5 级实机验收；现有 MemoFlow-Test 未修改 |
| P1-11 | GitHub Actions 通过；PR 由所有者验收后合并 |

## 4. 隔离与回滚

- 自动化测试使用内存 Mock，不写真实 Vault。
- 实机验收只在一次性临时 Vault 中进行；现有 `MemoFlow-Test` 只读。
- 验收前备份现有测试库；临时库由备份恢复/初始化。
- 失败时丢弃临时库；原库不改，无需恢复。
