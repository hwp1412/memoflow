# P1-SAFETY-1 验收报告

- 分支：`fix/p1-safety-1`
- 基线：`7216f03`
- 当前状态：待项目所有者人工验收
- 修改范围：根 `main.js` 的 `walkSubtree()` 及 `boost` / `postponeSubtree` / `subsetReview` 三个调用点
- 未修改：Phase 1 分支、`tree-core.js`、MF-US-1、SR、发布流程

## 1. 实际测试

```text
node --test test/memoflow-subtree-safety.test.js
# tests 20
# pass 20
# fail 0

node --test test/*.test.js
# tests 216
# pass 216
# fail 0

npm run check
通过（validate-release + 216 tests）

npm run verify:memoflow
通过（构建 + node --check + 216 tests + validate-memoflow）
```

M03 24 项旧断言未修改。

## 2. 覆盖结果

- 跨来源移动后：
  - 从原始 Source A boost/postpone：不写移动后的 E1/E2；
  - 从新父 Source B boost/postpone：正常更新。
- 旧数据仅 `source`：仍可遍历。
- `tree_root=true`：不从 source 挂回。
- 路径/别名/大小写：正确解析；路径限定可消歧同名节点。
- 显式 parent 无效：
  - parent 字段完全不存在：允许 source 回退；
  - parent 字段存在但为空/无法解析：不回退 source；
  - 若 source 指向当前子树，严格拒绝；
  - 零 Frontmatter 写入。
- 直接自环 `E1.parent=[[E1]]`：严格拒绝，零写入。
- Cards 是遍历叶子：不继续遍历 Card 下的 Extract，不写 SR/Frontmatter。
- 无关 Source C 坏链接：不阻塞 Source A。
- 重复 parent/root、循环、超深：预检拒绝，零写入。
- 非 cascade boost：单节点写入，不受无关坏链接影响。
- 中途写入失败：停止后续写入，Notice 明确已写入部分，不声称原子性。
- Cards：遍历叶子，无 SR/Frontmatter 写入。
- Subset Review：排除异常关系，不写 Frontmatter。

## 3. 数据安全

- 本任务自动化测试全部使用内存 Mock，未打开/修改/恢复现有 `MemoFlow-Test`。
- 无真实 Vault 写入、无数据迁移。
- 历史 workspace.json 事件与恢复哈希见交付报告；今后未经授权不打开/覆盖/恢复现有测试 Vault。

## 4. 剩余风险

1. 严格预检只覆盖“与当前子树相关”的异常；无关分支坏链接按设计不阻塞，但用户可能希望全局清理提示。
2. 预检成功后的写入不是事务；中途失败会保留已写入部分，必须依赖 Notice 与后续人工检查。
3. 路径解析按 Vault 实际 path / basename；极端大小写/Unicode 归一化仍需真实 Obsidian 验证。
4. `subsetReview` 不写 Frontmatter，但会排除异常节点；用户可能看不到被排除项，只有 Notice 计数。
5. 未修改 `openParent()`；Extract 仍会跳 `source`，属于另一项导航问题。

## 5. 回滚

- 删除分支/PR，或 `git revert` 本 PR commits。
- 无数据迁移；无需恢复 Vault。
