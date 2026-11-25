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
- 未完成 Topic 不从未处理分母中删除：`m01Waiting.unresolved*` 单独报告。

## 4. 八类场景（S01–S08）

| ID | 配置 | 关键结果 |
|---|---|---|
| S01 | 100 / 1,000 / 10,000 Topic；混合 Source/Extract、P1–100、due −30…+30、done/dismissed/pending；180/180/60 天；预算 30 | 100：处理 126、未处理 12、平均等待 5.29 天、P95 26、利用率 0.178、完成率 0.64；1,000：处理 703、未处理 419、平均 61.1、P95 166、利用率 0.992、完成率 0.373；10,000（60 天）：处理 248、未处理 8,925、平均 26.14、P95 67、利用率 1.0、完成率 0.012 |
| S02 | 100 初始 + 每日 20 个新 Extract，60 天 | 新增 1,200；处理 336、未处理 1,117；理想积压 49 → 1,165；**父 Source 逐字节不变** |
| S03 | 300 Topic，第 11–24 天完全停止学习，第 25 天恢复 | 中断期 0 次评阅、0 分钟；恢复后处理 116、未处理 167、平均等待 21.1、P95 63；恢复日理想积压 201 |
| S04 | Source → E1 → E2 → E3 → E4，Source 不在窗口内到期 | 4 个 Extract 各自独立评阅；Source 快照逐字节不变 |
| S05 | 3 Source + 10 Extract + 1 个 120 分钟任务；预算 30 | 首日选入 3 个（用满 30 分钟），11 个超预算延后；120 分钟任务始终未选入但保留在 `deferredByBudget`；5 天无一天超预算 |
| S06 | 20 个 P1–P20 + 200 个 P90–P100 + 每日 2 个 P5；60 天 | 高优先级处理 360 个、平均等待 2.02 天；**低优先级处理 0 个、未处理 200 个、最老积压 80 天**（饥饿，见 §7） |
| S07 | 4 个逾期 Topic；W=7；预览 → 应用 → 单项 revision 冲突 → 撤销 → 部分撤销续做；另测 W=3/14/30、过期预览、重复 ID | 分配 4、应用 4；人为改一项 revision 后冲突 1、其余 3 成功；撤销 4 项恢复原值；缺失后重试可继续并最终 `undone`；跨日预览 `E_MERCY_PLAN_STALE`；重复 ID 冲突 1；窗口槽数 3/7/14/30 |
| S08 | Card、非法 Priority、非法日期、缺失 ID、重复 ID、损坏字段；事件重复与 revision 冲突 | `E_TOPIC_TYPE`、`E_PRIORITY_RANGE`、`E_DATE_INVALID`、`E_QUEUE_ID_REQUIRED`、`E_DUPLICATE_ID ×2`；3 个合法 Topic 正常选入；E1→E2→E1 重放为 duplicate 且评阅数仍为 2；`E_REVISION_CONFLICT` |

## 5. 八组指标（M01–M08）与计算定义

| 指标 | 定义 | 主要结果 |
|---|---|---|
| M01 等待时间 | Effective Due → 实际处理日的日历天数；未处理者单列积压天数 | S01-100：均值 5.29 / P95 26；S01-1000：61.1 / 166；S06 低优先级未处理 200 个 |
| M02 P1–P20 | 同上的高优先级子集 | S06：360 次处理，均值 2.02 天 |
| M03 低优先级 | P80–P100 最长等待 + 未处理最老积压 | S06：处理 0、未处理 200、最老 80 天 |
| M04 每日超预算 | 实际选中分钟 vs 预算；Mercy 计划超载单独报告 | 模拟中每日均不超预算（`overBudgetMinutes = 0`）；S01-1000 利用率 0.992 |
| M05 理想逾期 | 每日 `ideal_due < today` 且未完成的 active 数 | S01-1000 峰值 816；S02 49 → 1,165；S03 恢复日 201 |
| M06 完成率 | ① 评阅事件数 ② 至少处理一次的 Topic ③ COMPLETE，三者分开；分母给出 | S01-100：②126、③64、初始完成率 0.64；S01-10,000（60 天）：②116（唯一）、③120 事件、初始完成率 0.012 |
| M07 人工干预 | 按事件类型计数，标注为“模拟策略动作” | ADVANCED/COMPLETE（S07 含 Mercy 预览/应用/撤销） |
| M08 异常 | 按错误码 + 阶段（queue/event/mercy）计数，附最小样本 | S01-1000：16 条唯一异常；S08 见上表 |

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
3. **大规模积压（S01-10,000）**：60 天内 8,925 个 Topic 未处理，说明预算相对于存量极小；仅记录，不调参。
4. **无超预算**：所有模拟日 `usedMinutes ≤ budgetMinutes`，预算贪心未越界。

## 8. 性质测试（A13.1 与跨模块）

`test/mf-us-1-simulation-properties.test.js` 覆盖：同 seed 完全可复现（含每日新增）；冻结输入不被修改；SKIP/POSTPONE/Mercy 都不是有效评阅；done/dismissed 不自动复活；Card 永不进入队列；预算不超支；幂等重试不重复计数；Mercy 撤销不覆盖后续用户修改；异常记录不污染合法 Topic；Priority → 首次间隔单调；模拟后 Interval/A-Factor/Priority/revision 仍在合法范围；Legacy proxy 可复现且自带限制声明。

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
