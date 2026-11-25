# P2-US1-CORE-02 — MF-US-1 Event State Machine & Idempotency Core

- 任务 ID：`P2-US1-CORE-02`
- 状态：本地实现 + 自测完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ 243b14cbc970ba42a54ad1c9f21eb744b2f022ba`（PR #15 合并后）
- 分支：`feat/phase2-mf-us-1-events`
- 本地 commit：见本次验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft + Q5/Q6/Q7/Q9/Q13/Q14/Q15 裁决

## 1. 范围

纯事件状态转换与幂等协调，可在 Node.js 下独立运行，不接触 Obsidian：

- 十个事件：ADVANCED / HOLD / SOON / SKIP / POSTPONE / MANUAL_SCHEDULE / SET_PRIORITY / COMPLETE / DISMISS / REACTIVATE；
- `effective_due` 与三类到期统计（理想逾期 / 目前可处理 / 因延期暂不可处理）；
- 合法状态转换、事件对象校验、`expectedRevision` 校验、`mf_revision` 与 `mf_last_event_id` 更新；
- 调度差异（diff）与 A12 解释；
- 内存事件账本（同 `eventId` 幂等、同 ID 异内容冲突、E1→E2→E1 重试）。

## 2. 非范围

持久化账本（Q14 未授权）、Frontmatter 写入、`data.json`、Vault 审计文件、Obsidian 入口、队列/预算/Mercy、Legacy/Shadow/Unified 模式、迁移、UI、真实数据访问。

## 3. 文件清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `src/scheduling/events.js` | 十事件状态机、校验、diff、解释 | 新增 |
| `src/scheduling/due.js` | Effective Due、三类到期统计 | 新增 |
| `src/scheduling/event-ledger.js` | 内存账本、幂等协调、内容指纹 | 新增 |
| `src/scheduling/schema.js` | 新增 `validateStatus/validateRevision/validateCount/validateTopic` | 修改 |
| `src/scheduling/index.js` | 导出新模块 | 修改 |
| `test/mf-us-1-events.test.js` | 40 项事件、时间契约与 payload 测试 | 新增 |
| `test/mf-us-1-due.test.js` | 10 项到期语义测试 | 新增 |
| `test/mf-us-1-idempotency.test.js` | 19 项幂等/身份/指纹/重放测试 | 新增 |
| `docs/MF-US-1-DELIVERY-MATRIX.md` | 状态更新 | 修改 |
| `docs/P2-US1-CORE-02.md` | 本说明 | 新增 |

未修改：根 `main.js`、`src/main.js`、`date-core.js`、`status-core.js`、`tree-core.js`、`src/data/*`、SR、`.github/workflows/*`、`package.json`、`dist/*`、PR-01 已验收的数学/日期公式。

> 说明：`src/scheduling/events.js` 中状态机的 **SKIP 分支** 与 PR-01 的 `initializeTopic` 契约互相独立，未改动已验收公式。

## 4. API 契约

```js
// 事件状态机（SPEC A9）
applyEvent(topic, event, config?, today)
  -> {
       topic,                 // 新对象；入参不被修改
       applied,               // 是否真的改变了权威状态
       needsWrite,            // === applied
       reviewApplied,         // 是否计为有效评阅
       duplicate: false,
       reason,                // null | 'SESSION_ONLY' | 'NO_LATER_THAN_IDEAL' | ...
       diff: { fields: { [field]: { from, to } } },
       explain: { text, data },
       algorithmVersion: 1,
       event: { eventId, topicId, type, expectedRevision },
     }

validateEvent(event, topic, today) -> event   // 单独可测

// 到期语义（SPEC A2.4）
effectiveDue(topic) -> 'YYYY-MM-DD'
dueState(topic, today) -> {
  idealDue, notBefore, effectiveDue, overdueDays,
  idealOverdue, available, postponedOnly, notYetDue,
}
summarizeDue(topics, today) -> { total, idealOverdue, available, postponedOnly, notYetDue, maxOverdueDays }

// 幂等协调（内存，无持久化）
createEventLedger() -> { version: 1, entries: {} }       // 冻结
applyEventWithLedger(ledger, topic, event, config?, today)
  -> { ledger, topic, duplicate, result }
lookupEvent(ledger, eventId) -> entry | null
eventFingerprint(event) -> string                        // 确定性内容指纹
```

事件对象：`{ eventId, topicId, type, expectedRevision, algorithmVersion, payload?, calendarDate? }`。

## 5. 事件语义

| 事件 | 允许源状态 | 字段变化 | 评阅 | revision |
|---|---|---|---|---|
| ADVANCED | active | I→clamp(roundHalfUp(I×A),1,3650)、ideal=today+I′、not_before=null、count+1、last_reviewed=today | 是 | +1 |
| HOLD | active | ideal=today+I、not_before=null、count+1、last_reviewed=today | 是 | +1 |
| SOON | active | I→min(I,2)、ideal=today+I′、not_before=null、count+1、last_reviewed=today | 是 | +1 |
| SKIP | active | 无 | 否 | 不变 |
| POSTPONE | active | 仅 `mf_not_before`；无可见变化时 no-op | 否 | 有变化才 +1 |
| MANUAL_SCHEDULE | active | `mf_ideal_due`=目标、`mf_not_before`=null；需 reason | 否 | +1 |
| SET_PRIORITY | active | 仅 `priority` | 否 | 有变化才 +1 |
| COMPLETE | active | 仅 `status='done'` | 否 | +1 |
| DISMISS | active | 仅 `status='dismissed'` | 否 | +1 |
| REACTIVATE | done/dismissed | `status='active'`、`mf_ideal_due`=显式日期、`mf_not_before`=null | 否 | +1 |

不变量（实现内断言，违反即 `E_INTERNAL_INVARIANT`）：任何事件都不改 `a_factor`、`type`、`mf_id`、`mf_parent_id`、`mf_root_id`；只有三者改 `status`；只有 ADVANCED/HOLD/SOON 改 `review_count` 与 `last_reviewed`；`applied` 时 revision 恰好 +1 且写入 `mf_last_event_id`；no-op 时二者不变。

## 6. 规范条款对照

| 规范 | 实现 |
|---|---|
| A2.4 Effective Due | `due.js` |
| A4.1 后续间隔、不重算 | `events.js` → `computeNextIntervalDays`（PR-01） |
| A4.2 三类有效评阅 | `transitionAdvanced/Hold/Soon` |
| A4.3 COMPLETE/DISMISS/REACTIVATE | `transitionComplete/Dismiss/Reactivate` |
| A5.1 SKIP | `transitionSkip`（零写入） |
| A5.2 POSTPONE | `transitionPostpone`（`max(not_before?, ideal, today+N)`） |
| A5.3 MANUAL_SCHEDULE | `transitionManualSchedule`（+ reason） |
| A5.4 SET_PRIORITY | `transitionSetPriority` |
| A8 状态机/事件对象/幂等 | `ALLOWED_SOURCE_STATUS`, `validateEvent`, `event-ledger.js` |
| A9 纯接口 | `applyEvent`，无 I/O/时钟/存储 |
| A12 解释 | 每个事件返回中文解释，区分算法日期与行政日期 |
| A13 T05–T13 | 见交付矩阵 §2 |
| A13.1 性质 4/5/6/9 | 见交付矩阵 §3 |

## 7. 实现决策（需你确认的、规范未逐字规定的点）

1. **POSTPONE 的“未进一步推迟”按 no-op 处理**：当 `max(ideal, today+N)` 不晚于现有 `not_before` / 或不晚于 `mf_ideal_due` 时，返回 `applied:false` + `reason`（`NO_LATER_THAN_EXISTING` / `NO_LATER_THAN_IDEAL`），**不写字段、不增 revision**。理由：有效到期日没有变化，写入只会制造无意义字段变更；规范要求“提示未进一步推迟”，未要求写入。
2. **SKIP 不做 revision 校验**：SKIP 零写入（A5.1 + Q6），过期 revision 不影响结果；若强制校验，会把合法跳过误报为冲突。
3. **legacy 状态（inbox/pending/container）报 `E_STATUS_UNSUPPORTED`**，与“事件不允许从该状态发生”（`E_INVALID_TRANSITION`）区分。含义需 PR-06 适配器确认（A8）。
4. **MANUAL_SCHEDULE 强制 `reason`**（1–500 字符）：用户指令要求“必须记录人工覆盖原因与结果”，比规范更严格，不改变规范字段语义。
5. **`mf_revision` 只在实际改变权威状态时 +1**；no-op、SKIP 均不增（Q9 + 本次指令）。
6. **A-Factor 恒定**（Q13）：事件不写 `a_factor`，也不复用 Toolkit 的 progress-aware/quality 公式。
7. **COMPLETE/DISMISS 保留 `mf_not_before`**（Q7）：规范只要求保留间隔与日期历史；保留行政限制有利于撤销后恢复，且不产生评阅。
8. **`last_reviewed` 采用 ISO 日期**：与 `mf_*` 一致；旧库的 Vault 日期格式由 PR-06 适配器归一化后再进入核心。
9. **事件时间契约（A8，审查修复 1）**：事件必须携带 `calendarDate` 或 `createdAt`，否则 `E_EVENT_TIME_REQUIRED`。
   - `calendarDate`：严格 ISO 本地日期，必须等于显式 `today`；
   - `createdAt`：必须带显式偏移（`+HH:MM` 或 `Z`），格式与时钟字段严格校验；带数字偏移时其字面日期即本地日期，必须等于 `today`；
   - `Z`（UTC）时间戳**不能**单独确定本地日期：必须另附 `calendarDate`（两者一致），否则 `E_EVENT_TIME_INVALID`；核心从不做时区换算；
   - 事件是**当日事件**：跨日未应用的事件必须以新 `eventId` 重建；已应用事件的跨日重试仍由账本按重复处理（不重新校验日期）。
10. **Payload 白名单（审查修复 3）**：每类事件只允许固定键（`POSTPONE.days`、`MANUAL_SCHEDULE.idealDue/reason`、`SET_PRIORITY.priority`、`REACTIVATE.idealDue`，其余为空）。未知键、`NaN`/`Infinity`/`undefined` 一律 `E_EVENT_PAYLOAD_INVALID`，不依赖 JSON 隐式转换。
11. **重复事件必须校验 Topic 身份（审查修复 2）**：账本命中时同时要求 `topic.mf_id === 账本.topicId === event.topicId`，否则 `E_EVENT_TOPIC_CONFLICT`，绝不把 Topic A 的事件当作 Topic B 的重复。

## 8. 幂等模型与已明确的局限

- **判定顺序**：账本命中 → Topic 身份校验 → 内容指纹校验 → 返回存储结果；未命中 → revision 校验 → 状态机。这保证“已成功处理的重试”不会被误报为 revision 冲突，也不会跨 Topic 复用结果。
- **同 ID 异内容**：`eventFingerprint`（type / topicId / expectedRevision / algorithmVersion / calendarDate / payload 的规范化 JSON）不同 → `E_EVENT_ID_CONFLICT`，绝不复用旧结果。
- **no-op 也记账**（status `noop`），使重放保持原结果；**失败不记账**，修正后可重试。
- **账本丢失**：旧事件重试的 `expectedRevision` 必然过期 → `E_REVISION_CONFLICT`，不会静默重复计入评阅。
- **未覆盖**：持久化、跨重启、跨设备、真实崩溃窗口。**当前不得宣称已实现持久幂等**（Q14）。

## 9. 持久化方案对比（Q14 前置研究，未实施）

| 场景 | 纯内存模型下的行为 | 持久化方案需解决的问题 |
|---|---|---|
| `data.json` 丢失 / 重装 | 账本为空；旧事件重试 → revision 冲突（安全，不重复计数） | 若调用方用“最新 revision”重建事件，可能二次应用；需备份策略或指纹残留字段 |
| 多设备同步 | 每设备独立账本；Topic frontmatter 同步 | 两台设备离线各自应用同一事件：revision 相同、都成功，合并时冲突；需同步合并策略 |
| 同一 Topic 并发事件 | `expectedRevision` 乐观检查，第二个冲突 | 需写入串行化或 CAS（Obsidian `processFrontMatter` 无 CAS） |
| 崩溃后 pending 恢复 | 无 pending 概念（纯函数一次性返回） | 需 WAL：记录 intent → 写 Topic → 标记 applied；启动时对账 |
| Topic 已写入、账本未确认 | 账本缺失 → 重试冲突（安全） | 需“Topic 先写、账本后写”顺序 + 启动对账，避免重复应用 |
| 账本已记录、Topic 未写入 | 纯模型中不会发生（先算后记） | 若持久化先写账本，会造成“已处理但未生效”的静默丢失；必须禁止该顺序 |
| 旧事件重试 / ID 冲突 | 指纹冲突报 `E_EVENT_ID_CONFLICT` | 需确定指纹算法版本并纳入迁移 |

建议（待裁决，不在本 PR 实施）：Topic 先写、账本后写；账本条目带 `revisionAfterProcessing`；启动时若 `ledger.revisionAfter > topic.mf_revision` 标为可疑并禁止自动重放；`data.json` 纳入备份。

## 10. 测试证据

```
node --test test/mf-us-1-*.test.js     tests 135  pass 135  fail 0   （PR-01 66 + PR-02 69）
node --test test/*.test.js             tests 515  pass 515  fail 0
node --test $(排除 mf-us-1-)            tests 380  pass 380  fail 0   （243b14c 基线未变）
node scripts/validate-release.mjs      valid
node scripts/build.mjs --dry-run       no files written
```

未执行：`npm ci` / `npm test`（本机无 npm；CI 仍为 `npm ci && npm run check`）。Obsidian 实机：**未验证**（本阶段只允许离线）。

## 11. 仍未完成

持久账本与恢复（Q14/PR-09）、队列与预算（PR-03）、Mercy（PR-04）、模拟与性能（PR-05）、只读适配（PR-06）、Shadow（PR-07）、迁移（PR-08）、Unified 写入与入口接管（PR-09）、UI（PR-10）、SR 边界审计（PR-11）、实机验收（PR-12）。

## 12. 风险

- `E_STATUS_UNSUPPORTED` 会让 legacy 状态在 Unified 启用前不可调度——这是 A8 的要求，需 PR-06 适配器补齐映射。
- 账本仅内存，不能作为“幂等已交付”的依据；集成阶段必须重做并验收。
- POSTPONE 的 no-op 语义（§7.1）若与你的预期不同，需在 PR-03 前裁决，因为它影响行政延期记录。
- COMPLETE 后 `mf_not_before` 保留（§7.7）与 REACTIVATE 清空（Q5）组合正确性已测试，但产品语义值得确认。
