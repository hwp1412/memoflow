# P2-US1-WRITE-01 — Persistent Event Ledger, Concurrency Control & Single Authoritative Writer

- 任务 ID：`P2-US1-WRITE-01`
- 状态：合成存储实现 + 故障注入测试完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ 526aa6a`（PR #22 合并后）
- 分支：`feat/phase2-mf-us-1-unified-writer`
- 本地 commit：见验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A8、A10.1、A10.3、A11、A13）

## 1. 范围与非范围

**范围**：可序列化持久事件账本、单 Topic 可信写入、revision/内容 hash/稳定身份校验、崩溃恢复、模式隔离、Mercy 持久批次（合成存储）、审计隐私。

**非范围**：真实 Obsidian 读写、真实插件入口接线、用户确认后的 Unified 启用、旧 Toolkit 退场（PR-10）；SR 边界（PR-11）；实机验收（PR-12）。本轮全部使用 `SyntheticUnifiedStorage` / `MemoryLedgerStore`。

## 2. 旧写入入口与 Unified 对应关系（只读审计）

| 旧入口（只读审计） | 位置 | Unified 对应 | 处理 |
|---|---|---|---|
| `_gradeTopic()` 评阅 | `main.js:3737` | `executeUnifiedEvent` + `ADVANCED/HOLD/SOON` | PR-10 切换；本 PR 不调用旧方法 |
| `postpone()` | `main.js:4289` | `POSTPONE` | 保持行政语义 |
| `postponeSubtree()` | `main.js:4496` | 批量 `POSTPONE`（逐 Topic） | PR-10 接入 |
| `spreadOverdue()` / Mercy 应用 | `src/main.js:1042`、`main.js:4490` | `unified-mercy-writer` | 合成批次已验证 |
| `markDone()` | `main.js:4263` | `COMPLETE` | 保留历史 |
| Dismiss | `main.js:4283` | `DISMISS` | 保留历史 |
| Source/Extract 创建 | `main.js:~5000`、`src/main.js:1316` | 非调度事件 | 仍由创建路径负责，不经过 writer |
| SR Card 评分 | SR 桥接 | **不接管** | 继续由 SR 管理 |

## 3. 持久事件账本

记录（纯 JSON，无正文/绝对路径）：

```js
{ eventId, topicId, fingerprint, type, algorithmVersion, expectedRevision, today, eventDate,
  status, beforeHash, expectedAfterHash, afterHash, actualRevision, fields,
  audit: { before, after, result, reason, writesPerformed, requiresManualRecovery }, ... }
```

- `fingerprint = sha256(canonical request)`：同 eventId 不同 payload/type/topicId → `E_EVENT_ID_CONFLICT`。
- 状态：`prepared / applied / failed / uncertain / conflict / requires-manual-recovery`。
- 跨重启：账本存储在注入式 `MemoryLedgerStore`，`dump()` 后可由新的 `PersistentEventLedger` 加载；测试用新实例验证 E1→E2→E1 不重复计数。
- 不依赖 `mf_last_event_id` 判断全部历史。

## 4. 存储契约与 CAS 限制

- `SyntheticUnifiedStorage`：按 `mf_id` 索引、`read`、`compareAndSwap(expectedHash, expectedRevision)`。
- 该 CAS 只在**同一进程的合成后端**内原子；**不代表** Obsidian Frontmatter API 提供跨进程 CAS。真实适配器必须由 PR-10 单独评审。
- 存储通过模块私有 `WeakSet` 注册，普通对象无法伪造；账本、批次库同理。
- 写入模式必须同时满足：`mode.mode === 'unified'` + 不可伪造的合成能力对象；PR-07 的 `canCommitUnified` 仍为 false，`assertUnifiedWriteAuthorized()` 仍恒抛。

## 5. 单 Topic 写入流程

1. 校验请求（UUID、type、expectedRevision、today、algorithmVersion）。
2. 模式与能力门禁；拒绝附加 `legacyWriter`（`E_DOUBLE_WRITE_FORBIDDEN`）。
3. 按 `mf_id` 定位文件；重复 ID / 缺失 → conflict。
4. 校验持久 revision、`mf_scheduler_version`、类型、状态（REACTIVATE 允许 done/dismissed）。
5. 账本分类：duplicate / conflict / pending 恢复 / 新事件。
6. `applyEvent()` 计算候选状态（不重写公式）。
7. 生成投影字段（`mf_revision`、`mf_last_event_id`、`mf_scheduler_version`、`mf_interval_days`、`mf_ideal_due`、`mf_not_before`、priority、a_factor、review_count、last_reviewed、status、`next_review = formatLegacyDate(effective_due)`）。
8. 账本 `prepare` 固定 `beforeHash` / `expectedAfterHash` / fields。
9. CAS 提交（expectedHash + expectedRevision）。
10. 回读校验 hash 与 revision；失败 → `uncertain`。
11. 账本 `markApplied`，记录审计。

`SKIP` 等 no-op：账本标记 applied 但 `writesPerformed=false`，Topic 零写入；重复提交返回 duplicate。

## 6. 崩溃窗口与恢复

| 窗口 | 行为 |
|---|---|
| 准备前失败 | 无记录，无写入 |
| prepared、未写入 | 重试时按 beforeHash 安全重算并写入 |
| 写入成功、回读失败 | `uncertain`，不报成功 |
| 写入成功、账本未 applied | 用持久 intent 的 expectedAfterHash 识别 → 恢复为 applied（不重写） |
| 恢复时文件被用户编辑 | `requires-manual-recovery`，不覆盖 |
| 账本损坏 | `E_LEDGER_CORRUPT` → 人工恢复 |
| 账本丢失 | 旧 revision 与当前不符 → conflict，不重放 |

`reconcileUnifiedEvent` 用 beforeHash/expectedAfterHash 重新核实真实状态。

## 7. Mercy 持久批次

- `prepareUnifiedMercyBatch(plan)`：从 PR-04 预览生成固定批次（topicId、before/after notBefore、before/after revision）。
- `applyUnifiedMercyBatch`：逐 Topic CAS；已有 notBefore 且 revision 匹配 → `already-applied`；revision 不符 → conflict；部分失败保留。
- `undoUnifiedMercyBatch`：只回滚仍为 after 状态的 Topic；重复撤销幂等；用户编辑 → conflict。
- 批次存储在注入式 `MemoryBatchStore`，可 dump/reload。

## 8. 审计隐私

审计字段只含事件/批次、Topic ID、版本、类型、日期、revision、Priority/Interval/A-Factor/Due、结果与原因；**不含**正文、PDF、绝对路径。测试断言序列化记录不含 body 与 `Sources/`。

## 9. 测试与性能

```
node --test test/mf-us-1-unified*.test.js test/mf-us-1-persistent-ledger.test.js
  tests 58  pass 58  fail 0
```

- 合成性能：1,000 Topic / 1,000 Event ≈ 48ms；10,000 Topic / 1,000 Event ≈ 39ms（Apple M4 / Node v24.21.0）。仅持久写入观测，不是 A14 队列基准。

## 10. 交付矩阵

- `WRITE-01`：`NOT_STARTED` → `TESTED`（合成；真实存储未集成）
- `EVT-08`：跨重启合成账本幂等已实现；真实磁盘耐久性待 PR-10/12
- `MERCY-03`：持久合成批次 apply/undo
- `MODE-01`：单写入者门禁（合成能力）
- `TEST-01`：T13/T16/T19 纯/持久模拟证据
- `ACC-01`：仍未执行

## 11. PR-10 需要接入的真实入口

`_gradeTopic`、`postpone`、`postponeSubtree`、`spreadOverdue`、`markDone`/Dismiss/Reactivate、创建路径的初始化，以及模式切换与旧入口退场；真实存储 Adapter 必须实现并审计 CAS/备份/回滚语义。

## 12. 安全边界

全部使用合成存储；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未修改 Frontmatter/data.json；未启用 Unified；未执行真实迁移；未改 PR-01～08 已验收算法；未创建 PR/合并。
