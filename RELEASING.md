# MemoFlow 发布清单（1.0）

MemoFlow 是独立插件（id `memoflow`）。发布产物只有三个文件：`main.js`、`manifest.json`、`styles.css`。
官方 Community Plugins 渠道遵循 Obsidian 的更新规则；自用分发通过 GitHub Releases 页面手动下载。

## 发布前

1. 版本必须一致：
   - `plugin/manifest.json` → `version`
   - `versions.json` → 新增对应版本映射
   - `CHANGELOG.md` → 顶部新增该版本条目
2. 运行检查：
   ```bash
   node --test test/*.test.js
   TZ=UTC node --test test/*.test.js
   npm run check
   node scripts/validate-release.mjs
   node scripts/build.mjs --dry-run
   node scripts/build.mjs
   ```
3. 确认正式构建（`dist/memoflow/`）：
   - 仅包含 `main.js`、`manifest.json`、`styles.css`；
   - 不含测试专用命令（扫描 `e2e-` 命令 id，应为 0）；
   - `manifest.json` 的版本与准备发布的 tag 一致。
4. 在一次性测试 Vault 中安装正式构建，人工完成 `docs/RC-01-ACCEPTANCE-REPORT.md` 中的 Not Tested 项（Queue 排序、Dashboard Card 统计、Session、窄屏）。

## 创建 Release

1. 合并到默认分支后，从该提交创建与 `manifest.json` 一致的 annotated tag：
   ```bash
   git tag -a 1.0.0 -m "MemoFlow 1.0.0"
   git push origin 1.0.0
   ```
2. GitHub Release 附件上传 `dist/memoflow/` 的三个文件；Release 说明使用 `CHANGELOG.md` 的 1.0.0 条目。
3. Release 说明必须包含「旧格式 Vault 暂不支持无缝迁移」和「移动端仍在校验」两条限制。
4. 不要用 main 分支最新 Commit 冒充正式版本；不要附带测试构建或 E2E 命令。

## 发布后

- 确认 Releases 页面可打开、三文件可下载、版本号与 tag 一致；
- 插件内「检查更新」在 API 正常时应显示已最新；403/网络失败时应能通过「打开发布页」到达 Releases。
