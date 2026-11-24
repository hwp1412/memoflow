# 附录 A — MF-US-1 统一增量阅读调度算法技术规范

> 文档 ID：MF-US-1-SPEC  
> 规范版本：1.0.0-draft  
> 关联：[MemoFlow 1.0 AI Agent 开发总规约](../AGENTS.md)  
> 适用：阅读 Topic（Source / Extract / 多级 Extract），**不适用**记忆卡片  
> 状态：**设计基线，尚未通过模拟、实机和真实学习效果验证**

## A0. 文档用途与规范效力

本文是 MF-US-1 的**唯一算法定义来源**。`AGENTS.md` 只引用本文，不重复公式和参数。

本文包含的具体默认值属于 **MemoFlow 的待检验启发式参数**，不是原版 SuperMemo 的默认值，也不是已证实的学习效果最优解。

约束语义：

- **必须（MUST）**：实现与验收要求。
- **不得（MUST NOT）**：禁止行为。
- **建议（SHOULD）**：默认采取，偏离时须记录理由。
- **实验参数（EXPERIMENTAL）**：保持版本固定并用对照测试验证，Agent 不得自行调参。

更改任何公式、状态转移或兼容语义，必须更新本文版本、影响分析、测试与迁移计划，得到项目所有者批准。

## A1. 目标、模型边界与术语

### A1.1 目标

统一以下入口的阅读排期：

- 新建文章、PDF、章节等来源。
- 从 Source / Extract 创建新摘录。
- 有效阅读评阅、继续加工、保持间隔、近期再读。
- 用户手动排期、跳过与行政延期。
- 每日阅读队列选择与 Mercy 过载分配。

统一的是**接口与状态语义**，不是让所有材料采用同样间隔。

### A1.2 不在范围内

- QA、双向问答、Cloze、图片卡等**记忆项目**的复习调度。
- SR / FSRS 的记忆稳定度、遗忘率优化。
- 自动判定用户是否理解知识。
- 根据未经验证的数据训练预测模型。

记忆卡片继续交由 Spaced Repetition（SR）调度。

### A1.3 术语

| 术语 | 定义 |
|---|---|
| Topic | 可安排再次处理的阅读材料 |
| Source | 文章、PDF、章节、原始笔记 |
| Extract | 从 Source 或另一 Extract 提取的内容 |
| Priority (P) | 1~100 整数；1 最重要 |
| Interval (I) | 上次有效学习后设定的真实调度间隔（整数自然日） |
| A-Factor (A) | Topic 后续间隔增长倍率 |
| Ideal Due | 理想到期日期，不受行政延期影响 |
| Not Before | 行政延期产生的最早可展示日期，可为空 |
| Effective Due | 经过行政延期后，能进入普通队列的最早日期 |
| Review Event | 有效知识加工/正式评阅事件 |
| Administrative Event | Skip、Postpone、Mercy 等非学习事件 |
| Shadow | 新算法只计算与比较，不控制真实排期 |

### A1.4 数据与行为不变量

- `P` 必须为 1~100 整数；`I` 必须为 1~3650 整数；`A` 必须为 1.10~3.00 的有限数。
- 只有 `ADVANCED`、`HOLD`、`SOON` 增加 `review_count`。
- `SKIP`、`POSTPONE`、`MERCY` 不修改 Interval、A-Factor、评阅次数或最后有效评阅日。
- 新建子摘录不自动视为父主题评阅。
- `done/dismissed/container` 等不参与普通今日阅读队列（旧状态以兼容适配器实际语义为准）。
- 同一合法输入、配置、日历日期必须产生相同结果。
- 同一 `eventId` 不得被重复计为评阅。
- 不能由 MF-US-1 修改 SR 卡片复习历史。
- 升级时不能擅自重排已有 Topic。
- 任何写入失败不能导致部分调度字段成功更新、另一部分未更新而不报错。

## A2. 数据契约与兼容

### A2.1 旧字段（读取并维护兼容）

`type`, `priority`, `interval`, `a_factor`, `review_count`, `next_review`, `last_reviewed`, `status`, `source`, `parent`。

字段存在性、取值范围和旧 `status` 的实际映射必须先审计真实仓库。若值缺失、歧义或不合法，必须报告，不得为了套入新模型静默批量改写。

### A2.2 新字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `mf_scheduler_version` | integer | 当前调度版本，v1 用 1 |
| `mf_id` | UUID string | Topic 稳定 ID |
| `mf_parent_id` | UUID/null | 直接父 Topic |
| `mf_root_id` | UUID/null | 原始根 Topic |
| `mf_ideal_due` | ISO date | 理想到期日 |
| `mf_not_before` | ISO date/null | 行政最早可见日 |
| `mf_interval_days` | integer | 真实学习间隔 |
| `mf_last_event_id` | UUID/null | 最后成功处理事件 |
| `mf_revision` | integer | 乐观并发检查版本 |

旧 `next_review` 只作为兼容投影：

`next_review = formatForVault(effective_due)`。

`mf_ideal_due` 与 `mf_interval_days` 是 Unified 模式的权威调度字段。

### A2.3 日期

- 核心纯算法内采用 `YYYY-MM-DD` 的**本地日历日期**。
- `today` 必须作为显式参数传入。
- 加 N 天按日历加法操作，不得用 `N × 86400000 ms` 假装自然日。
- 统一测试跨月、闰年、夏令时变更。
- 已有旧格式只能通过 Vault 当前设置严格解析；不明确时停止该条数据迁移。

### A2.4 到期日

当 `mf_not_before == null`：

`effective_due = mf_ideal_due`

否则：

`effective_due = max(mf_ideal_due, mf_not_before)`。

“理想已逾期”“目前可处理”“因延期暂不可处理”必须分开统计；不得靠改日期掩盖真实积压。

## A3. 首次间隔算法（MF-US-1 INITIAL）

### A3.1 参数表（实验值，禁止 Agent 自行变更）

| 参数 | 值 |
|---|---:|
| 默认 Priority | 50 |
| Source 系数 `K_source` | 1.00 |
| Extract 系数 `K_extract` | 0.75 |
| 首次间隔范围 | 1~30 天 |
| 初始 Source A-Factor | 1.50 |
| 初始 Extract A-Factor | 1.80 |
| A-Factor 合法范围 | 1.10~3.00 |

**Priority 越小表示越重要。**

### A3.2 基础映射 B(P)

锚点：

| P | B(P) |
|---|---:|
| 1 | 1 |
| 50 | 3 |
| 80 | 7 |
| 100 | 21 |

分段线性插值：

- `1 ≤ P ≤ 50`：`B(P) = 1 + (P - 1) × 2 / 49`
- `50 < P ≤ 80`：`B(P) = 3 + (P - 50) × 4 / 30`
- `80 < P ≤ 100`：`B(P) = 7 + (P - 80) × 14 / 20`

`P` 非法时返回验证错误，**不得静默按 P50 处理已存在的异常数据**。

### A3.3 取整与间隔

只针对非负数定义：

`roundHalfUp(x) = floor(x + 0.5)`

`clamp(x, lo, hi) = min(hi, max(lo, x))`

`I0 = clamp(roundHalfUp(B(P) × K_type), 1, 30)`

新 Topic：

- `mf_interval_days = I0`
- `mf_ideal_due = addCalendarDays(today, I0)`
- `mf_not_before = null`
- `review_count = 0`
- `a_factor = A_type`（新建时才使用默认）
- `mf_scheduler_version = 1`

预期值：

| P | Source | Extract |
|---|---:|---:|
| 1 | 1 | 1 |
| 30 | 2 | 2 |
| 50 | 3 | 2 |
| 80 | 7 | 5 |
| 100 | 21 | 16 |

例如 `today=2026-11-24`，新建 P50 Source 到期 `2026-11-27`，新建 P50 Extract 到期 `2026-11-26`。

### A3.4 创建与父子继承

- 新 Extract 默认**仅继承父节点 Priority 数值**，但拥有独立 `mf_id`、独立理想日期、Interval、A-Factor 和 `review_count=0`。
- `mf_parent_id` 指向**当前正在摘录的直接父节点**，`mf_root_id` 指向最初来源。
- 父节点日后改 Priority 不自动同步所有子节点。
- 创建子节点**不自动增加父节点评阅次数**、不将父节点设为 done。
- 手动指定新节点首次日期是显式覆盖，不重写 Priority 或 A-Factor。
- 允许无固定深度限制的再摘录，但必须拒绝循环父子关系。

## A4. 后续间隔算法（MF-US-1 REVISIT）

### A4.1 基本公式

对成功的 `ADVANCED`：

`I_next = clamp(roundHalfUp(I_current × A_current), 1, 3650)`

`ideal_due_next = addCalendarDays(today, I_next)`

既有 Topic 的合法 A-Factor 与 Interval 应原样读取。

**第一次正式评阅不得再次使用 B(P) 或旧 `ceil(priority × 0.15)`。**

例如旧 Topic `review_count=0, interval=8, A=1.5`，下一次 `ADVANCED` 以 8 为基础得 `12` 天，**不能改为新 P50 首次 3 天**。

### A4.2 有效评阅类型

| event | 间隔结果 | `review_count` | 下次理想日期 |
|---|---|---|---|
| `ADVANCED` | `clamp(roundHalfUp(I×A),1,3650)` | +1 | 今天 + 新间隔 |
| `HOLD` | `I` | +1 | 今天 + I |
| `SOON` | `min(I,2)` | +1 | 今天 + 新间隔 |

三类事件均：

1. 校验当前版本、ID、状态。
2. 记录 `last_reviewed = today`。
3. 更新 `mf_interval_days` 与 `mf_ideal_due`。
4. 清除旧的 `mf_not_before`（以此次有效评阅为新起点）。
5. 同步兼容字段，并记录不可重复的事件 ID。

**阅读进度不等于知识加工完成**。Source 的页码变化可提供辅助提示；Extract 则以用户确认的处理结果为准。只打开材料或滚动页面不自动创建有效评阅。

### A4.3 状态事件

- `COMPLETE`：设为 done，退出 Topic 队列；不删来源、子摘录或卡片；不自动计评阅。
- `DISMISS`：主动移出 Topic 队列；不自动计评阅。
- `REACTIVATE`：明确恢复 active；恢复有效调度日期须由用户指定或采用文档化的恢复策略，**不得隐式视为学习**。

首次版本可将 REACTIVATE 的日期选择作为用户确认步骤，避免不确定行为。

## A5. 非学习事件与人工覆盖

### A5.1 SKIP

只移动当前会话指针。不得更改：

`interval`, `mf_interval_days`, `a_factor`, `review_count`, `last_reviewed`, `mf_ideal_due`, `mf_not_before`, `status`。

### A5.2 POSTPONE

输入 `N` 为正整数天：

`mf_not_before = max(mf_not_before?, mf_ideal_due, addCalendarDays(today,N))`

忽略空的 `mf_not_before`。

- 只修改行政限制及必要的审计版本。
- 不改变学习间隔、A-Factor、评阅次数及理想日期。
- 多次延期默认不提前已有的 `mf_not_before`。
- 若理想到期日在目标日期之后，应提示“未进一步推迟”。

### A5.3 MANUAL_SCHEDULE

用户直接指定目标日期，则：

- 将目标日期写入 `mf_ideal_due`。
- 清除不再适用的旧 `mf_not_before`。
- 保留真实学习间隔和评阅次数。
- 记录人工覆盖事件；允许恢复自动调度。

**手动排期不代表做过一次学习评阅。**

### A5.4 SET_PRIORITY

- 更新 1~100 的 Priority。
- 立即影响队列排序。
- 不自动改写已有间隔、A-Factor 或到期日。

## A6. 每日队列（MF-US-1 QUEUE）

### A6.1 候选条件

- 类型是 Source 或 Extract。
- 调度状态有效（active 或兼容旧版的可调度状态）。
- `effective_due ≤ today`。
- 关键字段可被合法解析。

用户“主动提前阅读”属于显式独立入口，不需要满足正常候选日期条件。

### A6.2 排序

`overdueDays = max(0, calendarDayDifference(today,effective_due))`

`ageBonus = min(20, floor(overdueDays / 7))`

`effectivePriority = max(1, P - ageBonus)`

按以下**稳定顺序**升序排序：

1. `effectivePriority`
2. 原始 `P`
3. `effective_due`
4. 创建日期
5. 稳定 Topic ID

缺失 ID 的旧笔记：在 Legacy/Shadow 中允许使用确定性的临时只读标识；进入 Unified 需要先经过受控的 ID 初始化。不得因读取队列自动改写真实 Vault。

有界等待补偿不能保证低优先级任务永不饿死；必须报告极端等待情形并允许人工提升。

### A6.3 学习时间预算

实验默认参数：

- 每日预算：30 分钟（可配置）。
- Source 预计成本：10 分钟。
- Extract 预计成本：5 分钟。
- 单 Topic 自定义预计成本：1~120 分钟。

选择规则：

1. 构建并排序候选集合。
2. 从当前剩余预算里寻找**排序最靠前且放得下**的任务。
3. 选中后扣除预计分钟数。
4. 重复直至没有任务可放入。
5. 超预算任务保留原排期，不被删除、延期或自动视为完成。

若没有任务能放入预算，提示增加预算或手动选择。不得无限循环。

### A6.4 负荷统计

分别统计未来 7 天：

- 理想日期到期数量。
- 实际可处理数量。
- 预计处理分钟数。
- 每日预算。
- 预计超载量。

预测不反向修改 Topic 的间隔。

## A7. Mercy 行政过载分配

### A7.1 与普通调度严格隔离

Mercy 不是一次 Review，也不是 A-Factor 调整。

支持窗口 `W ∈ {3,7,14,30}` 天。默认关闭自动 Mercy。

### A7.2 分配算法

输入：当前有效逾期候选集合、窗口 W、每日预算、今天日期。

1. 以 Priority、理想到期日和稳定 ID 排序。
2. 创建从**明天**开始的 W 个日历日期槽。
3. 每日维护已安排的预计分钟数。
4. 按序给每项选择最早、仍能容纳其预计分钟数的日期。
5. 如果窗口内没有可容纳日期，选择**当前预计分钟数最少**的槽（同分选更早日期），并标记超载。
6. 为每项更新 `mf_not_before`；如原有更晚限制，不得意外提前。
7. 保留 Interval、A-Factor、评阅次数与 `mf_ideal_due`。
8. 保存批次 ID、操作前的 `mf_not_before`、revision 与执行结果。

### A7.3 预览与撤销

执行前 MUST 展示：

- 目标任务数、各日任务数和分钟数。
- 预计超载日期。
- 高优先级任务是否被延迟。
- 原始 vs 预期 Effective Due。

用户确认后才能写入。

撤销时不得直接把全部 `mf_not_before` 清空，必须恢复**该批次操作前各条目的值**。遇到执行后用户又手动更改该 Topic 的情况，应进行 revision 冲突检查，逐条询问或跳过，不得覆盖新操作。

## A8. 状态机与事件契约

| 操作 | 允许的典型源状态 | 结果 | 有效评阅？ |
|---|---|---|---|
| 新建 | 不存在 | active | 否 |
| ADVANCED/HOLD/SOON | active | active，更新调度 | 是 |
| SKIP | active | active，不改调度 | 否 |
| POSTPONE | active | active，只改行政日期 | 否 |
| SET_PRIORITY | active | active，只改优先级 | 否 |
| COMPLETE | active | done | 否 |
| DISMISS | active | dismissed | 否 |
| REACTIVATE | done/dismissed | active，需明确日期策略 | 否 |

`inbox`、`pending`、`container` 等历史状态需由兼容适配器映射，**未确认含义前不得自行归类**。

事件对象至少包含：

- `eventId`（唯一）
- `topicId`
- `type`
- `createdAt` 或本地日历日期
- `payload`（事件特定）
- `expectedRevision`
- `algorithmVersion`

同 `eventId` 重复提交应返回已处理结果或幂等状态，不得重放评阅。

## A9. 纯算法接口和代码边界

建议模块：

```text
src/scheduling/
  schema.js
  dates.js
  initial.js
  interval.js
  events.js
  queue.js
  mercy.js
  migration.js
  explain.js
  index.js
```

必须提供的纯接口：

```js
initializeTopic(topic, config, today)
applyEvent(topic, event, config, today)
selectDailyQueue(topics, config, today)
previewMercy(topics, config, today)
explainSchedule(topic, config)
```

规则：

- 纯模块不得访问 Obsidian Vault、文件系统、当前系统时间、SR 内部对象或 UI。
- 输出至少包含新状态、变更差异、解释、版本、校验错误与是否需要写入。
- 由外层适配器进行单一可信写入。
- **同一 Topic 不得同时由旧 `_gradeTopic()` 和 Unified 写入。**

## A10. Legacy / Shadow / Unified 兼容和迁移

### A10.1 模式

- **Legacy**：旧算法继续实际读写。
- **Shadow**：旧算法继续写入；MF-US-1 仅计算建议和差异，**不得把新结果写回 Topic**。
- **Unified**：经用户确认后，MF-US-1 负责全部 Source/Extract 的实际调度。

首次升级默认 Legacy 或经授权的 Shadow，**不得自动启用 Unified**。

### A10.2 旧数据迁移

必须先处理字段映射与兼容性：

- 旧合法 `next_review` → 首次 `mf_ideal_due`。
- 旧合法 `interval` → `mf_interval_days`。
- 旧合法 `a_factor`、`review_count` 原样保留。
- `mf_not_before = null`（旧延期无法可靠区分时须记录限制）。
- 未生成稳定 ID 之前先运行只读适配，不得随读随写。
- 旧 Mercy 可能已覆盖历史 Interval；**不能从现有字段推断恢复原值**。

迁移需支持预览、逐项异常报告、备份和回滚。任何修改真实 Vault 的迁移都需要用户明确授权。

### A10.3 外部编辑及并发冲突

用户直接改 Frontmatter 或 Obsidian 多端同步后，若新旧字段相互冲突：

- 不静默用新字段覆盖用户修改。
- 校验 `mf_revision`。
- 提供接受外部修改或恢复调度状态的明确选择。
- 保留可恢复的旧状态和冲突原因。

## A11. 写入一致性、审计和恢复

建议写入流程：

1. 从最新文件读取 Topic。
2. 校验 `expectedRevision` 和事件是否重复。
3. 调用 `applyEvent()`。
4. 校验所得状态与不变量。
5. 以**一次 Frontmatter 更新**写入单 Topic 的相关字段。
6. 读取后验证，记录结果。
7. 批量事务保留每项独立的前后快照与结果。

不能假定跨多个 Markdown 文件具备数据库级事务。批量 Mercy 失败时必须报告部分成功、部分失败，并允许按批次安全恢复。

日志至少包含事件 ID、Topic ID、算法版本、前后 Priority/Interval/A-Factor/Due、时间、成功或失败及原因。默认不复制私人正文。

## A12. 算法解释和可观察性

每次排期应能产生人类可读解释，例如：

> P50 摘录：首次间隔 2 天（B=3 × K=0.75，按 half-up 取整）；首次到期 2026-11-26。  
> 本次有效推进：历史间隔 2 天，A-Factor 1.8，下一次间隔 4 天。  
> 因手动延期而暂不展示：理想到期 11-30，实际可展示 12-03。

解释必须区分“算法理想到期”与“行政展示日期”，不得把延期叙述为学习成功。

## A13. 验收测试（规范性）

| ID | 输入 / 事件 | 必须得到 |
|---|---|---|
| T01 | 新 P50 Source | I0=3 天 |
| T02 | 新 P50 Extract | I0=2 天 |
| T03 | 新 P1 Source | I0=1 天 |
| T04 | 新 P100 Source | I0=21 天 |
| T05 | I=3,A=1.5,ADVANCED | I_next=5 |
| T06 | I=8,HOLD | I_next=8 |
| T07 | I=8,SOON | I_next=2 |
| T08 | SKIP | 所有学习调度字段不变 |
| T09 | POSTPONE +7 | Effective Due 延后，Interval 不变 |
| T10 | P50→P10 | 只改 Priority，不重排理想日期 |
| T11 | 旧 review_count=0,I=8,A=1.5,ADVANCED | 新间隔 12，不能重新算 P50 首次值 |
| T12 | COMPLETE | 退出队列，不删除子节点 |
| T13 | eventId 重复 | 不重复计数 |
| T14 | 相同优先级与日期 | 稳定排序 |
| T15 | 跨夏令时 +1 天 | 下一个日历日期 |
| T16 | Mercy 后撤销 | 恢复每项原 `mf_not_before` |
| T17 | 新建 Extract→Extract | 父 Topic 调度不被隐式改变 |
| T18 | SR 卡片评分 | MF-US-1 不触碰 SR 数据 |
| T19 | Shadow 模式 | 新算法结果不写回 Topic |
| T20 | 同名笔记/重命名 | 稳定 ID 来源关系正确 |

### A13.1 属性测试

- `P` 增加时，同类型的 `I0` 单调不减。
- `I`、`A` 始终在合法边界内。
- 完全相同输入产生完全相同输出。
- Skip/Postpone/Mercy 不引入有效评阅。
- 后续评阅不重新调用首次间隔函数。
- 完成或移出后不自动复活。
- 合法旧数据迁移前后 Effective Due 相同。
- 不能在普通每日队列中自动选择尚未到期项。
- 跨多次失败/重试的事件保持幂等。

### A13.2 离线模拟

针对同一输入比较 Legacy 与 Unified：

- 100 / 1,000 / 10,000 Topic。
- 每日 20 个新摘录。
- 连续 14 天中断学习。
- 5 级递归摘录。
- 每日 30 分钟预算。
- 高优先级与大量低优先级积压。
- 批量 Mercy + 撤销。
- 重命名、损坏 Frontmatter 和并发冲突。

指标：平均及 P95 等待天数、P1~P20 等待时间、低优先级最长等待、每日超预算量、理想逾期数量、完成率、手动干预次数及异常数。

**模拟只证明调度行为，不证明记忆效果更好。**

## A14. 发布门槛与性能目标

**发布门槛：**

- 全部规范性测试和不变量测试通过。
- Legacy/Shadow/Unified 正确隔离；旧库不意外重排。
- 无半写入、无重复评阅、无 SR 卡片数据误改。
- 行政延期、Mercy 预览/撤销经过测试。
- 更新前备份与迁移恢复测试通过。
- Obsidian 测试 Vault 的完整工作流通过。
- 实机不可验证的地方明确标注“未验证”，不得冒充通过。

**性能目标（待基准测试验证）：**

- 10,000 Topic 的纯队列计算目标低于 500ms（参考桌面环境）。
- 不因界面重绘反复扫描全部 Markdown 正文。
- 移动端分批处理，避免长时间阻塞。

## A15. 尚未验证的设计决策

| 项目 | 目前决定 | 后续验证 |
|---|---|---|
| 首次间隔锚点 | P1=1,P50=3,P80=7,P100=21 | 真实加工等待与负荷 |
| Extract 类型系数 | 0.75 | 摘录处理完成率 |
| 初始 A-Factor | Source 1.5 / Extract 1.8 | 主题积压、手动改期率 |
| 等待补偿 | 每逾期 7 天减 1 优先级值，上限 20 | 长期低优先级饥饿 |
| 时间预算 | 30 分钟 | 真实平均处理耗时 |
| 任务成本 | Source 10 / Extract 5 分钟 | 实际耗时分布 |
| Mercy 分配 | 明天起、优先级与分钟数约束 | 负荷均衡与高优先级保护 |

**禁止 Agent 在未经批准的情况下“优化”这些参数。** 发现设计缺陷应形成修订提案，说明反例、受影响测试、旧库迁移和预期收益。

## A16. 与 SuperMemo 的关系

本设计借鉴：

- SuperMemo 增量阅读 Topic 与记忆 Item 的区分。
- A-Factor 控制 Topic 后续间隔增长的思想。
- Priority Queue 与在积压下保护高价值材料的思想。
- 学习反馈应与单纯的行政推迟分开的工程需求。

以下不是 SuperMemo 官方默认公式：`B(P)` 的四个锚点、Extract 0.75 系数、每日 30 分钟、年龄补偿、`mf_ideal_due`/`mf_not_before` 双日期模型及本规范的 Mercy 分配策略。

可供 Agent 核查的原始材料包括 Piotr Wozniak 的 *Optimization of Learning*、*Economics of Learning*、与 Gorzelańczyk 合作的重复间隔研究，以及 SuperMemo 官方 Incremental Reading 技术说明。外部研究仅用于解释设计来源，不得擅自覆盖本文的版本化工程契约。

---

**最终原则：MF-US-1 = 同一阅读事件入口 + 可解释首次排期 + A-Factor 后续间隔 + 优先级队列 + 独立行政延期 + 可验证的兼容/恢复。**
