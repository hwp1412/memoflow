# Phase 1 子摘录创建 — 验收报告

- 任务：Phase 1 第一项最小功能 — 从已有 Extract 创建子 Extract
- 当前状态：已同步 P1-SAFETY-1；实机验收与命令面板冒烟完成，待项目所有者最终验收
- 分支：`feat/phase1-child-extract`
- 基线 Commit：`efb901f`（P1-SAFETY-1 合并后的 main）
- 实现范围：MemoFlow `createTimestampExtract` / `clipboardExtract`
- 未修改：根 `main.js`、MF-US-1、SR、发布流程；`MemoFlow-Test` 在所有者授权下用于验收，验收前已备份

## 1. 实际实现

- 新增 `parent` 写入：直接父 Extract。
- `source` 写入创建时原始根 Source。
- `createTimestampExtract` 支持从任意层级 Extract 继续创建。
- `clipboardExtract` 复用同一路径。
- 创建前校验：
  - 根缺失、同名歧义、循环、超过 64 层、文件覆盖；
  - 新文件名避开其他 IR basename。
- 父级 priority/A-Factor bump 失败时报告“摘录已创建、父级更新失败，笔记已保留”。
- 旧数据只读兼容；未批量改写。
- 上游 `extractSelection` / `extractClipboard` / `_writeExtract` 保持原样，不支持多级，留待后续 PR。

## 2. 修改文件

- `src/main.js`
- `src/data/extract.js`
- `test/helpers/obsidian-mock.js`（仅为测试支持内存文件夹与创建后 Frontmatter 解析）
- `test/memoflow-recursive-extract.test.js`（新增 17 项）
- `test/memoflow-extract.test.js`（新增 1 项）
- `docs/PHASE1-CHILD-EXTRACT.md`
- `docs/PHASE1-ACCEPTANCE.md`

**未修改**：根 `main.js`、`tree-core.js`、`status-core.js`、SR 集成、`.github/workflows/`、MF-US-1 规范。`MemoFlow-Test` 已获授权用于验收，验收前完整备份。

## 3. 自动化测试

```text
node --test test/memoflow-recursive-extract.test.js
# tests 17
# pass 17
# fail 0

node --test test/memoflow-write-regression.test.js
# tests 24
# pass 24
# fail 0

node --test test/*.test.js
# tests 234
# pass 234
# fail 0

npm run check
通过（validate-release + 234 tests）

npm run verify:memoflow
通过（构建 + node --check + 234 tests + validate-memoflow）
```

- M03 的 24 项旧断言未修改。
- Source→第一层 Extract 的旧 Frontmatter/正文保持兼容。
- 五级创建、旧数据、安全拒绝、父级 bump 失败、navigation/subtree 行为均有测试。

## 4. 实际行为结果

### 4.1 五级创建

自动化验证：

```text
Source -> E1 -> E2 -> E3 -> E4 -> E5
```

- E1：`source=Source`，无 `parent`。
- E2..E5：`parent` 指向直接前驱，`source` 均为原始 Source。
- `buildTreeIndex` 的 childrenOf 逐级正确。

### 4.2 旧数据

- 旧 `source` 指向直接父 Extract 时，根解析继续向上。
- 旧数据字段逐一保持，不重写。
- 只有 `source` 的旧摘录仍按旧树逻辑显示。

### 4.3 安全拒绝

以下情况均拒绝创建，且不创建文件、不写 Frontmatter：

- 根缺失；
- 根/父 basename 重复；
- 父链循环；
- 超过 64 层；
- 新文件名与现有 IR basename 冲突（冲突时自动用 ` 2` 后缀，而不是覆盖）。

### 4.4 部分成功

创建成功后父级 bump 失败：

- 新摘录保留；
- 源/父 priority 不更新；
- Notice 明确报告“摘录已创建…父级更新失败…笔记已保留”。

## 5. Legacy / 限制

### 5.1 `openParent()` 仍跳原始 Source

当前根 `main.js` 的 `openParent()` 对 Extract 使用 `fm.source`。新子摘录的 `source` 是原始 Source，因此：

- 从 E2 执行“打开父节点”会打开 Source，而不是 E1；
- 这是只读导航问题，不写入数据；
- 本轮按批准的边界**不修改根 `main.js`**；已用 Mock 测试记录。

### 5.2 跨来源移动（P1-SAFETY-1 已修复）

Phase 1 分支已合并 main `efb901f`（P1-SAFETY-1）：

- `walkSubtree()` 现在优先 `parent`，只有没有 parent 时才回退 `source`；
- E1 从 Source A 移到 Source B 后：
  - 从 A 执行 boost/postpone：E1/E2 不被写入；
  - 从 B 执行：正常更新；
- Phase 1 原先“legacy 跨来源会波及”的两项断言已更新为 P1 修复后的安全断言（不删除测试，只改为断言正确行为）；
- M03 24 项旧断言未修改。

### 5.3 删除/完成不级联

- 删除父节点：子节点保留；dangling parent 在树中成为根；不自动删除/重挂。
- 完成父节点：子节点保持原状态；树提升展示；不自动完成。
- 移动：只改 `parent`，`source` 保持原始来源。

### 5.4 上游入口

上游 `extractSelection` / `extractClipboard` / `_writeExtract`：

- 仍只支持其原有路径/限制；
- 本轮没有修改根 `main.js`；
- 从已有 Extract 创建子摘录的完整上游支持留待后续独立 PR。

## 6. 测试 Vault / 实机状态

- 项目所有者已明确授权直接使用 `MemoFlow-Test` 进行 Phase 1 验收。
- 验收前创建独立完整备份并校验：
  - 备份：`MemoFlow-Backups/2026-11-24_225702_phase1-final-acceptance`
  - `verify:test-vault-backup`：通过（44 files / 11 directories / 14.40 MiB）
- 实机验收已完成：真实 Obsidian + MemoFlow-Test，详见 `docs/PHASE1-RUNTIME-ACCEPTANCE.md`。
- 已区分：
  - **临时验收插件调用**：五级创建、移动、完成、删除、Boost/Postpone、重启；
  - **真实命令面板 UI**：从已有 Extract 通过 Obsidian 命令面板执行一次创建子 Extract（临时 harness 驱动命令面板 DOM；不是直接调用 `createTimestampExtract`）。
- 测试专用笔记和临时插件已删除；非目标笔记未修改。
- 最终与备份差异仅：
  - `.obsidian/plugins/memoflow/main.js`（PR 构建产物）；
  - `.obsidian/workspace.json`（Obsidian 运行状态）；
  - `.obsidian/plugins/obsidian-spaced-repetition/data.json`（SR 插件自身 `buryDate` 日期滚动，非 Phase 1 写入）。
- 证据：`/Users/Admin/Documents/插件开发/Phase1-验收证据/`。

## 7. 数据风险与回滚

- 自动化测试使用内存 Mock；实机验收使用所有者授权的 `MemoFlow-Test`，验收前已备份。
- 测试专用笔记、临时插件已清理；非目标笔记未修改。
- 遗留的 Obsidian 运行状态变化：`workspace.json`；SR 插件自身 `buryDate` 从 `2026-11-24` 滚动到 `2026-11-25`。后者不是 Phase 1 业务代码写入，证据已保存。
- 回滚（合并前）：直接关闭 PR #6；`main` 不受影响；无需删除分支或恢复 Vault。
- 回滚（合并后）：按实际合并方式 revert PR #6 的 merge commit 或对应 commits；代码回滚**不会自动恢复**已生成的 Vault 笔记或 Obsidian 运行状态。
- 如需恢复 Vault 数据，只能基于备份 `2026-11-24_225702_phase1-final-acceptance` 单独操作，并需项目所有者确认。
- 未修改调度算法、SR 集成、Phase 1 之外功能。

## 8. PR / CI

- 分支：`feat/phase1-child-extract`
- 基线：`efb901f`
- 同步 Merge Commit：`ce83d15`
- PR：#6：<https://github.com/hwp1412/memoflow/pull/6>
- GitHub Actions：Run `45421097509` 已通过（`npm ci` + `npm run check`）；本报告文档提交后的最新 CI 见最终交付消息。
- 未合并、未发布、未进入 MF-US-1。
