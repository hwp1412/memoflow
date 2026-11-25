# P2-US1-SIM-01 — MF-US-1 Offline Simulation, Property Regression & Performance Benchmark

- 任务 ID：`P2-US1-SIM-01`
- 状态：本地实现 + 自测完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ 0bf93c9`（PR #18 合并后）
- 分支：`feat/phase2-mf-us-1-simulation`
- 本地 commit：见本次验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A13.2、A13.1、A14）

## 1. 范围与边界

本 PR 只做离线验证，不改动任何已验收算法：

- 合成数据 + 内存模拟器（按显式日历推进，不读系统时间、不读 Vault、不依赖 SR）；
- A13.2 八类场景（S01–S08）；
- A13.2 八组指标（M01–M08）；
- Legacy（proxy）与 Unified 的同输入对照；
- 跨模块性质测试；
- A14 正式性能基准（10,000 Topic 纯队列计算）。

**不是**新算法参数、不是实机验证、不是学习效果证明。

## 2. 文件结构

```text
test/helpers/simulation/
  fixtures.js          固定 seed PRNG、Topic/事件构造、混合种群
  runner.js            日历驱动的日循环仿真器（队列 → ADVANCED → COMPLETE）
  metrics.js           M01–M08 指标计算（分母明确定义）
  legacy-reference.js  Legacy proxy（文档化的近似模型）
  scenarios.js         S01–S08 与对照场景
test/mf-us-1-simulation.test.js
test/mf-us-1-simulation-properties.test.js
test/mf-us-1-simulation-regression.test.js
scripts/bench-mf-us-1.mjs
docs/P2-US1-SIM-01.md
docs/MF-US-1-BENCHMARK.md
```

模拟代码位于 `test/helpers/simulation/`，**不进入生产构建**（esbuild 只从 `src/main.js` 打包）。

## 3. 可复现性

- 随机分布使用 `mulberry32` + 显式 `seed`；稳定 ID 由计数器派生，不依赖时间或 UUID 随机源。
- 同一 `(seed, scenario, days, algorithmVersion)` 必须产生相同结果：`mf-us-1-simulation.test.js` 与 properties 测试均断言 `deepEqual`。
- 模拟时间由 `startDate + offset` 显式推进；不调用 `Date.now()`。
- 模拟周期：**180 天**（模拟配置，不是算法参数）。10,000 Topic 的 S01 因运行时间下降为 **60 天**，已在结果中标注，并另做 300/1000 Topic × 180 天对照。
- 期末负荷与从未处理分开统计：`neverProcessed`（窗口内零次评阅）与 `outstandingAtEnd`（结束时 active 且 Effective Due ≤ endDate、仍待下一次处理，包含“处理过一次后又到期”的 Topic）。`unresolved` 仅作为 `outstandingAtEnd` 的兼容别名保留。
- 已处理等待只统计**已发生的评阅事件**；期末未处理属于截尾观测，单独以积压分布报告，绝不并入已处理均值。

## 4. 八类场景（S01–S08）

| ID | 配置 | 关键结果 |
|---|---|---|
| S01 | 100 / 1,000 / 10,000 Topic；混合 Source/Extract、P1–100、due −30…+30、done/dismissed/pending；180/180/60 天；预算 30 | 100：评阅事件 126、唯一处理 Topic 75、COMPLETE 64、从未处理 25、期末待处理 12、均值 5.29 / P95 26、利用率 0.178、初始完成率 0.64；1,000：评阅 703、唯一 499、COMPLETE 373、从未处理 501、期末待处理 433、均值 61.1 / P95 166、利用率 0.992、完成率 0.373；10,000（60 天）：评阅 248、唯一 202、COMPLETE 119、从未处理 9,798、期末待处理 8,934、均值 26.14 / P95 67、利用率 1.0、完成率 0.012 |
| S02 | 101 初始 + 每日 20 个新 Extract，60 天 | 新增 1,200（总计 1,301）；评阅 336、唯一 177、COMPLETE 77（初始群体 19 + 新增 58）、从未处理 1,124、期末待处理 1,180；理想积压 49 → 1,165；初始完成率 19/101 = **0.188**，全体完成率 77/1,301 = **0.059**；**父 Source 逐字节不变** |
| S03 | 300 Topic，第 11–24 天完全停止学习，第 25 天恢复 | 中断期 0 次评阅、0 分钟；恢复后评阅 116、期末待处理 167、均值 21.1 / P95 63；恢复日理想积压 201 |
| S04 | Source → E1 → E2 → E3 → E4，Source 不在窗口内到期 | 评阅事件 7、唯一处理 4（4 个 Extract 各自独立评阅）；Source 快照逐字节不变 |
| S05 | 3 Source + 10 Extract + 1 个 120 分钟任务；预算 30 | 首日选入 3 个（用满 30 分钟），11 个超预算延后；120 分钟任务始终未选入但保留在 `deferredByBudget`；5 天无一天超预算 |
| S06 | 20 个 P1–P20 + 200 个 P90–P100 + 每日 2 个 P5；60 天 | 高优先级评阅 360 次、均值 2.02 天；**低优先级评阅 0 次、期末待处理 200 个、P80–P100 最老积压 80 天**（饥饿，见 §7） |
| S07 | 4 个逾期 Topic；W=7；预览 → 应用 → 单项 revision 冲突 → 撤销 → 部分撤销续做；另测 W=3/14/30、过期预览、重复 ID | 分配 4、应用 4；人为改一项 revision 后冲突 1、其余 3 成功；撤销 4 项恢复原值；缺失后重试可继续并最终 `undone`；跨日预览 `E_MERCY_PLAN_STALE`；重复 ID 冲突 1；窗口槽数 3/7/14/30 |
| S08 | Card、非法 Priority、非法日期、缺失 ID、重复 ID、损坏字段；事件重复与 revision 冲突；**纯对象重命名** | `E_TOPIC_TYPE`、`E_PRIORITY_RANGE`、`E_DATE_INVALID`、`E_QUEUE_ID_REQUIRED`、`E_DUPLICATE_ID ×2`；3 个合法 Topic 正常选入；E1→E2→E1 重放为 duplicate 且评阅数仍为 2；`E_REVISION_CONFLICT`；重命名 A→B 后 `mf_id`/父/根/全部调度字段不变、稳定排序不变 |

## 5. 八组指标（M01–M08）与计算定义

| 指标 | 定义 | 主要结果 |
|---|---|---|
| M01 等待时间 | **仅**统计已发生评阅：Effective Due → 处理日；同时单列 `neverProcessed` 与 `outstandingAtEnd`（含再到期者）及其积压天数 | S01-100：评阅 126、均值 5.29 / P95 26、从未处理 25、期末待处理 12、最老 206 天；S01-1000：703 / 61.1 / 166 / 501 / 433 |
| M02 P1–P20 | 高优先级评阅子集 | S06：360 次评阅，均值 2.02 天 |
| M03 低优先级 | **只用 P80–P100 的期末待处理**计算最老积压；另报低优先级从未处理数 | S06：评阅 0、期末待处理 200、最老 80 天 |
| M04 每日超预算 | 实际选中分钟 vs 预算；Mercy 计划超载单独报告 | 模拟中每日均不超预算（`overBudgetMinutes = 0`）；S01-1000 利用率 0.992 |
| M05 理想逾期 | 每日 `ideal_due < today` 且未完成的 active 数 | S01-1000 峰值 816；S02 49 → 1,165；S03 恢复日 201 |
| M06 完成率 | 评阅事件 / 唯一处理 Topic / COMPLETE 三者分开；COMPLETE 按**初始群体**与**新增群体**分别累计，`completionRateOfInitial` 只用初始群体的 COMPLETE | S01-100：评阅 126、唯一 75、COMPLETE 64、初始完成率 0.64；S01-10,000：评阅 248、唯一 202、COMPLETE 119、完成率 0.012；S02：COMPLETE 77 = 初始 19 + 新增 58 → 0.188（19/101）vs 0.059（77/1,301） |
| M07 人工干预 | 按事件类型计数，标注为“模拟策略动作” | ADVANCED/COMPLETE（S07 含 Mercy 预览/应用/撤销） |
| M08 异常 | 同时给出**唯一异常身份数**（stage+code+topic）与**发生次数** | S01-1000：唯一 16 / 发生 2,880；S01-10,000：唯一 204 / 发生 12,240 |

### 5.1 统计口径反例（本次修复）

- **M03 只统计 P80–P100**：P10 逾期 100 天 + P90 逾期 5 天 → M03 低优先级最老积压 = **5 天**；M01 的全局最老积压仍为 100 天。两者口径不同，不可混用。
- **M06 分子必须同群体**：S02 初始 101 个 Topic、含新增共 1,301 个、COMPLETE 77 个（其中初始群体 19、新增群体 58）→ 初始完成率 **19/101 = 0.188**、全体完成率 **77/1,301 = 0.059**。旧实现用 77/101 = 0.762 属分子分母混群，已修正；报告任何完成率时必须同时说明分子所属群体与分母。
- **M08 两种计数**：同一坏 Topic 连续多日被报告 → 唯一身份 1 个、发生次数按天累计（如 S01-1000：16 唯一 / 2,880 次）。
- **S01-100 的 126 是评阅事件数**，唯一处理 Topic 为 **75**，COMPLETE 为 64；不得写作“处理 126 个 Topic”。
- **期末待处理 ≠ 从未处理**：S01-100 从未处理 25、期末待处理 12（后者包含处理过一次后又到期的 Topic）。

## 6. Legacy 与 Unified 对照

同一 300 Topic、同一 seed、同一 90 天日历、同一 30 分钟预算：

| 指标 | Unified | Legacy proxy | 差异来源 |
|---|---:|---:|---|
| 平均等待（天） | 23.77 | 26.17 | Legacy 首次评阅重算 `ceil(P×0.15)`；Legacy 固定 A=2.0 |
| P95 等待（天） | 74 | 81 | Legacy 排序用 urgency（含到期惩罚、无 ageBonus） |
| 未处理数 | 45 | 45 | 预算与日历相同 |
| 初始完成率 | 0.55 | 0.62 | Legacy 首次评阅间隔更短，早期完成更多 |
| 超预算分钟 | 0 | 0 | 两者都用同一贪心预算 |

**基线可信度**：`simulateLegacy` 是 **Legacy proxy**，不是真实上游实现。已文档化差异：固定 `a_factor = 2.0`（真实实现是 progress-aware，需要页数/秒数元数据）、未模拟 SR 卡片混排、Vault 读取与 frontmatter 写入、无 `not_before`/Effective Due/Mercy。因此只做**规则级差异对照**，不宣称旧插件行为等价；矩阵中以 `Legacy proxy` 标注。

**禁止外推**：以上只是调度行为差异，不证明学习效果优劣（A15）。

## 7. 发现的算法观察（未修改算法）

1. **低优先级饥饿（S06）**：在“高优先级持续涌入 + 每日预算固定”下，P90–P100 在 60 天内 0 次被处理，最老积压 80 天。这是 A6.2 有界补偿（`ageBonus ≤ 20`）与固定预算的已知后果，规范 A6.2 也要求“报告极端等待情形并允许人工提升”。**未调整 ageBonus、Priority 权重或预算。**
2. **持续新增压力（S02）**：每日 20 个新 Extract 远高于 30 分钟预算（约 100 分钟/天），理想积压 49 → 1,165，符合预期；未做任何自动限流。
3. **大规模积压（S01-10,000）**：60 天内 9,798 个 Topic 从未处理、8,934 个期末仍待处理（含再次到期者），说明预算相对于存量极小；仅记录，不调参。
4. **无超预算**：所有模拟日 `usedMinutes ≤ budgetMinutes`，预算贪心未越界。

## 8. 性质测试（A13.1 与跨模块）

`test/mf-us-1-simulation-properties.test.js` 与 `mf-us-1-simulation.test.js` 覆盖：同 seed 完全可复现（含每日新增）；`neverProcessed` 与 `outstandingAtEnd` 的区分（含“处理过一次后再次到期”的反例）；冻结输入不被修改；SKIP/POSTPONE/Mercy 都不是有效评阅；done/dismissed 不自动复活；Card 永不进入队列；预算不超支；幂等重试不重复计数；Mercy 撤销不覆盖后续用户修改；异常记录不污染合法 Topic；Priority → 首次间隔单调；模拟后 Interval/A-Factor/Priority/revision 仍在合法范围；Legacy proxy 可复现且自带限制声明。

## 9. T01–T20 覆盖差距（诚实矩阵）

| 测试 | 状态 | 证据 / 缺口 |
|---|---|---|
| T01–T04 | PASS | PR-01 `mf-us-1-initial` |
| T05–T13 | PASS | PR-02/03/04 专项测试 |
| T14 | PASS | PR-03 稳定排序 |
| T15 | PASS | PR-01 DST/日历 |
| T16 | PASS | PR-04 撤销 |
| T17 | **PARTIAL（纯对象层）** | S04 证明“创建/评阅子节点不改父对象”；真实父子创建与稳定 ID 适配属 PR-06 |
| T18 | **未覆盖** | SR 卡片评分集成属 PR-11，本 PR 不接触 SR |
| T19 | **未覆盖** | Shadow 模式尚未实现（PR-07），无“只算不写”证据 |
| T20 | **未覆盖** | 真实重命名/路径变化与稳定 ID 属 PR-06 |

## 10. 性能

正式基准见 `docs/MF-US-1-BENCHMARK.md`：10,000 Topic `selectDailyQueue` 中位数 **53.15ms**（重复运行 52.97–53.15ms；P95 65.88ms、最大 124.52ms，25 轮），低于 A14 的 500ms 目标；输入未修改、结果确定。基准环境为 Apple M4 / darwin arm64 / Node v24.21.0，非服务器参考机，已在基准文档中披露。

## 11. 安全与边界

- 全部使用合成内存数据；未访问 Vault、Frontmatter、`data.json`、SR、Obsidian、`MemoFlow-Test` 或 `phase2 test`。
- 未修改 PR-01–PR-04 已验收算法（`src/scheduling/*` 零 diff），仅新增 `test/helpers/simulation/`、测试与 `scripts/bench-mf-us-1.mjs`。
- 未创建 PR、未合并、未迁移、未启用 Unified、未发布。

## 12. 仍未真实集成

- 模拟中的“父子关系”是纯对象字段，不代表 Obsidian 文件系统或 Phase 1 适配器已验证；
- Shadow/Unified 模式、持久化 Mercy、真实写入、UI、SR 边界均未实现；
- Legacy 对照是 proxy，不是旧插件行为等价证明；
- 性能只在当前机器测量，其他平台需重新基准。

## 13. 复现命令

```bash
node --test test/mf-us-1-simulation.test.js \
            test/mf-us-1-simulation-properties.test.js \
            test/mf-us-1-simulation-regression.test.js
node scripts/bench-mf-us-1.mjs
```
