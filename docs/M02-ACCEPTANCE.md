# MemoFlow M02 验收报告

- 任务 ID / 名称：M02 — 测试 Vault 备份与恢复工具
- 当前状态：待项目所有者人工验收
- 分支：`feat/m02-vault-backup-restore`
- 基线 Commit：`348e067`（CI-BASELINE-1 合并后的 main）
- 实现 Commit：`bccc8c2`
- 安全修复 Commit：`5fb6162`
- 验收报告 Commit：本文件所在提交（分支 HEAD）
- PR：#4：<https://github.com/hwp1412/memoflow/pull/4>
- 合并状态：**未合并**；未发布；未开始 M03 / Phase 1

## 1. 本次实现

- 新增共享库 `scripts/vault-snapshot.js`：
  - 扫描/分类/逐文件 SHA-256；
  - manifest/checksums；
  - 备份 `.partial` → 校验 → rename；
  - 备份前后源清单对比，源变化立即中止；
  - 备份校验、legacy M01 只读校验；
  - 恢复预览、merge/replace/select；
  - 安全快照、staging、两次 rename、失败回滚；
  - restore journal 与中断恢复；
  - 路径/标记/Obsidian/磁盘空间检查。
- 新增 CLI：
  - `scripts/backup-test-vault.mjs`
  - `scripts/verify-test-vault-backup.mjs`
  - `scripts/restore-test-vault.mjs`（默认 dry-run）
- 新增 `test/vault-backup.test.js`（30 项）。
- 新增 `docs/M02-TEST-VAULT-BACKUP.md`。
- `package.json` 新增三个 npm 脚本。
- `docs/M01-TEST-VAULT-SAFETY.md` 备份章节改为引用 M02。

**未修改**：`src/`、根 `main.js`、`*-core.js`、`plugin/`、`dist/`、`.github/workflows/`、MemoFlow 运行时、调度算法、SR 集成、现有数据格式。

## 2. 测试结果

```text
node --test test/*.test.js
1..172
# tests 172
# pass 172
# fail 0
# cancelled 0
# skipped 0
# todo 0

npm run check
通过（validate-release + 172 tests）
```

新增 30 项测试覆盖：

- 备份分类计数、manifest/checksums、空目录、Unicode/空格路径；
- `--dry-run` 零写入；
- 源文件在复制期间变化 → `SOURCE_CHANGED`，不生成正式备份；
- symlink 拒绝；
- 备份根位于 Vault/仓库内拒绝；
- 修改/缺失/额外文件被 verify 发现；
- manifest 路径穿越拒绝；
- legacy M01 布局只读校验/计划；
- merge 保留额外文件、replace 删除额外文件、select 只改选中文件；
- 目标标记 `vaultId` 保留；
- 安全快照、旧目标保留；
- 失败于 swap 前 / 旧库 rename 后 / staging rename 后 / 验证后，均回滚；
- 中断恢复（old-renamed、swapped、CLI `--recover`）；
- Obsidian 检测注入；
- backup/restore CLI dry-run 零写入。

完整日志：本地 `/tmp/m02-npm-check.log` 与测试输出；验收报告不包含私有 Vault 路径。

## 3. 现有测试库只读备份结果

在 Obsidian 完全退出后，对现有 `MemoFlow-Test` 执行只读备份：

```text
node scripts/backup-test-vault.mjs --label m02-acceptance
```

结果：

- 备份：`MemoFlow-Backups/2026-11-24_203930_m02-acceptance/`
- 44 个文件、11 个目录、15,099,931 字节；
- 分类：26 notes、2 pdf、7 obsidian-config、4 memoflow、4 spaced-repetition、1 marker；
- MemoFlow 0.1.0、SR 1.15.4；
- 备份前后源库逐文件 SHA-256 完全一致；
- `diff -r` 备份 `vault/` 与源库无差异（含标记）；
- `verify-test-vault-backup.mjs --strict` 通过。

**本次没有对现有 MemoFlow-Test 执行任何恢复、覆盖或 replace。**

## 4. 临时 Vault 恢复演练

在新建的一次性临时 Vault 中执行，未修改现有测试库：

### 4.1 Replace

- 先 `--dry-run` 审阅 plan；
- `--apply --mode replace --yes --confirm-remove-extra`；
- 恢复后 `diff -r --exclude='.memoflow-test-vault' <backup>/vault <temp-vault>` **无差异**；
- 临时目标标记 `vaultId` 前后一致（目标标记保留，未使用备份标记）；
- MemoFlow `data.json` 哈希：`0e3d4bb6…`；SR `data.json` 哈希：`107a36fa…`；
- 生成 `pre-restore` 安全快照与 `<temp-vault>.before-restore-*` 旧目录。

### 4.2 Merge

- 在临时库新增 `extra.md`、修改欢迎笔记、删除一个 PDF；
- merge plan：added 1、replaced 1、removed 0；
- apply 后：`extra.md` 保留、PDF 与笔记恢复；安全快照生成。

### 4.3 Select

- 只选择 `.obsidian/plugins/memoflow/data.json`；
- 恢复后该文件与备份一致；临时库其他额外文件保留。

### 4.4 失败回滚

自动化测试在临时 Vault 中覆盖：

- `beforeSwap` 失败：目标不变，staging/journal 清理；
- `afterOldRename` 失败：旧目标 rename 回原位；
- `afterStagingRename` 失败：新目标移到 `.failed-restore-*`，旧目标换回；
- `afterVerify` 失败：同上；
- 中断恢复：`old-renamed` 与 `swapped` 两种状态均能把旧目标恢复；
- CLI `--recover --journal` 通过。

## 5. 数据与兼容性影响

- 运行时数据格式：无变化。
- 现有 `MemoFlow-Test`：只读备份，数据未改；备份前后哈希一致。
- MemoFlow `data.json`、SR `data.json`、SR 调度数据、笔记、PDF、附件、`.obsidian` 配置均进入备份。
- 新工具只写备份根、临时 staging、旧目标目录；都经过守卫/边界检查。
- 现有 M01 守卫未被绕过；目标必须是有效标记的 `MemoFlow-Test`。
- 未来真正恢复现有测试库仍需单独批准：先展示 plan、覆盖清单和风险。

## 6. 风险、限制与回滚

### 风险

- 备份包含私人笔记/PDF，备份根在仓库外且权限 `0700`；不得上传/提交。
- 同一磁盘备份不能防磁盘故障；建议 Time Machine/外置盘。
- 两次 rename 不是整体原子事务；工具提供安全快照、旧目标保留、journal 和 `--recover`，但仍需在失败后人工核对。
- 不保留 xattr/ACL/资源分支；内容/size/SHA-256 为权威。
- symlink/特殊文件直接拒绝。
- `workspace.json` 恢复后 UI 状态可能过期。
- 旧 M01 备份只读兼容；不写回迁移。

### 回滚

1. 代码：分支未合并，删除分支或 `git revert 5fb6162 bccc8c2`；`main` 未改。
2. 数据：恢复失败时把 `<target>.before-restore-*` rename 回 `<target>`；或使用 `pre-restore` 安全快照。
3. 中断：使用 restore journal + `--recover`，优先恢复旧目标。
4. 现有测试库未被恢复；其备份可保留或按需删除。

## 7. 人工验收步骤

1. 查看 PR diff，确认只新增 M02 工具/测试/文档，未修改运行时。
2. 退出 Obsidian 后，运行一次只读备份：
   ```bash
   node scripts/backup-test-vault.mjs --label m02-review
   node scripts/verify-test-vault-backup.mjs --backup "<backup>" --strict
   ```
   确认现有库哈希不变。
3. 如需亲自恢复演练，只对一次性临时 Vault 执行；不要恢复现有 `MemoFlow-Test`。
4. 临时 Vault 准备：
   ```bash
   mkdir -p "<temp-vault>/.obsidian"
   node scripts/test-vault.js --init-marker --vault "<temp-vault>" --confirm
   node scripts/restore-test-vault.mjs --backup "<backup>" --vault "<temp-vault>" --dry-run
   node scripts/restore-test-vault.mjs --backup "<backup>" --vault "<temp-vault>" --apply --mode replace --yes --confirm-remove-extra
   ```
5. 校验临时库与备份一致；检查安全快照/旧目标；不要删除旧目标，直到确认。
6. 验收通过后由你决定是否合并；**不得由我自行合并**。

## 8. PR / CI

- 分支：`feat/m02-vault-backup-restore`
- 安全修复 Commit：`5fb6162`
- PR：#4：<https://github.com/hwp1412/memoflow/pull/4>
- GitHub Actions：**通过**。Run `45399162124`，job `138462883964`：
  - `Run npm ci` success；
  - `Run npm run check` success；
  - 其他步骤 success。
- 链接：<https://github.com/hwp1412/memoflow/actions/runs/45399162124>
- M02 测试已纳入 `npm test`；CI 仍不构建 `dist/memoflow`（CI-BASELINE-2 范围），M02 不修改工作流。

## 9. 安全边界修复（本次补充）

针对 `recoverInterruptedRestore()` 的审查意见，补充：

1. **journal 可信关联**：
   - journal 新增 `journalId`、`vaultId`、`markerSha256`、`backupFormat`、`backupProof`；
   - journal 文件必须位于目标同父目录，文件名必须是 `.memoflow-restore-*.json`；
   - journal 中的 `target`/`oldTarget`/`staging` 必须是同一父目录下的合法恢复路径；
   - 必须通过 `verifyBackup` 并校验备份格式与 backup proof 哈希。
2. **旧目录改名后的身份校验**：
   - 不调用 `validateTestVault(oldTarget)` 简单绕过；
   - 读取旧目录标记，验证其 `kind`/`version`/`vaultName`/`vaultId`/`markerSha256`；
   - 旧目录标记的 `pathHash` 必须等于**原 target 路径**的哈希，证明该目录是从 target 改名而来；
   - target 与 oldTarget 的 `vaultId` 必须一致，且都等于 journal 中的 `vaultId`；
   - target 本身仍必须通过 `validateTestVault`。
3. **恢复前 Obsidian 检查**：
   - `restore-test-vault.mjs --recover` 调用 `assertObsidianClosedForTarget`；
   - 默认测试库在 Obsidian 运行时拒绝；
   - 无法检测平台时要求 `--confirm-obsidian-closed`。
4. **失败处理**：
   - target + old 同时存在时优先恢复旧目标；
   - 若旧目标换回后校验失败，尝试把新目标换回并报告；
   - 不在校验失败时删除 journal/旧目录。
5. **新增负向测试**：
   - journal 不在目标父目录；
   - 旧目录 marker 的 pathHash 不属于 target；
   - journal vaultId / marker hash 不匹配；
   - backup proof 不匹配；
   - journalId 非法、kind/phase/mode/backupFormat 非法、journal 为 symlink；
   - Obsidian 检测 helper 的 running/unsupported/confirmed 分支。

实际重跑：`node --test test/*.test.js` → **172 pass / 0 fail**；`npm run check` 通过。  
GitHub Actions（Run `45399162124`）的 `npm ci` 与 `npm run check` 均通过。  
修复后再次在一次性临时 Vault 执行 Replace 实际恢复：`diff -r --exclude='.memoflow-test-vault'` 无差异。

## 10. 建议下一任务

**M02 范围内：无。** 等待人工验收与 PR 合并决定。  
在明确批准前不开始 M03、Phase 1 或其他开发任务。
