# P2-US1-HOST-SUBTREE-01 — 多级子树延期宿主接线（交付）

- 基线：`personal/main @ 13ac9f9`（PR #36 合并后）
- 分支：`feat/phase2-mf-us-1-host-subtree`
- 方案提交：`f7711a2`
- 范围：子树延期接入 Unified 宿主；未改算法、Runtime、Ledger、协调器

## 1. 修改文件

| 文件 | 变更 |
|---|---|
| `src/integration/subtree-postpone-host.js` | **新增** 计划 / 顺序执行 / 汇总 / 报告（不写 Frontmatter、不计算调度） |
| `main.js` | `postponeSubtree()` 模式分流；`_postponeSubtreeLegacy(root, choice)`；新增 `postponeSubtreeHost` / `_mfUs1VerifySubtreeNode` / `_mfUs1ReportBatch`；`postponeFile` 支持固定 `today` |
| `test/mf-us-1-host-subtree.test.js` | **新增** 17 项测试 |
| `docs/MF-US-1-DELIVERY-MATRIX.md` | 状态行更新 |

## 2. 实际 UI 调用链

```
root main.js:3138 / src/main.js:192 高级菜单「Postpone subtree」
  → postponeSubtree()
     ├ Legacy / Shadow（保持原样）
     │    resolveSourceFromActive（仅 Source/PDF）→ pickFromList
     │    → _mfUs1RunLegacy({action:'POSTPONE_SUBTREE'}, _postponeSubtreeLegacy(root, choice))
     │      → 逐节点 processFrontMatter(next_review)
     └ Unified（Extract 也可作根）
          active 必须为 Source/Extract（Card 不作为根）→ pickFromList
          → postponeSubtreeHost(rootFile, days)
             → walkSubtree(strict) 预检（失败零写入）
             → planSubtreePostpone（排序 + batchId + 节点过滤）
             → 逐节点 verifyNode → postponeFile(node, days, {quiet, today})
                → HostSchedulerService → Async Runtime → A5.2 POSTPONE
             → describeBatchOutcome → 一条汇总 Notice
```

## 3. 六项契约实现

| 契约 | 实现 |
|---|---|
| 子树范围 | `walkSubtree(strict)`；Card 仅作遍历叶子且被 plan 标记 skipped；循环/歧义/过深整体拒绝；节点集合计划阶段固定 |
| 延期语义 | 每节点一次 A5.2 POSTPONE：只写 `mf_not_before`；间隔/A-Factor/评阅次数/`mf_ideal_due`/`last_reviewed` 不变 |
| 批次与身份 | 节点 eventId 由既有 descriptor 生成；`batchId = sha256(rootId+days+today+sortedIds)` 仅报告用，不落盘；重试幂等由 A5.2 `max()` 保证 |
| 部分成功 | 顺序执行、逐节点状态；`partial` 明确提示"非原子、已修改不回滚"；失败节点不阻断后续 |
| 崩溃恢复 | 每节点独立 WAL；批次无进度状态；重启 `recover()` 处理未决，重跑对已应用节点为 `no-op` |
| 模式隔离 | Legacy/Shadow 旧行为不变；Unified 不回退 Legacy；Card 永不进入 Writer |

附加安全：执行前逐节点复核 `mf_id` 与父子/来源链接，变化则 `E_TOPIC_IDENTITY_CHANGED` / `E_SUBTREE_CHANGED`（blocked，零写入）；根缺 `mf_id` 整批拒绝。

## 4. 测试

```
test/mf-us-1-host-subtree.test.js   20 pass
test/*.test.js                    1263 pass（基线 1243 + 20）
validate-release                  valid
build --dry-run                   no files written
```

覆盖：多级子树字段不变量、创建顺序无关、Extract 根不越界、根缺 ID 整批拒绝、节点缺 ID blocked、
Card/`done`/`dismissed` skipped、单节点冲突 partial、uncertain 突出显示、同批重跑全 `no-op` 且 revision 不变、
重启恢复后再跑 `no-op`、歧义根预检零写入、跨午夜固定 `today`、执行期身份变化 blocked、
Legacy 字段对照、Shadow 不写账本、静态接线断言。

## 5. 已知限制

- 批次非事务：无回滚、无批次进度持久化；以节点级账本与 A5.2 幂等为准。
- 缺 `mf_id` 的旧节点无法在 Unified 下延期（blocked），需先迁移。
- 大子树串行执行较慢（逐节点等待 Runtime 确认），仅有一条汇总提示。
- 未在真实 Obsidian 验证（本任务禁止）。

## 6. 安全边界

未启用 Unified 生产写入；未访问真实 Vault / `MemoFlow-Test` / `phase2 test`；未启动 Obsidian；
未迁移；未创建 PR/Merge；Phase 1 与 SR 未触碰。

---

## PR #37 审查闭合

### 1. 重复 `mf_id` → 整批 fail-closed

`planSubtreePostpone()` 在排序后立即做**批次写前身份唯一性检查**：不同路径共用同一非空 `topicId`
→ 抛 `E_DUPLICATE_SUBTREE_ID`，`postponeSubtreeHost` 捕获后返回 `{status:'refused'}`，
**零节点写入**。沿用队列的"同一稳定 ID 只能出现一次"规则，不建立新的持久身份索引。

测试：`two files sharing one stable id refuse the whole batch before any write`。

### 2. 父子关系变化与真实写入的一致性

原先 `_mfUs1VerifySubtreeNode()` 只基于 MetadataCache，校验与 CAS 之间存在窗口。现在把
**关系前置条件推进到真实字节的 CAS 内**：

```
postponeFile(..., { expectations: { relationKey } })
  → descriptor.expectations
  → _mfUs1UnifiedRequest().expectations
  → executeUnifiedEventAsync（读取磁盘最新内容）
  → storage.compareAndSwap(..., expectedRelation)
  → Vault.process 回调内：hash/mf_id/revision/version/type/status + parent|source 复核
     └ 不一致 → E_SUBTREE_CHANGED（写入前抛出，零字节变化）
```

`E_SUBTREE_CHANGED` 归类为 `conflict`。MetadataCache 仍是第一道快速检查（未变化的场景更早拒绝），
但最终一致性由真实字节保证。

测试：`a parent change with a stale MetadataCache blocks that node only` —— 计划后直接改磁盘
`source`、保留陈旧缓存，该节点 `conflict / E_SUBTREE_CHANGED` 且 `mf_not_before` 仍为空，
其余节点正常延期，汇总 `partial`。

### 3. 多级 Extract 夹具（parent + source 正式约定）

新增测试 `parent/source convention: a mid-level Extract root…`：`source` 始终指向原始 Source、
`parent` 指向直接父节点；以中间 Extract 为根，只写自身与后代，**祖先 Source、父节点与兄弟节点零写入**。
复用 `walkSubtree(strict)`，未修改 Phase 1 关系算法。

### 4. 回归

```
node --test test/mf-us-1-host-subtree.test.js   20 pass
node --test test/*.test.js                    1263 pass
validate-release                              valid
build --dry-run                               no files written
```
