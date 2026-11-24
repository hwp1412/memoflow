# P1-NAV-1 验收报告

- 分支：`fix/p1-nav-1`
- 基线：`2e76ce5`
- 范围：根 `main.js` `openParent()` + 局部解析 + 测试/文档
- 未修改：创建逻辑、tree-core、status-core、Boost/Postpone/Subset、SR、调度、MF-US-1、发布流程

## 1. 实际测试

```text
node --test test/memoflow-parent-nav.test.js
# tests 17
# pass 17
# fail 0

node --test test/*.test.js
# tests 251
# pass 251
# fail 0

npm run check
通过（validate-release + 251 tests）

npm run verify:memoflow
通过（构建 + node --check + 251 tests + validate-memoflow）
```

- M03 24 项、P1-SAFETY-1 安全断言未修改。
- 本次只新增测试/文档，没有新增生产代码修改。
- Phase1 的旧 `openParent` 断言从“跳 source”更新为“跳直接父”，这是本任务的预期行为变更，不是弱化。

## 2. 覆盖

- E2→E1、E3→E2；
- 第一层 Extract 无 parent 时 source 回退；
- parent 空/null/不可解析：不回退；
- 普通文本 parent 与旧 YAML 单元素列表：合法兼容，且目标必须唯一；
- parent 已删除：不回退；
- parent 同名歧义：不误跳；
- 路径链接、alias、大小写；
- tree_root=true；
- Card 保持 source；
- Source 保持 parent；
- 自引用拒绝；
- 失败不打开错误文件；
- 全部导航零写入。

## 3. 普通文本 parent 兼容性结论

**结论：普通文本 parent（如 `parent: E1`）是既有兼容格式，不是无效格式。**

依据：

1. `tree-core.js` 的 `linkTargetName()` 注释明确写明：
   > 若值不是 wikilink，则原样返回；frontmatter 可能存普通 basename。
2. `test/tree-core.test.js` 的既有契约测试明确断言：
   - `linkTargetName('Plain Name') === 'Plain Name'`；
   - 非 wikilink 字符串必须保留。
3. `docs/MF-US-1-SPEC.md` A2.1 要求旧字段 `parent`/`source` 读取并维护兼容，未限定只能是 wikilink。
4. 对现有 `MemoFlow-Test` 的只读格式审计：
   - 16 个含 parent 的文件；
   - 6 个 wikilink；
   - 10 个普通/旧 YAML 单元素列表形式；
   - 13 个普通 source；
   - 未做任何改写。
5. `treeCore.linkTargetName()` 在运行时把普通字符串及旧 YAML 单元素列表归一为 basename；现有导航代码已验证可解析。

因此采用**情况 A**：保留现有导航兼容行为，不新增“非链接即拒绝”的生产代码校验。普通文本仍要求：
- 目标存在且唯一；
- 同名歧义、缺失目标 → 停止，不回退 source。

新增测试覆盖 `parent: E1` 与旧 YAML 单元素列表父节点。

## 3. 实机验收

- Vault：`MemoFlow-Test`（项目所有者授权）
- 验收前备份：`MemoFlow-Backups/2026-11-25_003351_p1-nav1-acceptance`（44 files / 14.41 MiB，verify 通过）
- 安装本分支构建产物。

在真实 Obsidian 运行时：

| 操作 | 实际 active file |
|---|---|
| E2 执行 `openParent()` | `Extracts/P1 NAV E1.md` |
| E1 执行 `openParent()` | `Sources/P1 NAV Source.md` |

- 三次笔记正文前后完全一致；
- 没有 Frontmatter/正文写入；
- 测试后专用 Source/E1/E2、临时 harness 已清理；
- 最终 Vault 44 文件，除 `.obsidian/workspace.json` 运行状态外与备份一致；
- 证据：`/Users/Admin/Documents/插件开发/Phase1-验收证据/P1-NAV-Smoke.json`。

## 4. 剩余风险

1. 根 `main.js` 属于高风险文件，但本次仅改 `openParent` 与只读解析。
2. Card/Source 保留旧 `getFirstLinkpathDest` 行为；本次没有扩展其解析契约。
3. 无稳定 ID；同名子树仍需路径或唯一 basename。
4. 无自动修复/迁移。
5. 实机验证使用临时 harness 调用 `openParent`，不是人工 UI 点击；实际运行在 Obsidian 中。

## 5. 回滚

- 合并前：关闭 PR；main 不受影响。
- 合并后：按实际 merge 方式 revert 本 PR 的 commits；代码回滚不恢复 Vault 运行状态。
- 无 Frontmatter/正文写入，无数据迁移；无需恢复 Vault。

## 6. PR / CI

- PR #8：<https://github.com/hwp1412/memoflow/pull/8>
- base：`2e76ce5`
- 兼容性结论提交 HEAD：`1aa0857`
- GitHub Actions：Run `45440329589`，success
  - `npm ci` success
  - `npm run check` success
- 未合并、未发布。
