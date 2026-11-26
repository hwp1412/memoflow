# P2-US1-HOST-ACTIONS-01 — 三操作宿主接线（交付）

- 基线：`personal/main @ 12c2bcd`（PR #35 合并后）
- 分支：`feat/phase2-mf-us-1-host-actions`
- 方案提交：`b53d414`；实现提交见本条之后的 Commit
- 范围：POSTPONE / MANUAL_SCHEDULE / SET_PRIORITY 的真实宿主入口接线；未改算法、Runtime、Ledger、协调器

## 1. 接线后的入口矩阵

| 用户面 | 动作 | 现状 |
|---|---|---|
| 命令 / 中文菜单「Postpone」 | POSTPONE | `postpone()` → `postponeFile()` → facade |
| 阅读条「延后」→ 1/3/7 天 | POSTPONE | `_postponeReadingFile()` → `postponeFile()` → facade |
| popover / PDF 更多「延后 N 天」 | POSTPONE | 同上 |
| 命令 / 菜单「Schedule」 | MANUAL_SCHEDULE | `schedule()` → `scheduleFile()` → facade |
| popover 新增「手动排期…」 | MANUAL_SCHEDULE | `_runReadingAction('schedule')` → `_promptManualSchedule()` → `scheduleFile()` |
| 命令 / 菜单「Set priority」 | SET_PRIORITY | `setPriority()` → `setPriorityFile()` → facade |
| 阅读条 P 徽标 | SET_PRIORITY | `openPriorityDialog()` → `onApply` → `setPriorityFile()` |
| popover「设置优先级…」 | SET_PRIORITY | 同上 |
| Dashboard `queue-priority` | SET_PRIORITY | 同上 |
| 菜单「Boost priority」 | — | Unified 显式阻断（`E_BOOST_REQUIRES_BATCH_EVENTS`），Legacy 不变 |

## 2. 执行协议（三个动作一致）

```
用户操作 → 参数校验（1–100 / 1–3650 天 / 严格 YYYY-MM-DD）
        → _mfUs1EventDescriptor(type, file, fm, today, payload)
             （唯一 eventId；expectedRevision 来自持久 Frontmatter）
        → HostSchedulerService.execute
             legacy  → 该 UI 面原有的 Legacy writer（逐面保留）
             shadow  → Legacy 写入 + 只读对照
             unified → Async Runtime → applyEvent → Intent → CAS → 回读 → Ledger
        → describeOutcome() → UI 仅对 applied/duplicate 显示成功
```

- payload 由 `reading-integration.mapReadingAction` 生成，**不新增第二张映射表**。
- `postponeFile/scheduleFile/setPriorityFile` 是唯一的 descriptor 构造点；菜单只负责收集参数再转调。
- Legacy 逐面保留：`_postponeReadingFileLegacy`（阅读条原文案与字段）与菜单 `_postponeLegacyWrite` 分开，
  优先级对话框的 `boost_from` + 缓存刷新也在其 legacy 回调内，避免"共用事件名就假设可无差别替换"。

## 3. 语义对照

| 动作 | Legacy（不变） | Unified（生产仍锁定） |
|---|---|---|
| POSTPONE | `next_review` + `interval=N` | A5.2：`mf_not_before = max(旧值, mf_ideal_due, today+N)`；间隔/A-Factor/评阅次数/`mf_ideal_due`/`last_reviewed` 不变；无进一步延期返回 `no-op` |
| MANUAL_SCHEDULE | `next_review` + 重算 `interval` | A5.3：写 `mf_ideal_due`、清 `mf_not_before`、保留间隔与评阅次数、原因入 ledger audit |
| SET_PRIORITY | 写 `priority`（+`boost_from`） | A5.4：写 `priority`，其余不变；`mf_revision` 前进 |

## 4. UI 反馈

| 结果 | 提示 |
|---|---|
| applied | 具体结果（延期日/排期日/新优先级）+ 5s |
| duplicate | “此前已完成（重复提交）” |
| no-op | `NO_LATER_THAN_EXISTING` / `NO_LATER_THAN_IDEAL` 的明确说明 |
| conflict | “写入被拒绝（码）：可能已被外部修改” + 9s |
| uncertain | “结果尚未确认，请核对笔记后重试；不要重复点击” |
| failed | 失败原因码 |

Legacy 模式仍由原 writer 弹原有 Notice，适配层不追加第二条。

## 5. 测试

```
test/mf-us-1-host-actions.test.js     26 pass
test/mf-us-1-host-wiring.test.js       5 pass（静态接线断言已按新单一入口更新）
test/*.test.js                      1243 pass
node scripts/validate-release.mjs     valid
node scripts/build.mjs --dry-run      no files written
```

覆盖：阅读条延期（字段不变量）、重复延期不提前、菜单同入口、手动排期清 `mf_not_before`、
排期取消零写入、`+7d` 相对输入、Source/Extract 优先级、队列排序随优先级变化、
非法参数零写入、外部编辑冲突、Intent 失败零写入、结果确认失败为 uncertain 且无成功提示、
重启恢复不重复应用、Legacy 字段对照、Unified 不调用 Legacy Writer、Shadow 不写账本、
Card 拒绝、Boost 阻断零字节、静态接线断言。

## 6. 残余与未接线

- Dashboard / 每日队列的 Unified 数据源切换仍未完成（本轮只验证纯计算排序）。
- Boost 批量优先级、`postponeSubtree`、Mercy、`resetCurrent` 仍待后续阶段。
- 未在真实 Obsidian 验证（本任务禁止）；`metadataCache` 刷新时序仅由 mock 模拟。
- 手动排期为新增 popover 入口，未新增 Dashboard 按钮。

## 7. 安全边界

未启用 Unified 生产写入；未访问真实 Vault / `MemoFlow-Test` / `phase2 test`；未启动 Obsidian；
未迁移；未创建 PR/Merge；Phase 1 未触碰。

---

## 验收补充（PR #36 最终意见）

### 1. 阅读条延期失败后的 Session 行为

调用链（修复后）：

```
_runsReadingAction('postpone')
  → _postponeReadingFile → postponeFile → HostSchedulerService → …
  → outcome.status ∈ {applied, duplicate, legacy} ? consumeSessionItem + _openNextSessionTarget : 停留
```

- `conflict / uncertain / failed / no-op` **不**切换下一篇、**不**移除 Session Topic；
- 只有 `applied / duplicate` 与 Legacy 已写入（`legacy`）才推进会话；
- 失败时 UI 只显示对应错误文案，不出现“已延期”。

测试：`an applied postpone advances the session once`、`a failed postpone keeps the reader on the current topic`、
`a conflicting postpone does not advance or claim success`、`an uncertain postpone does not advance and says so`、
`a no-op postpone (already postponed further) does not advance`。

### 2. MANUAL_SCHEDULE 的 Ledger reason

链路：`scheduleFile(file, idealDue)` → `buildEventPayload('schedule', {idealDue, reason})`
→ `mapReadingAction('manual-schedule')` → payload `{ idealDue, reason }`
→ HostSchedulerService → Async Runtime → `ledger.prepare(request, intent)`
→ 记录字段 **`record.payload.reason`**（同时保留 `record.payload.idealDue`），审计快照在 `record.audit.after`。

落盘位置：`data.json → mfUs1Ledger.records[eventId].payload`。
断言（`manual schedule sets ideal due…`）：

```js
const record = Object.values(opened.store.dump()).find(item => item.type === 'MANUAL_SCHEDULE');
assert.equal(record.payload.reason, 'manual-schedule');
assert.equal(record.payload.idealDue, '2026-12-10');
assert.equal(record.audit.after.idealDue, '2026-12-10');
```

`PersistentEventLedger.prepare` 增加 `payload` 字段（旧记录无此字段仍可读；不含正文/路径，仅调度参数）。

### 3. uncertain 后的 UI 重试安全

1. uncertain → `topicLocks` 保留（unknown），下一次点击返回
   `requires-manual-recovery / E_TOPIC_INTENT_STATE_UNKNOWN`，**零写入**；
2. `recover()` 确认该事件已应用 → 解锁并写回 applied；
3. 用户再次点击：新的 descriptor（revision 已前进）→ POSTPONE 的目标不晚于现有
   `mf_not_before` → `no-op / NO_LATER_THAN_EXISTING`，日期与 revision 都不再变化。

测试：`after an uncertain write the next click is blocked, and recovery does not double apply`。

### 4. 回归

```
node --test test/*.test.js     1243 pass（基线 1217 + 26 host-action 测试）
validate-release               valid
build --dry-run                no files written
```

手动排期测试中恒真的三元表达式已改为固定目标日 `2026-12-10`。
