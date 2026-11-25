# P1-REFINE-SAFETY — Sync Guard

- 基线：`4d6dbec`（PR #23 合并）
- 分支：`feat/p1-refine-safety-sync-guard`
- 范围：最小外部写入防护
- 不修改 schema、不引入 sidecar、不使用 Vault.process

## 1. 防护

- snapshot 记录完整正文、可选 `adapter.stat`；
- `_assertUnchanged` 比较 Editor、磁盘正文和 stat；
- replace/applied 后、save 前再次 `_assertDiskUnchanged`；
- 允许磁盘等于**本次 expected**（Editor autosave）；
- 外部差异 → `DISK_CHANGED`；
- save 后 `_saveAndVerify` 仍验证 expected；
- 失败保留真实 operation/state，不宣称成功。

不把 D2 != D0 当冲突；D2 == expected 也不证明窗口内无外部 D1。

## 2. 限制

- stat/hash 只能检测，不能提供跨进程 CAS；
- 无法保证 Obsidian Sync/第三方同步/外部编辑器；
- 未观察到的 D1 不能通过 D0 preimage 找回；
- 不创建 sidecar，不自动合并。

## 3. 测试

- 外部正文在 save 前变化 → 拒绝；
- 外部 stat 变化、内容相同 → 拒绝；
- 正常 autosave expected 允许；
- save 后不一致 → conflict；
- 多窗口已有测试；
- v1/v2 回归。

全量 **874/874**。

## 4. 回滚

revert 分支；无持久化 schema 变化。
