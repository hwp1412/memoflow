# P1-SAFETY-1 — Subtree write scope safety

- 任务：修复跨来源移动后 `walkSubtree()` 的写入范围错误
- 分支：`fix/p1-safety-1`
- 基线：`main` / `7216f03`
- 状态：实施完成，待人工验收
- 非目标：MF-US-1、Phase 1、SR、调度公式、删除/移动 UI

## 1. 问题

旧 `walkSubtree()` 按：

```text
parent 命中 OR source 命中
```

跨来源移动后，新 Phase 1 数据仍保留：

```text
E1.parent = 新直接父
E1.source = 原始 Source
```

因此从原始 Source 执行 `boost` / `postponeSubtree` 时，E1 可能被错误写入。`boost` 还会先写根节点再遍历，存在部分写入风险。

## 2. 目标遍历语义

与 `treeCore.effectiveParent()` 对齐：

1. `tree_root === true` → 无父。
2. 有显式 `parent`：
   - 解析为唯一目标；
   - **不允许回退 `source`**；
   - 解析失败/目标不存在/重名 → 危险写入拒绝。
3. 没有 `parent`：
   - 才使用旧 `source` 回退；
   - source 解析失败/目标不存在/重名 → 危险写入拒绝。
4. 支持：
   - 大小写不敏感匹配；
   - `[[Folder/Note|alias]]` 路径 + 别名；
   - `[[Note#heading]]` 标题；
   - 路径限定的同名节点消歧。
5. 保持 `tree_root` 不被 source 重新挂回。
6. 保持 Cards 作为遍历叶子，不写 SR 数据。

## 3. 严格预检范围

只检查会影响当前请求子树的异常关系：

- 种子节点无法确认；
- 当前子树种子/成员名称重复；
- 当前子树相关的显式 parent 缺失/重复/无法解析；
- 显式 parent 无效且 source 指向当前子树（成员归属仍不明确）；
- 当前子树内的循环/超深。

**无关分支**中的坏链接不阻塞当前子树写入。`boost` 非级联模式保持单节点行为，不受无关坏链接影响。

## 4. 写入路径

- `boost()`：
  - cascade=true：严格预检 → 写根 → 写后代；
  - 预检失败：零写入；
  - 写入中途失败：停止，报告 partial，不声称原子性；
  - cascade=false：单节点原行为。
- `postponeSubtree()`：
  - 严格预检 → 逐项写 `next_review`；
  - 预检失败：零写入；
  - 中途失败：停止并报告已更新数量。
- `subsetReview()`：
  - 使用有效 parent 关系；
  - 排除归属不明确节点并 Notice；
  - 不写 Frontmatter。
- `openParent()`、`reparent()`、删除逻辑、调度公式、SR、Phase 1 源码均不改。

## 5. 测试

新增 `test/memoflow-subtree-safety.test.js`：

- 跨来源移动后，原 Source 的 boost/postpone 不触碰移动节点；
- 新直接父的 boost/postpone 正常；
- 旧 source fallback；
- 路径、别名、大小写、同名消歧；
- 显式 parent 缺失/空字符串/无法解析且 source 指向当前子树 → 拒绝；
- 显式 parent 为空时不回退 source；
- 直接自环 E1.parent=[[E1]] → 零写入拒绝；
- 无关 Source C 坏链接不影响 A；
- 重复 parent/root、循环、超深 → 零写入；
- tree_root=true 不被 source 挂回；
- Cards 不接收 boost 写入，且不会继续遍历 Card 下的 Extract；
- cascade Boost 预检先于根写入；
- 中途写入失败 → 停止 + partial 报告；
- Subset Review 排除异常且零 Frontmatter 写入。

## 6. 回滚

- 独立分支/PR；未合并。
- 回滚：删除分支或 `git revert` 本 PR commits。
- 无数据迁移、无真实 Vault 写入。
