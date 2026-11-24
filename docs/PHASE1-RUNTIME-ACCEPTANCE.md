# Phase 1 实机验收报告（MemoFlow-Test）

- 分支：`feat/phase1-child-extract`
- HEAD：`b70d698`（PR #6）
- 基线 main：`efb901f`（P1-SAFETY-1 已合并）
- 验收 Vault：`/Users/Admin/Documents/插件开发/MemoFlow-Test`
- 验收方式：真实 Obsidian 运行时；五级/移动/Boost 等由临时验收插件直接调用；另有真实命令面板 UI 冒烟（临时 harness 驱动 DOM）；测试笔记与插件已清理
- 授权：项目所有者已明确授权直接使用 `MemoFlow-Test` 验收

## 1. 备份

验收前创建独立完整备份，未覆盖旧备份：

- `MemoFlow-Backups/2026-11-24_225702_phase1-final-acceptance`
- 44 files / 11 directories / 14.40 MiB
- `verify:test-vault-backup`：通过

## 2. 构建与安装

从 PR #6 HEAD `b70d698` 构建：

```text
dist/memoflow/main.js  472.2kb
sha256 main.js: 7b06438e821c8dc5585dbcbcd05bdc901e17ec629230d7d223e70d233067c281
sha256 manifest: 67391b5b2bee2daeb5c5bd5edfe31395b13a2813544fff87271da7ac133dba90
manifest: memoflow 0.1.0 / minAppVersion 1.12.7
```

已安装到 `MemoFlow-Test/.obsidian/plugins/memoflow/main.js`；`data.json` 最后恢复为验收前内容。

## 3. 五级摘录实际结果

通过真实 Obsidian 运行时调用 `createTimestampExtract`：

```text
Source C
→ 2026-11-24 22-59-42
→ 2026-11-24 22-59-42 2
→ 2026-11-24 22-59-43
→ 2026-11-24 22-59-43 2
→ 2026-11-24 22-59-43 3
```

实际 Frontmatter：

| 层级 | parent | source |
|---|---|---|
| E1 | 无 | `[[Phase1 Acceptance Source C]]` |
| E2 | `[[2026-11-24 22-59-42]]` | `[[Phase1 Acceptance Source C]]` |
| E3 | `[[2026-11-24 22-59-42 2]]` | `[[Phase1 Acceptance Source C]]` |
| E4 | `[[2026-11-24 22-59-43]]` | `[[Phase1 Acceptance Source C]]` |
| E5 | `[[2026-11-24 22-59-43 2]]` | `[[Phase1 Acceptance Source C]]` |

## 3.9 GUI 命令面板冒烟

除临时验收插件的直接方法调用外，另做了真实 Obsidian **命令面板**冒烟：

- 临时 harness 打开命令面板 DOM，搜索 `生成时间戳摘录` 并点击命令；
- 该操作实际调用现有 MemoFlow 创建入口，不是直接调用 `createTimestampExtract`；
- 第一次创建 parent Extract；
- 第二次从 parent 创建 child Extract；
- 结果：
  - active file = child `2026-11-25 00-20-04`
  - child `parent=[[2026-11-25 00-20-01]]`
  - child `source=[[Phase1 GUI Source]]`
  - parent 无 `parent`，`source=[[Phase1 GUI Source]]`
  - 实际 Markdown 已写入 `parent`/`source`/`type/status` 等字段。
- 证据：`Phase1-GUI-Smoke.json`。
- 说明：这是命令面板 UI，但由临时 harness 自动驱动；不是人工鼠标点击。五级/移动/Boost 等仍是临时插件直接调用。

## 4. 移动、完成、删除

- 将 E1 从 Source C 移到 Source D：
  - E1 `parent=[[Phase1 Acceptance Source D]]`
  - E1 `source=[[Phase1 Acceptance Source C]]`（原始根保留）
  - tree 的 Source D 子节点包含 E1；Source C 不再包含 E1
- 完成 E1：
  - E1 `status=done`
  - E2 `status=pending`
  - 未级联完成子节点
- 删除 E1：
  - E1 文件不存在
  - E2 文件仍存在
  - E2 的 `parent` 仍为已删除的 E1（dangling），tree 将 E2 显示为根
  - 未级联删除子节点

## 5. 跨来源 Boost / Postpone

在真实 Obsidian 中用临时验收插件调用 `boost()` / `postponeSubtree()`：

- Source E 的子摘录已移动为 `parent=Source F`、`source=Source E`。
- 从 Source E 执行 cascade Boost：
  - Source E priority `56 → 51`
  - 移动后的子摘录 priority 保持 `55`（未被误写）
- 从 Source E 执行 Postpone subtree：
  - Source E `next_review` `24-11-2026 → 27-11-2026`
  - 移动后的子摘录 `next_review` 保持 `03-12-2026`（未被误写）

这验证了 P1-SAFETY-1 的跨来源归属修复在真实运行时生效。

## 6. 重启读取

关闭 Obsidian 后重新打开 `MemoFlow-Test`，临时验收插件重新读取：

- E2 仍存在；
- E2 `parent=[[2026-11-24 22-59-42]]`（E1 已删除，dangling）；
- E2 `source=[[Phase1 Acceptance Source C]]`；
- E3 仍在 E2 下；
- tree 根包含 E2（孤儿根）。

## 7. 树展示

- 实际打开 Knowledge tree 视图成功；UI DOM 捕获到 20 行树节点（分类、Source、Extract、Card、Unfiled 等）。
- 同时通过真实插件 `buildTreeIndex()` 校验：
  - Source C 下 E1；E1 下 E2；E2 下 E3；E3 下 E4；E4 下 E5；
  - 移动后 Source D 下 E1；Source C 不再包含 E1；
  - 删除 E1 后 E2 成为根。
- 说明：DOM 截图未作为交付物；以运行时 JSON 证据 + 实际 tree index 为准。

## 8. Cards 叶子

- P1-SAFETY-1 自动化测试验证：Card 作为遍历叶子，不会继续遍历 Card 下的 Extract，Boost/Postpone 不写 Card 或其下 Extract；
- 本次实机五级验收未重复构造 Card 下的错误挂载场景，避免扩大测试范围。

## 9. 非目标数据检查

- 验收前 diff 仅显示新增/修改的专用测试笔记、临时插件、报告、workspace/plugin 构建文件；
- 没有既有 Source/Extract/Card 笔记被意外修改；
- 清理后：
  - 测试专用 Source/Extract、临时插件、Vault 内报告全部删除；
  - `community-plugins.json` 与 `data.json` 恢复备份内容；
  - 仅剩 `.obsidian/plugins/memoflow/main.js`（PR 构建）、`.obsidian/workspace.json`（Obsidian 运行状态）、`.obsidian/plugins/obsidian-spaced-repetition/data.json`（SR 自身 `buryDate` 日期滚动）与备份不同；
  - 文件数 44。

## 10. 证据位置

`/Users/Admin/Documents/插件开发/Phase1-验收证据/`：

- `Phase1-Acceptance-Report-v2.json`（五级、移动、完成、删除）
- `Phase1-Acceptance-Restart-v2.json`（重启读取）
- `Phase1-Acceptance-Write.json`（Boost/Postpone 实际写入）
- `Phase1-Acceptance-Tree.json`（实际 tree 视图 DOM 行）
- `Phase1-GUI-Smoke.json`（真实命令面板 UI 冒烟）
- `vault-diff-before-cleanup.txt`
- `vault-diff-after-cleanup.txt`
- `SHA256SUMS.txt`

## 11. 剩余风险 / 未验证

1. UI 树视图的完整展开截图未交付；结构以 `buildTreeIndex()` 与 DOM 行数为准。
2. Card 下的错误挂载场景仅由 P1 自动化测试覆盖，本次未做实机构造。
3. `openParent()` 仍从 Extract 跳原始 `source`，是独立导航问题。
4. 上游 `extractSelection` / `extractClipboard` 仍未支持多级创建。
5. CI 只运行 `npm run check`，不构建 dist；构建产物本地验证。
6. 实机验收使用的临时插件已移除；未修改生产代码。
7. GUI 冒烟的 SR 插件自身 `buryDate` 日期滚动不是 Phase 1 写入；证据保留，未擅自恢复。

## 12. 回滚

- 测试 Vault 备份：`2026-11-24_225702_phase1-final-acceptance`。
- 合并前：直接关闭 PR #6；main 不受影响；无需删除分支或恢复 Vault。
- 合并后：按实际合并方式 revert PR #6 的 merge commit 或对应 commits；代码回滚不会自动恢复已生成/修改的 Vault 数据。
- Vault 数据恢复只能基于上述备份单独执行，并需项目所有者确认。
- 不删除整个 Vault，不覆盖旧备份。
