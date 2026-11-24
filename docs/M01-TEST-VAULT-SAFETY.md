# 测试 Vault 安全与隔离（M01）

> 适用范围：MemoFlow 1.0 开发期的所有自动化测试、种子脚本和 Obsidian 手工验收。
> 关联：`AGENTS.md` 第 3 节、`docs/GITHUB-WORKFLOW.md`。

## 1. 结论

- MemoFlow 的开发测试库固定为 `<repo>/../MemoFlow-Test`。
- 任何会写入 Vault 的脚本都必须先通过 `scripts/test-vault.js` 守卫。
- 守卫缺失/异常一律拒绝执行；默认不覆盖已有笔记。
- 日常 Vault 不参与自动化测试，也不应出现测试标记。

## 2. 测试库位置

默认路径由脚本自身位置推导，不依赖 `process.cwd()`：

```text
<repo>/../MemoFlow-Test
```

例如仓库在 `.../memoflow`，测试库就是同级的 `.../MemoFlow-Test`。

需要指向受控副本时，可以设置 `MF_TEST_VAULT`：

```bash
MF_TEST_VAULT="/absolute/path/to/MemoFlow-Test" node scripts/test-vault.js --check
```

即使设置了覆盖，标记、路径哈希、目录名和目录边界仍会全部校验。

## 3. 唯一标记

标记文件位于测试库根：

```text
<test-vault>/.memoflow-test-vault
```

内容示例：

```json
{
  "kind": "memoflow-test-vault",
  "markerVersion": 1,
  "vaultId": "<uuid-v4>",
  "vaultName": "MemoFlow-Test",
  "pathHash": "<sha256(realpath)>",
  "createdAt": "<ISO timestamp>",
  "warning": "MemoFlow development test vault only. Never copy this marker into a real vault."
}
```

- `vaultId` 唯一标识这个测试库实例。
- `pathHash` 只保存绝对路径的 SHA-256，不把本机完整路径写进 Vault。
- 移动或重命名测试库后，`pathHash` 会失效；守卫会拒绝，需要先备份，再用 `--init-marker --force` 重新生成。
- **不要把标记复制到任何日常/真实 Vault。**

## 4. 守卫检查项

`scripts/test-vault.js` 在写入前检查：

1. 路径必须是绝对路径。
2. 路径必须存在且是目录。
3. 路径本身不能是 symlink。
4. 必须存在 `.obsidian/`。
5. 必须存在 `.memoflow-test-vault`。
6. 标记必须是合法 JSON 对象。
7. `kind`、`markerVersion`、`vaultId`（UUID v4）、`vaultName` 必须正确。
8. `pathHash` 必须等于当前 `realpath` 的 SHA-256。
9. 仓库不能位于测试库内部。
10. 测试库不能位于仓库内部。
11. 每个写入目标必须位于测试库内，父目录 realpath 也不能越界。
12. 已存在的写入目标不能是 symlink。

任一项失败：打印失败原因，退出码非 0，不创建任何目录或文件。

## 5. 常用命令

```bash
# 只读检查（不写任何文件）
node scripts/test-vault.js --check

# 初始化标记（仅在已完成备份后执行；只写一个标记文件）
node scripts/test-vault.js --init-marker --vault "<test-vault>" --confirm

# 移动测试库后重新生成标记（先备份）
node scripts/test-vault.js --init-marker --vault "<test-vault>" --confirm --force
```

## 6. 脚本写入规则

| 脚本 | 是否写 Vault | 规则 |
|---|---|---|
| `scripts/seed-test-vault.mjs` | 是 | 守卫 + `--dry-run`；默认跳过已存在文件；`--force --approve-overwrite` 才覆盖 |
| `scripts/seed-book-workflow.mjs` | 是 | 守卫 + `--dry-run`；必须显式 `MF_BOOK_PDF`；默认跳过已存在 PDF/来源；`--force --approve-overwrite` 才覆盖 |
| `scripts/build.mjs --install-test` | 是（仅 3 个插件产物） | 守卫 + `--dry-run`；只写 `main.js`、`manifest.json`、`styles.css`；从不写 `data.json` |
| `scripts/screenshot.mjs` | 否 | 不访问 Vault |
| `test/*.test.js` | 否（仅系统临时目录） | 不访问真实测试库 |

### 默认不覆盖

- 已存在的笔记、Review Log、PDF、来源默认跳过。
- `community-plugins.json` 只做合并，保留已有插件。
- `--dry-run` 只打印计划，不 `mkdir`、不写文件、不构建 `dist`。
- `--force` 单独使用会报错；必须同时提供 `--approve-overwrite`，且需要项目所有者明确批准。

### 只安装三个产物

`build.mjs --install-test` 与 `seed-test-vault.mjs` 的插件安装步骤只处理：

```text
main.js
manifest.json
styles.css
```

`data.json`、笔记、SR 数据、`.obsidian` 其他配置一律不碰。

## 7. 备份与恢复

备份放在测试库和仓库之外：

```text
<workspace>/MemoFlow-Backups/<YYYY-MM-DD_HHMMSS>_pre-<task>/
├── MemoFlow-Test/          # 完整副本
├── MemoFlow-Test.tar.gz    # 压缩归档
├── config/                 # 关键设置副本
├── checksums/              # 逐文件 SHA-256
├── inventory.json
└── RESTORE.md
```

恢复前必须退出 Obsidian。完整恢复流程：

```bash
# 1. 退出 Obsidian
# 2. 保留现场
mv "<test-vault>" "<test-vault>.before-restore-<timestamp>"
# 3. 恢复
ditto "<backup>/MemoFlow-Test" "<test-vault>"
# 4. 校验
cd "<test-vault>" && shasum -a 256 -c "<backup>/checksums/backup.sha256"
# 5. 重新打开 Obsidian
```

只恢复单个文件时，直接从 `<backup>/MemoFlow-Test/` 对应路径复制，并核对哈希。

## 8. 禁止事项

- 不要把标记复制到日常 Vault。
- 不要在未备份、未退出 Obsidian 的情况下做完整备份或覆盖性操作。
- 不要在没有 `--dry-run` 结果的情况下直接运行 seed。
- 不要在没有项目所有者书面批准时使用 `--force --approve-overwrite`。
- 不要用测试脚本指向 `MF_TEST_VAULT` 之外的真实库路径。
- 不要让测试脚本清理、重建或重新初始化现有测试库。

## 9. M01 范围

M01 只增加测试库标记、守卫、脚本安全参数和文档；不修改 MemoFlow 运行时业务代码、SR 集成、阅读调度算法或现有数据格式。
