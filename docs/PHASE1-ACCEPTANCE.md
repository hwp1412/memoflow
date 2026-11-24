# Phase 1 子摘录创建 — 验收报告

- 任务：Phase 1 第一项最小功能 — 从已有 Extract 创建子 Extract
- 当前状态：待项目所有者人工验收
- 分支：`feat/phase1-child-extract`
- 基线 Commit：`7216f03`（M03 合并后的 main）
- 实现范围：MemoFlow `createTimestampExtract` / `clipboardExtract`
- 未修改：根 `main.js`、MF-US-1、SR、发布流程、现有测试 Vault

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

**未修改**：根 `main.js`、`tree-core.js`、`status-core.js`、SR 集成、`.github/workflows/`、MF-US-1 规范、现有 `MemoFlow-Test`。

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
# tests 214
# pass 214
# fail 0

npm run check
通过（validate-release + 214 tests）

npm run verify:memoflow
通过（构建 + node --check + 214 tests + validate-memoflow）
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

## 5. Legacy 发现与限制

### 5.1 `openParent()` 仍跳原始 Source

当前根 `main.js` 的 `openParent()` 对 Extract 使用 `fm.source`。新子摘录的 `source` 是原始 Source，因此：

- 从 E2 执行“打开父节点”会打开 Source，而不是 E1；
- 这是只读导航问题，不写入数据；
- 本轮按批准的边界**不修改根 `main.js`**；已用 Mock 测试记录。

### 5.2 跨来源移动后子树遍历可能波及已移动节点

`walkSubtree()` 同时匹配 `parent` 和 `source`。新数据中 `source` 保留原始根，因此：

- 将 E1 从 Source A 移到 Source B 后，树索引按 `parent` 显示在 B；
- 从 Source A 执行 `boost` / `postponeSubtree` 时，仍可能通过 `source=[[Source A]]` 把 E1（及子节点）纳入写入范围；
- 已用 Mock 测试复现并记录；
- 这是**潜在数据写入风险**，但属于既有 `walkSubtree` 语义；本轮未擅自修复，等待你决定后续处理。

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

- 自动化测试全部在内存 Mock 中，未访问真实 Vault。
- 现有 `MemoFlow-Test` 已只读备份并校验：
  - 备份：`MemoFlow-Backups/2026-11-24_220430_phase1-child-extract`
  - `verify:test-vault-backup`：通过（44 files / 11 directories / 14.40 MiB）
  - 最终 `diff -rq` 与备份一致，44 个文件。
- 临时 Obsidian Vault 的五级手工验收：**待项目所有者完成**（本报告不把 Mock 测试冒充实机验收）。
- 验收步骤：
  1. 备份现有测试库；
  2. 用备份恢复/复制到一次性临时 Vault，初始化测试标记；
  3. 安装本分支构建产物；
  4. 手工执行 Source→E1→E2→E3→E4→E5；
  5. 检查 parent/source/树、完成父节点、移动、删除、重启读取；
  6. 比对临时库与备份，丢弃临时库。
- 原测试库不改；失败只丢弃临时库。

## 7. 数据风险与回滚

- 无真实 Vault 写入；无数据迁移。
- 未修改 SR 数据、调度算法、根 `main.js`。
- 回滚：删除分支/PR，或 `git revert` 本 PR 的 src/test/docs commits；无需恢复 Vault。
- 如果未来接受“source 原始根 + 移动”语义，需另行决定 `walkSubtree` 的 source 匹配策略。

## 8. PR / CI

- 分支：`feat/phase1-child-extract`
- 基线：`7216f03`
- PR：待创建
- GitHub Actions：尚未运行；PR 创建后需 `npm ci` + `npm run check` 通过。
- 未合并、未发布、未进入 MF-US-1。
