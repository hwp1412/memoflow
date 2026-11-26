# P2-US1-HOST-DATA-01 — 统一持久化协调

- 基线：`personal/main @ 5a1942d`（PR #34 合并后）
- 分支：`feat/phase2-mf-us-1-host-data`
- 范围：只做持久化协调；未触碰调度、SR、Phase 1、Mercy、队列算法

## 1. 解决的问题

`Plugin.saveData(obj)` **替换整个 `data.json`**，而修改前的代码有三处写入者：

- 设置/会话保存（`main.js` 4 处）写整个 `this.settings`；
- Unified Ledger 由键级 adapter 单独保存；
- `onload` 把 `data.json` 全部键并入 `this.settings`，**包括 `mfUs1Ledger`**。

因此设置保存不是"删掉账本"，而是把**启动时的旧账本快照写回**：已 applied 的事件记录、
`prepared/uncertain` 的 WAL 记录会被回滚，重复评阅保护随之失效。

## 2. 迁移后的写入矩阵

| ID | 位置 | 现状 |
|---|---|---|
| W1 | `main.js` onload 首写 | `pluginData.update('settings', …)` |
| W2 | `main.js` `saveSettings()` | `pluginData.update('settings', …)`（22 个调用方零改动） |
| W3 | `main.js` `_scheduleSessionSave()` | `pluginData.update('settings', …)` + 失败日志 |
| W4 | `main.js` `onunload()` | 取消去抖 → 提交最新 session → `flush()`；失败只记录 |
| W5 | Ledger（lifecycle → adapter） | 注入 `pluginData.ledgerStore()`，与设置共享同一队列 |

读取：`onload` 使用 `stripReservedKeys(rawData)`，并再次 `delete this.settings[reservedKey]`。

## 3. 协调器契约（`src/integration/plugin-data-coordinator.js`）

- **单队列**：所有 `update()` 串行；每次写都 `await plugin.loadData()` 取**磁盘最新快照**再合并。
- **所有权**：`settings` 拥有除保留键外的全部键（含 `session`）；`ledger` 只写 `mfUs1Ledger`。
  设置提交值中的保留键会被过滤，**不会**写回旧账本；其他 owner 的键永不被删除。
- **成功判定**：`saveData` 返回后必须**读回并比较该 owner 段**；不一致 → `E_PERSIST_UNVERIFIED`。
- **失败分类**：
  - `E_PERSIST_PREWRITE`：读取/构造阶段失败，**确定未写入**；
  - `E_PERSIST_WRITE_UNKNOWN`：`saveData` 抛错，**结果未知**（`uncertain:true`）；
  - `E_PERSIST_UNVERIFIED`：写入调用返回但读回不一致/读回失败，**未确认**；
  - `E_DATA_CORRUPT`：`data.json` 不是对象 → 拒绝覆盖。
- **失败传播**：`openPluginDataLedger().flush()` 现在检查 `saveData` 的返回值，
  `{ok:false}` 不再被当成成功；`host-runtime` 的 `persistIntent` 因此保持"未确认禁止 CAS"。
- **诊断**：`{code, owner, phase, pendingRetry, at}`；首次失败弹一次非阻塞 Notice，
  同码持续失败**不再重复弹**，恢复后清除并提示一次；不记录账本内容。

## 4. main.js 修改（已获批 M1–M7）

| # | 改动 | 行数 |
|---|---|---|
| M1 | onload 建协调器、剥离保留键 | ~12 |
| M2 | onload 首写走协调器 | 1 |
| M3 | `saveSettings()` 走协调器（带 legacy 回退） | 8 |
| M4 | 会话去抖走协调器 + 失败日志 | 10 |
| M5 | `onunload` 取消定时器 → 提交 → flush | 20 |
| M6 | lifecycle 注入 `ledgerStore()` | 2 |
| M7 | 暴露 `this.pluginData` | 1 |

约 58 行（超出原估 25–35）：额外部分是**legacy 回退**（未调用 onload 的测试/宿主仍可用
`this.saveData`）、失败日志与说明性注释；未触碰任何调度、SR、Phase 1 逻辑。

## 5. 测试（19 项新增）

```
test/mf-us-1-host-data.test.js   19 pass
test/*.test.js                 1214 pass
node scripts/validate-release.mjs   valid
node scripts/build.mjs --dry-run    no files written
```

覆盖：设置+账本并发、设置永不删除/回滚账本、双 Topic 账本串行、完成顺序反转、
一成一败、读回不一致、损坏文件拒绝、旧数据/未知键保留、交错写入、入口矩阵静态检查
（含"src 内不得绕过协调器写 data.json"）、`{ok:false}` 传播、无协调器的旧适配器兼容、
启动剥离历史账本快照、onunload 取消去抖并提交最新 session、未确认 Intent 阻止 CAS、
重启后记录不丢且同 eventId 仍 `duplicate`。

## 6. 残余风险（未验证 / 边界）

1. **卸载时不可等待**：Obsidian `onunload` 是同步的，最终写入是尽力而为，不保证完成。
2. **无磁盘事务**：读回校验证明"观察到已写入"，不证明断电耐久；跨 `data.json` 与 Markdown 无事务。
3. **单进程内串行**：同一次会话内有效；两个 Obsidian 实例（同步盘/多设备）仍由 Obsidian 同步决定。
4. **未识别的新写入者**：任何未来直接调用 `plugin.saveData` 的模块都会绕过队列；已用
   静态测试锁定当前 `src/`，新增模块必须先登记所有权。
5. **实机未验证**：未在真实 Vault/Obsidian 中运行；真实 `data.json` 行为、卸载语义、
   大文件性能均未实测。

## 7. 回滚

`git revert <commit>`：协调器为新增文件，`main.js` 改动集中在 4 个持久化方法 + onload 初始化，
回退后恢复为直接 `saveData(this.settings)`；账本格式与键名未变，无数据迁移。

## 8. 安全边界

未启用 Unified；未访问真实 Vault / `MemoFlow-Test` / `phase2 test`；未启动 Obsidian；
未迁移数据；未创建 PR/Merge；Phase 1 工作区未触碰。
