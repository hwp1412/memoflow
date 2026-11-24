# P2-US1-CORE-01 — MF-US-1 Deterministic Math & Calendar Core

- 任务 ID：`P2-US1-CORE-01`
- 状态：本地实现与自测完成，待项目所有者验收（未 push、未建 PR）
- 基线：`main @ cff090d72cea666aa69f9b3dd92cca452b2000e6`（PR #13 合并后）
- 分支：`feat/phase2-mf-us-1-core`
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft + 项目所有者 Q1/Q2/Q3 裁决

## 1. 范围

实现 MF-US-1 的确定性数学与日历基础，可在纯 Node.js 下运行：

- 参数与不变量校验、稳定错误契约（A1.4 / A2.2 / A3.2 / A15）；
- 严格 ISO 本地日历日期解析与整数日历运算（A2.3 / Q3）；
- 首次间隔 `I0 = clamp(roundHalfUp(B(P) × K_type), 1, 30)`（A3.2 / A3.3）；
- 初始 A-Factor（A3.1）；
- 后续间隔 `I_next = clamp(roundHalfUp(I × A), 1, 3650)`（A4.1）；
- 新建 Topic 字段初始化（A3.3 / A8）；
- 已有 Interval 不被重新初始化的保护（A4.1 / T11）。

## 2. 非范围（明确不做）

事件状态机（EVT-01..08）、`review_count` / `last_reviewed` 副作用、事件幂等与 `mf_revision` 递增、`effective_due`、每日队列、预算、Mercy、迁移、Shadow/Unified、UI、任何 Frontmatter 写入、任何真实 Vault 访问、任何 UUID 生成。

## 3. 文件清单

| 文件 | 作用 |
|---|---|
| `src/scheduling/constants.js` | 规范参数唯一事实源；深度冻结；含 4 个 B(P) 锚点与年份范围 |
| `src/scheduling/errors.js` | `SchedulingError`（稳定 `code` + 不可变 `details`） |
| `src/scheduling/schema.js` | 类型/范围校验、UUID 校验、配置防篡改校验 |
| `src/scheduling/dates.js` | ISO 日期 ↔ 整数日序（Hinnant 算法），日历加减/差值/比较 |
| `src/scheduling/initial.js` | B(P)、I0、初始 A-Factor、`initializeTopic()`、不重算保护 |
| `src/scheduling/interval.js` | `roundHalfUp`、`clamp`、`computeNextIntervalDays()`、解释器 |
| `src/scheduling/index.js` | 聚合导出（扁平 + 命名空间） |
| `test/mf-us-1-schema.test.js` | 校验、错误契约、参数冻结、模块纯净性 |
| `test/mf-us-1-dates.test.js` | 日期合法性、闰年、月末/年末、DST、越界、对称性 |
| `test/mf-us-1-initial.test.js` | B(P)、I0 规范表、初始 A、初始化字段、不重算、不可变性 |
| `test/mf-us-1-interval.test.js` | half-up、钳制、T05/T11、单调性、十进制精确性 |
| `docs/MF-US-1-DELIVERY-MATRIX.md` | 41 项交付矩阵（新建） |
| `docs/P2-US1-CORE-01.md` | 本说明（新建） |

未修改：根 `main.js`、`src/main.js`、`date-core.js`、`status-core.js`、`tree-core.js`、`src/data/*`、SR 相关代码、`.github/workflows/*`、`package.json`、`dist/*`。

## 4. API 契约

全部为同步纯函数：无 I/O、无时钟、无随机、不改入参。

```js
// 参数与校验
SPEC_CONFIG                                  // 深度冻结；与规范逐项一致
assertConfig(config?) -> SPEC_CONFIG         // 任何偏离规范/未知键 => 抛错
validatePriority(v) -> 1..100 整数
validateIntervalDays(v) -> 1..3650 整数
validateAFactor(v) -> 1.10..3.00 有限数
validateTopicType(v) -> 'source' | 'extract'
validateUuid(v) / validateOptionalUuid(v)    // 只校验，不生成

// 日期（入参/出参均为 'YYYY-MM-DD'，0001-01-01 .. 9999-12-31）
isValidDateString(s) -> boolean
assertDateString(s) -> s | 抛 E_DATE_FORMAT / E_DATE_INVALID
addCalendarDays(s, days) -> 'YYYY-MM-DD'     // days 必须为整数
calendarDayDifference(a, b) -> 整数（a - b）
compareDate(a, b) -> -1 | 0 | 1
maxDate(a, b) / minDate(a, b)
toDayNumber(s) / fromDayNumber(n)            // 整数日序，0 = 1970-01-01

// 首次排期
baseInitialIntervalDays(priority) -> B(P)（浮点，不取整）
initialIntervalDays({ type, priority }) -> I0 整数
initialAFactor(type) -> 1.5 | 1.8
initializeTopic({ type, priority?, mfId, mfParentId?, mfRootId? }, config?, today)
  -> { topic, diff: { created: true }, explain: { text, data }, algorithmVersion: 1, needsWrite: true }

// 后续间隔
roundHalfUp(x) -> 整数（x 必须 >= 0 有限数）
clamp(x, lo, hi)
computeNextIntervalDays({ mf_interval_days, a_factor }) -> 整数
explainNextInterval({ mf_interval_days, a_factor }) -> { intervalDays, nextIntervalDays, text, data }
```

`initializeTopic()` 产出的 `topic`：

```js
{
  type, priority, status: 'active',
  mf_id, mf_parent_id, mf_root_id,
  mf_ideal_due,            // today + I0
  mf_not_before: null,
  mf_interval_days: I0,
  mf_last_event_id: null,
  mf_revision: 0,          // 初始值；递增语义由 PR-02 决定
  mf_scheduler_version: 1,
  a_factor,                // 1.5 | 1.8
  review_count: 0,
}
```

不写入 `last_reviewed`：新建不是评阅（A4.2 / A8）。

## 5. 错误码

| code | 触发 |
|---|---|
| `E_OBJECT_REQUIRED` | 入参不是普通对象 |
| `E_PRIORITY_TYPE` / `E_PRIORITY_RANGE` | Priority 非整数 / 越界（含 `"50"`、`null`、`1.5`） |
| `E_INTERVAL_TYPE` / `E_INTERVAL_RANGE` | Interval 非整数 / 不在 1..3650 |
| `E_AFACTOR_TYPE` / `E_AFACTOR_RANGE` | A-Factor 非有限数 / 不在 1.10..3.00（旧 1.05、5.0 一律报错） |
| `E_TOPIC_TYPE` | 非 source/extract（`card` 归 SR） |
| `E_ID_REQUIRED` / `E_ID_FORMAT` | 缺少稳定 ID / 非 UUID |
| `E_ALREADY_INITIALIZED` | 已存在调度状态，拒绝重新初始化 |
| `E_DATE_FORMAT` / `E_DATE_INVALID` / `E_DATE_OUT_OF_RANGE` | 日期格式 / 非真实日期 / 超出 0001..9999 |
| `E_DAY_ADD_TYPE` | 加天参数非整数 |
| `E_ROUND_TYPE` / `E_NEGATIVE_INPUT` | `roundHalfUp` 入参非法 |
| `E_CONFIG_SPEC_VIOLATION` / `E_CONFIG_UNKNOWN_KEY` | 试图改动规范参数 / 传入未知参数 |

## 6. 关键实现决策

1. **Q1**：`priority === undefined` 时才使用默认 50；显式 `null`、字符串、越界一律报错。
2. **Q2**：A-Factor 严格 1.10–3.00；1.05 与 5.0（旧 clamp 边界）报 `E_AFACTOR_RANGE`，不截断、不替换默认值、不写回。
3. **Q3**：严格四位 ISO 日期，0001-01-01 ~ 9999-12-31；越界返回 `E_DATE_OUT_OF_RANGE`；全程整数日序运算，从不使用毫秒换算。
4. **ID 由调用方提供**：核心不生成 UUID（`E_ID_REQUIRED`）。
5. **参数不可调**：`assertConfig()` 要求传入配置与规范逐值相等，未知键拒绝，始终使用冻结的规范配置（A15）。
6. **十进制守卫**：`roundHalfUp` 先归一到 9 位小数再 `floor(x+0.5)`，消除 IEEE-754 表示误差造成的半值错判（例如 `25 × 2.3 = 57.49999999999999` 必须得 58）。该决策只修正浮点表示，不改变规范的数学语义。
7. **不重算保护**：只要入参带有 `mf_interval_days` / `interval` / `a_factor` / `review_count > 0` / `last_reviewed` / `next_review` / `mf_ideal_due`，`initializeTopic()` 抛 `E_ALREADY_INITIALIZED`。
8. **不触碰父节点**：创建子节点不修改父对象，也不用创建充当父评阅（A3.4）。

## 7. 规范条款对照

| 规范 | 实现位置 | 测试 |
|---|---|---|
| A1.4 不变量 | `schema.js` | `mf-us-1-schema` |
| A2.2 版本 / 错误契约 | `constants.js`, `errors.js` | `mf-us-1-schema` |
| A2.3 日期 | `dates.js` | `mf-us-1-dates` |
| A3.1 参数表 | `constants.js` | `mf-us-1-schema`, `mf-us-1-initial` |
| A3.2 B(P) | `initial.js` | `mf-us-1-initial` |
| A3.3 取整与 I0 | `interval.js`, `initial.js` | `mf-us-1-initial`, `mf-us-1-interval` |
| A3.3 新建字段 | `initial.js` | `mf-us-1-initial` |
| A4.1 后续间隔 + T11 | `interval.js`, `initial.js` | `mf-us-1-interval`, `mf-us-1-initial` |
| A8 新建 → active | `initial.js` | `mf-us-1-initial` |
| A9 纯接口边界 | 全部模块 | 纯净性测试（无 `require` 外部模块、无时钟/随机/IO） |
| A12 解释 | `initial.js`, `interval.js` | `mf-us-1-initial`, `mf-us-1-interval` |
| A15 参数不可调 | `schema.js` | `mf-us-1-schema` |

## 8. 测试证据

```
# 新增测试
node --test test/mf-us-1-*.test.js
  tests 60  pass 60  fail 0

# 完整回归（本 worktree，含 PR-01 新增）
node --test test/*.test.js
  tests 417 pass 417 fail 0

# 基线对照（排除 PR-01 新增文件）
node --test $(ls test/*.test.js | grep -v 'mf-us-1-')
  tests 357 pass 357 fail 0     # main @ cff090d 的既有基线

# 仓库校验脚本
node scripts/validate-release.mjs   -> Release metadata and assets are valid.
node scripts/build.mjs --dry-run    -> [dry-run] no files were written.
```

未执行：`npm ci` / `npm test`（本机无 npm，仅 DSH 内置 `node v24.21.0`；CI 仍使用 `npm ci && npm run check`）。Obsidian 实机验收：**未验证**（本阶段只允许离线测试）。

## 9. 风险与待裁决

- `mf_revision: 0` 是当前初始值；递增与并发语义待 Q9 裁决（PR-02）。
- `initializeTopic()` 要求 `mfId`；若 PR-06 需要为无 ID 的旧数据构造确定性临时 ID，需再裁决其形式（Q8），当前不实现。
- 旧库 `interval` 已被 POSTPONE/MANUAL/MERCY 覆盖，迁移不得反推真实间隔（PR-08 处理）。
- 新裁决项：**A-Factor 是否随评阅动态调整**——规范未给出更新公式，本 PR 不实现、不沿用 Toolkit 的 progress-aware/quality 规则，留待规范裁决。

## 10. 回滚

纯新增文件，无既有文件改动。回滚方式：删除 `src/scheduling/`、`test/mf-us-1-*.test.js` 与两份新文档，或直接丢弃分支 `feat/phase2-mf-us-1-core`。无数据写入、无迁移、无真实 Vault 影响。
