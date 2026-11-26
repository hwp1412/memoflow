# P2-US1-HOST-SUBTREE-01 — 子树延期宿主接线：只读审查与实施方案

- 基线：`personal/main @ 13ac9f9`（PR #36 已合并；`c7e4cd2` 为祖先）
- 拟用分支 / worktree（已创建，暂无业务代码）：`feat/phase2-mf-us-1-host-subtree` / `memoflow-phase2-subtree`
- 本轮：**只读审查 + 实施方案**，未改业务代码
- Phase 1 工作区未访问、未修改

---

## 1. 真实调用图（当前源码）

```
root main.js:3138 advancedTools「Postpone subtree」─┐
src/main.js:192  advancedTools（中文菜单）──────────┤
                                                    └→ postponeSubtree()
                                                        → _mfUs1RunLegacy(
                                                             {action:'POSTPONE_SUBTREE'},
                                                             () => _postponeSubtreeLegacy())
                                                           ├ Unified: facade 直接 E_UNIFIED_NOT_AUTHORIZED（零写入）
                                                           └ Legacy/Shadow: 逐节点 processFrontMatter(next_review = base+days)
```

`_postponeSubtreeLegacy()` 内部：

1. `resolveSourceFromActive()` —— **只接受 Source/PDF**，打开 Extract 时提示"不是 source"；
2. `pickFromList` 选择 +1/3/7/14/30 天；
3. `walkSubtree(..., {rows, strict:true})` —— 预检，关系异常时**在任何写入前抛错**；
4. 逐节点过滤 `card / done / container / dismissed`；
5. 以 `next_review`（若在未来则以其为基准）加天数，写 `next_review`；
6. 中途失败 → 提示已更新 N 个、**无原子回滚**。

### 绕过分析

| 项 | 结论 |
|---|---|
| UI 入口 | 只有两个菜单项，均调用 `postponeSubtree()`，**没有绕过** |
| Legacy Body | 直接写 N 个文件的 `next_review`，不经过分派器（这是 Legacy 权威路径，Unified 下被门禁挡住） |
| Unified 现状 | 整个功能不可用（fail-closed），**不存在双写**，但也没有按节点事件化 |
| 其他相关 | `boost()` 的 cascade 是优先级批量，与本任务无关；`mercy()` 是独立的批次协议 |

---

## 2. 六项契约分析

### 2.1 子树范围

- 复用 `walkSubtree(..., {strict:true})`：源/摘录为节点，**Card 是遍历叶子**（即使畸形子节点挂在 Card 下也不纳入写范围），循环/过深/歧义父链在**写入前**整体拒绝。
- 节点集合在计划阶段一次性确定并**排序（stableId 升序）**，执行阶段不再重新遍历，避免边跑边扩范围。
- 过滤规则与 Legacy 一致：跳过 `card`、`done`、`container`、`dismissed`；额外要求 Unified 节点必须**具备持久 `mf_id`**，缺失则记为 `blocked`（E_ID_NOT_PERSISTED），不做隐式迁移。

### 2.2 延期语义

`docs/MF-US-1-SPEC.md` **没有子树原语**：子树延期是宿主层"对每个节点各发一次 A5.2 POSTPONE"的批量操作，不是新算法。

每个节点由 `applyEvent(POSTPONE)` 计算：`mf_not_before = max(旧值, mf_ideal_due, today+N)`；
间隔、A-Factor、评阅次数、`mf_ideal_due`、`last_reviewed` 全部不变。

### 2.3 逐 Topic 事件与身份

- **节点 eventId**：沿用 `_mfUs1EventDescriptor('POSTPONE', node.file, node.fm, today, {days})`
  —— 内容含 topicId / expectedRevision / today / payload，天然稳定且节点间唯一。
- **批次身份**：`batchId = sha256('subtree-postpone:' + rootMfId + ':' + days + ':' + today + ':' + sortedNodeIds)`。
  仅用于报告与审计文案，**不落盘为批次记录** —— 避免再造一套 Mercy 式批次事务。
- **重试不重复**：节点已成功 → revision 前进 → 新 descriptor 产生新 eventId；但 `max()` 语义使其成为
  `no-op / NO_LATER_THAN_EXISTING`，日期不再前移。即：幂等由 **A5.2 算法**保证，而不是靠批次回滚。

### 2.4 部分成功

- 顺序执行、逐节点收集 `{path, stableId, status, reason}`；
- 汇总：全 applied → `applied`；有成功也有非成功 → `partial`；全部非成功 → `failed`；
- UI 提示只给**计数 + 前若干个节点 basename**（不写绝对路径），并明确"非原子事务"；
- 任何节点失败都**不阻断**后续节点（与单 Topic 的独立锁一致）。

### 2.5 崩溃恢复

- 每个节点都是独立的单 Topic 事件，已有 WAL：Intent → CAS → 回读 → Ledger 确认；
- 批次**不保存**自己的进度：重启后 `recover()` 逐条处理 prepared/uncertain；
- 用户重跑批次时：已应用节点变 `no-op`，未执行节点正常应用，未决节点被 Topic 锁阻断
  （`E_TOPIC_INTENT_STATE_UNKNOWN`），直到恢复；
- 明确记录：批次不是事务，不存在"整体回滚"。

### 2.6 模式隔离

| 模式 | 行为 |
|---|---|
| Legacy | 保持现有整段 `_postponeSubtreeLegacy`（`next_review` 写入、原有 Notice、中途失败提示） |
| Shadow | 仍由 Legacy 写权威字段，**不新增任何 Unified 写入**；因此本任务对 Shadow 不新增对照路径（避免半成品 shadow 批量） |
| Unified | 逐节点走 `postponeFile`（单 Topic POSTPONE），任一节点失败不回退 Legacy |

### 2.7 锁顺序与并发

- 批次**串行**执行节点（排序后逐个 await），任意时刻最多持有一个 Topic 链 → 无死锁、无跨 Topic 锁；
- 与单点操作并发时，同一 Topic 由既有 `withTopicLock` 串行；
- 不同 Topic 保持独立（一个节点 uncertain 不阻断其他节点）。

---

## 3. 拟修改的文件

### 3.1 新增 `src/integration/subtree-postpone-host.js`

纯编排层（不写 Frontmatter、不做算法）：

```js
planSubtreePostpone({ nodes, rootMfId, days, today })
  // → { batchId, order: [stableId...], nodes: [{path, topicId, file, fm}] }

runSubtreePostpone({ plan, runNode, onProgress })
  // runNode(node) → postponeFile 的返回值（applied/no-op/conflict/uncertain/failed/…）
  // → { status, batchId, results, counts }

describeBatchOutcome(outcome)  // 供 UI 的计数与问题节点摘要
```

### 3.2 修改根目录 `main.js`（**高风险，需批准**）

| # | 位置 | 改动 | 理由 |
|---|---|---|---|
| S1 | `postponeSubtree()` | 解析根节点与天数后：Legacy/Shadow 走原 `_mfUs1RunLegacy`；Unified 走新的 `postponeSubtreeHost()` | 唯一入口分流 |
| S2 | `_postponeSubtreeLegacy(root, choice)` | 接收已解析的 root/choice（原逻辑不变） | 避免二次提问，保持 Legacy 输出一致 |
| S3 | 新增 `postponeSubtreeHost(rootFile, days)` | 计划 → 逐节点 `postponeFile(node, days)` → 汇总 → Notice | 批量编排复用单 Topic 入口 |
| S4 | 根解析 | 从 `resolveSourceFromActive` 改为可接受 Source **或 Extract**（`allowCard:false`） | 任务要求 Source/Extract 子树；当前打开 Extract 时功能不可用 |

预计 **120–160 行**（含汇总与提示）。不动 `walkSubtree`、`tree-core`、Phase 1 逻辑。

### 3.3 是否必须改 `main.js`

是。唯一入口 `postponeSubtree()` 就在 `main.js`，Legacy 整段写入也在其中；不改则 Unified 永远 fail-closed。

---

## 4. Mock 离线集成测试计划（12 项）

1. Source + 2 级 Extract 子树：全部 `mf_not_before` 前移，`mf_interval_days/a_factor/review_count/mf_ideal_due/last_reviewed` 不变。
2. 多级（3–5 层）子树与乱序文件创建顺序，结果与顺序无关。
3. 根为 Extract 时按该 Extract 的子树执行（新增能力）。
4. 节点缺 `mf_id`：该节点 `blocked`，其余正常，无隐式迁移。
5. 节点 revision 冲突：该节点 `conflict`，其余 applied，汇总 `partial`。
6. 节点 uncertain（结果保存失败）：汇总 `uncertain`，该 Topic 被锁，其余节点完成。
7. 同批次同一天重跑：全部 `no-op`，`mf_not_before` 不再前移（幂等）。
8. 重启：`recover()` 后 uncertain 节点变 applied；再跑批次仍 no-op。
9. Card 在子树内：始终 `skipped`，零写入（SR 不受影响）。
10. `done / container / dismissed` 节点：skipped，零写入。
11. Legacy 模式：整段旧写入（`next_review` 写入、无 `mf_not_before`），Notice 与现有测试一致；Unified 不执行。
12. 静态接线断言：菜单 → `postponeSubtree()` → Unified 分支 `postponeSubtreeHost`；每节点必须调用 `postponeFile`，不得直接 `processFrontMatter`。

另加：`walkSubtree(strict)` 预检失败时**零写入**（沿用现有安全测试，需在 Unified 分支同样成立）。

---

## 5. 对 Legacy / Phase 1 / SR 的影响与风险

| 项 | 影响 |
|---|---|
| Legacy 行为 | 字段与 Notice 保持不变；仅把 root/choice 提前解析后传入（同一逻辑） |
| Phase 1 | 只读复用 `walkSubtree`/`getIRRows`，不修改 Phase 1 代码 |
| SR / Card | 批次永不写入 Card；`boost` 与本任务无关 |
| 风险 1 | `walkSubtree` 是 Legacy 关系解析器；若子树巨大（数百节点）会逐个串行执行，耗时明显 → 报告进度、提示非原子 |
| 风险 2 | 节点无 `mf_id` 时 Unified 不能处理（只能 blocked），需在报告中明确 |
| 风险 3 | 批次无持久状态；重启后进度不可精确汇总（以账本为准，节点级幂等） |
| 风险 4 | 未在真实 Obsidian 验证（本任务禁止） |

---

## 6. 请你裁决

1. **批准 S1–S4 的 `main.js` 修改**（约 120–160 行，4 处）。
2. **根节点范围**：允许以 Extract 为根（推荐，符合"Source / Extract 子树"），还是保持仅 Source/PDF？
3. **批次报告**：计数 + 前 3 个节点 basename（推荐，无绝对路径），是否需要同时写入诊断日志？

## 7. 安全边界

未改业务代码；未启用 Unified；未访问真实 Vault / `MemoFlow-Test` / `phase2 test`；未启动 Obsidian；
未迁移；未创建 PR/Merge；Phase 1 未触碰。
