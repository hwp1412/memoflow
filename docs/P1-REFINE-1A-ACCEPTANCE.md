# P1-REFINE-1A 验收报告

- 分支：`feat/p1-refine-1a`
- 基线：`b25c0e1`
- 范围：历史/状态/完整性/恢复计划基础
- 未实现：编辑器选区、预览 UI、真实正文替换、Source 精简、1B/1C

## 1. 验证结果

```text
node --test test/refine-history.test.js
# tests 11
# pass 11
# fail 0

node --test test/refine-store.test.js
# tests 25
# pass 25
# fail 0

node --test test/*.test.js
# tests 287
# pass 287
# fail 0

npm run check
通过（validate-release + 287 tests）

npm run verify:memoflow
通过（构建 + node --check + 287 tests + validate-memoflow）
```

- M03 24 项、P1-SAFETY-1、Phase 1、P1-NAV-1 断言全部保留。
- 1A 测试使用内存 Adapter，不写 MemoFlow-Test，不写任何真实笔记正文/Frontmatter。

## 2. 覆盖

- BOM/CRLF/LF/空正文/无 Frontmatter/异常分隔符；
- 完整原文快照与 after body/hash；
- operation 完整性篡改检测；
- 历史写失败、读回失败、rename 失败、state 写失败；
- prepared/applied/failed/conflict/缺失 state 阻止新 operation 与恢复；
- 重复 operationId 拒绝覆盖；
- 并发不同 operation 独立历史（无跨实例锁声明）；
- 历史缺失/损坏；
- 路径重命名不自动匹配；
- 恢复 body-only、保留当前 Frontmatter；
- 当前 type=source/无 type/歧义 → 恢复拒绝；
- body 变化冲突；
- 直接 setStatus verified 被拒绝；markVerified 校验 body/type；
- 不覆盖目标 Adapter 的 rename 失败保留旧 state；
- 软 20 条限制不自动删除；
- 1 MiB note 拒绝；
- 所有测试写入都在 history root，不写真实笔记。

## 3. 历史格式/状态

见 `docs/P1-REFINE-1A.md`：

- 不可变 `<operationId>.json`；
- 独立 `<operationId>.state.json`；
- `prepared → applied → verified → restored`；
- failed/conflict 作为安全终止状态；
- 快照包含完整原文、前后 body/full hash、选区、替换内容、restoreOf。

## 4. 安全限制

- 不宣称 history+body 事务原子性；
- temp/rename 只是风险降低；
- 失败保留诊断文件，不静默删除；
- 1A 不执行真实正文写入；
- 无跨实例锁；
- 路径不是稳定 ID；
- 历史容量策略未最终确定。

## 5. Adapter 行为核实

- `DataAdapter.rename` 的目标覆盖语义不视为跨平台保证。
- 使用“目标已存在即失败”的内存 Adapter 注入测试：
  - state rename 失败；
  - 旧 state 文件内容保持不变；
  - 新 state temp 保留用于诊断；
  - operation/history 不丢失。
- 仍不宣称 temp+rename 为事务或具备 fsync 保证。

## 6. 1B 接入

1B 必须：

- 读取真实 Editor + disk 内容并校验一致；
- 处理未保存、多窗口、外部修改；
- 保存快照后调用 1A prepare；
- 用户确认后执行正文替换；
- 重新读磁盘校验后才推进 `verified`；
- 处理恢复冲突。

## 7. 回滚

- 删除分支/PR，或 revert 1A commits；
- 无真实 Vault 写入，无数据迁移。
