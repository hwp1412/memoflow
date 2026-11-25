# MemoFlow 1.0 — MF-US-1 交付矩阵

> 文档 ID：MF-US-1-DELIVERY-MATRIX
> 规范来源：`docs/MF-US-1-SPEC.md`（version 1.0.0-draft）唯一权威
> 维护规则：每个规范模块独立跟踪；`IMPLEMENTED` ≠ `TESTED` ≠ `INTEGRATED` ≠ `ACCEPTED`
> 最后更新：P2-US1-HOST-01（宿主门面接线、Vault.process 适配、持久账本边界）

## 0. 状态定义

| 状态 | 含义 |
|---|---|
| `NOT_STARTED` | 尚未实现 |
| `IN_PROGRESS` | 部分实现，规范要求未覆盖完整 |
| `IMPLEMENTED` | 代码已实现，未达测试门槛 |
| `TESTED` | 规范相关单元测试 + 性质测试通过（纯算法层） |
| `INTEGRATED` | 已接入真实读写入口并通过回归 |
| `ACCEPTED` | 通过项目所有者实机/验收 |
| `BLOCKED` | 存在需裁决或依赖的阻塞项 |

## 1. 模块矩阵（41 项）

PR-01 之前的报告曾把本矩阵误标为 40 项；按编号逐项核算为 **41 项**，以此表为准。

| # | ID | 功能 | 规范条款 | 状态 | PR | 备注 |
|---:|---|---|---|---|---|---|
| 1 | SCH-SCHEMA-01 | 旧/新字段与数据不变量校验（P/I/A 范围、类型、非法值报错） | A1.4, A2.1, A2.2 | `TESTED` | 01 | 纯校验，不修复数据；含新建契约状态字段校验 |
| 2 | SCH-SCHEMA-02 | 算法版本、错误码契约、配置防篡改 | A2.2, A9, A15 | `TESTED` | 01 | `E_CONFIG_SPEC_VIOLATION` 防止参数被覆盖 |
| 3 | DATE-01 | 严格四位 ISO 本地日历日期解析 | A2.3, Q3 | `TESTED` | 01 | 0001-01-01 ~ 9999-12-31 |
| 4 | DATE-02 | 日历加减与自然日差值（整数运算） | A2.3 | `TESTED` | 01 | 无 `Date`、无时区、无 DST |
| 5 | DATE-03 | 跨月/闰年/跨年/DST/非法日期/越界 | A2.3, A13 T15 | `TESTED` | 01 | 1900/2000/2100 闰年规则已测 |
| 6 | INIT-01 | B(P) 四锚点分段线性插值 | A3.2 | `TESTED` | 01 | 锚点精确命中 1/3/7/21 |
| 7 | INIT-02 | 类型系数 K、half-up 取整、I0 钳制 1..30 | A3.1, A3.3 | `TESTED` | 01 | r2：B(P) 与 K 以精确有理数计算，无浮点路径 |
| 8 | INIT-03 | 初始 A-Factor（Source 1.50 / Extract 1.80） | A3.1 | `TESTED` | 01 | |
| 9 | INIT-04 | 新建 Topic 字段初始化（active、`mf_not_before=null`、`review_count=0`、version=1） | A3.3, A8 | `TESTED` | 01 | 不生成 ID、不读时钟；r2：非 active/非法历史一律显式报错 |
| 10 | INIT-05 | 父子继承与创建语义（只继承 Priority 数值；不改父节点） | A3.4 | `IN_PROGRESS` | 06/10B | 创建入口已接门面（Unified 拒绝）；真实 Unified 创建未启用 |
| 11 | REV-01 | 后续间隔 `clamp(roundHalfUp(I×A),1,3650)` 与“不重新初始化”保护 | A4.1, A13 T11 | `TESTED` | 01 | 与 Priority 无关；r2：I×A 精确十进制，无容差吸附 |
| 12 | EVT-01 | ADVANCED / HOLD / SOON 评阅 | A4.2 | `TESTED` | 02 | T05–T07；清行政延期、count+1、revision+1 |
| 13 | EVT-02 | COMPLETE / DISMISS | A4.3, A8 | `TESTED` | 02 | T12；保留间隔/日期/评阅历史，不级联删除 |
| 14 | EVT-03 | REACTIVATE 与恢复日期策略 | A4.3 | `TESTED` | 02 | Q5 已裁决：显式恢复日期必填，清行政延期，不计评阅 |
| 15 | EVT-04 | SKIP（不改任何学习字段） | A5.1 | `TESTED` | 02 | Q6 已裁决：零写入、不增 revision、不更新 last_event_id |
| 16 | EVT-05 | POSTPONE（只写 `mf_not_before`） | A5.2 | `TESTED` | 02 | T09；不可提前；无可见变化返回 no-op（见 §7.1） |
| 17 | EVT-06 | MANUAL_SCHEDULE（写 `mf_ideal_due`、保留间隔） | A5.3 | `TESTED` | 02 | 强制记录 reason；清旧 not_before |
| 18 | EVT-07 | SET_PRIORITY（不重排理想日期） | A5.4, A13 T10 | `TESTED` | 02 | T10；不改间隔/日期/A-Factor/子节点 |
| 19 | EVT-08 | 事件对象契约、`eventId` 幂等、`mf_revision` 乐观并发 | A8, A13 T13 | `TESTED` | 02/09 | T13；跨重启合成账本幂等；真实磁盘耐久性待 10/12 |
| 20 | DUE-01 | Ideal Due / Not Before / Effective Due 三日期语义与分别统计 | A2.4 | `TESTED` | 02 | 三类统计分离，不用改日期掩盖积压 |
| 21 | QUEUE-01 | 到期候选筛选（仅 Source/Extract、可调度状态） | A6.1 | `TESTED` | 03 | active 才入队；Card/历史状态/未到期分别报告；身份解析先于字段校验 |
| 22 | QUEUE-02 | Priority 排序、逾期补偿、五级稳定键 | A6.2, A13 T14 | `TESTED` | 03 | T14；effectivePriority 不写回；缺创建日期排最后（Q16）；重复身份跨状态且覆盖非法字段记录 |
| 23 | QUEUE-03 | 每日时间预算与贪心选择 | A6.3 | `TESTED` | 03 | Q4 已落地为 `estimated_minutes`（1–120）；预算 Q15 1–1440 |
| 24 | QUEUE-04 | 未来 7 天负荷统计 | A6.4 | `TESTED` | 03 | 窗口 [today, today+6]（Q17）；Ideal/Effective 分轴；逾期积压计入今日实际负荷（available*），原始积压用 idealBacklog*，只计一次不摊未来 |
| 25 | QUEUE-05 | 排期解释（算法日期 vs 行政日期分离） | A12 | `TESTED` | 01→03 | 队列逐条解释：到期、补偿、排序、预算、延期原因 |
| 26 | MERCY-01 | Mercy 分配（明天起 W 槽、预算、超载标记） | A7.2 | `TESTED` | 04 | 原始 Priority 排序；无槽可容纳时取最少负载槽并标超载；不提前既有延期 |
| 27 | MERCY-02 | Mercy 预览（目标数/日分布/超载/高优先级延迟/前后 Effective Due） | A7.3 | `TESTED` | 04 | 只读、确定性；含 batchId、类型与有效成本快照；预览按日绑定，过期需重生成 |
| 28 | MERCY-03 | Mercy 撤销与 revision 冲突逐条处理 | A7.3, A13 T16 | `TESTED` | 04/09 | T16；digest 确认 + intent 冻结 + next_review 同步投影 + 可信 undo；真实 UI 待 10 |
| 29 | API-01 | 五个纯接口与输出契约（新状态/差异/解释/版本/错误/是否写入） | A9 | `IN_PROGRESS` | 01→10 | `explainSchedule` 已补齐；真实入口接线待批准 |
| 30 | MODE-01 | Legacy / Shadow / Unified 隔离与默认不启用 | A10.1, A13 T19 | `TESTED` | 07/09/10B | 宿主门面热读模式 + Unified 无条件拒绝；真实启用未授权 |
| 31 | MIG-01 | 只读旧数据适配（严格日期解析、异常逐项报告） | A10.2 | `TESTED` | 06 | 六类结果 + 逐项隔离；现代/旧关系与事件字段冲突检测；writesPerformed=false |
| 32 | MIG-02 | 迁移预览、备份、回滚 | A10.2 | `TESTED` | 08 | 私有存储 + 意图重算 + 计划/备份双向对应 + 引号键 add-only；真实 Vault 待 09/12 |
| 33 | MIG-03 | 稳定 ID 初始化（确定性临时 ID → UUID） | A6.2, A10.2 | `TESTED` | 06/08 | 固定 UUID 批次清单 + 冲突检测 + 重试幂等；真实落盘待 09 |
| 34 | WRITE-01 | 单一可信写入、前后快照、失败恢复、审计日志 | A11 | `TESTED` | 09/10B | TFile + 字节保真 process 编辑 + Plugin Data 账本边界（Mock）；真实写入待 12 |
| 35 | UI-01 | 阅读 UI / Dashboard / 命令入口接入与旧算法退场审计 | A1.1 | `NOT_STARTED` | 10 | 必须审计全部 Source/Extract 入口 |
| 36 | SR-01 | SR 边界（Card 不进入 MF-US-1，不改 SR 历史） | A1.2, A13 T18 | `NOT_STARTED` | 11 | 核心层已拒绝 `type: card` |
| 37 | TEST-01 | 规范测试 T01–T20 | A13 | `IN_PROGRESS` | 01→08 | T01–T16 PASS；T17/T20 纯层证据含 5 级链；T19 PASS（PR-07）；T18 仍缺真实验收 |
| 38 | TEST-02 | 性质测试（9 条） | A13.1 | `TESTED` | 01→08 | 迁移前后 Effective Due 在计划与合成执行层已证；真实 Vault 待 12 |
| 39 | TEST-03 | 离线模拟（8 场景、8 指标） | A13.2 | `TESTED` | 05 | S01–S08 + M01–M08 + 对照；M06 按初始/新增群体拆分；对照为 **Legacy proxy**（见 docs/P2-US1-SIM-01.md） |
| 40 | TEST-04 | 性能基准（10k Topic 队列 < 500ms） | A14 | `TESTED` | 05 | 本机 Apple M4：10k 中位 53.15ms（P95 65.88ms）；见 docs/MF-US-1-BENCHMARK.md |
| 41 | ACC-01 | 隔离 Vault 实机验收与发布门槛 | A14 | `NOT_STARTED` | 12 | 禁碰 `MemoFlow-Test` |

## 2. 规范测试 T01–T20 覆盖

按规范原文核对：**共 20 条**（T01–T20）。

| ID | 内容 | 状态 | 证据 |
|---|---|---|---|
| T01 | 新 P50 Source → I0=3 | `PASS` | `mf-us-1-initial.test.js` |
| T02 | 新 P50 Extract → I0=2 | `PASS` | 同上 |
| T03 | 新 P1 Source → I0=1 | `PASS` | 同上 |
| T04 | 新 P100 Source → I0=21 | `PASS` | 同上 |
| T05 | I=3,A=1.5,ADVANCED → 5 | `PASS` | `mf-us-1-interval.test.js` |
| T06 | I=8,HOLD → 8 | `PASS` | `mf-us-1-events.test.js` |
| T07 | I=8,SOON → 2 | `PASS` | 同上 |
| T08 | SKIP 全部学习字段不变 | `PASS` | 同上（含 revision/last_event_id 不变） |
| T09 | POSTPONE +7 只延后 Effective Due | `PASS` | 同上 + `mf-us-1-due.test.js` |
| T10 | P50→P10 只改 Priority | `PASS` | 同上 |
| T11 | 旧 I=8,A=1.5,ADVANCED → 12，不重算首次值 | `PASS` | PR-01 同时覆盖“不重新初始化”保护 |
| T12 | COMPLETE 退出队列且不删子节点 | `PASS` | 核心无级联；父/根关联与全部调度字段保留 |
| T13 | `eventId` 重复不重复计数 | `PASS` | `mf-us-1-idempotency.test.js`（含 E1→E2→E1） |
| T14 | 相同优先级与日期稳定排序 | `PASS` | `mf-us-1-queue.test.js`（含乱序与 code-unit 决胜） |
| T15 | 跨夏令时 +1 天 | `PASS` | `mf-us-1-dates.test.js`（美/欧 DST 日） |
| T16 | Mercy 撤销恢复原 `mf_not_before` | `PASS` | `mf-us-1-mercy-undo.test.js`（含 null 与具体日期混合） |
| T17 | 新建 Extract→Extract 不改父调度 | `PARTIAL` | PR-01/05/06 证明纯对象层父调度不变；真实创建与适配器接线仍未执行 |
| T18 | SR 卡片评分不触碰 SR 数据 | `TODO` | PR-11；本 PR 仅证明 Card 不进入阅读队列（S08/性质测试） |
| T19 | Shadow 模式不写回 Topic | `TODO` | PR-07（尚未实现 Shadow，无证据） |
| T20 | 同名/重命名后稳定 ID 关系正确 | `TODO` | PR-06 证明持久 ID 不随路径/标题变化；真实重命名与路径解析未验收 |

## 3. 性质测试（A13.1，共 9 条）

按规范原文核对：**共 9 条**（此前报告误写为 10 条）。

| # | 性质 | 状态 | PR |
|---:|---|---|---|
| 1 | P 增加时同类型 I0 单调不减 | `PASS` | 01 |
| 2 | I、A 始终在合法边界内 | `PASS` | 01 |
| 3 | 完全相同输入产生完全相同输出 | `PASS` | 01 |
| 4 | Skip/Postpone/Mercy 不引入有效评阅 | `PASS` | 02 Skip/Postpone + 04 Mercy（仅改 mf_not_before） |
| 5 | 后续评阅不重新调用首次间隔函数 | `PASS`（核心层） | 01 |
| 6 | 完成或移出后不自动复活 | `PASS` | 02（只有显式 REACTIVATE 可复活） |
| 7 | 合法旧数据迁移前后 Effective Due 相同 | `PARTIAL` | 06 只读候选层已证（严格解析后 Effective Due 不变）；真实迁移待 08 |
| 8 | 普通每日队列不自动选择未到期项 | `PASS` | 03（含 10k 性质测试） |
| 9 | 跨失败/重试事件保持幂等 | `PASS`（纯模型） | 02；持久化重试待 09 |

## 4. 离线模拟（A13.2）规模核对

按规范原文：**8 个场景**（100/1,000/10,000 Topic；每日 20 新摘录；连续 14 天中断；5 级递归；30 分钟预算；高优先级叠加低优先级积压；批量 Mercy + 撤销；重命名/损坏 Frontmatter/并发冲突），**8 组指标**（平均与 P95 等待、P1–P20 等待、低优先级最长等待、每日超预算、理想逾期数、完成率、手动干预次数、异常数）。此前报告误写为 9 场景。全部 `NOT_STARTED`（PR-05）。

## 5. 发布门槛（A14）

| 门槛 | 状态 |
|---|---|
| 全部规范测试与不变量测试通过 | `NOT_STARTED` |
| Legacy/Shadow/Unified 正确隔离，旧库不意外重排 | `NOT_STARTED` |
| 无半写入、无重复评阅、无 SR 数据误改 | `NOT_STARTED` |
| 行政延期、Mercy 预览/撤销测试 | `NOT_STARTED` |
| 备份与迁移恢复测试 | `NOT_STARTED` |
| 隔离测试 Vault 完整工作流（Phase 2 专用副本 `phase2 test`） | `NOT_STARTED` |
| 实机不可验证处标注“未验证” | 持续遵守 |
