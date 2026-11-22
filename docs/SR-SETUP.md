# Spaced Repetition 接入说明

MemoFlow 不自己实现 FSRS/复习界面；卡片评分与下次复习日期由
[Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)（SR）负责。
MemoFlow 只负责从摘录制卡、打开 SR 复习、把卡片放回今日学习流。

## 版本

- 固定验证版本：`1.15.4`
- Min app：`1.2.8`
- 桌面 / 移动：`isDesktopOnly: false`
- 插件 ID：`obsidian-spaced-repetition`

## 测试 Vault 安装

测试 Vault 已经安装了 SR。若换机器或重建测试 Vault：

1. 从 SR 的 GitHub Release `1.15.4` 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放到：
   ```
   MemoFlow-Test/.obsidian/plugins/obsidian-spaced-repetition/
   ```
3. 在 `MemoFlow-Test/.obsidian/community-plugins.json` 中同时保留：
   ```json
   ["memoflow", "obsidian-spaced-repetition"]
   ```
4. 打开测试 Vault，在第三方插件里确认两者都启用。
5. MemoFlow 设置 → 环境状态应显示“Spaced Repetition 已就绪”。

`scripts/seed-test-vault.mjs` 会保留已存在的 SR 插件目录，并自动把它写回
`community-plugins.json`；它不会下载或覆盖 SR 版本。

## 真实 Vault 安装

默认**不要**在 `supermemo` 真实库直接试。确认要装时：

1. 备份 `<vault>/.obsidian/plugins/` 与卡片笔记；
2. 在 Obsidian 社区插件市场搜索 **Spaced Repetition**，安装并启用；
3. 在 SR 设置里确认 flashcard tag。MemoFlow 默认使用：
   ```
   flashcards/incremental-reading
   ```
   如果 SR 没有把它识别成 deck，把该 tag 加到 SR 的 flashcard tags；
4. 打开 MemoFlow 设置 → 运行环境检查；
5. 先在测试 Vault 复习一张卡，再回真实库使用。

## Deck / tag 行为

- MemoFlow 生成的卡片带：
  ```yaml
  tags:
    - incremental-reading
    - ir/card
    - flashcards/incremental-reading
  ```
- SR 把 `flashcards/incremental-reading` 识别为 deck；实际 deck 名可能显示为
  `incremental-reading`，这是 SR 的层级显示，不是 MemoFlow 漏写 tag。
- 卡片正文使用 SR 格式：
  - basic：`问题 ? 答案`（分隔符可在 MemoFlow / SR 设置里调整）
  - cloze：`用 ==关键词== 标出`。
- SR 评分后会在卡片正文写：
  ```html
  <!--SR:!2026-11-25,3,250-->
  ```
  MemoFlow 不解析、不改写这条注释。

## 回滚

- 停用 SR：卡片恢复成普通 Markdown 笔记；MemoFlow 的卡片统计显示“需 SR”，
  制卡仍可创建但无法复习。
- 删除 SR 插件目录：不会删除卡片笔记；SR 的 `data.json` 删除后复习历史丢失，
  请先备份。
- MemoFlow 本身不保存 SR 的调度数据。

## 统一学习外壳与 SR 内部接口

统一学习外壳为了在同一个页面里完成卡片评分，会临时打开 SR 的 per-note 复习会话，隐藏其弹窗，然后调用 SR 的 `contentManager._processReview()`。这是对 SR `1.15.4` 内部的桥接：

- 已验证 SR 1.15.4；
- SR 大版本升级后如果 `contentManager`/`_processReview` 改名，外壳会降级为「打开原笔记 / 用复习此卡」；
- 没有复制 SR 的 FSRS 算法，也没有改写 SR 数据格式。

## 已知边界

- MemoFlow 不做留存率/正确率统计；SR 没有向外部提供评分历史 API。
- 「卡片复习」外壳只列到期卡片，并在内部调用 SR 评分；卡片阅读条「复习此卡」仍直接打开当前卡的 SR 复习。两者都不复制调度逻辑。
- 测试 Vault 未安装 SR 的旧版本仍能打开总览；只是卡片不可复习。
