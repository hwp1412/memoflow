# P1-NAV-1 — Direct parent navigation

- 任务：修复多级 Extract 的 `openParent()` 错误跳原始 Source
- 分支：`fix/p1-nav-1`
- 基线：`personal/main` = `2e76ce5`
- 范围：只读导航；不改创建、移动、删除、调度、Frontmatter 写入

## 1. 导航契约

### Extract

1. `tree_root === true`：停止，不通过 source 找父。
2. 显式 `parent` 字段存在：只解析该字段。
3. `parent` 唯一有效：打开直接父。
4. `parent` 空/null/无效/目标缺失/歧义：停止并提示，**不回退 source**。
5. 仅完全不存在 `parent` 字段：旧数据允许 `source` 回退。
6. 目标为当前文件：拒绝。
7. 路径链接按路径解析；裸链接要求唯一 basename；大小写不敏感；支持 alias/heading 去除。
8. **普通文本 parent 是旧数据兼容格式**，不是无效值：
   - `parent: E1` 在没有歧义且目标存在时可导航；
   - `parent` 的单元素 YAML 列表形式（旧数据可能产生）由既有 `linkTargetName()`/String 归一化兼容；
   - 普通文本仍必须满足目标唯一；缺失/歧义时停止，不回退 source。

### Card / Source

- Card：保持现有 `source` 导航。
- Source：保持现有 `parent` 导航。
- 两者增加自引用保护，不改变来源语义。

## 2. 实现

根 `main.js`：

- 新增 `_resolveExtractNavigationTarget(active, link)`：
  - 显式 parent 与旧 source 共用安全解析；
  - 路径优先、basename 唯一、大小写、alias/heading；
  - 缺失/歧义/自引用返回错误码；
  - 不依赖 `getFirstLinkpathDest()` 在歧义时任意选择。
- 修改 `openParent()`：
  - Extract 严格 parent/source 契约；
  - Card/Source 保留原行为；
  - 失败不打开错误文件。

不修改：

- `src/main.js`、`src/data/extract.js`
- `tree-core.js`、`status-core.js`
- Boost/Postpone/Subset
- SR、调度、MF-US-1、发布流程

## 3. 测试

`test/memoflow-parent-nav.test.js` 17 项：

- E2→E1、E3→E2；
- 无 parent 的旧 source 回退；
- 空/null/不可解析 parent 不回退；
- 删除父、同名歧义、路径、大小写、alias；
- tree_root、Card、Source；
- 自引用；
- 失败不打开错误文件；
- 所有导航零 Frontmatter/正文/append/create 写入。

现有 Phase1 的旧 `openParent` 断言已更新为直接父行为；M03 24 项与 P1-SAFETY-1 断言未改。

## 4. 回滚

- 合并前：关闭 PR 即可，main 不受影响。
- 合并后：按实际 merge 方式 revert；代码回滚不恢复导航历史或 Vault 运行状态。
- 本任务无 Frontmatter/正文写入，无数据迁移。
