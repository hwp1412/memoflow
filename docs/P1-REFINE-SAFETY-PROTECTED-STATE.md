# P1-REFINE-SAFETY — Protected Links / State Diagnostics / P2

- 基线：`4d6dbec`（PR #23 合并）
- 分支：`feat/p1-refine-safety-protected-state`
- 范围：SAFE-P1-04、SAFE-P1-02、必要 P2
- 不含 Sync Guard、reconcile、自动修复、自动清理

## 1. Protected links

`linkRanges` 扩展：

- wiki / embed（含转义）；
- inline Markdown link；
- reference-style link；
- reference definition；
- autolink；
- HTML `href` / `src`。

`structureSignature` 对未闭合 wiki 链接保守拒绝；原有 code/math/table/inline Card/SR/readpoint 保护保留。

相同受保护目标、普通正文变化允许；目标变化拒绝。

## 2. State diagnostics

历史中心只读诊断：

- prepared/applied/failed/conflict；
- verified restore pending 显示“待收尾”；
- missing/corrupt state；
- corrupt operation；
- orphan 旧路径；
- operation ID 和最后状态；
- trust 失败原因；
- 安全下一步提示（备份、不要手改/删除历史）。

不自动 markVerified/markRestored，不自动修复，不写 state。

新增 `listEntriesDetailed`：有效条目仍可只读查看，错误独立报告；严格 `listEntries` 仍用于恢复/计划。

## 3. P2

- 容量统计优先使用 operation/state 文件 `stat.size`，无 stat 时回退读取文件/JSON；
- 同 basename 的旧路径历史显示 orphan 提示，不自动 relink；
- 损坏历史逐条隔离；
- 手动编辑后通过 `trust` 状态禁用恢复按钮；
- 原有浅色/深色/窄窗口样式不变。

## 4. 测试

全量 **878/878**。

新增：

- reference/autolink/HTML href；
- escaped wiki；
- unclosed wiki 歧义；
- pending restore；
- corrupt/orphan/trust 诊断；
- detailed listing 有效条目 + 错误；
- trust/corrupt 按钮禁用。

## 5. 回滚

revert 本分支；不迁移历史，不改变 schema。
