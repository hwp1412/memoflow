# MemoFlow 个人速查

作者：三斤的多多 / DeepSeek  
定位：个人自用，不发布。

## 每天开始

1. 总览 →「开始今日学习」。
2. PDF 来源用 Obsidian 原生 PDF 打开；笔记来源用阅读条。
3. 读完一段 →「完成阅读」→ 输入页码/质量 → 下一项。

## PDF 摘录

1. 在 PDF 中选中文字并复制。
2. 点 PDF 顶部「剪贴摘录」。
3. 后台生成摘录，然后选择：
   - 留在当前：继续读 PDF；
   - 在新标签页打开：检查/编辑摘录。
4. 页码优先级：`#page=` 链接 > 当前 PDF 页 > `read_point`。
5. 新摘录正文不含黄色 callout；旧 `[!PDF]` callout 会被全局 CSS 中性化。

## 制卡与复习

- 摘录阅读条 →「制卡」→ 基础问答 / 双向问答 / Cloze C1/C2/C3。
- 图片卡、图片遮挡在制卡弹窗底部「更多卡片类型」进入上游编辑器。
- 卡片复习：总览 →「卡片复习」；只复习到期卡片。
- 卡片调度、评分、间隔由 Spaced Repetition 负责。

## SR 出问题时

- 先确认 Spaced Repetition 已启用，版本仍为 `1.15.4`。
- 卡片复习页打不开时，点「打开原笔记」或卡片阅读条「复习此卡」。
- 重载 Obsidian 后再试；不要把 SR 大版本升级当作无风险操作。

## 备份

个人使用至少保留：

- 整个 Vault 的 Git/Time Machine 备份；
- `.obsidian/plugins/memoflow/data.json`；
- 关键来源/摘录/卡片笔记本身。

不要只备份插件文件，frontmatter 才是真正的学习数据。

## 不做的范围

- 不发布到社区；
- 不追英文 UI/公开 API；
- 不为 Highlighter 做私有绑定适配；
- 不把 MemoFlow 当作 PDF++/Annotator 的替代品。
