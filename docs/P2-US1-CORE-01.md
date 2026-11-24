# P2-US1-CORE-01 — MF-US-1 Deterministic Math & Calendar Core

- 任务 ID：`P2-US1-CORE-01`（含 r2 最小修复）
- 状态：本地实现 + r2 修复 + 自测完成，待项目所有者最终验收（未 push、未建 PR）
- 基线：`main @ cff090d72cea666aa69f9b3dd92cca452b2000e6`
- 分支：`feat/phase2-mf-us-1-core`
- 本地 commit：`b1621d1`（初始实现）→ 本修复 commit（SHA 见 r2 验收报告）
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft + 所有者 Q1/Q2/Q3 裁决 + r2 复核意见

## 1. 范围

实现 MF-US-1 的确定性数学与日历基础，可在纯 Node.js 下运行：

- 参数与不变量校验、稳定错误契约（A1.4 / A2.2 / A3.2 / A15）；
- 严格 ISO 本地日历日期解析与整数日历运算（A2.3 / Q3）；
- 首次间隔 `I0 = clamp(roundHalfUp(B(P) × K_type), 1, 30)`（A3.2 / A3.3）；
- 初始 A-Factor（A3.1）；
- 后续间隔 `I_next = clamp(roundHalfUp(I × A), 1, 3650)`（A4.1）；
- 新建 Topic 字段初始化与新建契约（A3.3 / A8）；
- 已有 Interval 不被重新初始化的保护（A4.1 / T11）。

## 2. 非范围（明确不做）

事件状态机（EVT-01..08）、`review_count` / `last_reviewed` 副作用、事件幂等与 `mf_revision` 递增、`effective_due`、每日队列、预算、Mercy、迁移、Shadow/Unified、UI、任何 Frontmatter 写入、任何真实 Vault 访问、任何 UUID 生成。

## 3. 文件清单

| 文件 | 作用 | r2 |
|---|---|---|
| `src/scheduling/constants.js` | 规范参数唯一事实源；深度冻结 | — |
| `src/scheduling/errors.js` | `SchedulingError`（稳定 `code` + 不可变 `details`） | — |
| `src/scheduling/schema.js` | 类型/范围校验、UUID 校验、配置防篡改校验 | — |
| `src/scheduling/dates.js` | ISO 日期 ↔ 整数日序（Hinnant），日历加减/差值/比较 | — |
| `src/scheduling/decimal.js` | **精确十进制/有理数运算（BigInt）** | 新增 |
| `src/scheduling/initial.js` | B(P)、I0、初始 A、`initializeTopic()`、新建契约 | 修改 |
| `src/scheduling/interval.js` | `roundHalfUp`（严格）、`clamp`、精确 `I×A`、解释器 | 修改 |
| `src/scheduling/index.js` | 聚合导出（扁平 + 命名空间） | — |
| `test/mf-us-1-schema.test.js` | 校验、错误契约、参数冻结、模块纯净性 | — |
| `test/mf-us-1-dates.test.js` | 日期合法性、闰年、月末/年末、DST、越界 | — |
| `test/mf-us-1-initial.test.js` | B(P)、I0 规范表、初始化字段、新建契约 | 修改 |
| `test/mf-us-1-interval.test.js` | 取整契约、精确乘法、T05/T11、单调性 | 修改 |
| `docs/MF-US-1-DELIVERY-MATRIX.md` | 41 项交付矩阵 | — |
| `docs/P2-US1-CORE-01.md` | 本说明 | 修改 |

未修改：根 `main.js`、`src/main.js`、`date-core.js`、`status-core.js`、`tree-core.js`、`src/data/*`、SR 相关代码、`.github/workflows/*`、`package.json`、`dist/*`。

## 4. API 契约

全部为同步纯函数：无 I/O、无时钟、无随机、不改入参。

```js
// 参数与校验
SPEC_CONFIG                                  // 深度冻结；与规范逐项一致
assertConfig(config?) -> SPEC_CONFIG         // 偏离规范/未知键 => 抛错
validatePriority / validateIntervalDays / validateAFactor / validateTopicType
validateUuid / validateOptionalUuid          // 只校验，不生成

// 日期（'YYYY-MM-DD'，0001-01-01 .. 9999-12-31）
isValidDateString(s) / assertDateString(s)
addCalendarDays(s, days) / calendarDayDifference(a,b)
compareDate / maxDate / minDate / toDayNumber / fromDayNumber

// 首次排期
baseInitialIntervalDays(p) -> B(P) 浮点（仅供展示）
initialBaseRational(p) -> { n: BigInt, d: BigInt }   // 精确有理数
initialIntervalDays({type, priority}) -> I0
initialAFactor(type) -> 1.5 | 1.8
initializeTopic({type, priority?, mfId, mfParentId?, mfRootId?}, config?, today)
  -> { topic, diff:{created:true}, explain:{text,data}, algorithmVersion:1, needsWrite:true }

// 后续间隔
roundHalfUp(x) -> 整数            // 严格 floor(x+0.5)，不吸附
exactProduct(I, A) -> { n, d }    // 精确十进制乘积
computeNextIntervalDays({mf_interval_days, a_factor}) -> 整数
explainNextInterval({...}) -> { intervalDays, nextIntervalDays, text, data }
```

`topic` 字段：`type, priority, status:'active', mf_id, mf_parent_id, mf_root_id, mf_ideal_due, mf_not_before:null, mf_interval_days, mf_last_event_id:null, mf_revision:0, mf_scheduler_version:1, a_factor, review_count:0`。

### 4.1 取整契约（r2 明确拆分）

| 入口 | 契约 |
|---|---|
| `roundHalfUp(x)` | 严格 `floor(x + 0.5)`，作用于**传入的那个 double 值**；不做任何“接近半整数就吸附”的修正。实现为 `floor(x) + (fraction >= 0.5)`，因为直接计算 `x + 0.5` 会因加法舍入把 `0.49999999999999994` 变成 1.0。 |
| `computeNextIntervalDays()` | 先把 `I` 与 `A` 转成它们所表示的**精确十进制**（`String(v)` 的最短往返表示），用 BigInt 相乘，再对精确有理数做 `floor(p + 1/2)`。 |
| `initialIntervalDays()` | B(P) 与 K 以**精确有理数**保存（`(2P+47)/49`、`(2P−55)/15`、`(7P−490)/10`、`3/4`），全程 BigInt 取整，不经过浮点。 |

因此：`25 × 2.3 = 57.5 → 58`（数学真值），而 `1 × 1.4999999996 = 1.4999999996 → 1`（确实低于半整数）。

## 5. 错误码

| code | 触发 |
|---|---|
| `E_OBJECT_REQUIRED` | 入参不是普通对象 |
| `E_PRIORITY_TYPE` / `E_PRIORITY_RANGE` | Priority 非整数 / 越界（含 `"50"`、`null`、`1.5`） |
| `E_INTERVAL_TYPE` / `E_INTERVAL_RANGE` | Interval 非整数 / 不在 1..3650 |
| `E_AFACTOR_TYPE` / `E_AFACTOR_RANGE` | A-Factor 非有限数 / 不在 1.10..3.00 |
| `E_TOPIC_TYPE` | 非 source/extract（`card` 归 SR） |
| `E_ID_REQUIRED` / `E_ID_FORMAT` | 缺少稳定 ID / 非 UUID |
| `E_STATUS_NOT_NEW` | 传入非 active 的 status（r2 新增） |
| `E_REVIEW_COUNT_INVALID` | `review_count` 非非负整数（r2 新增） |
| `E_STATE_FIELD_INVALID` | 状态字段存在但类型非法/不明确（r2 新增） |
| `E_ALREADY_INITIALIZED` | 已存在调度状态，拒绝重新初始化 |
| `E_DATE_FORMAT` / `E_DATE_INVALID` / `E_DATE_OUT_OF_RANGE` | 日期格式 / 非真实日期 / 超出 0001..9999 |
| `E_DAY_ADD_TYPE` | 加天参数非整数 |
| `E_ROUND_TYPE` / `E_NEGATIVE_INPUT` | `roundHalfUp` 入参非法 |
| `E_DECIMAL_TYPE` / `E_DECIMAL_FORMAT` | 精确运算入参非法（r2 新增） |
| `E_CONFIG_SPEC_VIOLATION` / `E_CONFIG_UNKNOWN_KEY` | 试图改动规范参数 / 传入未知参数 |

## 6. 关键实现决策

1. **Q1**：`priority === undefined` 时才使用默认 50；显式 `null`、字符串、越界一律报错。
2. **Q2**：A-Factor 严格 1.10–3.00；1.05 与 5.0（旧 clamp 边界）报 `E_AFACTOR_RANGE`，不截断、不替换默认值、不写回。
3. **Q3**：严格四位 ISO 日期，0001-01-01 ~ 9999-12-31；越界返回 `E_DATE_OUT_OF_RANGE`；全程整数日序运算。
4. **ID 由调用方提供**：核心不生成 UUID（`E_ID_REQUIRED`）。
5. **参数不可调**：`assertConfig()` 要求与规范逐值相等，未知键拒绝，始终使用冻结配置（A15）。
6. **取整不靠容差**（r2）：不再使用 `toFixed(9)` 吸附；改为「严格 `roundHalfUp`」+「`I×A` / `B(P)×K` 精确有理数运算」两条独立契约。
7. **新建契约**（r2）：只有 `status` 缺省或为 `active`、`review_count` 缺省或为 `0`、且不含任何调度/记账字段的输入才能进入初始化；其余一律显式报错，核心不静默把既有笔记变成 active。
8. **不触碰父节点**：创建子节点不修改父对象，也不用创建充当父评阅（A3.4）。

## 7. 规范条款对照

| 规范 | 实现位置 | 测试 |
|---|---|---|
| A1.4 不变量 | `schema.js` | `mf-us-1-schema` |
| A2.2 版本 / 错误契约 | `constants.js`, `errors.js` | `mf-us-1-schema` |
| A2.3 日期 | `dates.js` | `mf-us-1-dates` |
| A3.1 参数表 | `constants.js` | schema + initial |
| A3.2 B(P)（精确有理数） | `initial.js` | `mf-us-1-initial` |
| A3.3 取整与 I0 | `decimal.js` + `initial.js` + `interval.js` | initial + interval |
| A3.3 新建字段 | `initial.js` | `mf-us-1-initial` |
| A4.1 后续间隔 + T11 | `interval.js` + `decimal.js` | `mf-us-1-interval` |
| A8 新建 → active、不得静默复活 | `initial.js` | `mf-us-1-initial`（r2 新增用例） |
| A9 纯接口边界 | 全部 | 纯净性测试 |
| A12 解释 | `initial.js`, `interval.js` | initial + interval |
| A15 参数不可调 | `schema.js` | `mf-us-1-schema` |

## 8. r2 修复记录

### 8.1 取整精度（fix 1）

- **根因**：`toFixed(9)` 归一会把“距半整数 < 5e-10”的值吸附到半整数。对 `0.4999999996`、`1 × 1.4999999996`、`1 × 2.4999999996` 造成错误进位；而放宽容差会破坏 `25 × 2.3 = 57.5 → 58`。
- **修复**：删除容差吸附；`roundHalfUp` 改为严格 `floor(x+0.5)`（并用 `floor(x) + fraction>=0.5` 避免加法舍入）；`I×A` 改为「最短往返十进制 → BigInt 有理数 → 精确 half-up」。`B(P)×K` 同步改为精确有理数，消除浮点路径。
- **反例测试**：`roundHalfUp(0.4999999996) = 0`；`{I:1,A:1.4999999996} = 1`；`{I:1,A:2.4999999996} = 2`；`{I:1,A:2.5} = 3`；`{I:25,A:2.3} = 58`；`{I:8,A:1.4999999996} = 12`；长小数 A（`1.234567890123456`）不截断。
- **独立验证**（一次性脚本，未入库）：A 两位小数 × I 1..3650 = 697,150 例、A 四位小数 × 204 个 I = 3,876,204 例，与独立整数精确算法 **0 不匹配**；`roundHalfUp` 对 2,821 个半整数邻域/ULP 值，与“double 精确值 → 有理数 half-up”**0 不匹配**。

### 8.2 新建契约（fix 2）

- **根因**：原实现在 `status` 已知为 `done/dismissed/container` 时仍输出 `status:'active'`；`review_count: -1` 或 `'oops'` 被 `hasMeaningfulState` 当成“无历史”而放过。
- **修复**：新增 `assertNotInitialized()` 的新建契约校验：
  - `status` 只能是缺省或 `active`，否则 `E_STATUS_NOT_NEW`；
  - `review_count` 必须是非负整数，否则 `E_REVIEW_COUNT_INVALID`；`> 0` 则 `E_ALREADY_INITIALIZED`；
  - `mf_interval_days` / `interval` / `a_factor`：类型非法 → `E_STATE_FIELD_INVALID`；合法 → `E_ALREADY_INITIALIZED`；
  - `last_reviewed` / `next_review` / `mf_ideal_due` / `mf_not_before`：非字符串或空串 → `E_STATE_FIELD_INVALID`；否则 `E_ALREADY_INITIALIZED`；
  - `mf_last_event_id` / `mf_revision` / `mf_scheduler_version` 只要出现即 `E_ALREADY_INITIALIZED`。
- **反例测试**：`status: done/dismissed/container/inbox/pending/null` 全部 `E_STATUS_NOT_NEW`；`review_count: -1/1.5/'oops'/NaN/Infinity` 全部 `E_REVIEW_COUNT_INVALID`；`a_factor:'oops'`、`a_factor:null`、`last_reviewed:null` 等 `E_STATE_FIELD_INVALID`；`status:'active'` 与 `review_count:0` 仍可用于新建。

## 9. 测试证据

```
node --test test/mf-us-1-*.test.js
  tests 66  pass 66  fail 0

node --test test/*.test.js
  tests 423 pass 423 fail 0        # 357 条既有基线 + 66 条新增

node --test $(ls test/*.test.js | grep -v 'mf-us-1-')
  tests 357 pass 357 fail 0        # main @ cff090d 基线，未修改未跳过

node scripts/validate-release.mjs -> Release metadata and assets are valid.
node scripts/build.mjs --dry-run  -> [dry-run] no files were written.
```

未执行：`npm ci` / `npm test`（本机无 npm，仅 DSH 内置 `node v24.21.0`；CI 仍用 `npm ci && npm run check`）。Obsidian 实机验收：**未验证**（本阶段只允许离线测试）。

## 10. 风险与待裁决

- `mf_revision: 0` 为初始占位；递增语义已在 Q9 定为“每次成功修改权威状态 +1”，PR-02 实现。
- `initializeTopic()` 要求 `mfId`；无 ID 旧数据的确定性临时 ID 待 Q8（PR-06）。
- 旧库 `interval` 已被 POSTPONE/MANUAL/MERCY 覆盖，迁移不得反推真实间隔（PR-08）。
- A-Factor 是否随评阅动态调整：Q13 已定为 PR-02 先保持恒定，1.0 的自适应需求另案。
- 新建契约要求调用方不得把 `initializeTopic()` 的输出回灌作为输入（含 `mf_revision:0` 等字段会被判为既有状态）；此约束需写入 PR-06 适配器契约。

## 11. 回滚

纯新增文件 + r2 局部修改，无既有文件改动。回滚：丢弃分支 `feat/phase2-mf-us-1-core`，或 revert 本修复 commit 回到 `b1621d1`。无数据写入、无迁移、无真实 Vault 影响。
