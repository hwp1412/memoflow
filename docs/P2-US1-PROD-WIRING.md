# P2-US1-PROD-WIRING — 生产接线补齐

- 基线：`main @ 5446164`（PR #31 合并后）
- 分支：`feat/phase2-mf-us-1-prod-wiring`
- 真实 Unified 仍锁定；本轮完成写前 Intent、UI 前置参数（部分入口）、onload 生命周期合成验证

## 1. 入口清点与状态

| 入口 | 参数确认位置 | 调度写入 | Unified 描述符 | 状态 |
|---|---|---|---|---|
| `_gradeTopic` | 阅读页评分/质量选择后 | 旧方法体 | topicId/revision/today/payload-derived eventId | 已前置 |
| `markDone` / `dismiss` | 命令/菜单即时 | 旧方法体 | 活动文件描述符 | 已前置 |
| `postpone` | `pickFromList` 天数 | `_postponeLegacyWrite` | `{days}` 在确认后生成 | **已 UI 前置** |
| `schedule` | `askText` 日期 | `_scheduleLegacyWrite` | `{idealDue, reason}` 在确认后生成 | **已 UI 前置** |
| `setPriority` | `askText` 优先级 | `_setPriorityLegacyWrite` | `{priority}` 在确认后生成 | **已 UI 前置** |
| `postponeSubtree` | 批量选择 | 旧方法体 | 无逐 Topic | BLOCKED |
| `newSource` / `_createExtract` / `createTimestampExtract` | 命令/剪贴板 | 旧方法体 | 无 Unified 初始化 | BLOCKED |
| `spreadOverdue` / Mercy | 批量选择 | 旧方法体 | PR-09 批次（合成） | 宿主未接 |
| `resetCurrent` | 命令 | 旧方法体 | 无 | Unified 显式阻断 |
| Dashboard / onload | 只读 / 启动 | — | host-lifecycle | 合成验证 |

## 2. 写前 Intent（WAL）顺序

`host-runtime` 的 Unified 路径：

1. 在**克隆的合成存储 + 临时账本**上规划精确写入，得到 prepared record（beforeHash/expectedAfterHash/fields）；
2. 先把 prepared 写入持久账本并确认 `saveData` 成功；
3. 失败则返回 `E_INTENT_PERSIST_FAILED`，**不执行 Topic CAS**；
4. 再在真实存储上执行 CAS；
5. 写后回读校验；
6. 持久化 applied；
7. applied 保存失败 → `uncertain`；重启用 prepared + 实际文件 hash 进行 reconcile。

该实现不修改 PR-09 writer；规划阶段仅在 `SyntheticUnifiedStorage` 上可用，其他后端 fail-closed（`E_INTENT_PLAN_UNAVAILABLE`）。真实 Unified 未授权。

### 3.1 durable-confirmed 重试补丁

- 内存 prepared ≠ 已持久化：runtime 维护 `confirmed` 集合，只有 `saveData` 成功才加入；
- prepared 保存失败：记录保留在内存但**不进入 confirmed**，并锁定该 Topic；
- 同 eventId 重试会重新尝试持久化，成功前不执行 CAS；
- 不同 eventId 在锁定 Topic 上返回 `E_TOPIC_INTENT_UNRESOLVED`（未知状态返回 `E_TOPIC_INTENT_STATE_UNKNOWN`）；
- 保存抛异常视为持久化结果未知，需重新核验/恢复，不能直接重试；
- applied 保存失败/异常 → `uncertain`，锁定 Topic，重启从 prepared 恢复；
- `recover()` 持久化失败 → `persisted:false`，恢复涉及的 Topic 全部保持锁定。

## 3. 故障窗口测试

`test/mf-us-1-closure-e2e.test.js` 覆盖：

- Intent 保存失败 → CAS 未执行，revision/review_count 不变；
- CAS 成功、applied 保存失败 → `uncertain`；重启后从 prepared 恢复为 applied，不重复评阅；
- Intent 后外部编辑 → 快照冲突，不覆盖外部内容；
- 重复事件重载后 duplicate，评阅次数不增加。

明确：`saveData()` resolve 不保证断电耐久，也不提供 Markdown 与 data.json 的跨文件事务。

## 4. 启动生命周期

`src/integration/host-lifecycle.js`：加载/校验版本化账本、hydrate 可信内存账本、recover prepared/uncertain、暴露阻塞 Topic 与 runtime view。测试验证：设置保留、损坏版本拒绝、prepared Topic 阻塞、真实 runtime `writeEnabled=false`。尚未接入真实 `onload`。

## 5. resetCurrent

Legacy 保留原行为；Unified 显式 `E_RESET_CURRENT_UNDECIDED`，不映射为 MANUAL_SCHEDULE。

## 6. 测试

```
test/mf-us-1-closure-e2e.test.js  16 pass
test/mf-us-1-*.test.js           720 pass
test/*.test.js                  1115 pass
validate-release                valid
build --dry-run                 no files written
```

## 7. 仍阻塞

1. `postponeSubtree` 逐 Topic 描述符/部分成功恢复；
2. Source/Extract Unified 创建与队列登记；
3. Mercy/子树宿主入口接线；
4. onload 生命周期真实接入；
5. 真实 CAS、断电恢复、跨插件并发实机验收；
6. 生产 Unified 授权、迁移/备份/回滚与旧写入者退场；
7. resetCurrent 规范事件（若需要）。

## 8. 安全边界

仅合成/Mock；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未写真实数据；未启用 Unified；Phase 1 未触碰。
