# P2-US1-HOST-RUNTIME-01 — Unified 异步宿主执行链

- 基线：`main @ 3bb80ca`（PR #33 合并后；ENTRY-CLOSURE 已确认合并）
- 分支：`feat/phase2-mf-us-1-host-runtime`
- 范围：把已验收的 MF-US-1 核心接入真实宿主执行链；不启用生产 Unified、不写真实 Vault。

## 1. 复用的模块与新增模块

复用（未改语义）：`applyEvent`、`buildTopic`、`buildProjection`、`PersistentEventLedger`、
`evaluateHostRuntime`、`topic-creation.js`、`createObsidianProcessAdapter`（PR-10B）。

新增：

| 模块 | 作用 |
|---|---|
| `src/integration/host-async-storage.js` | 异步 Topic 存储：`Vault.read` 读取 + 依赖 PR-10B 的 `Vault.process` 字节保真 CAS |
| `src/integration/host-async-executor.js` | 异步事件执行：复用核心算法，负责 Intent→CAS→回读→账本的顺序 |
| `src/integration/host-async-runtime.js` | 运行时门禁、Topic 锁、`recover()`（与同步运行时同契约） |
| `src/integration/topic-creation-host.js` | 创建编排（确定性 UUID + 回读校验 + 六态结果） |
| `host-lifecycle.initializeAsyncHostLifecycle` | onload 形状的打开/校验/恢复 |

## 2. 调用图（真实入口 → Writer）

```
用户阅读操作
  → main.js entry（newSource / _writeExtract / createTimestampExtract / _gradeTopic …）
  → host-scheduler-service.execute(descriptor)
      legacy  → 原 0.1 代码（不变）
      shadow  → legacy 一次 + 只读观察
      unified → 注入的 transport（仅隔离 harness 提供）
  → async host runtime.execute(request)          [门禁 + Topic 锁]
  → async executor                              [纯计划]
      assertRequest → buildTopic → applyEvent → buildProjection → changedFields
  → applyEdits(真实字节) 预演 → expectedAfterHash = sha256(真实字节)
  → ledger.prepare → persistIntent（await 保存成功）
  → storage.compareAndSwap（Vault.process 内再校验 hash/revision/id）
  → Vault.read 回读校验（hash 一致）
  → ledger.markApplied → persistResult（await）
```

## 3. 同步/异步矛盾的根因与解决

PR-09 的 `executeUnifiedEvent` 是同步的，且只接受 `SyntheticUnifiedStorage`；它的
`expectedAfterHash` 来自 `renderContent()` 合成的 YAML 字符串。真实 Vault 是异步的，
且 Markdown 的真实字节不等于任何合成序列化结果。

解决方式（未改同步 writer 的语义，只导出其纯函数复用）：

1. **读取异步**：`await Vault.read`，绝不缓存快照冒充已完成写入。
2. **Hash 用真实字节**：写入前用同一个 `applyEdits` 在真实内容上预演，得到
   `expectedAfterHash = sha256(真实字节)`；不再哈希合成 YAML。
3. **CAS 异步**：复用 PR-10B 的 `Vault.process` 适配器，回调内再次校验
   `hash / mf_id / mf_revision / mf_scheduler_version / type / status`。
4. **Intent 先落盘**：`persistIntent` 返回 `{ok:true}` 之后才允许 CAS；失败即失败关闭。
5. **回读验证**：适配器写后重新读取，比较真实字节 hash。
6. **结果落盘**：`persistResult` 失败 → `uncertain` + `requiresManualRecovery`，不谎报成功。

## 4. 失败注入证据

| 场景 | 结果 |
|---|---|
| Intent 保存返回 `{ok:false}` | `reason=E_LEDGER_SAVE_FAILED`，文件字节零变化 |
| 写成功、结果保存失败（第 2 次保存） | `uncertain`，`writesPerformed=true`，Topic 锁 |
| 重启（重读账本）后 reconcile | `applied`，`mf_revision` 不变、`review_count` 不重复 |
| 外部把 `mf_revision` 改为 1 后再提交旧事件 | `conflict / E_REVISION_MISMATCH`，不覆盖 |
| 同一 eventId 再次提交 | `duplicate`，`writesPerformed=false`，byte 不变 |
| 无合成授权执行 | `E_HOST_MODE_BLOCKED`，零写入 |
| 设置为 unified 但未注入 transport | `E_UNIFIED_NOT_AUTHORIZED`，Legacy 一次都不执行 |
| 崩溃后仅存 prepared（未写） | `recover()` → `retryable` |

## 5. Frontmatter 安全更新与一处契约扩展

PR-10B 的适配器默认拒绝任何缩进 YAML。真实笔记普遍带
`tags:\n  - …`，因此**默认严格模式会让所有带标签的笔记无法被 Unified 更新**
（本轮测试实测：`E_FRONTMATTER_UNSUPPORTED_STRUCTURE`）。

处理方式（需复核）：

- `parseBlock/applyEdits` 新增**可选择**的 `allowNestedBlocks`，**默认仍为 false**，
  PR-10B 的既有契约与测试不变；
- 只有异步生产适配器启用容错：缩进行归属于上一个键，**从不解释**，该键标记为
  `structured` 并**拒绝作为标量编辑**（`E_FIELD_STRUCTURED`）；
- 无父键的缩进行、重复顶层键、行内注释照旧拒绝；
- 测试证明：`tags` 列表与嵌套块在事件写入后逐字节保留；把 `priority` 改成嵌套后提交
  → `E_FIELD_STRUCTURED`，文件不变。

这是本轮唯一的契约扩展点，请确认是否接受，或改为“带嵌套块一律拒绝”的严格策略。

## 6. 测试

```
node --test test/mf-us-1-host-runtime.test.js     14 pass
node --test test/mf-us-1-creation-host.test.js    19 pass
node --test test/*.test.js                      1174 pass
node scripts/validate-release.mjs                valid
node scripts/build.mjs --dry-run                 no files written
```

## 7. 能力分层（必须区分）

| 能力 | 状态 |
|---|---|
| 宿主入口 → 算法 → 异步存储 → 账本 → 重启恢复（Mock） | **已通过集成测试** |
| 创建（Source / Extract，确定性 UUID、父子、六态结果） | **已通过集成测试** |
| 生产接口已实现、但无真实写入授权 | 异步适配器、执行器、运行时（门禁恒拒） |
| 依赖真实 Obsidian 才能验证 | 真实 `Vault.process` 行为、真实 `data.json` 断电耐久、实机崩溃窗口 |
| 仍需开发的宿主入口 | postpone / schedule / setPriority / postponeSubtree / Mercy / dashboard / 迁移激活 |

## 8. 与待审分支的关系

`feat/phase2-mf-us-1-creation-wiring`（3ef1106）已包含等价的创建接线。本分支同样包含
创建接线（基于 main 重新落地）。**两者只需合并一个**，请裁决保留哪条。

## 9. 安全边界

仅 Mock Obsidian / 内存数据；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；
未写真实 `data.json`；未启用 Unified；未执行迁移；未创建 PR；Phase 1 工作区未触碰。

---

## 补充轮次：并发、账本持久化与缓存契约

### A. Topic 级串行化

`host-async-runtime` 增加每 Topic 一条执行链 `topicChains`：

- 第二个事件**等待**第一个事件的整条链（读取→Intent→CAS→回读→账本）结束；
- 等待结束后**重新检查**运行时锁与最新修订，不会用旧快照继续；
- 同一 eventId 并发 → 第一个 applied，第二个 duplicate；
- 不同 eventId 同一 Topic → 后到者拿到 `E_REVISION_MISMATCH`（不双写）；
- 执行抛异常 → 链尾仍会清理 map 条目，Topic 不会被永久占用；
- 事件进入 uncertain → 链释放，但 `topicLocks` 保留，后续事件返回
  `E_TOPIC_INTENT_STATE_UNKNOWN`。

### B. 账本全局持久化顺序

- 运行时只有**一条**保存链 `saveChain`；快照在链内、前一次保存结束之后才取，
  因此后一次保存不可能写入更旧的快照，也不会丢掉其他 Topic 的记录；
- 每个事件的 Intent 必须 `await` 保存成功后才执行 Topic CAS（不变）；
- `createObsidianPluginDataStore` 的 `saveData` 也串行化（同一 adapter 内），
  避免并发 read-modify-write 导致后保存的键覆盖先保存的键；
- 残余限制（已披露）：调用方绕过 adapter 直接 `plugin.saveData()` 仍可能竞争。

### C. MetadataCache 契约

- MetadataCache 只当**索引**用：命中后仍在 `Vault.process` 回调里用最新字节复核
  `mf_id`，缓存过期/指向错误笔记 → 失败关闭，不写错文件；
- 缓存未命中（新建文件尚未索引）→ 有界直接读取回退（最多 500 个 Markdown 文件），
  找到后记住解析结果；未找到/重复 → `E_TOPIC_NOT_FOUND` / `E_DUPLICATE_TOPIC_ID`；
- 读取失败（文件已移动/删除）→ 丢弃记忆并失败关闭。

### D. 诊断与结果诚实性修复

- 结果保存失败 → 记录回落为 `uncertain`（而不是内存里留 `applied`），`recover()` 才能处理；
- `view().blockedTopicIds` 现在同时包含账本阻塞状态与运行时锁；
- 恢复成功会解除该 Topic 的运行时锁；
- “已恢复的 duplicate 但结果保存失败”不再返回 `duplicate:true`，而是 `uncertain`；
- `writesPerformed`：确定未写 = `false`；回读失败/异常 = `null`（未知）。

### E. 本轮测试

```
test/mf-us-1-host-concurrency.test.js   16 pass
test/mf-us-1-host-runtime.test.js       15 pass
test/*.test.js                        1190 pass
```
