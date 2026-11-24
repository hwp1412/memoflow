# P1-REFINE-1A 验收报告

- 分支：`feat/p1-refine-1a`
- 基线：`b25c0e1`
- 范围：历史/状态/完整性/恢复计划基础
- 未实现：编辑器选区、预览 UI、真实正文替换、Source 精简、1B/1C

## 1. 验证结果

```text
node --test test/refine-history.test.js
# tests 14
# pass 14
# fail 0

node --test test/refine-store.test.js
# tests 30
# pass 30
# fail 0

node --test test/*.test.js
# tests 295
# pass 295
# fail 0

npm run check
通过（validate-release + 295 tests）

npm run verify:memoflow
通过（构建 + node --check + 295 tests + validate-memoflow）
```

- M03 24 项、P1-SAFETY-1、Phase 1、P1-NAV-1 断言全部保留。
- 自动化测试使用内存 Adapter；真实 Adapter 探针只在专用临时目录执行并已清理，不写任何 Source/Extract/Card 正文/Frontmatter。

## 2. 覆盖

- BOM/CRLF/LF/空正文/无 Frontmatter/异常分隔符；
- 完整原文快照与 after body/hash；
- operation 完整性篡改检测；
- 历史写失败、读回失败、rename 失败、state 写失败；
- prepared/applied/failed/conflict/缺失 state 阻止新 operation 与恢复；
- 重复 operationId 拒绝覆盖；
- 未解决历史阻止后续 operation；不同实例仍无锁（不宣称跨实例保护）；
- 历史缺失/损坏；
- 路径重命名不自动匹配；
- 恢复 body-only、保留当前 Frontmatter；
- 当前 type=source/无 type/歧义 → 恢复拒绝；
- body 变化冲突；
- 直接 setStatus verified/restored 被拒绝；markVerified 校验 body/type；
- 普通 refine operation 不能标记 restored；恢复操作必须校验 restoreOf 关系；
- 已 restored / verified-but-not-restored 的恢复不能被再次当作可恢复；
- 新精简后恢复重新可用；
- type 重复声明（即使值相同）拒绝；
- createRefineOperation/createRestoreOperation 从内容重新解析 type，不信任调用方 noteType；
- append-only state event，不覆盖旧 state；
- 软 20 条限制不自动删除；
- 1 MiB note 拒绝；
- 所有测试写入都在 history root，不写真实笔记。

## 3. 历史格式/状态

见 `docs/P1-REFINE-1A.md`：

- 不可变 `<operationId>.json`；
- 初始 `<operationId>.state.json` + 只追加的状态事件 `<operationId>.state.<sequence>-<id>.json`；
- `prepared → applied → verified → restored`；
- failed/conflict 作为安全终止状态；
- 快照包含完整原文、前后 body/full hash、选区、替换内容、restoreOf。

## 4. 安全限制

- 不宣称 history+body 事务原子性；
- state 更新使用 append-only event，不覆盖/删除旧 state；temp/rename 仍只是风险降低；
- 失败保留诊断文件，不静默删除；
- 1A 不执行真实正文写入；
- 无跨实例锁；
- 路径不是稳定 ID；
- 历史容量策略未最终确定。

## 5. 真实 DataAdapter 验证

环境：

- Obsidian：`1.15.1`
- OS：macOS `darwin`
- Electron：`43.8.9`
- Adapter：`FileSystemAdapter`（实际构造名经压缩为 `ai`，`instanceof FileSystemAdapter === true`）

### 结果

1. 对已存在的目标执行 temp + rename：
   - 失败：`Destination file already exists!`
   - 目标保持 prepared；未删除、未损坏。
2. 因此停止使用“覆盖已有 state 的 rename”方案。
3. 改为 **append-only state event**：
   - 初始 `<id>.state.json`；
   - 后续 `<id>.state.<sequence>-<id>.json`；
   - 绝不覆盖、绝不删除旧 state。
4. 真实 Obsidian 中实际执行：
   - prepared；
   - applied；
   - verified；
   - 读回均正确；
   - 关闭/重开 Obsidian 后读回 `verified`。
5. 状态文件哈希：
   - 见 `Phase1-验收证据/P1-REFINE-1A-state-hashes.sha256`。
6. 清理后与启动前备份 `diff -qr` 为空，无 Source/Extract/Card 修改。

仍不宣称跨平台原子事务或 fsync；mobile 未实测。

## 6. 1B 接入

1B 必须：

- 读取真实 Editor + disk 内容并校验一致；
- 处理未保存、多窗口、外部修改；
- 保存快照后调用 1A prepare；
- 用户确认后执行正文替换；
- 重新读磁盘校验后才推进 `verified`；
- 处理恢复冲突。

## 7. 1B 前置条件

- 1A 的 history/verification/type/restore 契约已通过测试。
- 真实桌面 DataAdapter 与 append-only state 已验证；1A 合并条件基本满足。
- mobile Adapter 尚未实测，仍作为 1A 合并后的平台风险；不阻止 1A 合并，但 1B 实机验收必须覆盖移动端。

## 8. 回滚

- 删除分支/PR，或 revert 1A commits；
- 无真实 Vault 写入，无数据迁移。
