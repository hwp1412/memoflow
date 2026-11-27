# MemoFlow 1.0 — 产品体验简化报告（调度算法 + 版本更新）

分支：`feat/ux-simple-mode`（基于 `personal/main = 460d54f`）
目标：让 MemoFlow 像普通 Obsidian 插件一样工作，不再每天操作安全授权流程。

## 1. 调度算法

- 全新 Vault 默认 **Unified**：`DEFAULT_SETTINGS.mf_us1_mode = 'unified'`（已有用户持久化的选择保持不变）。
- 启动自动接线：`onLayoutReady` → `_mfUs1AutoStartRuntime()` 自动初始化运行时与调度能力，**不再弹确认/授权**；仍完整执行既有数据完整性检查（Topic 身份、parent/root、Ledger、Batch、Recovery、CAS、索引完整性）。
- 设置页「调度算法」下拉：新版 Unified（推荐）/ 旧版 Legacy / Shadow（高级诊断）；选择立即生效并持久化，重启继续使用。
- 异常 fail-closed：检查不通过时保持当前模式、阻止受影响写入并提示原因，不偷偷切换到另一算法；旧格式 Topic 明确提示不迁移。
- 普通界面移除会话授权/重新批准/撤销按钮与术语；Advanced tools 仅保留「调度算法…」入口与诊断。
- Shadow 保留为高级诊断选项。

## 2. 版本更新

- 真实 `MemoFlowSettingTab`（`src/views/settings-tab.js`）新增「版本更新」区：当前版本、检查按钮、结果状态。
- 通过 GitHub Releases API 获取 `hwp1412/memoflow` 最新稳定 Release（`/releases/latest`，不读取 main 分支 commit）。
- 状态：有可用更新（显示最新 tag + 更新说明 + 打开发布页）/ 已是最新 / 尚无 Release（404）/ 检查失败（网络或解析错误）。
- 仅提示与跳转，不自动安装、不影响笔记或用户设置；正式 Community Plugins 发布继续走官方更新渠道。

## 3. 测试与构建

- 全量 **1471 pass / 0 fail**（本地 + UTC）
- validate-release：valid
- build --dry-run：干净；正式构建成功且不含 E2E 激活命令
- 新增 `test/ux-simple-mode.test.js`（6 项）：默认 Unified、启动自动接线（无弹窗）、重启继续、Legacy 持久化、旧数据阻断不切换、版本检查四种状态与版本比较。

## 4. 未在本轮范围

- 未重写 Scheduler/CAS/Ledger/Batch/Phase 1/SR。
- 未新增授权审批层。
- 未执行真实用户 Vault 迁移；旧库迁移适配器仍不在范围内。
- GitHub 一键安装未实施（自用分发场景留待决定；官方渠道遵守 Obsidian 规则）。

## 5. 文件

- `main.js`：默认 Unified、启动自动接线、`setSchedulerMode`、`checkForUpdates`、菜单简化。
- `src/views/settings-tab.js`：调度算法选择器 + 版本更新检查。
- `test/ux-simple-mode.test.js`：新增回归。
- 既有测试按新语义更新（默认模式、模式菜单不再要求确认）。
