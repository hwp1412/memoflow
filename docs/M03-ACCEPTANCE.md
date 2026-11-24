# MemoFlow M03 验收报告

- 任务 ID / 名称：M03 — MemoFlow 0.1 关键数据写入行为回归测试
- 当前状态：待项目所有者人工验收
- 分支：`test/m03-write-regression`
- 基线 Commit：`8de610b`（M02 合并后的 main）
- 实现 Commit：`344e624`
- Mock 清理修正 Commit：`5a426a4`
- 验收报告 Commit：本文件所在提交（分支 HEAD）
- PR：#5：<https://github.com/hwp1412/memoflow/pull/5>
- 合并状态：**未合并**；未发布；未开始 Phase 1 / MF-US-1

## 1. 本次实现

新增：

- `test/helpers/obsidian-mock.js`：
  - 拦截 `obsidian` 模块并加载 `src/main.js`；
  - 不调用 `onload()`，只构造插件实例并注入测试设置；
  - 内存 Vault，捕获 `processFrontMatter` / `process` / `append` / `create`；
  - Mock Modal 自动响应内部 `TextPromptModal` / `ConfirmModal` / `GenericSuggestModal`；
  - 固定 `2026-11-24T12:00` 的测试时钟；
  - 不访问真实 Vault/Obsidian。
- `test/memoflow-write-regression.test.js`：24 项特征化测试。
- `docs/M03-WRITE-REGRESSION.md`：测试设计、覆盖范围、Legacy 基线。

**未修改**：`src/`、根 `main.js`、`*-core.js`、`plugin/`、`dist/`、`.github/workflows/`、运行时业务代码、调度算法、SR 集成、数据格式。  
**未访问/修改**：`MemoFlow-Test`、真实 Vault、学习历史。

## 2. 实际测试结果

```text
node --test test/memoflow-write-regression.test.js
# tests 24
# pass 24
# fail 0

node --test test/*.test.js
1..196
# tests 196
# pass 196
# fail 0
# cancelled 0
# skipped 0
# todo 0

npm run check
通过（validate-release + 196 tests）
```

M03 覆盖：

| 分组 | 实际覆盖 |
|---|---|
| 评阅 | 首次 Source、再次 Source、停滞保护、质量 Speed up、取消页码、非法页码、pending→active、评阅到最后一页完成 |
| Markdown 标记 | 拒绝位置更新 + 取消质量（零写入）；更新位置 + 取消质量（正文已写） |
| Extract | `stall_guard=true` 间隔保持 3；`stall_guard=false` 增长到 6 |
| 摘录 | 时间戳摘录字段、来源页脚、父来源 priority/A-Factor |
| 延后 | `next_review` +3、`interval=3` |
| Mercy | 3 个逾期主题 offset 0/2/4、interval 1/2/4，未波及非逾期 |
| 完成 | Source done 字段清理；Card deck tag 移除 |
| 重置 | Source 调度清理；Card tags 恢复、SR 注释移除 |
| 移出 | Source dismissed；Card 被拒绝 |
| 日志 | 成功追加 1 行；追加失败时 scheduling 保留、日志不写、console.error |
| Mock 清理 | 无 window 时恢复 Date 并删除 window；已有 window 时恢复 setTimeout；已有 window 无 setTimeout 时删除新增属性；Module._load 恢复 |

完整日志：本地 `/tmp/m03-check.log`（不入库）。

## 3. 实际发现的 0.1 Legacy 行为

本次测试以**实际执行结果**为准，发现/固定以下行为：

1. **Markdown 阅读位置先写正文，再弹质量选择**：
   - `_gradeTopic` 在 Markdown 来源中先执行 `vault.process` 插入/移动 `📍<!--ir-readpoint-->`；
   - 如果用户确认更新位置后在质量窗口取消，**正文已经改变**；
   - Frontmatter 未写入，Review Log 未追加；
   - 测试 `Markdown marker is written before quality cancellation (0.1 legacy behavior)` 通过，证明这是当前真实行为。
2. **Extract 默认无法增长间隔**：
   - 普通 Extract 没有阅读进度字段；
   - `stall_guard=true`（默认）时再次评阅，interval **保持 3**，不增长到 6；
   - `stall_guard=false` 时才增长到 6；
   - 这是后续调度改造需要明确处理的问题，M03 不修复。
3. **延后覆盖真实 interval**：`_postponeReadingFile` 写入 `interval=days`。
4. **Mercy 覆盖 interval**：`interval=max(1, offset)`，第一项 offset=0 时为 1。
5. **创建摘录隐式修改父来源**：父 `priority+1`、`a_factor×1.05`，分两次 Frontmatter 写入。
6. **完成删除 `next_review/interval`**，保留 `review_count/a_factor`。
7. **重置清空调度历史**，Card 额外删除 `<!--SR:...-->` 并恢复 deck tag。
8. **Review Log 追加失败不回滚**：调度 Frontmatter 已写入，日志追加失败只 `console.error`。
9. 首次评阅 Source P50 的 interval 为 8（`ceil(50×0.15)`）。
10. `pending` Source 评阅后变 `active`。

以上均为 0.1 特征化基线；**M03 没有修复任何一项**。

## 4. 保留的旧行为验证方式

- 每个用例通过真实插件方法执行，而不是源码文本匹配。
- 断言对象包括：
  - Frontmatter 字段值；
  - 正文变化（Markdown 标记、SR 注释）；
  - Review Log 内容；
  - `processFrontMatter` / `process` / `append` 调用次数；
  - 取消/非法输入时零写入。
- 测试固定日期为 `2026-11-24`，不依赖系统当前日期。

## 5. 未验证 / 限制

- Mock 不是 Obsidian 运行时；真实 Modal 焦点、metadataCache 刷新、视图行为、平台差异仍属未验证。
- 未打开 Obsidian，未做真实测试库手工操作。
- 未覆盖移动端/Windows。
- CI 尚未运行；PR 创建后需核对 `npm ci` 与 `npm run check`。
- 测试固定内部方法名和 0.1 公式；未来行为变更必须显式更新测试。

## 6. 数据风险与回滚

- 本任务全部使用内存 Mock；没有真实 Vault 写入。
- `MemoFlow-Test` 未被访问或修改。
- 无运行时/数据格式变更。
- 若需回滚：删除分支/PR，或 `git revert 344e624`；无需恢复 Vault。
- 若测试临时文件残留，手动清理 `os.tmpdir()` 下对应目录；M03 默认不产生。

## 7. 用户人工验收

1. 运行：
   ```bash
   node --test test/memoflow-write-regression.test.js
   node --test test/*.test.js
   npm run check
   ```
2. 查看测试名与断言，重点核对：
   - 取消页码/质量时零写入；
   - Markdown 位置更新后取消质量时正文已写入；
   - Extract `stall_guard=true/false` 的 3/6 天差异；
   - Review Log 追加失败时 scheduling 保留。
3. 对照 `docs/M03-WRITE-REGRESSION.md` 的 Legacy 基线，确认与 0.1 实际行为一致。
4. 无需打开 Obsidian；本任务不要求实机验收。

## 8. PR / CI

- 分支：`test/m03-write-regression`
- 实现提交：`344e624`
- Mock 清理修正提交：`5a426a4`
- 报告提交：本文件所在提交
- PR：#5：<https://github.com/hwp1412/memoflow/pull/5>
- GitHub Actions：**通过**。Run `45403998409`，job `138479713083`：
  - `Run npm ci` success；
  - `Run npm run check` success；
  - 其他步骤 success。
- 链接：<https://github.com/hwp1412/memoflow/actions/runs/45403998409>
- 未合并、未发布、未进入 Phase 1。

## 9. Mock 全局状态清理修正

根据审查意见补充：

- `withFrozenDate()` 现在完整保存/恢复：
  - 测试前的 `Date`；
  - 原有的 `window`；
  - 原有的 `window.setTimeout`（若原本存在则恢复，若原本不存在则删除新增属性）。
- 如果测试前不存在 `window`，测试结束后删除该全局对象。
- `Module._load` 的 `try/finally` 恢复机制保持，并新增测试验证加载后等于原函数。
- 新增 3 项清理测试：
  - 无 window → 恢复 Date 并删除 window；
  - 已有 window + setTimeout → 恢复原 setTimeout；
  - 已有 window 但无 setTimeout → 删除新增的 setTimeout。
- M03 测试从 20 项增加到 24 项；全量测试 196 项全部通过；`npm run check` 通过。

## 10. 建议下一任务

**M03 范围内：无。** 等待人工验收与 PR 合并决定。  
在明确批准前不开始 Phase 1、MF-US-1 或其他开发任务。
