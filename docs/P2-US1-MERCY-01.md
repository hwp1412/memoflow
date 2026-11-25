# P2-US1-MERCY-01 — MF-US-1 Mercy Allocation, Preview & Safe Undo Core

- 任务 ID：`P2-US1-MERCY-01`
- 状态：本地实现 + 自测完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ 4aa5c38f64e4af8c876cda0c1bb4375001f6a1d5`（PR #17 合并后）
- 分支：`feat/phase2-mf-us-1-mercy`
- 本地 commit：见本次验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A7、A11、A13 T16）

## 1. 范围

Mercy 的完整纯计算能力：

- `previewMercy(topics, config, today)`：只读分配计划（A7.2/A7.3）；
- `applyMercyBatch(plan, topics, today)`：内存中应用，产出新 Topic 状态 + 批次记录；
- `undoMercyBatch(batch, topics, today)`：按批次逐项恢复原 `mf_not_before`（T16）；
- 批次快照、revision 校验、逐项结果、批次汇总与解释。

## 2. 非范围

持久化执行、真实 Frontmatter/`data.json`/审计日志写入、UI、自动 Mercy 触发、跨设备并发、迁移、Unified。**持久化执行、批次审计与真实撤销仍是 MemoFlow 1.0 的必交付能力**（PR-09/10/12），本 PR 只交付其纯计算内核。

## 3. 文件清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/scheduling/mercy.js` | 配置校验、分配、预览、解释 | 新增 |
| `src/scheduling/mercy-batch.js` | 应用、批次记录、撤销、冲突处理 | 新增 |
| `src/scheduling/queue.js` | 仅新增导出 `compareStableIds` / `resolveStableId`（复用身份与排序，不改行为） | 兼容修改 |
| `src/scheduling/index.js` | 导出新模块 | 修改 |
| `test/mf-us-1-mercy.test.js` | 22 项分配/容量/边界测试 | 新增 |
| `test/mf-us-1-mercy-undo.test.js` | 26 项批次/撤销/冲突/重复身份/过期预览/成本快照测试 | 新增 |
| `test/mf-us-1-mercy-properties.test.js` | 7 项性质 + 10k 性能 | 新增 |
| `docs/MF-US-1-DELIVERY-MATRIX.md` | 状态更新 | 修改 |
| `docs/P2-US1-MERCY-01.md` | 本说明 | 新增 |

未修改：PR-01 数学/日期、PR-02 事件与账本、PR-03 队列算法（仅导出增补）、根 `main.js`、`src/main.js`、SR、Phase 1、`.github/workflows/`、`package.json`、`dist/`。

## 4. API 契约

```js
previewMercy(topics, config, today)
  -> {
       algorithmVersion, today, batchId, windowDays, queueConfig,
       slots: [{ date, budgetMinutes, plannedMinutes, topicCount, overloadMinutes, overloaded }],
       items: [item],            // assigned + noop
       assigned: [item],
       unchanged: [item],
       pinned: [item],           // 防御性：已有延期晚于窗口（不占容量）
       notOverdue: [...],
       existingPostponements: [...],
       excluded, unsupported, invalid,
       summary: { candidateCount, assignedCount, unchangedCount, pinnedCount,
                  overloadedSlotCount, totalPlannedMinutes, totalBudgetMinutes,
                  highestPriorityDelayed, delayed },
       status: 'planned' | 'noop',
       explain: { text, data },
     }

item = { stableId, priority, idealDue, notBeforeBefore, notBeforeAfter,
         effectiveDueBefore, effectiveDueAfter, estimatedMinutes, slotDate,
         revisionBefore, revisionAfter, changed, overloaded, movedEarlier,
         status: 'assigned' | 'noop', explain: { text, data } }

applyMercyBatch(plan, topics, today)
  -> { algorithmVersion, batch, results, topics, summary, explain }

undoMercyBatch(batch, topics, today)
  -> { algorithmVersion, batch (status undone/partially-undone), results, topics, summary, explain }
```

配置：`{ windowDays: 3|7|14|30, batchId, dailyBudgetMinutes? }`；`batchId` 必须由调用方提供（1–200 字符、已 trim），纯算法不生成 ID、不读时钟。

## 5. 分配契约（A7.2）

1. 候选复用 PR-03：active Source/Extract 且 `effective_due ≤ today`（`selected + deferredByBudget`）；Card、done/dismissed、legacy 状态、非法字段、重复身份分别报告。
2. 排序：**原始 Priority** → Ideal Due → 稳定 ID（注意：不是队列的 effectivePriority）。
3. 槽位：从**明天**开始 W 个连续日历日（today 永不入槽）。
4. 逐项取**最早可容纳**其成本的槽；若无槽可容纳 → 取**当前计划分钟数最少**的槽（并列取更早日期），标记超载，**不丢弃 Topic**。
5. 更新 `mf_not_before`；若已有延期更晚则不提前（`max(old, slot)`，实际候选中 old ≤ today < slot，恒不触发）。
6. 保留 Interval、A-Factor、Priority、`review_count`、`last_reviewed`、`mf_ideal_due`、父子关系。

### 5.1 容量与超载示例

today = 2026-11-25，W = 3（26/27/28），预算 30：

| Topic | P | 成本 | 分配 | 结果 |
|---|---:|---:|---|---|
| A | 10 | 40 | 26 | 26 日 40 分钟，超载 10，标记 overloaded |
| B | 20 | 10 | 27 | 26 已满×，27 放得下 |
| C | 30 | 15 | 27 | 26 55>30，27 25≤30 |
| D | 40 | 20 | 28 | 26 60>30，27 45>30，28 20 |

槽结果：26 = 40（超载 10），27 = 25，28 = 20。最高优先级被延期：P10 → 11-26。

### 5.2 已有行政延期

- **真正候选**必然 `effective_due ≤ today` ⇒ `not_before ≤ today < 明天`，因此 Mercy 的槽位总是**推后**而非提前；`max(old, slot)` 作为防御性护栏保留。
- 若调用方把「ideal 已逾期但被延期到未来」的 Topic 也传入：它属于 `existingPostponements`，**不占槽容量、不被提前**（否则会造成“虚构容量”），并保留原 `mf_not_before` 与 Effective Due。
- 这是 A7.2「当前有效逾期候选集合」的一种解释：**只有今天可处理的可获得 Topic 参与分配**。若产品希望把“被延期的积压”也纳入 Mercy，需要先裁决（见 §12 Q21），不得隐式提前延期。

## 6. 批次记录与 revision

```js
batch = {
  batchId, algorithmVersion, appliedOn, windowDays,
  status: 'applied' | 'partially-applied' | 'conflict' | 'noop' | 'undone' | 'partially-undone',
  items: [{ stableId, applyStatus: 'applied'|'noop',
            revisionBefore, revisionAfter,
            notBeforeBefore, notBeforeAfter,
            effectiveDueBefore, effectiveDueAfter }],
  undoneOn?, undoResults?,
}
```

- **预览按日绑定**：`plan.today !== today`（或 plan 无 `today`）→ 直接抛 `E_MERCY_PLAN_STALE`，要求重新预览；不会把昨天的槽位套到今天。
- 应用前逐项校验：Topic 仍是 `active` 的 Source/Extract（`NOT_SCHEDULABLE`）、**类型与预览一致**（`TOPIC_TYPE_CHANGED`）、`revision === revisionBefore`（`REVISION_MISMATCH`）、`mf_not_before === notBeforeBefore`（`NOT_BEFORE_CHANGED`）、`priority`（`PRIORITY_CHANGED`）、`mf_ideal_due`（`IDEAL_DUE_CHANGED`）、重算的 Effective Due（`EFFECTIVE_DUE_CHANGED`）；任一不符 → `conflict`，**不覆盖**。
- **有效预计成本快照**：应用时按“当前类型 + `estimated_minutes`（缺省用类型默认 10/5）”重新计算有效分钟数；与 `item.estimatedMinutes` 不一致 → `ESTIMATED_MINUTES_CHANGED`；当前 `estimated_minutes` 非法（0/121/负数/小数/字符串）→ `INVALID_ESTIMATED_MINUTES`（附 `E_ESTIMATED_MINUTES_INVALID`），**绝不回退默认值**。比较的是有效成本而非字段是否存在：预览时缺省、应用时显式写默认值（或反之）视为一致。
- **当前输入中的重复稳定 ID**：`indexTopics()` 记录重复集合而不是覆盖 Map；受影响条目一律 `conflict / DUPLICATE_ID`，不任选其一，其他 Topic 继续处理；不生成/修复/写回 ID。
- 真正变化 → `mf_revision + 1`；no-op 与冲突 → revision 不变。
- 冲突项不影响其他项，批次状态变为 `partially-applied`。
- 不设置 `mf_last_event_id`：Mercy 不是 A8 事件，批次身份由 `batchId` 独立记录（Q22）。

## 7. 撤销（A7.3 / T16）

- 只对 `applied` 项恢复 `notBeforeBefore`（**可能是 null，也可是具体日期**），并 `mf_revision + 1`（保持单调，避免与后续事件 revision 冲突）。
- **可续撤销**：每个批次项记录 `undoState: 'undone'` 与 `undoneRevision`；已恢复项再次撤销 → `already-undone`（**不再增加 revision**）；缺失项不标记，待 Topic 重新出现后可安全恢复；全部完成后批次状态为 `undone`，否则 `partially-undone` 并给出 `summary.pendingCount`。
- 撤销同样拒绝输入中的重复稳定 ID（`conflict / DUPLICATE_ID`），不影响其他项。
- 逐项校验 `stableId`、当前 revision === `revisionAfter`、当前 `mf_not_before` === `notBeforeAfter`；不符 → `conflict`，跳过该条。
- 缺失 Topic → `missing`；未应用项 → `nothing-to-undo`。
- 一项冲突不影响其他项；批次标记 `partially-undone`。
- 对已 `undone` 批次再次撤销 → 全部 `already-undone`，不再修改 revision。
- 撤销**不修改** Interval、A-Factor、Priority、评阅历史、Ideal Due。

## 8. 数据不变量（测试断言）

Mercy 前后：`mf_interval_days`、`a_factor`、`review_count`、`last_reviewed`、`priority`、`mf_ideal_due`、`mf_id`、`type`、`status`、父子字段全部不变；只有 `mf_not_before` 与 `mf_revision` 变化。预览完全不修改输入。

## 9. 规范条款对照

| 规范 | 实现 |
|---|---|
| A7.1 与普通调度隔离 | 只写 `mf_not_before`；无自动触发路径 |
| A7.2 排序/槽位/容量/超载 | `previewMercy` + `pickSlot` |
| A7.2 不得提前延期 | `max(old, slot)` + `existingPostponements` 不占容量 |
| A7.3 预览内容 | `slots/items/summary/explain` |
| A7.3 撤销恢复原值 | `undoMercyBatch` |
| A9 纯接口 | `previewMercy`，无 I/O/时钟/随机 |
| A11 审计字段 | `batch.items` 的 before/after/revision |
| A12 解释 | 每条 item + 批次摘要 |
| A13 T16 | `mf-us-1-mercy-undo.test.js` |

## 10. 测试证据

```
node --test test/mf-us-1-mercy.test.js test/mf-us-1-mercy-undo.test.js test/mf-us-1-mercy-properties.test.js
  tests 55  pass 55  fail 0

node --test test/*.test.js    tests 637  pass 637  fail 0
node --test $(排除 mf-us-1-)   tests 380  pass 380  fail 0
node scripts/validate-release.mjs -> valid
node scripts/build.mjs --dry-run  -> no files written
```

覆盖：W=3/7/14/30 与非法 W；窗口从明天开始；优先级/日期/ID 三级排序；乱序不变；刚好填满、成本>预算、全槽超载、并列取更早；跨月/跨年/闰年/DST；原 not_before 为 null/较早/较晚（既有延期不占容量）；无变化 no-op；学习字段不变；Card/历史状态/重复 ID/缺 revision 报告；预览确定性 50 次；撤销混合原值（T16）、apply/undo revision、revision 冲突、not_before 外部修改冲突、部分成功、缺失 Topic、重复撤销、冻结输入、批次字段完整性；**预览后才出现的重复 ID（apply/undo 两侧）**；**A 已撤销、B 缺失、B 恢复后重新撤销**；**过期预览、跨日拒绝、无预览日拒绝**；**状态/Priority/Ideal Due/Effective Due 无 revision 变化时拒绝应用**；**类型/有效成本在预览后变化（Source→Extract、默认→120、0/121、缺省与显式默认等价）逐项拒绝且不阻塞无关项**。

## 11. 初步性能

```
[perf] mercy preview 10k: 90.7ms, apply: 2.8ms
```

预览复用队列排序（O(n log n)）+ W 槽线性分配；远低于 A14 的 500ms 队列目标（Mercy 本身无独立目标）。

## 12. 待裁决问题

| ID | 问题 | 当前实现 | 影响 |
|---|---|---|---|
| Q21 | A7.2 的「有效逾期候选集合」是否包含被延期到未来的 Topic | 不包含；它们进入 `existingPostponements`，不占容量、不提前 | 若应包含，需先定义“延期中的积压如何占容量”，否则会虚构容量 |
| Q22 | Mercy 是否应写 `mf_last_event_id` | 不写；批次由 `batchId` 记录 | 若要求写，需要一个事件 ID 语义（Mercy 不是 A8 事件） |
| Q23 | “高优先级 Topic 的延期信息”的判定阈值 | 不设阈值；`summary.delayed` 按原始 Priority 升序给出全部，`highestPriorityDelayed` 为最高者 | 若需要“高优先级告警”阈值，需产品定义 |
| Q24 | 撤销时 revision 是否继续 +1 | 是（+1），保证单调且可被后续事件检测 | 若改为恢复原 revision，会与“revision 只增”契约冲突 |
| Q25 | 重复 apply 同一批次 | 第二次因 revision 不匹配报 `conflict`，不会重复写入 | 若要求显式 `already-applied`，需持久化批次记录（PR-09） |

## 13. 风险

- 纯粹内核尚无调用方：`previewMercy`/`applyMercyBatch` 未接入任何真实入口，`INTEGRATED` 未达成。
- 批次记录目前在内存；跨重启的批次审计与撤销恢复依赖 PR-09 的持久化设计。
- 槽容量只统计**本批次分配**的分钟数，不包含“已在窗口内被其他机制占用”的分钟（当前无其他机制；未来若有需重新定义）。
- Q21 若裁决改变，会影响 `existingPostponements` 的处理与容量基线。

## 14. 下一步

PR-05 离线模拟与正式性能、PR-06 Legacy 适配、PR-07 Shadow、PR-08 迁移、PR-09 Unified 写入与持久化 Mercy、PR-10 UI、PR-11 SR 边界、PR-12 完整验收。
