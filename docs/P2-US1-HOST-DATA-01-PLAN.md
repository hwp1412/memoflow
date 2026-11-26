# P2-US1-HOST-DATA-01 — 统一持久化协调：契约审查与实施方案

- 基线：`personal/main @ 5a1942d`（PR #34 已合并，`49fe66f` 为祖先）
- 本轮交付：**只做契约审查与方案**，不改源码
- 拟用分支 / worktree（已创建，暂无代码提交）：`feat/phase2-mf-us-1-host-data` / `memoflow-phase2-data`
- Phase 1 工作区（`memoflow`，`feat/p1-refine-safety-process-production`）未访问、未修改

---

## 1. `data.json` 读写入口矩阵（实际源码，非推测）

`Plugin.saveData(obj)` 的语义是**用 obj 替换整个 `data.json`**（不是按键合并），这是全部问题的前提。

### 1.1 写入入口

| ID | 位置 | 调用 | 写入内容 | 键范围 |
|---|---|---|---|---|
| W1 | `main.js:2936`（onload） | `await this.saveData(this.settings)` | 整个文件 | **全文件** |
| W2 | `main.js:3387` `saveSettings()` | `await this.saveData(this.settings)` | 整个文件 | **全文件** |
| W3 | `main.js:3594-3599` `_scheduleSessionSave()`（1.5s 去抖） | `this.saveData(this.settings)` | 整个文件 | **全文件** |
| W4 | `main.js:3029` `onunload()` | `this.saveData(this.settings).catch(...)` | 整个文件 | **全文件** |
| W5 | `host-lifecycle.js` → `plugin-data-ledger-store.js` → `createObsidianPluginDataStore.saveData` | `loadData()` → `{...current, mfUs1Ledger: value}` → `saveData` | 仅 `mfUs1Ledger` | 键级 |

W2 是唯一设置 choke point：`saveSettings()` 有 **22 处调用**（`main.js` 内 UI/设置页/命令），
但它们全部收敛到这一个方法，因此**改动面是 1 个方法体，不是 22 处**。

### 1.2 读取入口

| ID | 位置 | 读取 |
|---|---|---|
| R1 | `main.js:2860` | `Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` → **把 `data.json` 的每个键都塞进 `this.settings`**，包括 `mfUs1Ledger` |
| R2 | ledger adapter | `loadData('mfUs1Ledger')` |

### 1.3 已在协调范围内 / 仍会绕过的写入

| 写入 | 现状 |
|---|---|
| W5 Ledger | 经 adapter 的**单队列**（HOST-RUNTIME-01 加入），键级合并，保存串行化 |
| W1–W4 Settings/Session | **完全绕过** adapter；直接整文件替换 |
| Refine History | 独立 vault JSON 文件（`RefineHistoryStore`，temp + rename + 读回），**不写 `data.json`**，与本问题无冲突 |
| SR Card | 不写 `data.json`（由 SR 插件管理），无冲突 |

---

## 2. 根因（两层，第二层更严重）

### 根因 A：整文件替换 + 无共享队列

`this.settings` 不含当前账本，而 `saveData` 替换整个文件：

```
t0: Ledger 保存（含 E1 applied）        → data.json 有 mfUs1Ledger={E1}
t1: 会话去抖触发 saveData(this.settings) → data.json 只剩 settings，账本被删除
```

顺序完全不受约束：W3 在任意会话变化后 1.5s 触发，Ledger flush 可能落在任何时刻。

### 根因 B：把启动快照当成账本再写回（回滚而非删除）

R1 把 `mfUs1Ledger` 合并进 `this.settings`。因此后续每次 W1–W4 写回的不是"没有账本"，
而是**onload 时刻的旧账本快照**：

```
onload: data.json 有 E1..E5（applied）
t1: E6 applied，账本保存 → 文件有 E1..E6
t2: 会话保存写出 this.settings → 文件回到 E1..E5
```

后果（比丢 key 更危险）：

1. **重复评阅保护失效**：`classify()` 认为 E6 是 `new`，同一 eventId 重放会再次计入 `review_count`；
2. **WAL 的 prepared/uncertain 记录消失**：崩溃恢复看不到未决事件；
3. **恢复误判**：账本状态与真实 Topic 内容不一致，可能触发错误的人工恢复或覆盖判断。

### 根因 C："内存已完成 ≠ 已持久化"

`saveData` 的成功只代表写入调用返回，不代表磁盘耐久；当前代码在 W3/W4 中 `.catch(console.error)`
后即当成功。协调器必须显式区分 **in-memory / queued / written / verified**，并且不把
Promise 排队当作磁盘事务保证。

---

## 3. 建议的协调器（`PluginDataCoordinator`）

新增 `src/integration/plugin-data-coordinator.js`，**唯一**持有 `plugin.loadData/saveData` 的对象。

### 3.1 接口

```js
createPluginDataCoordinator({ plugin, reservedKeys = ['mfUs1Ledger'], onDiagnostic })

coordinator.update(owner, mutate)   // owner: 'settings' | 'ledger' | 扩展键名
  // → { ok, code, verified, keys, diagnostics }

coordinator.read(owner)             // 返回该 owner 拥有的键的最新持久化快照
coordinator.ledgerStore()           // 给 PersistentEventLedger / createObsidianPluginDataStore 用的键级 store
coordinator.flush()                 // 等待队列排空；返回最后一次写入结果
coordinator.state()                 // { pending, lastError, lastVerifiedAt, owners }
```

### 3.2 写入协议（每次 `update`）

```
1. 取队列锁（单一 FIFO，进程内）
2. snapshot = await plugin.loadData()      ← 权威来源是磁盘，不是 this.settings
3. 校验 snapshot 是可合并对象（否则 E_DATA_CORRUPT，失败关闭）
4. next = { ...snapshot }
   删除 reservedKeys 中被该 owner 禁止写的键（settings 不得写 mfUs1Ledger）
   next[ownedKeys] = mutate(该 owner 的当前值)
5. await plugin.saveData(next)
6. 读回 verify = await plugin.loadData(); 比较 owner 段的摘要
7. 返回 { ok, verified, ... }；失败保留 dirty 状态并在下一次 flush 重试
8. 释放队列
```

关键点：

- **只合并、不整文件替换**：任何 owner 都不会删除别人的键；
- **只写自己的键**：`settings` owner 被禁止写 `mfUs1Ledger`，`ledger` owner 被禁止写设置；
- **读回校验**：`verified:true` 才是持久化确认；`saveData` 返回但读回不一致 → `E_PERSIST_UNVERIFIED`；
- **失败不谎报**：`{ok:false}` 向上传递，调用方不得据此认为已保存。

### 3.3 数据所有权

| Owner | 拥有的键 | 说明 |
|---|---|---|
| `settings` | `data.json` 中除 `reservedKeys` 外的全部键（含 `session`） | 仍是同一个 `this.settings` 对象，22 个调用方无感 |
| `ledger` | `mfUs1Ledger`（及其内部 `version/records`） | 账本格式**不变**，仍是 v1 |
| 未来 | `refineState` 等需要进 data.json 的键 | 通过 `reservedKeys` 注册，避免再次出现同类问题 |

`session` 留在 `settings` 内（不拆键），避免数据结构变更；但 `session` 的写入与设置写入共享
**同一条设置队列**，因此不会再互相覆盖。

### 3.4 与 WAL 的关系（不新建账本体系）

`coordinator.ledgerStore()` 仍是 `loadData(key)/saveData(key, value)` 形状，`PersistentEventLedger`
与其恢复协议完全复用。区别只有两点：

1. `saveData` 走协调器队列并**读回校验**；
2. 返回 `{ok}` 只在 `verified:true` 时为真 → `persistIntent` 的语义从"已排队"升级为"已确认落盘"，
   与 HOST-RUNTIME-01 的 "Intent 持久化成功才允许 CAS" 保持一致。

---

## 4. 最小修改清单（**需要你批准后才实施**）

### 4.1 新增文件（1 个）

- `src/integration/plugin-data-coordinator.js`

### 4.2 修改 `plugin-data-ledger-store.js`（小改）

- `createObsidianPluginDataStore(plugin)` 增加可选 `coordinator` 参数：存在时 `saveData` 走
  `coordinator.update('ledger', …)`，不存在时保持现有行为（向后兼容，既有测试不动）。

### 4.3 修改上游 `main.js`（**高风险，需单独批准**）

| # | 位置 | 最小改动 | 理由 |
|---|---|---|---|
| M1 | `main.js:2860` onload | 读取后 `delete this.settings.mfUs1Ledger`（以及所有 `reservedKeys`），并以原始快照构造协调器 | 消除根因 B：设置对象不再携带账本快照 |
| M2 | `main.js:2936` | `await this.saveData(this.settings)` → `await this.pluginData.update('settings', …)` | 走协调器首写 |
| M3 | `main.js:3387` `saveSettings()` | 方法体改为调用协调器 | 22 个调用方零改动 |
| M4 | `main.js:3594` `_scheduleSessionSave()` | 定时器回调改调协调器；失败记诊断 + Notice（不静默） | 消除根因 A/C |
| M5 | `main.js:3029` `onunload()` | 改调 `coordinator.flush()`（fire-and-forget，附错误日志） | onunload 不能 await，保留残余风险并披露 |
| M6 | `main.js:2882` `initializeHostLifecycle` | 传入 `dataStore: coordinator.ledgerStore()` | 账本与设置共享同一队列 |
| M7 | onload 末尾 | 暴露 `this.pluginData` 供测试/未来模块使用 | 单一入口 |

改动规模：`main.js` 约 **25–35 行**（含 6 个调用点），不触碰调度、SR、Phase 1 代码。

### 4.4 兼容性影响

- `data.json` 结构、键名、账本版本 **不变**；旧数据可直接读；
- 未识别键全部保留（合并写），不会像现在这样被整文件替换丢弃；
- 22 个 `saveSettings()` 调用方签名与行为不变（返回 Promise）；
- 失败语义变化：以前静默 console.error，现在会返回 `{ok:false}` 并留下诊断——这是**行为修正**，
  需在验收中确认不会打断既有 UI 流程（UI 不会 await 失败）。

### 4.5 是否需要改 `main.js`

**是，必须改。** 理由：第二个写入者是 `main.js` 自己的 `saveData(this.settings)`，
不经过任何适配器；协调器无法拦截 `Plugin.saveData` 本身。若坚持不改 `main.js`，
唯一替代是"设置侧也改用 adapter"——但那仍然要改同一批调用点，且会把设置拆键，风险更大。
**因此本轮先停在这里等批准。**

---

## 5. 故障恢复方案

| 场景 | 处理 |
|---|---|
| 保存失败（抛错/拒绝） | `{ok:false, code}` 返回；保留 `dirty`；下一次任何写入或 `flush()` 重试 |
| 保存返回但读回不一致 | `E_PERSIST_UNVERIFIED`；不推进账本状态；Intent 视为未持久化 → 禁止 CAS |
| `data.json` 不可解析/非对象 | `E_DATA_CORRUPT`，失败关闭，不写入、不覆盖 |
| 启动时账本损坏 | 沿用 `openPluginDataLedger().healthy=false` + `blockedTopicIds`，行为不变 |
| 进程在写入中退出 | 下一次启动以磁盘内容为准；账本 prepared/uncertain 仍按 HOST-RUNTIME-01 恢复 |
| 并发写 | 单队列 FIFO；同一键的写入按到达顺序生效 |

明确披露（写进文档与代码注释）：**跨 `data.json` 与 Markdown 无事务**；读回校验只证明
"观察到已写入"，不证明断电耐久；真实耐久仍需实机验收。

---

## 6. 测试与验收计划（全部合成数据）

| # | 场景 | 断言 |
|---|---|---|
| T1 | Settings 与 Ledger 同时保存 | 最终文件两段都是最新；`settings` 不携带账本旧快照 |
| T2 | 不同 Topic 的 Intent 并发保存 | 两条记录都在；无丢失 |
| T3 | 保存完成顺序反转（第一个延迟） | 后完成者不被旧快照覆盖 |
| T4 | 一个成功、一个失败 | 失败方 `{ok:false}`；成功方数据完整 |
| T5 | 旧版本数据加载 | 未知键保留；ledger v1 可读；设置默认值合并不变 |
| T6 | Session/Settings/Ledger 交错多次 | 最终三者一致；无回滚 |
| T7 | 恢复期间持久化失败 | `uncertain`、恢复门保持关闭、可重试 |
| T8 | 重启后检查全部关键数据 | settings/session/ledger 完整；同 eventId 仍 `duplicate`（review_count 不重复） |
| T9 | 入口矩阵静态检查 | `main.js` 中除协调器外不得再有 `saveData(`；`saveSettings()` 走协调器 |
| T10 | Runtime 故障注入 E2E | Intent 未确认 → 不 CAS；读回失败 → `writesPerformed=null` |

验收：专项测试 + `test/*.test.js` 全量 + `validate-release` + `build --dry-run`；
GitHub CI 由你创建 PR 后运行。

---

## 7. 请你裁决的三件事

1. **批准修改上游 `main.js`**（M1–M7，约 25–35 行，全部集中在持久化调用点）。
2. **确认所有权规则**：`settings` owner 写入时丢弃 `mfUs1Ledger`；`ledger` owner 只写该键。
   是否还有其他键应加入 `reservedKeys`（例如未来 Refine 状态若迁入 `data.json`）。
3. **确认失败可见性**：保存失败时是否允许弹一次 Notice（非阻塞），还是仅记诊断日志。

批准后我按 4.1–4.3 实施，并把入口矩阵固化成测试（T9），防止未来新增写入再次绕过协调器。

## 8. 安全边界（本轮声明）

未修改任何源码；未启用 Unified；未访问真实 Vault / `MemoFlow-Test` / `phase2 test`；
未启动 Obsidian；未迁移数据；未创建 PR/Merge；Phase 1 工作区未触碰。
