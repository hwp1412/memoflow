# Community Plugins 提交（备忘）

Agent 无法代提交到 obsidian-releases（需你的 GitHub 账号，且遵循不自行建 PR 的约定）。步骤如下：

1. Fork <https://github.com/obsidianmd/obsidian-releases>
2. 在 `community-plugins.json` 末尾追加：

```json
{
  "id": "memoflow",
  "name": "MemoFlow",
  "author": "三斤的多多",
  "description": "A paper-and-ink incremental reading console with MF-US-1 scheduling and Spaced Repetition.",
  "repo": "hwp1412/memoflow"
}
```

3. 提交 PR（标题如 `Add MemoFlow`），等待官方审核。
4. 要求（已满足/需保持）：公开仓库、Release 提供 `main.js`/`manifest.json`/`styles.css`、`manifest.json` 版本与 tag 一致、无闭源依赖、描述与 README 一致。
5. 通过后插件会由 Obsidian 官方更新渠道分发；此前自用分发继续走 GitHub Releases。
