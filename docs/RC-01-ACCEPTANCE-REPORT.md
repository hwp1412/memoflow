# MemoFlow 1.0 — RC-01 验收报告

前提：最终 MF-US-1 整合 PR 已合入 `personal/main = cb2efa3`（PR #43，`b8f573e` 在主线）。

## 0. 发布资料修正后状态：**Ready for Release（资料阻塞已解除，待实际打 tag/Release）**

已于 RC 修复分支完成：manifest 版本 1.0.0、versions.json 映射、CHANGELOG 1.0.0、README 安装/升级与旧库限制、RELEASING.md 重写。以下为修正前结论，保留审计记录。

## 1. 修正前结论：Blocked（仅发布资料阻塞，未发现日常使用阻塞缺陷）

产品行为本身已通过本轮验证；阻塞项全部在发布元数据/文档/Release 产物对应关系，不属于调度或数据安全缺陷。

## 2. 产品要求验证

| 项目 | 结果 | 依据 |
|---|---|---|
| 设置页算法选择器唯一选项 MF-US-1 | **Pass** | 源码/正式构建：仅 `MF-US-1（当前唯一算法）`，无 legacy 选项 |
| 全新安装默认 MF-US-1 | **Pass** | `DEFAULT_SETTINGS.mf_us1_mode='unified'`；正式构建启动实测 |
| 启动/重启自动运行、无需人工激活 | **Pass** | 正式构建两次启动 `authorized=true`，无授权弹窗 |
| 正式操作不调用 Legacy/Shadow Writer | **Pass** | 正式构建无 `mode:'legacy'` 构建、无 legacy 选项；策略强制 MF-US-1 |
| Card/SR 独立 | **Pass** | Card 无 `mf_*`，不进入 Unified 计数/写入（此前正式构建 SR 复习已 Pass） |
| 正式构建无测试专用命令 | **Pass** | 运行时命令注册与产物扫描：E2E 命令 0 |

## 3. 真实 Obsidian 工作流（正式构建，一次性测试 Vault）

| 步骤 | 结果 |
|---|---|
| 安装插件/启用/打开设置 | **Pass**（正式构建加载，设置页正常） |
| 自动 Unified 启动（首次/重启） | **Pass**（`authorized=true`，无弹窗） |
| 创建 Source、创建多级 Extract | **Pass**（gateway 创建 Extract `status=applied`，mf_id/parent/root 正确） |
| 阅读评阅 | **Pass**（首次 `status=applied`，Revision 0→1；重启后再次评阅 `applied`，Revision 1→2） |
| Postpone / Priority | **Pass（沿用此前正式构建证据）**；本轮脚本对刚创建且 metadata 尚未就绪的 Extract 操作被安全拒绝（"只能对来源或摘录执行该操作"），属脚本时序问题，未定为产品缺陷 |
| Complete / Reactivate | **Not Tested（本轮）**；此前 P3/P4 测试构建覆盖，正式构建本轮未重复点击 |
| Boost / Mercy+Undo / Subtree | **Pass（沿用此前正式构建验收证据）**，本轮按要求不重复执行 |
| 关闭并重启后继续评阅 | **Pass**（自动接线 + Revision 递增） |
| Card/SR 真实复习 | **Pass（P3-03 正式构建 + SR 1.15.4 证据）**；本轮仅验证 Card 隔离 |

## 4. UI 数据对账

| 项目 | 结果 |
|---|---|
| Queue 条目/日期/排序 | **Not Tested**：`buildSessionQueue` 无返回值；Queue 视图 DOM 抓到 "Reading queue: Timeline: S"（条目存在），但未逐项核对日期与排序 |
| Dashboard Topic 数量 | **Pass**：真实 Markdown Topic 数 = 2，诊断 `topicCount` = 2 |
| Dashboard Card 统计 | **Not Tested**：`_spacedRepetitionCardFiles()` 在测试库返回 null（SR 插件未装），未与 Dashboard 数字对账 |
| Session 当前条目/完成状态 | **Not Tested（本轮）** |
| 设置页显示 MF-US-1 | **Pass** |
| 移动端/窄屏 | **Not Tested**（当前环境无法可靠调整窗口宽度；RC 步骤：375px 下检查设置/队列/树/Dashboard 的横向滚动与按钮） |

## 5. GitHub 版本更新

- 正式构建实际点击「检查更新」→ 真实请求 GitHub API，返回 **HTTP 403**（未认证限流）；UI 显示"检查失败"。
- 已补充 **「打开发布页」按钮**（403/网络失败时也可直接打开 `https://github.com/hwp1412/memoflow/releases`），无需 Token/登录。
- 当前版本/最新版本/更新说明/跳转：成功路径仍为 **Not Tested**（受限流影响）；逻辑有单元测试覆盖四种状态。

## 6. 发布准备检查（阻塞项）

| 检查 | 结果 |
|---|---|
| `dist/memoflow/manifest.json` 版本 | ✅ Fixed：`plugin/manifest.json` 升为 **1.0.0**，`versions.json` 增加 1.0.0 映射；正式构建重新生成 |
| 发布文件集合 | **Pass**：`main.js`、`manifest.json`、`styles.css` 齐全 |
| README / 安装说明 / 更新说明 | ✅ Fixed：README 改为 1.0.0 发布版，新增「安装」「升级与旧 Vault」说明 |
| GitHub Release 版本与产物对应 | ✅ Fixed：`RELEASING.md` 重写为 MemoFlow 1.0 流程（版本一致、三产物、tag=1.0.0、Release 说明含限制）；实际 tag/Release 仍由项目负责人执行 |
| 旧格式 Vault 不支持无缝升级的限制 | ✅ Fixed：README「升级与旧 Vault」与 CHANGELOG Known limitations 明确说明 |
| 正式构建无测试命令 | **Pass** |
| 全量测试 / UTC / validate / build | **Pass**：1368 tests（本地+UTC）、validate valid、build --dry-run 干净、正式构建成功 |

## 7. 仅列真正影响发布的问题

1. **版本号未对齐**：发布 manifest 需改为 1.0.0（并同步 `versions.json`/tag/Release 说明）。
2. **README/安装与升级说明**未面向发布更新，"个人自用不发布"与"v0.1.0"会误导用户。
3. **GitHub Release 产物与 tag 对应关系**未建立；`RELEASING.md` 未更新为 MemoFlow 流程。
4. **旧库升级限制**未在用户可见文档中说明。
5. UI 对账三项 Not Tested（Queue 排序、Dashboard Card 统计、Session 状态），需 RC 人工点击验收；不构成代码阻塞。

## 8. 验收命令

```
全量测试     1368 pass / 0 fail
UTC 回归     1368 pass / 0 fail
validate     valid
build        dry-run 干净；正式构建成功
```
