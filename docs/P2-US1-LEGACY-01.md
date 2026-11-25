# P2-US1-LEGACY-01 — Legacy Read-only Adapter, Stable Identity & Source Relations

- 任务 ID：`P2-US1-LEGACY-01`
- 状态：本地实现 + 自测完成，待项目所有者验收（未建 PR、未合并）
- 基线：`main @ 044eda8`（PR #19 合并后）
- 分支：`feat/phase2-mf-us-1-legacy-adapter`
- 本地 commit：见本次验收报告
- 规范：`docs/MF-US-1-SPEC.md` v1.0.0-draft（A2、A8、A10.2、A13）

## 1. 范围与非范围

**范围**：旧元数据快照的只读标准化、严格日期解析、稳定/临时身份、父子与根关系解析、逐项异常隔离。

**非范围**：迁移执行、写回 `mf_id`、持久化、Shadow/Unified、UI、真实 Vault 扫描、Obsidian 启动。所有结果 `writesPerformed: false`。

## 2. 旧字段与历史状态静态审计

只读审计当前 main（`044eda8`），证据如下：

| 字段 / 状态 | 源码位置与读写方 | 已确认语义 | 可否无损映射 | 歧义 / 风险 | 安全动作 |
|---|---|---|---|---|---|
| `type: source` | `main.js:5042` 创建、`isActiveIR` `main.js:503` | 阅读来源 | 是 | 无 | 映射 source |
| `type: extract` | `src/data/extract.js:75`、`src/main.js:1356` | 摘录 | 是 | 无 | 映射 extract |
| `type: card` | `status-core.js`、SR 桥接 | SR 记忆卡 | 否 | 卡片语义独立 | `unsupported`，不进入 Topic 队列 |
| `status: active` | 创建 `main.js:5042` | 正常可调度 | 是 | 无 | 映射 active |
| `status: done` | `status-core.js:33` `completeItemFrontmatter` | 完成 | 是 | 无 | 映射 done |
| `status: dismissed` | `main.js:4283` `dismiss()` | 主动移出 | 是 | 无 | 映射 dismissed |
| `status: inbox` | `main.js:5042` 创建时“Hold in inbox” | **未文档化** | 否 | 是否为“未开始/暂停”未知 | `unsupported`，不猜 |
| `status: pending` | `extract.js:78` 新建摘录默认 | **未文档化** | 否 | 与 active 的差异未确认 | `unsupported`，不猜 |
| `status: container` | `main.js:5470` split 后容器 | **未文档化** | 否 | 容器节点语义未定义 | `unsupported`，不猜 |
| `priority` | 创建 `main.js:4991`、`_gradeTopic` `main.js:3790` | 1–100，越小越重要 | 是（合法值） | 非法值不得回退 50 | 缺失/非法 → `invalid` |
| `interval` | 创建 `main.js:4991`、`_gradeTopic` `main.js:3819`、postpone `main.js:4302`、schedule `main.js:4330`、Mercy `main.js:4490` | 名义“下次间隔”，但**行政操作也会写入** | 部分 | 旧 Mercy/POSTPONE 已污染，无法反推真实学习间隔 | 原样映射 + `LEGACY_INTERVAL_MAY_INCLUDE_ADMINISTRATIVE_VALUE` |
| `a_factor` | 创建 `main.js:5044`（progress-aware）、clamp `main.js:545`（1.05–5.0） | 旧范围含 1.05 与 5.0，超出 MF-US-1 的 1.10–3.00 | 部分 | 越界值不可静默钳制 | 越界 → `invalid`（`E_LEGACY_AFACTOR_INVALID`） |
| `review_count` | `main.js:3815`、`extract.js:83` | 评阅次数 | 是 | 缺失不可默认 | 缺失/非法 → `invalid` |
| `next_review` | 创建与 `_gradeTopic`、postpone/schedule/Mercy | 旧到期日，格式依赖 Vault 设置 | 是（合法且格式已知） | 多格式回退会产生歧义 | 严格按配置格式解析；无格式 → `ambiguous` |
| `last_reviewed` | `_gradeTopic` `main.js:3854` | 最后评阅日 | 是 | 空串合法（新建） | 空 → null；非法 → `invalid` |
| `date_added` | `extract.js:85` | 创建日期，仅影响排序 | 是（可选） | 损坏不影响主字段 | 警告 + 视为缺失 |
| `parent` | `src/main.js:1328`、`extract.js:77` | 直接父节点（Phase 1） | 是（快照内） | 同名多笔记歧义 | 解析失败 → orphan/ambiguous |
| `source` | `extract.js:76`、`src/main.js:1362` | 创建时根 Source | 是（快照内） | 旧数据可能同时缺 parent/source | 回退链 parent → source |
| `tree_root` | `tree-core.js:19` | 显式根标记 | 是 | 与 parent 冲突时以 tree_root 为准 | 视为根 |
| `mf_id` / `mf_*` | 仅规范文档；代码中不存在 | 新字段 | 视情况 | 混合数据需冲突检测 | 新旧同时存在时逐项比较 |

**结论**：`inbox`、`pending`、`container` 在源码中确有写入，但没有可证明的统一语义，因此一律 `unsupported`，不默认 active/done。

## 3. 日期解析契约

- 调用方必须显式传入 `context.dateFormat`（`DD-MM-YYYY` / `MM-DD-YYYY` / `YYYY-MM-DD`，为歧义测试另支持 `DD/MM/YYYY` / `MM/DD/YYYY`）。
- 严格按该格式匹配，再用已验收的日历模块校验真实日期（闰年、月末）。
- 未提供格式且存在日期 → `ambiguous`（`E_LEGACY_DATE_FORMAT_REQUIRED`），不猜测。
- 格式不符 → `E_DATE_FORMAT`；日期不存在（`31-04-2026`、`29-02-2027`）→ `E_DATE_INVALID`。
- 输出统一为 `YYYY-MM-DD`；不做时区转换、不做宽松解析、不补全缺失部分。
- 旧 `next_review` 只作为候选 `mf_ideal_due`，绝不重新计算。

## 4. 字段映射（只读候选）

| 规范 A10.2 | 实现 |
|---|---|
| `next_review` → `mf_ideal_due` | 严格解析后写入候选；`mf_not_before = null` + `NOT_BEFORE_NOT_RECOVERABLE` |
| `interval` → `mf_interval_days` | 原样保留；`review_count=0` 时**不**重新调用首次间隔算法 |
| `a_factor` | 原样保留（必须落在 1.10–3.00，否则 invalid） |
| `review_count` | 原样保留 |
| `last_reviewed` | 原样保留（空 → null） |
| `priority` | 原样保留（1–100） |
| 旧 status | 仅 active/done/dismissed 映射；其余 unsupported |
| `source`/`parent` | 见 §6 关系解析 |

新旧字段同时存在时：分别校验；数值不一致 → `conflict`（如 `mf_ideal_due` vs `next_review`、`mf_interval_days` vs `interval`）；一致则正常；**不静默覆盖**。

## 5. 稳定身份与临时身份（Q8 预案）

| 情况 | 结果 |
|---|---|
| 合法 `mf_id`（UUID） | `persistent`，`renameStable = true` |
| `mf_id` 非法 | `invalid`（`E_ID_FORMAT`），不替换 |
| 无 `mf_id`、有快照路径 | `temp-<fnv1a(path)>`，`temporary`，`renameStable = false` |
| 无路径、有标题 | `temp-<fnv1a(title)>` + 警告 |
| 都没有 | `E_LEGACY_ID_UNAVAILABLE`，`invalid` |

- 临时 ID **永不**是 UUID 格式，也永不写回；
- 批量内重复 ID（持久或临时）→ 每个出现都 `conflict / E_DUPLICATE_ID`；UUID 比较键统一小写，大小写差异不会漏判（不改写原始值）；
- 同一路径的两条快照会得到相同临时 ID → 被识别为冲突；
- 读取前后原始对象逐字节不变。

**Q8 建议（未执行）**：采用“UUIDv4 在受控迁移中生成并写入 Frontmatter + 备份清单”的方案；路径哈希方案在重命名后失效，不建议作为永久 ID。迁移预览/备份/回滚属 PR-08。

## 6. 父子与根关系

- 解析顺序：`tree_root: true` → 根；否则 `parent` 链接，缺失时回退 `source`（与 `tree-core.effectiveParent` 一致）。
- 链接匹配只在**当前快照**内进行：含 `/` 按路径匹配，否则按 basename；同名多条 → `ambiguous`（列出候选）；无匹配 → `orphan`。
- 自引用 → `E_RELATION_SELF`；环 → `E_RELATION_CYCLE`（链上所有节点标记）。
- `depth` / `rootId` 沿父链计算；`mf_parent_id` 只在**直接父节点**是持久 UUID 时填写，`mf_root_id` 只在**整条祖先链**都是持久 UUID 时填写，否则为 null + `RELATION_NOT_PERSISTENT`；临时祖先或未解析祖先会沿链传播（orphan/ambiguous/duplicate/cycle）。
- 同一规范化路径的多条记录全部保留，引用该路径即 `ambiguous`（列出候选），不取第一条；重复 ID 不进入关系绑定。
- 原始 `mf_parent_id` / `mf_root_id` / `mf_last_event_id` 分别校验 UUID 格式；现代关系与旧 parent/source 推导逐一比较，一致才 `verified`，不一致 `conflict`，仅有现代关系时 `MODERN_RELATION_UNVERIFIED`（保留现代值但不声称已验证）。
- 子节点解析**不修改**父节点任何字段（测试用快照比对）。
- 临时 ID 关系明确标注为非持久；重命名后需要重新解析。

## 7. 分类与隔离

`ready` / `read-only-limited` / `unsupported` / `invalid` / `conflict` / `ambiguous` 六类；单项异常不影响其他条目。批量摘要给出各类计数，`writesPerformed: false`。

## 7.1 架构审查安全修复（本轮）

| 修复 | 内容 | 回归测试 |
|---|---|---|
| 祖先链持久性 | 沿完整链判定；三层/五层混合临时/持久身份，`mf_root_id` 不泄漏临时 ID；未解析祖先沿链传播 | 3 项 |
| 路径/重复身份 | 路径索引保留全部候选；重复 UUID（含大小写差异）、重复路径、重复临时 ID 不绑定关系；乱序一致 | 6 项 |
| 现代字段 | `mf_parent_id`/`mf_root_id`/`mf_last_event_id` 校验与保留；新旧关系一致/冲突/仅现代/非法 UUID；revision/version 标记 provisional | 5 项 |
| 可调度门禁 | 仅 ready + 持久唯一身份 + source/extract + active + 必要字段合法 + 无未解决冲突 | 2 项 |

## 8. 测试证据

```
node --test test/mf-us-1-legacy-adapter.test.js test/mf-us-1-legacy-identity.test.js test/mf-us-1-legacy-relations.test.js
  tests 54  pass 54  fail 0
```

覆盖：合法 Source/Extract；`review_count=0` 保留 interval；优先级缺失/非法；A-Factor 缺失/越界；日期格式（ISO/DD-MM/MM-DD/斜杠）、歧义、闰年、跨年、非法日期；新旧字段冲突与一致；`mf_not_before` 信息损失；`estimated_minutes` 校验；卡片与历史状态；UUID 合法/非法；临时 ID 确定性/重命名/碰撞；五级链、orphan、ambiguous、cycle、self、tree_root、done 父节点、临时关系、乱序一致、输入不可变。

**T17**：纯对象层证明“创建/解析子节点不改父节点”，仍为 `PARTIAL`（真实创建属 PR-06 之后的集成阶段）。
**T20**：只证明快照内重命名不改变持久 ID 与关系，真实重命名/路径解析未执行，仍为 `TODO`。

## 9. 风险与待裁决

| ID | 问题 | 当前处理 |
|---|---|---|
| Q26 | `inbox`/`pending`/`container` 的最终语义 | `unsupported`，不进入队列 |
| Q27 | 旧 `interval` 已被行政操作污染，迁移时如何标注 | 只读层标注不确定；PR-08 需逐项预览并接受不可恢复 |
| Q28 | 根 Source 的 `mf_root_id` 应为自己还是 null | 适配器在持久 ID 下填自身 id |
| Q8 | 永久 UUID 分配策略 | 建议受控迁移生成 UUIDv4 + 备份，PR-08 执行 |

## 10. 未完成

真实 Vault 读取、Frontmatter 写入、UUID 持久化、迁移预览/回滚、Shadow/Unified、UI、SR 边界与实机验收均未进行。
