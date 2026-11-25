# P2-US1-SHADOW-01 — Scheduler Mode Isolation & Read-only Shadow Comparison

- 任务 ID：`P2-US1-SHADOW-01`
- 状态：本地实现 + 自测完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ 776fdf0`（PR #20 合并后）
- 分支：`feat/phase2-mf-us-1-shadow`
- 本地 commit：见验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A9、A10.1、A11、A12、A13 T19）

## 1. 范围与非范围

**范围**：纯模式策略（legacy / shadow / unified 的能力与拒绝路径）、只读 Shadow 对照、只读事件预览。

**非范围**：真实 Obsidian 写入、旧 Toolkit 入口接管、持久事件账本、Mercy 应用/撤销、迁移、UUID 落盘、UI、SR。Shadow 只返回数据，不写任何字段。

## 2. 模式契约

| 模式 | 实际调度权威 | canComputeShadow | canCommitUnified | writesPerformed | 说明 |
|---|---|---|---|---|---|
| `legacy`（默认） | legacy | false | false | false | 不转换旧字段、不补 UUID/revision/version |
| `shadow` | legacy | true | false | false | 只读对照与诊断 |
| `unified` | legacy（本 PR 未启用） | false | false | false | `requiresMigration` + `requiresUserAuthorization`，诊断 `E_UNIFIED_NOT_AUTHORIZED` |

- 缺失配置 → `legacy`；显式非法模式（`nope`、`''`、非字符串、非对象配置）→ `E_MODE_INVALID`，绝不自动切换模式。
- `assertUnifiedWriteAuthorized()` 在 PR-07 恒定抛 `E_UNIFIED_NOT_AUTHORIZED`，不存在隐藏参数或测试开关可绕过。
- 能力布尔值只描述契约意图，不等于物理写入已被阻止；本 PR 不含任何真实写入调用路径。

## 3. 接口

```js
resolveSchedulerMode(config)            // { mode, authoritativeScheduler, canComputeShadow, canCommitUnified, writesPerformed, requiresMigration, requiresUserAuthorization, configured, diagnostics }
compareShadowBatch(snapshots, options)  // options: { mode, context: {dateFormat}, today, observations }
previewShadowEvent(snapshot, event, options) // 返回 proposedState，绝不写回
```

所有输入由调用方提供，包括 `today`、日期格式、旧元数据快照、已观察的 Legacy 结果。缺失 `today` → `E_SHADOW_TODAY_REQUIRED`；缺失事件 → `E_SHADOW_EVENT_REQUIRED`；非 shadow 模式 → `E_MODE_NOT_SHADOW`。

## 4. Legacy 观察值来源与可信度

| `observation.source` | trust | 可比较 | 说明 |
|---|---|---|---|
| `legacy-executed` | executed | 是 | 调用方确认真实旧算法执行结果 |
| `legacy-export` / `legacy-observed` | observed | 是 | 只读导出/观察 |
| `legacy-proxy` / `proxy` | proxy | **否** | 明确标记 proxy，`LEGACY_PROXY_NOT_AUTHORITATIVE` |
| 缺失/其他 | untrusted/missing | 否 | `LEGACY_OBSERVATION_UNTRUSTED` / `LEGACY_OBSERVATION_MISSING` |

不会编造 Legacy Interval/Due/A-Factor；`administrative: true` 的观察值（旧 POSTPONE/Mercy 影响）标记 `LEGACY_ADMINISTRATIVE_CONTAMINATION` 并拒绝直接比较。

## 5. 差异比较

每条结果包含：id 与身份类型、adapter 状态、模式/算法版本、比较日期、Legacy 来源与可信度、候选 Priority/Interval/A-Factor/Ideal Due/Effective Due/status/schedulable、Legacy 各值、差值、`differences[]`、`nextReviewComparison`、`causes[]`、`reasons[]`、`caveats[]`、`explanation`、`writesPerformed: false`。

比较字段与原因：

| 字段 | cause | 说明 |
|---|---|---|
| priority | `DATA_SEMANTICS` | 原始数据差异 |
| interval | `ALGORITHM_OR_LEGACY_HISTORY` | 无法区分算法差异与旧 POSTPONE/Mercy 污染 |
| aFactor | `ALGORITHM` | 学习参数差异 |
| idealDue | `SCHEDULE_OR_ADMIN` | 排期或行政调整 |
| effectiveDue | `ADMIN_OR_SCHEDULE` | Effective Due 差异 |

- `legacy.next_review` **不**等同于 Ideal Due：只进入 `nextReviewComparison`，`equivalent: false`，原因 `LEGACY_NEXT_REVIEW_MAY_INCLUDE_ADMINISTRATIVE_CHANGE`，不参与 match/mismatch 判定。
- 所有日期/天数差使用既有纯日期模块；不修改任何历史 interval。
- 分类：`match` / `mismatch` / `not-comparable`（含 unavailable 原因）。

## 6. 事件预览边界

- 事件必须显式提供；候选新状态只在 `proposedState` 返回，原始快照逐字节不变。
- `committedLegacyState` 仅在调用方提供真实已执行快照时原样返回，并记录 `committedSource`；不会用 proxy 冒充。
- ADVANCED/HOLD/SOON 增加“建议的”review_count；SKIP/POSTPONE 的 `reviewApplied = false`，不描述为有效评阅。
- 临时身份拒绝提案（`read-only-limited`），不生成 UUID；卡片 `unsupported`；事件非法 → `status: 'error'` + 诊断，不抛出到旧调度。
- 同一事件重复预览结果一致，不产生重复真实事件。

## 7. 故障隔离

- 单条损坏、重复 ID、日期格式未知、新旧冲突、关系未验证、适配失败均逐条返回诊断，其他记录继续比较。
- Shadow 抛错不会改变模式（仍为调用方设定的 legacy/shadow），也不会改动快照。
- 不使用 catch 后自动写入的降级方案；不会因失败切到 Unified。
- 真实运行时故障隔离仍需 PR-09/10 集成验收，纯单元测试不宣称完成。

## 8. T19 证据（纯算法层）

- Shadow 下候选不写回 Topic；原始快照完全冻结仍可预览；
- 多次预览不增加 revision/review_count；Interval/A-Factor/Priority/Ideal Due/Not Before 不变；
- 不创建正式 UUID；不执行 Mercy 或迁移；Card 不进入影子 Topic。

## 9. 性能（初步观测，非 A14）

10,000 个合成 Source、10,000 条观察值：`compareShadowBatch` 约 **49ms**（本机）。该数字仅用于观察 Shadow 对照开销，不与 A14 的 10k 纯队列 500ms 目标混淆，也不构成发布性能承诺。

## 10. 交付矩阵更新

- `MODE-01`：`NOT_STARTED` → **`TESTED`**（纯模式隔离；真实入口未接线，不标 INTEGRATED/ACCEPTED）。
- `TEST-01`：T19 纯层已覆盖（备注更新）。
- `API-01`：补充 mode/shadow 只读接口；`explainSchedule` 仍未实现，不虚报。
- `WRITE-01`：保持 `NOT_STARTED`。

## 11. 未完成 / 后续

- 真实 Legacy/Shadow 运行时入口、Unified 单一写入、持久事件账本、迁移与恢复：PR-09/10。
- 真实 Obsidian 实机验收、SR 边界：PR-11/12。
- 待裁决：Shadow 观察值的真实采集方式（由集成层提供，不在纯核心内实现）。

## 12. 安全边界

全部使用内存合成快照；未访问 Vault/`MemoFlow-Test`/`phase2 test`/Obsidian/SR；未修改 Frontmatter/`data.json`；未生成 UUID；未迁移；未启用 Unified；未改 PR-01～06 已验收算法；未创建 PR/合并。
