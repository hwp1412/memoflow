# MemoFlow 0.1 关键数据写入行为回归测试（M03）

> 目的：用 Obsidian Mock 和内存 Vault 直接执行 0.1 的真实写入方法，固定当前行为，防止后续多级摘录/MF-US-1 开发意外改变旧数据。
> 本任务只新增测试设施、测试和文档；不修改运行时业务代码、调度算法或数据格式。

## 1. 测试目标

覆盖：

- 来源/摘录评阅（`_gradeTopic`）
- 时间戳摘录创建（`createTimestampExtract`）
- 延后（`_postponeReadingFile`）
- Mercy（`spreadOverdue`）
- 完成（`markPathsDone`）
- 重置（`resetPaths`）
- 移出队列（`dismissTreeNode`）
- Review Log 追加成功/失败

每个用例断言实际写入的：

- Frontmatter 字段和值；
- 正文变化；
- Review Log 内容；
- `processFrontMatter` / `vault.process` / `vault.append` 调用次数；
- 取消/非法输入时零写入。

## 2. Harness

新增：

- `test/helpers/obsidian-mock.js`：Obsidian Mock、内存 Vault、自动 Modal 响应、插件实例化。
- `test/memoflow-write-regression.test.js`：24 项特征化测试。

关键设计：

1. `Module._load` 拦截 `obsidian`，加载 `src/main.js`；不调用 `onload()`。
2. Mock `Modal` 自动响应内部 `TextPromptModal` / `ConfirmModal` / `GenericSuggestModal`，不修改生产代码。
3. 内存 Vault 记录 `processFrontMatter`、`process`、`append`、`create` 的实际调用和结果。
4. `withFrozenDate` 固定到 `2026-11-24T12:00`，所有日期可精确断言；测试结束恢复原 `Date`、原 `window`/`setTimeout`，无 window 时删除该全局。
5. 设置 fixture 复制默认值；测试不读取 `MemoFlow-Test`，不打开 Obsidian。

## 3. 测试清单

| 分组 | 用例 |
|---|---|
| 评阅 | 首次 Source、再次 Source、停滞保护、质量 Speed up、取消页码、非法页码、pending→active、评阅到最后一页完成 |
| Markdown 标记 | 拒绝更新并取消质量；更新正文后取消质量（body 已写入） |
| Extract | `stall_guard=true` 不增长；`stall_guard=false` 增长 |
| 摘录 | 时间戳摘录字段、来源链接、父来源 priority/A-Factor 变更 |
| 延后 | `next_review` 与 `interval=days` |
| Mercy | 3 个逾期主题的 offset/interval/日期，非逾期不受影响 |
| 完成 | Source done 字段清理；Card deck tag 移除 |
| 重置 | Source 调度清理；Card tags 恢复、`<!--SR:-->` 清除 |
| 移出 | Source status=dismissed；Card 被拒绝 |
| 日志 | 成功追加一行；追加失败不回收 Frontmatter 写入，记录 console.error |

## 4. 0.1 当前行为（Legacy 基线）

以下行为由测试固定，**不代表符合 MF-US-1**：

1. **Markdown 阅读位置先于质量选择**：
   - `_gradeTopic` 在 Markdown 来源中先执行 `vault.process` 更新 `📍`，再等待质量选择。
   - 如果用户更新位置后在质量窗口取消，**正文已经写入**，但 Frontmatter 和 Review Log 未写入。
2. **Extract 默认 stall guard 阻止增长**：
   - 普通 Extract 没有 `read_point`/`read_point_seconds`/`read_point_line`，`stall_guard=true` 时 interval 保持 3，不增长到 6。
   - `stall_guard=false` 时才按 `round(3×A)` 增长到 6。
3. **首次间隔**：`ceil(priority×0.15)`。
4. **后续间隔**：`round(interval×A)` + 进度感知 A-Factor + 质量倍率。
5. **延后**：`next_review=today+days`，`interval=days`。
6. **Mercy**：`interval=max(1, offset)`，第一项 offset=0 时为 1。
7. **创建摘录**：父来源 `priority+1`、`a_factor×1.05`，即使父主题并未被评阅。
8. **完成**：`status=done`，删除 `next_review/interval`，保留 `review_count/a_factor`。
9. **重置**：清空调度历史；卡片恢复 deck tag 并删除 `<!--SR:...-->`。
10. **Review Log 写入失败**：scheduling Frontmatter 已写入，日志追加失败只 `console.error`，不回滚。

这些是后续 Phase 1/2 必须显式处理的 Legacy 风险；M03 只记录，不修复。

## 5. 隔离与安全

- 全部测试使用内存 Vault，不访问 `MemoFlow-Test` 或真实 Vault。
- 不打开 Obsidian、不读剪贴板、不写仓库之外的数据。
- `withFrozenDate` 在测试结束后恢复全局 `Date`。
- 测试失败不会修改任何真实学习数据。

## 6. 运行

```bash
node --test test/memoflow-write-regression.test.js
node --test test/*.test.js
npm run check
```

## 7. 限制

- Mock 不是 Obsidian 运行时；真实 Modal、metadataCache、视图刷新、平台差异仍属未验证。
- 测试固定内部方法名和 0.1 公式；未来行为变更必须显式更新测试并提供迁移/回滚说明。
- 不覆盖 UI、PDF 阅读器、Spaced Repetition 内部实现。
- 不修改运行时业务代码；如果发现必须修改生产逻辑才能测试，停止并报告。
