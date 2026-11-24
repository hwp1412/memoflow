# P1-NAV-1 验收报告

- 分支：`fix/p1-nav-1`
- 基线：`2e76ce5`
- 范围：根 `main.js` `openParent()` + 局部解析 + 测试/文档
- 未修改：创建逻辑、tree-core、status-core、Boost/Postpone/Subset、SR、调度、MF-US-1、发布流程

## 1. 实际测试

```text
node --test test/memoflow-parent-nav.test.js
# tests 15
# pass 15
# fail 0

node --test test/*.test.js
# tests 249
# pass 249
# fail 0

npm run check
通过（validate-release + 249 tests）

npm run verify:memoflow
通过（构建 + node --check + 249 tests + validate-memoflow）
```

- M03 24 项、P1-SAFETY-1 安全断言未修改。
- Phase1 的旧 `openParent` 断言从“跳 source”更新为“跳直接父”，这是本任务的预期行为变更，不是弱化。

## 2. 覆盖

- E2→E1、E3→E2；
- 第一层 Extract 无 parent 时 source 回退；
- parent 空/null/非链接：不回退；
- parent 已删除：不回退；
- parent 同名歧义：不误跳；
- 路径链接、alias、大小写；
- tree_root=true；
- Card 保持 source；
- Source 保持 parent；
- 自引用拒绝；
- 失败不打开错误文件；
- 全部导航零写入。

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

- 分支已推送：`fd3a2fc`
- 本机没有可用的 GitHub PR 凭据，未能自动创建 Draft PR；创建链接：
  `https://github.com/hwp1412/memoflow/pull/new/fix/p1-nav-1`
- 因 PR 未创建，GitHub Actions 尚未运行；本地 `npm run check` / `verify:memoflow` 已通过。
- 不合并、不发布。
