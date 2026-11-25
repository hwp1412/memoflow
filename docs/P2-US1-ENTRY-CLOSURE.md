# P2-US1-ENTRY-CLOSURE — 剩余入口接线

- 基线：`main @ d4a7234`（PR #32 合并后）
- 分支：`feat/phase2-mf-us-1-entry-closure`
- 范围：仅处理创建、子树、Mercy 宿主、onload 四组；不重审算法

## 1. 实际完成

### D. onload 生命周期（已接入）

`main.js` onload 在设置初始化后调用 `initializeHostLifecycle`：

- 加载并校验版本化账本；
- 损坏/缺失/未决时 `healthy=false`、`blockedTopicIds` 可见；
- runtime 始终 locked/read-only（无生产 Unified 授权）；
- 异常仅记录日志，不阻断 Legacy 启动；
- 未因合成授权函数存在而开放真实写入。

测试：Mock Plugin API（`loadData/saveData`）验证 settings 保留、损坏账本 `healthy=false`、`writeEnabled=false`。

### A. Source/Extract 创建（纯层完成，宿主未接）

`src/integration/topic-creation.js`：

- `allocateStableUuid(requestId)`：稳定 UUID，重试不重复；
- `createTopic()`：Source/Extract 独立初始化、父子/Root 关系、Revision 0、队列字段；
- `createTopicOnce()`：requestId 幂等，重复返回同一 Topic，不修改父节点；
- 无持久父 ID 的 Extract fail-closed。

测试：Source、多级 Extract、幂等、父不变、队列投影。

**宿主 `newSource/_createExtract/createTimestampExtract` 尚未改为调用该模块 → BLOCKED。**

### B. postponeSubtree — BLOCKED

本轮未实现逐 Topic 描述符/部分成功恢复；现有 Legacy 行为保留，Unified 阻断。

### C. Mercy 宿主接线 — BLOCKED

PR-09 批次协议与合成 E2E 已存在；真实宿主 Preview/Confirm/Apply/Undo 入口尚未接线。

## 2. 入口矩阵

| 入口 | Legacy | Unified | 状态 |
|---|---|---|---|
| newSource | 原样 | 阻断 | 创建模块就绪，宿主未接 |
| _createExtract / createTimestampExtract | 原样 | 阻断 | 同上 |
| postponeSubtree | 原样 | 阻断 | BLOCKED |
| Mercy Apply/Undo 宿主 | 原样 | 阻断 | BLOCKED |
| onload 生命周期 | 不受影响 | locked | 已接入（合成验证） |
| resetCurrent | 原样 | 显式阻断 | 保持 |
| SR Card | SR 独立 | 不适用 | 已由 PR-11 证明 |

## 3. 测试与构建

```
test/mf-us-1-entry-closure.test.js   7 pass
test/mf-us-1-*.test.js             727 pass
test/*.test.js                    1122 pass
validate-release                  valid
build --dry-run                   no files written
```

## 4. 剩余生产门禁

1. 创建宿主接线：newSource/_createExtract/createTimestampExtract 调用统一创建模块并处理文件与账本分别失败。
2. postponeSubtree 逐 Topic 事件、部分成功与恢复。
3. Mercy 宿主 Preview/Confirm/Apply/Undo 与未决批次识别。
4. 真实 onload 实机验证、真实账本持久化/恢复。
5. 真实 CAS/崩溃验收与生产 Unified 授权。

## 5. 安全边界

仅 Mock/Fake；未访问真实 Vault、`MemoFlow-Test`、`phase2 test`、Obsidian、SR；未写真实数据；未启用 Unified；Phase 1 未触碰。
