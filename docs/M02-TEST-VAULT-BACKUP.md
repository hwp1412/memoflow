# 测试 Vault 备份与恢复（M02）

> 适用：`<repo>/../MemoFlow-Test` 隔离测试库。
> 不适用于日常/真实学习库。
> 关联：[M01 测试库安全](M01-TEST-VAULT-SAFETY.md)。

## 1. 目标

为测试 Vault 提供可重复、可校验、可安全回滚的备份与恢复：

- 完整覆盖 Markdown、PDF、附件、`.obsidian` 配置、MemoFlow 设置、Spaced Repetition 数据。
- 每个文件 SHA-256 校验，备份清单权威。
- 恢复默认 dry-run；`--apply` 前必须审阅计划并确认。
- 恢复使用 staging + 安全快照 + 目录替换；中途失败会回滚。
- 只操作带有效标记的测试 Vault；不绕过 M01 路径/标记守卫。

## 2. 命令

```bash
# 只读检查测试库
node scripts/test-vault.js --check

# 备份（默认输出到 <workspace>/MemoFlow-Backups）
node scripts/backup-test-vault.mjs --label m02

# 备份 dry-run（不写文件）
node scripts/backup-test-vault.mjs --label m02 --dry-run --json

# 校验备份
node scripts/verify-test-vault-backup.mjs --backup "<backup>" --strict

# 恢复预览（默认即 dry-run，零写入）
node scripts/restore-test-vault.mjs --backup "<backup>" --vault "<test-vault>" --dry-run

# 实际恢复（先审阅 dry-run；非交互环境必须 --yes）
node scripts/restore-test-vault.mjs --backup "<backup>" --vault "<test-vault>" \
  --apply --mode merge --yes

# 只恢复某个文件
node scripts/restore-test-vault.mjs --backup "<backup>" --vault "<test-vault>" \
  --select ".obsidian/plugins/memoflow/data.json" --apply --yes

# Replace（会删除目标额外文件，必须额外确认）
node scripts/restore-test-vault.mjs --backup "<backup>" --vault "<test-vault>" \
  --apply --mode replace --yes --confirm-remove-extra

# 恢复中断后
node scripts/restore-test-vault.mjs --recover --journal "<journal>"
```

退出码：

- `0` 成功 / dry-run 完成；
- `1` 校验或操作失败；
- `2` 用法错误、缺少确认或缺少危险操作确认。

## 3. 备份布局

```text
<backup-root>/<YYYY-MM-DD_HHMMSS>_<label>/
├── vault/                    # 完整副本（相对路径）
├── manifest.json             # 权威清单
├── checksums.sha256          # 逐文件 SHA-256
├── RESTORE.md                # 恢复步骤
└── vault.tar.gz              # 可选（--archive）
```

默认备份根：`<workspace>/MemoFlow-Backups`，可用 `MF_BACKUP_ROOT` 覆盖。

- 备份根、备份目录不能位于测试 Vault 内，也不能位于仓库内。
- 先写 `<final>.partial`，校验通过后才 rename 为正式备份；失败不会留下“看起来有效”的备份。
- 备份目录权限为 `0700`。

## 4. manifest

```json
{
  "schemaVersion": 1,
  "kind": "memoflow-test-vault-backup",
  "createdAt": "ISO-8601",
  "tool": "m02",
  "source": {
    "path": "<absolute>",
    "realpath": "<absolute>",
    "vaultId": "<uuid>",
    "vaultName": "MemoFlow-Test"
  },
  "counts": {
    "files": 44,
    "directories": 11,
    "bytes": 15099931,
    "byCategory": {
      "notes": 26,
      "pdf": 2,
      "attachments": 0,
      "obsidian-config": 7,
      "memoflow": 4,
      "spaced-repetition": 4,
      "marker": 1,
      "other": 0
    }
  },
  "plugins": {
    "memoflow": { "version": "0.1.0", "dataSha256": "..." },
    "obsidian-spaced-repetition": { "version": "1.15.4", "dataSha256": "..." }
  },
  "files": [
    { "path": "...", "size": 123, "sha256": "...", "mode": 420, "category": "notes" }
  ],
  "directories": ["..."],
  "marker": { "path": ".memoflow-test-vault", "vaultId": "...", "sha256": "..." },
  "archive": null
}
```

- 路径使用 POSIX `/` 相对路径；禁止绝对路径、`..`、空路径。
- `checksums.sha256` 从 manifest 生成，二者交叉校验。
- 源文件在备份前后各有一次清单哈希；不一致立即中止。

## 5. 文件分类

| category | 规则 |
|---|---|
| `notes` | `.obsidian/` 之外的 `.md` |
| `pdf` | 任意位置的 `.pdf` |
| `attachments` | `.obsidian/` 之外的非 `.md`/`.pdf` 文件 |
| `obsidian-config` | `.obsidian/**` 中非插件目录文件 |
| `memoflow` | `.obsidian/plugins/memoflow/**` |
| `spaced-repetition` | `.obsidian/plugins/obsidian-spaced-repetition/**` |
| `marker` | 根目录 `.memoflow-test-vault` |
| `other` | 其他文件（如 `.DS_Store`） |

## 6. 完整性校验

`verify` 检查：

1. manifest schema/kind/version；
2. 每个文件存在、size/SHA-256 一致、不是 symlink；
3. 无缺失文件；严格模式下无额外文件；
4. `checksums.sha256` 与 manifest 一致；
5. 目录清单存在；
6. 路径安全（无绝对路径/`..`）；
7. 可选归档存在、大小/SHA-256 一致；
8. 旧 M01 布局（`MemoFlow-Test/` + `checksums/backup.sha256`）只读校验。

## 7. 恢复语义

### 模式

- `merge`（默认）：新增缺失文件、覆盖有差异文件，保留目标额外文件。
- `replace`：目标最终与备份一致，删除目标额外文件；必须 `--confirm-remove-extra`。
- `select`：只恢复指定相对路径，保留其他目标文件；不能与 `replace` 同用。

### 确认

- 不带 `--apply` 永远 dry-run，零写入。
- `--apply` 必须 `--yes`。
- `replace` 有删除项时，还必须 `--confirm-remove-extra`。

### 标记策略

`.memoflow-test-vault` 的 `pathHash` 绑定路径，恢复时**绝不**把备份里的标记原样写到不同路径：

- 备份保留标记，manifest 记录 `vaultId`/哈希；
- 恢复时过滤备份标记；
- 保留目标 Vault 当前标记（目标必须已带有效标记）；
- 新建临时目标先准备：
  ```bash
  mkdir -p "<temp-vault>/.obsidian"
  node scripts/test-vault.js --init-marker --vault "<temp-vault>" --confirm
  ```

### 安全快照、staging 与替换

实际恢复不是“一个原子事务”，工具明确区分：

1. **安全快照**：恢复前把目标完整备份到备份根，label `pre-restore`，校验通过才继续。
2. **staging**：在目标同父目录创建 `.<basename>.restore-<timestamp>`，先复制/覆盖文件。
3. **staging 校验**：所有应恢复文件哈希一致；未恢复文件保持原哈希；replace 无多余文件。
4. **两次 rename**：
   - 目标 → `<target>.before-restore-<timestamp>`；
   - staging → 目标。
   - 这不是整体原子事务；中间崩溃会留下可恢复目录状态。
5. **替换后校验**：失败时把新目标移到 `.failed-restore-*`，旧目标换回。
6. **中断恢复**：journal 位于目标同父目录 `.memoflow-restore-<timestamp>.json`；使用 `--recover --journal` 优先恢复旧目标。
   - journal 必须包含 `journalId`、`vaultId`、`markerSha256`、`backupFormat`、`backupProof`；
   - 恢复前必须通过备份校验、journal 路径/父目录校验、target/old 标记的身份校验；
   - 旧目录标记的 `pathHash` 必须等于原 target 路径的哈希（允许目录改名，但不绕过 M01 规则）；
   - target 与 oldTarget 的 `vaultId`/标记哈希必须与 journal 一致；
   - `--recover` 对默认测试库也检查 Obsidian 是否运行。
7. 旧目标与安全快照不自动删除，供人工核对/回滚。

## 8. Obsidian 运行检查

- 对默认测试库（`<repo>/../MemoFlow-Test`）执行备份/恢复前检查 Obsidian 进程。
- macOS：`pgrep -x Obsidian`；Linux：`pgrep -x obsidian`；Windows：`tasklist`。
- 检测到运行：拒绝。
- 平台无法检测：要求显式 `--confirm-obsidian-closed`。
- `restore-test-vault.mjs --recover` 同样执行该检查。
- 一次性临时 Vault 不受该限制；自动化测试使用临时 Vault。

## 9. 当前测试库基线

现有 `MemoFlow-Test`（M02 备份实测）：

- 44 个文件、11 个目录、15,099,931 字节；
- 26 notes、2 pdf、7 obsidian-config、4 memoflow、4 spaced-repetition、1 marker；
- MemoFlow 0.1.0、SR 1.15.4。

备份是只读操作；M02 的自动化测试和人工演练默认只对临时副本做恢复。

## 10. 限制

- 不提供加密、云同步、增量/去重、定时备份。
- 不保证 xattr/ACL/资源分支；内容 SHA-256、size、mode、mtime 尽力保留。
- symlink/特殊文件直接拒绝。
- `workspace.json` 会恢复；恢复到不同路径后 UI 状态可能过期，需重新打开 Vault。
- 不自动兼容写入旧 M01 格式；旧 M01 备份可只读校验/恢复。
- 不修改 MemoFlow 运行时、调度、SR 集成或 GitHub Actions。
