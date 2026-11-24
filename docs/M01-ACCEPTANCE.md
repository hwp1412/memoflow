# MemoFlow M01 验收报告

- 任务 ID / 名称：M01 — 保护并规范现有 MemoFlow-Test 测试环境
- 当前状态：待项目所有者人工验收
- 分支：`test/m01-test-vault-guard`
- 基线 Commit：`ea86c48`
- 实现 Commit：`55eb615`
- 验收报告 Commit：本文件所在提交（分支 HEAD）
- PR：方案 A，等待创建：<https://github.com/hwp1412/memoflow/pull/new/test/m01-test-vault-guard>
- 合并状态：**未合并**；未发布；未开始下一任务

## 1. 本次实现

1. 新增测试 Vault 守卫 `scripts/test-vault.js`：
   - 默认路径由仓库位置推导为 `<repo>/../MemoFlow-Test`，不依赖当前工作目录。
   - 校验绝对路径、`realpath`、symlink、`.obsidian/`、标记文件、标记字段、路径哈希、仓库/测试库目录边界。
   - 校验每个写入目标在测试库内，父目录 realpath 不越界，已存在目标不能是 symlink。
   - 任一异常都 fail closed：不创建目录、不写文件。
2. 为现有测试库增加唯一标记 `.memoflow-test-vault`：
   - `vaultId` 为 UUID v4；`pathHash` 为 `realpath` 的 SHA-256，不保存完整本地路径。
3. 三个会写 Vault 的脚本接入守卫：
   - `scripts/seed-test-vault.mjs`
   - `scripts/seed-book-workflow.mjs`
   - `scripts/build.mjs --install-test`
4. 增加安全参数：
   - `--dry-run`：只打印计划，不 `mkdir`、不写文件、不构建 `dist`。
   - 默认跳过已存在的笔记 / Review Log / PDF / 来源；`community-plugins.json` 只合并，不整体替换。
   - `--force` 单独使用报错；必须同时 `--approve-overwrite`，且需要项目所有者明确批准。
5. 插件安装只处理三个构建产物：`main.js`、`manifest.json`、`styles.css`；从不写 `data.json`。
6. 新增 20 项守卫测试；新增 `docs/M01-TEST-VAULT-SAFETY.md`；更新 `docs/WORKFLOW-TEST.md` 并去除本机绝对路径/具体书目。
7. **未修改**任何 MemoFlow 运行时业务代码、SR 集成、调度算法、笔记、`data.json` 或现有数据格式。

## 2. 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/test-vault.js` | 新增 | 测试 Vault 解析、标记、边界与写入目标守卫 |
| `test/test-vault-guard.test.js` | 新增 | 20 项守卫/负向/临时库测试 |
| `docs/M01-TEST-VAULT-SAFETY.md` | 新增 | 安全流程、备份恢复、覆盖规则 |
| `scripts/seed-test-vault.mjs` | 修改 | 接入守卫；`--dry-run`；默认不覆盖；仅 3 个插件产物 |
| `scripts/seed-book-workflow.mjs` | 修改 | 接入守卫；`--dry-run`；默认不覆盖；`MF_BOOK_PDF` 可配置 |
| `scripts/build.mjs` | 修改 | 仅 `--install-test` 接入守卫；`--dry-run` 零构建；显式 3 文件安装 |
| `docs/WORKFLOW-TEST.md` | 修改 | 增加安全前置、dry-run、标记说明；脱敏 |
| `package.json` | 修改 | 新增 `test-vault:check` 脚本 |

**未修改**：`src/`、根 `main.js`、`*-core.js`、`plugin/`、`dist/*`、任何笔记、`data.json`、SR 数据。

## 3. 原有功能保护

- 运行时插件代码零改动；`dist/memoflow/main.js` 的 SHA-256 仍为 `67ed8f79…c225c0f`。
- 现有测试库的 26 篇 Markdown、2 个 PDF、`.obsidian` 配置、MemoFlow/SR 的 `data.json` 均逐字节未变。
- 唯一新增：测试库根 `.memoflow-test-vault` 标记。
- 默认 seed 不覆盖已有笔记；实际运行前先 `--dry-run`。
- 本次**未实际运行** seed、`--install-test`、`--force` 或任何会覆盖测试库的操作。

## 4. 测试证据

### 4.1 实际执行并通过

```text
node --test test/*.test.js
ℹ tests 142
ℹ pass 142
ℹ fail 0
ℹ skipped 0
ℹ duration_ms ~165ms
```

（原有 122 项 + 新增 20 项守卫测试。）

```text
node scripts/test-vault.js --check
Test vault OK
  vaultId: 78896b66-c7a1-4e9d-a1aa-edba1b082dcb
  source: default

node scripts/test-vault.js --check --json
{ "ok": true, ... }

node scripts/validate-memoflow.mjs
MemoFlow validation passed (462 KB main.js).

node scripts/build.mjs   # 在 /tmp 仓库副本中执行，避免改动仓库 dist
[build] plugin -> dist/memoflow
462.3 KB; SHA-256 = 67ed8f79…c225c0f（与仓库现有 dist 一致）
```

### 4.2 负向与零写入验证

| 验证 | 结果 |
|---|---|
| 标记不存在时 `seed-test-vault.mjs --dry-run` | 退出码 1，不创建/覆盖任何文件 |
| 标记不存在时 `build.mjs --install-test --dry-run` | 退出码 1，不构建 `dist`、不写测试库 |
| 标记不存在时 `seed-book-workflow.mjs --dry-run` | 退出码 1，不写文件 |
| 重复 `--init-marker` | 退出码 1，原标记 SHA-256 不变 |
| `--force` 不带 `--approve-overwrite` | 退出码 2，零写入 |
| 临时测试库 `--dry-run` 前后逐文件 SHA-256 | 完全一致（零写入） |
| 临时测试库预置自定义笔记后正常运行 seed | 自定义笔记内容原样保留；只创建缺失文件 |
| `build.mjs --install-test --dry-run` 前后 `dist/` 和测试库插件 mtime | 完全一致（未清理、未重建、未安装） |
| symlink 测试库 / symlink `.obsidian` / symlink 标记 / 越界写入目标 | 均被拒绝 |
| 名称类似日常 Vault 的目录 + 复制标记 | 被拒绝（名称/路径哈希不匹配） |

### 4.3 测试库保全校验

- 备份前：43 个文件，15,099,567 字节。
- M01 后：43 个原文件逐文件 SHA-256 与备份清单**完全一致**；仅新增标记，文件总数 44。
- MemoFlow `data.json` 哈希：`0e3d4bb6…`（未变）。
- Spaced Repetition `data.json` 哈希：`107a36fa…`（未变）。
- 26 篇笔记：5 source / 11 extract / 6 card / 2 category + 欢迎页 + Review Log（未变）。

### 4.4 备份与恢复演练

- 备份位置：`<workspace>/MemoFlow-Backups/<timestamp>_pre-M01/`
  - 完整副本：`MemoFlow-Test/`（43 个文件）
  - 压缩归档：`MemoFlow-Test.tar.gz`（43 个条目）
  - `config/`：MemoFlow/SR 设置、manifest、插件列表、workspace
  - `checksums/source.sha256` 与 `checksums/backup.sha256`
  - `inventory.json`、`RESTORE.md`
- 源库与副本的逐文件 SHA-256 **完全相同**（43/43）。
- 在 `/tmp` 临时目录做恢复演练：43 个文件恢复，`shasum -c` 43 项全部 OK，0 项失败，`data.json` 与备份一致；演练后删除临时目录。
- 备份期间 Obsidian 已完全退出（`pgrep -x Obsidian` 为空）。

### 4.5 未执行 / 未验证

| 项 | 状态 | 原因 |
|---|---|---|
| 实际运行 `seed-test-vault.mjs` / `seed-book-workflow.mjs` | **未执行** | 按约束只跑 `--dry-run` 和临时库，不覆盖现有测试库 |
| 实际运行 `build.mjs --install-test` | **未执行** | 会覆盖测试库插件；等 M01 验收后再按需执行 |
| 实际运行 `--force --approve-overwrite` | **未执行** | 未获得单独批准 |
| Obsidian 实机验收 | **未验证** | 需你打开测试库确认 UI/队列/阅读条 |
| 移动端 / Windows 平板 | **未验证** | 无设备 |
| SR 1.15.4 评分交互 | **未验证** | 本次未打开 Obsidian、未评分 |
| PR 实际创建 | **未完成** | 方案 A：需你点击链接创建 |

## 5. 用户手动验收步骤

1. 用 Obsidian 打开测试库（`<repo>/../MemoFlow-Test`），不要打开日常 Vault。
2. 确认 MemoFlow 版本 0.1.0、Spaced Repetition 1.15.4。
3. 确认笔记数量与内容：5 来源 / 11 摘录 / 6 卡片 / 2 分类；26 篇 Markdown、2 个 PDF。
4. 打开总览、队列、任意来源阅读条、PDF 页码跳转，确认与 M01 前一致。
5. **不要评分、延后、Mercy、改日期格式**，避免测试数据变化。
6. 关闭 Obsidian 后，如需核对，可比较备份清单与当前文件哈希；只有 `.memoflow-test-vault` 是新增。
7. 如果验收通过，请创建 PR 并决定是否合并；**我不会自行合并**。

## 6. 数据和兼容性影响

- 运行时数据格式：无变化。
- 测试库数据：无变化（除新增标记）。
- `data.json`：无变化。
- SR 数据：无变化。
- 新标记只影响开发脚本；Obsidian 不把它当笔记索引。
- 守卫默认路径固定为仓库同级测试库；如果测试库被移动/重命名，`pathHash` 失效，需先备份再 `--init-marker --force`。

## 7. 风险、限制与回滚

### 风险

- 测试库移动/改名后守卫会拒绝；这是 fail closed，不是数据损坏。
- 守卫拒绝 symlink 路径；如通过 symlink 访问测试库，需改用真实路径。
- 备份与测试库在同一磁盘，不能防磁盘故障；建议同时保留 Time Machine/外置盘副本。
- `--force --approve-overwrite` 仍是高风险入口，本次未使用；后续使用前必须单独批准。
- PR 创建需要你点击方案 A 链接；本机没有 `gh`/API token。

### 回滚

1. **测试库**：退出 Obsidian，把当前测试库改名保留，`ditto` 备份副本回原路径，`shasum -c` 校验。
2. **只撤销标记**：删除 `<test-vault>/.memoflow-test-vault`；脚本会 fail closed，不会误写。
3. **代码**：分支未合并；`git revert 55eb615` 或删除分支即可；`main` 未改动。
4. **备份**：`<workspace>/MemoFlow-Backups/<timestamp>_pre-M01/` 保留至你确认不再需要。

## 8. 隐私与脱敏

本报告与新增文档不包含本机绝对路径、日常 Vault 名称或具体 PDF 文件名；路径统一使用 `<repo>`、`<workspace>`、`<test-vault>`、`<backup>` 占位符。

## 9. 建议下一任务

**无。** 等待你人工验收 M01、创建 PR 并决定是否合并；在明确批准前不开始 M02 或 Phase 1。
