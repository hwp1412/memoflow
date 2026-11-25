# P2-US1-CREATION-WIRING — Source/Extract 创建宿主接线

- 基线：`main @ 3bb80ca`（PR #33 合并后）
- 分支：`feat/phase2-mf-us-1-creation-wiring`
- 范围：只补齐 ENTRY-CLOSURE 遗留门禁 1（`newSource` / `_createExtract` / `createTimestampExtract`）。
  postponeSubtree 与 Mercy 宿主入口仍为 BLOCKED，本文不涉及。
- 未重审、未修改任何已验收算法（PR-01～PR-11）。

## 1. 为什么创建不能当成“事件”走 WAL

`SPEC A8` 的 `EVENT_TYPES` 只有 10 个评阅/行政事件，**没有 CREATE**。创建在规范中的定义是
*字段初始化*（A3.3 首次间隔、A3.4 父子与独立排期），因此：

- 创建**没有**事件指纹、没有 `mf_last_event_id`、没有 CAS revision 前置条件；
- 创建**无法**复用 `src/integration/host-runtime.js` 的 Write-Ahead Intent；
- 创建**没有** `data.json` 账本记录 —— 因此本模块显式返回 `ledgerRecorded: false`，
  而不是伪造一条“已记账”的结论。

## 2. 三个可分离的结果，不虚构原子性

`src/integration/topic-creation-host.js` 把创建拆成可分别观测的三步：

| 步骤 | 观测字段 | 失败语义 |
|---|---|---|
| 1. 文件创建 | `fileCreated` / `writesPerformed` | 抛错且路径确认不存在 → `failed`；抛错但文件已存在 → `uncertain` |
| 2. 回读校验 | `verified` | `mf_id`/`mf_revision` 与计划不一致 → `partial` + `requiresManualRecovery` |
| 3. 账本登记 | `ledgerRecorded` | 按规范**不存在**该步骤，恒为 `false`，文档化而非静默 |

状态取值：`applied` / `duplicate` / `conflict` / `partial` / `failed` / `uncertain`。

## 3. 稳定 UUID 与幂等

- `mf_id = UUIDv4(sha256('mf-us1-create:' + requestId))`，由 `allocateStableUuid` 纯函数派生：
  同一 `requestId` 重试必然得到同一 UUID，不依赖任何持久注册表。
- 宿主 `requestId` 取 `source:<vault 路径>` / `extract:<vault 路径>`，路径由既有命名逻辑确定。
- 重试判定读**已存在文件的 `mf_id`**：
  - 相同 → `duplicate`，零写入、不生成第二个 Topic；
  - 不同或缺失 → `conflict`，**不覆盖**，交人工处理。
- 限制：崩溃发生在“文件写入后、回读前”时，只能靠读回文件发现，不能靠账本发现。
  这是创建阶段（无事件、无跨文件事务）的已知边界，不是本轮可消除的问题。

## 4. 字段合成（A2.2 兼容投影）

`composeCreationContent()` 只替换**规范字段**，其余旧行与正文逐字节保留：

- 替换：`priority`、`next_review`、`interval`、`a_factor`、`review_count`、`last_reviewed`
  以及 `mf_id`、`mf_parent_id`、`mf_root_id`、`mf_ideal_due`、`mf_not_before`、
  `mf_interval_days`、`mf_last_event_id`、`mf_revision`、`mf_scheduler_version`；
- `next_review` 由宿主提供 formatter，**入参固定为 `mf_ideal_due`**，即在格式层实现
  `next_review = formatForVault(effective_due)`，不接受调用方另造日期；
- 旧 Frontmatter 出现重复规范键（如两个 `a_factor:`）→ `E_FRONTMATTER_DUPLICATE_KEY`，
  不静默取其一；CRLF / 缺 frontmatter → 明确拒绝。

## 5. 宿主接线（最小侵入）

`main.js` 新增 `_mfUs1CreateTopicFromHost()` 网关，三个入口在**真正写文件的那一行之前**接入：

| 入口 | 接入点 | Legacy 分支 |
|---|---|---|
| `_createExtract` → `_writeExtract` | `vault.create` 前 | 完全不变 |
| `newSource` → `_newSourceLegacy` | `vault.create` 前 | 完全不变 |
| `createTimestampExtract` → `_createTimestampExtractLegacy`（`src/main.js`） | `vault.create` 前 | 完全不变 |

网关在**没有合成授权 token 时是严格 no-op**（`handled:false`），直接落到原有代码路径：

- 授权 token 只能由 `issueSyntheticCreationAuthorization()` 通过 `WeakSet` 发放；
- 设置项里**没有**对应开关，生产 Runtime 从不发放该 token；
- `main.js` 不出现 `issueSyntheticRuntimeAuthorization` 或 `mode: 'unified'` 字样，
  既有 `test/mf-us-1-host-wiring.test.js` 的静态断言继续成立。

## 6. 需要项目所有者裁决的两处语义

本轮按“更严格的数据保护”处理，均未静默沿用 Legacy，也未擅自改规范：

1. **`newSource` 的 “Hold in inbox”**：`SPEC A8` 规定创建即 `active`，`inbox` 属旧状态且
   语义需兼容适配器解释。Unified 创建目前**仅写 `active`**；若用户选择 inbox，
   应按“Unified 尚不支持 inbox 创建”显式拒绝，而不是静默改写为 active。
   *本轮未在 Unified 路径实现 inbox 拒绝分支 —— 当前 Unified 创建尚未对真实用户开放，
   `newSource` 的 inbox 分支在 Legacy 下不受影响；该项列为待裁决 + 待实现。*
2. **Legacy 创建时会顺带把父节点 `priority +1` 并 bump A-Factor**。A3.4 只规定
   “创建子节点不增加父节点评阅次数、不将父节点设为 done”，未定义 priority/A-Factor bump。
   这是一次**隐式调度写入**，在 Unified 下会造成父节点 revision 之外的变化。
   本轮 Unified 创建**不执行**该 bump（`createTimestampExtract` 已显式跳过），
   Legacy 分支保持原样。是否需要为父节点定义显式事件，请裁决。

## 7. 测试

```
node --test test/mf-us-1-creation-wiring.test.js   19 pass
node --test test/*.test.js                        1141 pass（基线 1122 + 本轮 19）
node scripts/validate-release.mjs                 valid
node scripts/build.mjs --dry-run                  no files written
```

覆盖：未授权零读写、确定性 UUID、A3.3 字段、字段合成保真、重复规范键拒绝、
`next_review` 源自 effective due、applied/duplicate/conflict/partial/failed/uncertain 六态、
重复请求不产生第二个文件、父级缺 `mf_id` 时阻断且不回退 Legacy、
Unified 创建不触碰父节点调度字段、Legacy 输出无 `mf_*` 泄漏。

## 8. 仍未完成的生产门禁

1. `postponeSubtree` 逐 Topic 事件、部分成功与恢复（BLOCKED）。
2. Mercy 宿主 Preview/Confirm/Apply/Undo 与未决批次识别（BLOCKED）。
3. 真实 onload 实机验证、真实账本持久化/恢复。
4. 创建阶段的崩溃窗口只能用回读发现（无事件账本），需实机验收口径。
5. 真实 CAS/崩溃验收与生产 Unified 授权。

## 9. 安全边界

仅 Mock / Fake Vault；未访问 `MemoFlow-Test`、`phase2 test`、任何真实 Vault、Obsidian、SR；
未写入真实 Frontmatter/`data.json`；未执行迁移、未启用 Unified、未创建 PR、未 Merge；
Phase 1 工作区未触碰。
