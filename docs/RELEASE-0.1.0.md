# MemoFlow 0.1.0 个人版

发布日期：2026-11-22  
作者：三斤的多多 / DeepSeek  
定位：个人自用，不发布。

## 已完成

- 每日学习总览、阅读队列、知识树、优先级、A-Factor、Mercy、子集复习；
- 原生 PDF 打开、阅读点、PDF 横向功能栏；
- 剪贴摘录：当前 PDF 页 / `#page=` / `read_point` 页码回退；
- 摘录后询问「留在当前 / 在新标签页打开」；
- 新摘录清理 PDF callout 外壳、纯 `**来源**` 页脚、中性背景；
- 基础问答、Cloze C1/C2/C3、双向问答；图片卡/图片遮挡沿用上游入口；
- 卡片复习与 Spaced Repetition 集成；
- 移出队列/仅标记完成确认；
- 中文界面、个人速查与 smoke checklist；
- 122 项测试通过。

## 已知边界

- 桌面为主；移动端尚未实机验收；
- PDF 高亮不在 MemoFlow 内，视觉高亮可用 Highlighter，摘录走剪贴板；
- 卡片桥接固定验证 Spaced Repetition `1.15.4`；
- 不发布、不做社区目录、不做英文 UI/公开 API；
- 上游根 `manifest.json` 仍是 Incremental Reading Toolkit 1.1.8；MemoFlow 自身版本看 `plugin/manifest.json` 的 0.1.0。

## 验证

```bash
node --test test/*.test.js
node scripts/validate-memoflow.mjs
```

## Git

- 分支：`feature/memoflow-dashboard`
- 标签：`memoflow-v0.1.0`
- 远程 `origin` 仍指向上游 `kja140/incremental-reading`；个人 tag 不要推到上游。
