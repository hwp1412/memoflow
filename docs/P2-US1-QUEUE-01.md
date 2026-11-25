# P2-US1-QUEUE-01 — MF-US-1 Daily Queue, Priority & Workload Core

- 任务 ID：`P2-US1-QUEUE-01`
- 状态：本地实现 + 自测完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ f177d7e4d13f14e7cb823fd3ee0ebbe2d8bdad18`（PR #16 合并后）
- 分支：`feat/phase2-mf-us-1-queue`
- 本地 commit：见本次验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft + Q15 裁决

## 1. 范围

A6 的完整纯队列计算，可在 Node.js 下独立运行：

- 候选筛选（仅 active Source/Extract，`effective_due ≤ today`）；
- Priority 1–100 与逾期补偿（`ageBonus`、`effectivePriority`）；
- 五级确定性稳定排序；
- 每日时间预算与贪心选择；
- 未来七天负荷统计（Ideal 与 Effective 分轴）；
- 每条结果的 A12 解释（到期原因、补偿、排序依据、预算结果、延期原因）。

## 2. 非范围

Mercy、离线模拟/正式性能验收、Legacy 适配/迁移、Shadow/Unified、UI、真实 Frontmatter/Vault、Card 调度、用户“主动提前阅读”入口（未来显式入口，本 PR 不实现也不阻塞）。

## 3. 文件清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/scheduling/queue.js` | 候选分析、五级排序、预算选择、解释 | 新增 |
| `src/scheduling/workload.js` | 七日负荷预测（纯函数，输入已接受条目） | 新增 |
| `src/scheduling/queue-config.js` | `QUEUE_CONFIG`：预算可配 1–1440，成本默认固定 | 新增 |
| `src/scheduling/due.js` | 兼容扩展：`dueStateFromDates` / `effectiveDueFromDates`（原函数行为不变） | 修改 |
| `src/scheduling/schema.js` | 新增 `validateEstimatedMinutes` / `validateStableId`（纯新增） | 修改 |
| `src/scheduling/index.js` | 导出新模块 | 修改 |
| `test/mf-us-1-queue.test.js` | 41 项候选/优先级/排序/预算/解释/重复身份测试 | 新增 |
| `test/mf-us-1-workload.test.js` | 15 项七日负荷（含逾期积压）测试 | 新增 |
| `test/mf-us-1-queue-properties.test.js` | 8 项性质 + 10k 性能测试 | 新增 |
| `docs/MF-US-1-DELIVERY-MATRIX.md` | 状态更新 | 修改 |
| `docs/P2-US1-QUEUE-01.md` | 本说明 | 新增 |

未修改：PR-01 的 `decimal.js` / `interval.js` / `initial.js` / `dates.js`、PR-02 的事件与账本逻辑、根 `main.js`、`src/main.js`、SR、Phase 1、`.github/workflows/`、`package.json`、`dist/`。

## 4. API 契约

```js
selectDailyQueue(topics, queueConfig?, today)
  -> {
       algorithmVersion: 1,
       today,
       queueConfig,                    // 规范化后的冻结配置
       selected: [entry],              // 已选入（按队列顺序）
       deferredByBudget: [entry],      // 到期但预算不足
       postponed: [entry],             // 理想到期已过、行政延期未到
       notYetDue: [entry],             // 尚未到期
       excluded: [item],               // done / dismissed
       unsupported: [item],            // inbox / pending / container
       invalid: [{ index, code, message, details }],
       budget: { budgetMinutes, usedMinutes, remainingMinutes,
                 selectedCount, candidateCount, deferredCount },
       workload: { startDate, endDate, days: [...], totals, budgetMinutes },
       explain: { text, data },
     }

entry = {
  stableId, type, status, priority,
  idealDue, notBefore, effectiveDue,
  overdueDays, ageBonus, effectivePriority,
  estimatedMinutes, createdDate,
  selected, reason,           // SELECTED | NO_BUDGET_REMAINING
  rank,                        // 1..n（候选内排名）
  explain: { text, data },
}
```

配置：

```js
DEFAULT_QUEUE_CONFIG = {
  version: 1,
  dailyBudgetMinutes: 30,
  budgetRange: { min: 1, max: 1440 },      // Q15
  defaultMinutes: { source: 10, extract: 5 },  // A6.3 固定启发式
  customMinutesRange: { min: 1, max: 120 },
  workloadDays: 7,
}
createQueueConfig({ dailyBudgetMinutes })   // 仅预算可覆盖
assertQueueConfig(config)                    // 固定项不可篡改
```

## 5. 候选与状态处理

| 输入 | 处理 |
|---|---|
| `type: card` | `invalid`，`E_TOPIC_TYPE`（Card 永远走 SR） |
| `status: active` 且 `effective_due ≤ today` | 候选 |
| `status: active` 且 `ideal_due ≤ today < effective_due` | `postponed`（积压保留在 ideal 轴） |
| `status: active` 且 `ideal_due > today` | `notYetDue` |
| `status: done / dismissed` | `excluded`（`STATUS_NOT_ACTIVE`） |
| `status: inbox / pending / container` | `unsupported`（`E_STATUS_UNSUPPORTED`，需适配器） |
| 字段非法（Priority/日期/成本/ID） | `invalid`，逐条报告，不中断整批 |

## 6. Priority 与逾期补偿（A6.2）

```
overdueDays      = max(0, calendarDayDifference(today, effective_due))
ageBonus         = min(20, floor(overdueDays / 7))
effectivePriority = max(1, P - ageBonus)
```

- 补偿基于 **Effective Due**（被 POSTPONE 的任务不会因为原始逾期而虚高）。
- **只用于排序**，绝不写回 `priority`；测试断言输入对象不变。
- P1/P50/P80/P100、逾期 0/6/7/14/140/2000 天、`effectivePriority ≥ 1` 均已覆盖。

## 7. 五级稳定排序（A6.2 / T14）

1. `effectivePriority` 升序
2. `priority` 升序
3. `effectiveDue` 升序
4. `createdDate` 升序（**缺失排最后**）
5. `stableId` 按 **UTF-16 code unit** 升序（`localeCompare` 依语言环境，已明确不使用）

确定性与边界：

- 输入数组顺序、随机数、系统时间都不参与决胜；
- **身份解析先于业务字段校验**：Source/Extract 的 `stableId` 在 Priority、日期、成本校验之前解析；因此即使某个 Topic 的 Priority/日期/成本非法，它仍会以可读身份参与重复检测，合法 Topic 无法借“对方已非法”绕过身份保护；
- 重复 `stableId` 在 **所有可解析身份的 Source/Extract 之间** 检测（active、done/dismissed、inbox/pending/container，以及因业务字段非法而 invalid 的记录一并参与）→ 每个出现都判 `invalid`（`E_DUPLICATE_ID`），同时从原桶移除，不任选其一；业务字段的原错误诊断同时保留（如 `E_PRIORITY_RANGE`），不静默修复；
- 身份本身不可解析的记录（无 `mf_id`/`stable_id`、或 `stable_id` 非法）不参与该检测，因此不会阻塞无关 Topic；
- Card 不参与 MF-US-1 身份检测（属于 SR），与 Source 同 ID 也不会被当成 Topic 重复；
- 无 `mf_id` 时接受调用方提供的只读 `stable_id`；两者都没有 → `E_QUEUE_ID_REQUIRED`；
- **绝不生成 UUID / 持久身份**；不写回任何 Topic。

## 8. 时间预算（A6.3）

- 默认 30 分钟；Source 10 / Extract 5；单 Topic `estimated_minutes` 1–120。
- 非法成本（0/121/负数/NaN/小数/字符串）→ 该 Topic `invalid`，不静默回退默认值。
- 选择：按排序遍历，放得下就选、扣减预算；放不下进入 `deferredByBudget`，**不修改排期、不延期、不标记完成**。

**单趟等价性说明**：规范描述为“反复找最靠前且放得下的任务”。由于预算只减不增、任务成本固定，先前放不下的任务之后也不可能放下，因此单趟线性遍历与反复扫描结果完全相同；实现用单趟，天然终止，10k 数据无循环风险。

## 9. 七日负荷（A6.4）

**窗口定义（本 PR 明确，Q17 已确认）**：`[today, today + 6]`，共 7 个日历日，含今天。

### 9.1 字段含义

| 字段 | 含义 |
|---|---|
| `idealDueCount` | 当天**新到期**的理想到期数量（`ideal_due == day`） |
| `effectiveDueCount` | 当天**新到期**的实际可处理数量（`effective_due == day`） |
| `plannedMinutes` | 当天新到期任务的预计分钟数 |
| `backlogCount` / `backlogMinutes` | **窗口开始前已逾期且今天仍可处理**的积压（`effective_due < today`），只在 today 行统计一次 |
| `availableCount` / `availableMinutes` | 当天**真实可处理负荷** = 新到期 + 积压（today 行以外仅等于新到期） |
| `budgetMinutes` | 当天预算（默认 30，可配 1–1440） |
| `overloadMinutes` | `max(0, availableMinutes - budgetMinutes)` |
| `totals.idealBacklogCount` / `idealBacklogMinutes` | **窗口无关**的原始积压信号：所有 `ideal_due < today` 的条目（含被 POSTPONE 到窗口外的），只读展示 |

### 9.2 语义（审查修复 1）

- **积压进入今日实际负荷**：`effective_due ≤ today` 的逾期任务计入 today 行的 `backlog*`，因此“今天实际要做多久”不会被漏算。审查反例（10 个逾期 Source × 10 分钟）现在得到 `backlogMinutes=100`、`availableMinutes=100`、`overloadMinutes=70`，而不是 0。
- **只计一次、不摊到未来**：积压只写入 today 行；把积压分配到未来日期属于 PR-04 Mercy 的职责，预测不做。
- **行政延期保留原始积压、不计入今日负荷**：`idealBacklogCount/Mininutes` 记录原始积压；若 `effective_due` 在窗口内则落到对应 effective 日，若在窗口外则只保留在 `idealBacklog*` 中，today 行 `backlog*=0`。
- **Ideal 与 Effective 分轴**：POSTPONE 只移动 effective 计数，不抹掉 ideal 计数。
- 只统计合法的 active Source/Extract；`done/dismissed/legacy/invalid` 不计入负荷（分别在结果桶中报告）。
- 预测只读，不反向修改任何 Topic、间隔或日期。

> 字段归属说明：`backlogCount/backlogMinutes/availableCount/availableMinutes` 是 **A6.4“实际可处理数量 / 预计处理分钟数”的实现**（修复漏算）；`idealBacklogCount/idealBacklogMinutes` 是**建议新增的只读信号**，不改变规范语义，也不需要修订 MF-US-1-SPEC。

## 10. 解释（A12）

每条 entry 的 `explain.text` 说明：类型与原始 Priority、理想到期（含行政延期）、实际可展示日、逾期天数、补偿级数、有效优先级、预计分钟数、是否选入及剩余预算（或未选入原因）。`postponed` / `notYetDue` / `excluded` / `unsupported` 各自给出原因说明；不会把延期、跳过或预算不足表述为学习完成。

## 11. 测试证据

```
node --test test/mf-us-1-queue.test.js test/mf-us-1-workload.test.js test/mf-us-1-queue-properties.test.js
  tests 64  pass 64  fail 0
[perf] 10,000 topics: 46-62ms, selected 3
```

覆盖：P1/P50/P80/P100、逾期 0/6/7/14/140/2000、`ageBonus` 上限、`effectivePriority` 下限与 1–100 性质、原始 Priority 不变、五级键逐级决胜、输入乱序不变、缺创建日期排最后、code-unit 排序、重复 ID（active+done/dismissed/inbox/pending/container 跨状态、三重复、**业务字段非法但身份可读**、Priority/日期/成本三类反例、乱序一致性）判非法且不阻塞无关 Topic、身份不可解析的记录不阻塞他人、Card 不参与身份检测、Card/历史状态拒绝、预算默认与自定义（1/120）、刚好放满、超大任务跳过后续补位、全部放不下、非法成本、预算 1–1440、确定性 100 次、输入不可变、月末/闰年/跨年/DST、七日窗口边界（today+6 计入、+7 不计）、Ideal/Effective 分轴、逾期积压进入今日负荷、行政延期保留 ideal 积压不计今日负荷、积压只计一次不摊未来、混合负荷与超载。

完整回归：

```
node --test test/*.test.js            tests 582  pass 582  fail 0
node --test $(排除 mf-us-1-)           tests 380  pass 380  fail 0
node scripts/validate-release.mjs     valid
node scripts/build.mjs --dry-run      no files written
```

未执行：`npm ci` / `npm test`（本机无 npm；CI 仍为 `npm ci && npm run check`）。Obsidian 实机：未验证。

## 12. 待裁决问题

| ID | 问题 | 当前实现 | 影响 |
|---|---|---|---|
| Q16 | 规范未定义**创建日期缺失**时的排序位置 | 缺失排最后（已知日期优先） | 只影响同优先级/同到期日的旧数据顺序 |
| Q17 | A6.4 “未来 7 天”未定义是否含今天 | 采用 `[today, today+6]`（含今天） | 若改为 `[today+1, today+7]`，今日到期不计入负荷 |
| Q18 | 标准化输入中“创建日期”“自定义成本”“只读稳定标识”的字段名 | `date_added` / `estimated_minutes` / `stable_id` | 未来适配器映射到 Frontmatter，本 PR 不写任何字段 |
| Q19 | `done/dismissed` 是否应计入负荷统计 | 不计入（仅在 `excluded` 报告） | 若需计入，会改变“剩余负荷”语义 |
| Q20 | 预算是否允许 0 分钟（暂停一天） | 不允许（Q15 为 1–1440） | 若需要“今日不读”，应由 UI 表达而非 0 预算 |

## 13. 风险

- 队列是纯计算，尚未接入任何真实入口；`selectDailyQueue` 目前无调用方，`INTEGRATED` 未达成。
- `stable_id` 为适配器契约，若未来迁移生成真实 UUID，需保证同一 Topic 的标识稳定，否则排序与账本关联会漂移。
- 七日窗口口径（Q17）若调整，会影响负荷报表基线与未来验收数据。
- 预算贪心是规范规定的策略，不保证“最省空闲时间”的最优解；这是规范选择，不是实现缺陷。

## 14. 下一步

PR-04 Mercy（预览/分配/撤销）、PR-05 离线模拟与正式性能、PR-06 Legacy 适配、PR-07 Shadow、PR-08 迁移、PR-09 Unified 写入、PR-10 UI、PR-11 SR 边界、PR-12 完整验收。
