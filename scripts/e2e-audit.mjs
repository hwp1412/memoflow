#!/usr/bin/env node
// Read-only E2E audit for MemoFlow test vaults.
//
// It never writes to the vault. It inspects plugin installation, MF-US-1 topic
// identities/relations, ledger consistency, batch records, Card isolation and
// (optionally) compares the vault against a pre-run baseline snapshot.
//
// Usage:
//   node scripts/e2e-audit.mjs --vault <path> --snapshot out.json
//   node scripts/e2e-audit.mjs --vault <path> --baseline out.json [--allow-changes]
//   node scripts/e2e-audit.mjs --vault <path> --profile empty|memoflow|phase2 --json
//
// Exit code: 0 all pass, 1 any FAIL, 2 invalid arguments.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.smart-env']);
const MD_EXT = '.md';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Tolerant YAML subset parser: top-level `key: value` lines only. Nested
// structures (tags lists, quotes, etc.) are ignored, which is all the audit
// needs.
export function parseFrontmatter(content) {
  if (typeof content !== 'string') return {};
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0] === undefined || lines[0].trim() !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return {};
  const fields = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value === '' || value === 'null' || value === '~') { fields[key] = null; continue; }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^-?\d+$/.test(value)) fields[key] = Number(value);
    else if (value === 'true') fields[key] = true;
    else if (value === 'false') fields[key] = false;
    else fields[key] = value;
  }
  return fields;
}

async function walkMarkdown(dir, root) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...await walkMarkdown(full, root));
    } else if (entry.isFile() && entry.name.endsWith(MD_EXT)) {
      out.push(path.relative(root, full));
    }
  }
  return out;
}

export async function snapshotVault(vaultDir) {
  const files = {};
  const paths = (await walkMarkdown(vaultDir, vaultDir)).sort();
  for (const rel of paths) {
    const content = await readFile(path.join(vaultDir, rel), 'utf8');
    files[rel] = { sha256: sha256(content), bytes: Buffer.byteLength(content) };
  }
  let dataJsonSha = null;
  try {
    dataJsonSha = sha256(await readFile(path.join(vaultDir, '.obsidian', 'plugins', 'memoflow', 'data.json'), 'utf8'));
  } catch { /* optional */ }
  let mainSha = null;
  try {
    mainSha = sha256(await readFile(path.join(vaultDir, '.obsidian', 'plugins', 'memoflow', 'main.js'), 'utf8'));
  } catch { /* optional */ }
  return { createdAt: new Date().toISOString(), vaultDir, files, dataJsonSha, mainSha };
}

function readPluginManifest(vaultDir) {
  return readFile(path.join(vaultDir, '.obsidian', 'plugins', 'memoflow', 'manifest.json'), 'utf8')
    .then(text => JSON.parse(text)).catch(() => null);
}

function readDataJson(vaultDir) {
  return readFile(path.join(vaultDir, '.obsidian', 'plugins', 'memoflow', 'data.json'), 'utf8')
    .then(text => JSON.parse(text)).catch(() => ({}));
}

function check(checks, level, code, message, extra = null) {
  checks.push({ level, code, message, extra });
}

function indexTopics(topics) {
  const byId = new Map();
  for (const topic of topics) {
    const id = topic.fm && topic.fm.mf_id;
    if (!id) continue;
    const key = String(id).toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(topic);
  }
  return byId;
}

export async function auditVault({ vaultDir, profile = 'auto', baseline = null, allowChanges = false, expectedMainSha = null } = {}) {
  const checks = [];
  const manifest = await readPluginManifest(vaultDir);
  if (!manifest) check(checks, 'FAIL', 'PLUGIN_MISSING', '插件 manifest 未找到（.obsidian/plugins/memoflow/manifest.json）');
  else if (manifest.id !== 'memoflow') check(checks, 'FAIL', 'PLUGIN_ID', `插件 id 非 memoflow：${manifest.id}`);
  else check(checks, 'PASS', 'PLUGIN_OK', `插件已安装：${manifest.name || 'MemoFlow'} ${manifest.version || ''}`.trim());

  const files = {};
  for (const rel of await walkMarkdown(vaultDir, vaultDir)) {
    files[rel] = await readFile(path.join(vaultDir, rel), 'utf8');
  }

  const topics = [];
  for (const [rel, content] of Object.entries(files)) {
    const fm = parseFrontmatter(content);
    if (!fm || !['source', 'extract', 'card'].includes(fm.type)) continue;
    topics.push({ path: rel, basename: path.basename(rel, MD_EXT), fm, content });
  }
  const byId = indexTopics(topics);

  let sourceCount = 0;
  let extractCount = 0;
  let cardCount = 0;
  let legacyTopicCount = 0;
  for (const topic of topics) {
    const fm = topic.fm;
    if (fm.type === 'card') {
      cardCount += 1;
      const leaked = Object.keys(fm).filter(key => key.startsWith('mf_'));
      if (leaked.length) check(checks, 'FAIL', 'CARD_MF_FIELDS', `Card 出现 MF-US-1 字段：${topic.basename}（${leaked.join(',')}）`);
      continue;
    }
    sourceCount += fm.type === 'source' ? 1 : 0;
    extractCount += fm.type === 'extract' ? 1 : 0;
    if (!fm.mf_id) {
      legacyTopicCount += 1;
      continue;
    }
    const id = String(fm.mf_id);
    if (!UUID_RE.test(id)) check(checks, 'FAIL', 'MF_ID_INVALID', `mf_id 不是持久 UUID：${topic.basename} (${id})`);
    if (!Number.isInteger(fm.mf_revision) || fm.mf_revision < 0) {
      check(checks, 'FAIL', 'MF_REVISION_MISSING', `mf_revision 缺失/非法：${topic.basename}`);
    }
    if (!Number.isInteger(fm.mf_scheduler_version) || fm.mf_scheduler_version < 1) {
      check(checks, 'FAIL', 'MF_VERSION_MISSING', `mf_scheduler_version 缺失/非法：${topic.basename}`);
    }
  }

  for (const [key, list] of byId) {
    if (list.length > 1) {
      check(checks, 'FAIL', 'DUPLICATE_MF_ID', `mf_id 重复：${key}（${list.map(topic => topic.basename).join('、')}）`);
    }
  }

  // Parent / root relations.
  for (const topic of topics) {
    if (!topic.fm.mf_id) continue;
    const parentId = topic.fm.mf_parent_id;
    if (parentId) {
      const parents = byId.get(String(parentId).toLowerCase());
      if (!parents || !parents.length) {
        check(checks, 'FAIL', 'PARENT_MISSING', `mf_parent_id 指向不存在的 Topic：${topic.basename}`);
      } else if (parents[0].fm.type === 'card') {
        check(checks, 'FAIL', 'PARENT_IS_CARD', `mf_parent_id 指向 Card：${topic.basename}`);
      }
    }
    const rootId = topic.fm.mf_root_id;
    if (rootId) {
      const roots = byId.get(String(rootId).toLowerCase());
      if (!roots || !roots.length) {
        check(checks, 'FAIL', 'ROOT_MISSING', `mf_root_id 指向不存在的 Topic：${topic.basename}`);
      } else {
        const root = roots[0];
        if (root.fm.type !== 'source') {
          check(checks, 'FAIL', 'ROOT_NOT_SOURCE', `mf_root_id 不是 Source：${topic.basename} → ${root.basename}`);
        }
        if (root.fm.mf_parent_id != null) {
          check(checks, 'FAIL', 'ROOT_HAS_PARENT', `根 Topic 仍有 mf_parent_id：${root.basename}`);
        }
        if (root.fm.mf_root_id && String(root.fm.mf_root_id).toLowerCase() !== String(root.fm.mf_id).toLowerCase()) {
          check(checks, 'FAIL', 'ROOT_SELF_MISMATCH', `Source 的 mf_root_id 未指向自身：${root.basename}`);
        }
      }
    }
    if (topic.fm.type === 'extract' && !topic.fm.mf_parent_id) {
      check(checks, 'FAIL', 'EXTRACT_WITHOUT_PARENT', `Extract 缺少 mf_parent_id：${topic.basename}`);
    }
  }

  // Ledger consistency.
  const data = await readDataJson(vaultDir);
  const ledger = data && data.mfUs1Ledger && typeof data.mfUs1Ledger === 'object' ? data.mfUs1Ledger : null;
  if (!ledger) {
    check(checks, 'WARN', 'LEDGER_ABSENT', 'data.json 中无 mfUs1Ledger（尚未有 Unified 事件时正常）');
  } else {
    const records = Object.values(ledger.records || ledger).filter(record => record && typeof record === 'object' && record.eventId);
    for (const record of records) {
      if (record.status !== 'applied') continue;
      const owners = byId.get(String(record.topicId || '').toLowerCase()) || [];
      if (!owners.length) {
        check(checks, 'FAIL', 'LEDGER_ORPHAN', `Ledger applied 记录找不到对应 Topic：${record.eventId}`);
        continue;
      }
      const topic = owners[0];
      const lastEvent = topic.fm.mf_last_event_id;
      if (lastEvent && String(lastEvent).toLowerCase() !== String(record.eventId).toLowerCase()) {
        check(checks, 'WARN', 'LEDGER_LAST_EVENT', `${topic.basename} 的 mf_last_event_id 与 Ledger 记录不同（可能后续还有事件）`);
      }
    }
    check(checks, 'PASS', 'LEDGER_READABLE', `Ledger 可读取：${records.length} 条记录`);
  }

  // Batch records.
  const batches = data && data.mfUs1Batches && typeof data.mfUs1Batches === 'object' ? data.mfUs1Batches : {};
  for (const batch of Object.values(batches)) {
    if (!batch || !batch.batchId) continue;
    if (batch.kind === 'BOOST' && Array.isArray(batch.targets)) {
      if (batch.status === 'applied' && (!Array.isArray(batch.eventIds) || !batch.eventIds.length)) {
        check(checks, 'FAIL', 'BATCH_NO_EVENT_IDS', `已 applied 的 Boost 批次缺少 eventIds：${batch.batchId}`);
      }
      if (batch.status === 'applied') {
        for (const target of batch.targets) {
          const owners = byId.get(String(target.topicId || '').toLowerCase()) || [];
          if (!owners.length) { check(checks, 'FAIL', 'BATCH_TOPIC_MISSING', `Boost 批次 Topic 不存在：${batch.batchId}`); continue; }
          if (Number(owners[0].fm.priority) !== Number(target.to)) {
            check(checks, 'FAIL', 'BATCH_TARGET_MISMATCH', `Boost 批次目标不符：${owners[0].basename} 当前 ${owners[0].fm.priority} ≠ ${target.to}`);
          }
        }
      }
    }
    if (batch.kind === 'MERCY' && Array.isArray(batch.items) && batch.status === 'applied') {
      for (const item of batch.items) {
        const owners = byId.get(String(item.topicId || '').toLowerCase()) || [];
        if (!owners.length) { check(checks, 'FAIL', 'BATCH_TOPIC_MISSING', `Mercy 批次 Topic 不存在：${batch.batchId}`); continue; }
        const current = owners[0].fm.mf_not_before == null ? null : String(owners[0].fm.mf_not_before);
        if (current !== String(item.notBefore)) {
          check(checks, 'FAIL', 'BATCH_TARGET_MISMATCH', `Mercy 批次目标不符：${owners[0].basename} 当前 ${current} ≠ ${item.notBefore}`);
        }
      }
    }
  }
  check(checks, 'PASS', 'TOPICS_SCANNED', `Topic：Source ${sourceCount} / Extract ${extractCount} / Card ${cardCount}；旧格式 Topic ${legacyTopicCount}`);

  const expectsEmpty = profile === 'empty';
  if (expectsEmpty && legacyTopicCount > 0) {
    check(checks, 'FAIL', 'LEGACY_TOPICS_IN_EMPTY_VAULT', `空库 profile 下存在 ${legacyTopicCount} 个旧格式 Topic`);
  }
  if (legacyTopicCount === 0) {
    check(checks, 'PASS', 'MIGRATION_NOT_REQUIRED', '迁移需求：全新库/无旧格式 Topic，activation 应为 migration-not-required');
  } else {
    check(checks, 'WARN', 'MIGRATION_REQUIRED', `存在 ${legacyTopicCount} 个旧格式 Topic：激活需要完成的迁移计划`);
  }

  // Baseline comparison.
  let changes = null;
  if (baseline) {
    const now = await snapshotVault(vaultDir);
    const before = baseline.files || {};
    const after = now.files || {};
    const added = Object.keys(after).filter(rel => !(rel in before));
    const removed = Object.keys(before).filter(rel => !(rel in after));
    const modified = Object.keys(after).filter(rel => rel in before && before[rel].sha256 !== after[rel].sha256);
    changes = {
      added, removed, modified,
      dataJsonChanged: baseline.dataJsonSha !== now.dataJsonSha,
      mainShaChanged: baseline.mainSha !== now.mainSha,
    };
    if (changes.dataJsonChanged) check(checks, 'WARN', 'DATA_JSON_CHANGED', 'data.json 发生变化（设置/账本/批次写入；需确认是否预期）');
    if (changes.mainShaChanged) check(checks, 'FAIL', 'PLUGIN_BUILD_CHANGED', '插件 main.js 在执行期间发生变化');
    const anyChange = added.length || removed.length || modified.length || changes.dataJsonChanged;
    if (anyChange && !allowChanges) {
      check(checks, 'FAIL', 'UNEXPECTED_CHANGES', `Vault 内容与基线不一致：新增 ${added.length} / 修改 ${modified.length} / 删除 ${removed.length}`);
    } else if (anyChange) {
      check(checks, 'WARN', 'CHANGES_ALLOWED', `按 --allow-changes 接受变更：新增 ${added.length} / 修改 ${modified.length} / 删除 ${removed.length}`);
    } else {
      check(checks, 'PASS', 'NO_CHANGES', 'Vault 内容与基线完全一致');
    }
  }

  if (expectedMainSha && baseline && baseline.mainSha && expectedMainSha !== baseline.mainSha) {
    check(checks, 'FAIL', 'MAIN_SHA_MISMATCH', `插件 main.js 哈希与期望不符：${baseline.mainSha} ≠ ${expectedMainSha}`);
  }

  const failures = checks.filter(item => item.level === 'FAIL');
  return { ok: failures.length === 0, vaultDir, profile, checks, changes, failures, counts: { sourceCount, extractCount, cardCount, legacyTopicCount } };
}

export function formatReport(result) {
  const lines = [];
  lines.push(`# MemoFlow E2E 审计 — ${result.vaultDir}`);
  lines.push(`profile=${result.profile} · result=${result.ok ? 'PASS' : 'FAIL'} · Topic ${result.counts.sourceCount}/${result.counts.extractCount}/${result.counts.cardCount} · 旧格式 ${result.counts.legacyTopicCount}`);
  for (const item of result.checks) lines.push(`[${item.level}] ${item.code}: ${item.message}`);
  if (result.changes) {
    const c = result.changes;
    lines.push(`变更：新增 ${c.added.length} · 修改 ${c.modified.length} · 删除 ${c.removed.length} · data.json ${c.dataJsonChanged ? '变化' : '未变'}`);
    for (const rel of c.added.slice(0, 10)) lines.push(`  + ${rel}`);
    for (const rel of c.modified.slice(0, 10)) lines.push(`  ~ ${rel}`);
    for (const rel of c.removed.slice(0, 10)) lines.push(`  - ${rel}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { vault: null, snapshot: null, baseline: null, profile: 'auto', json: false, allowChanges: false, expectedMainSha: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--vault') args.vault = argv[++i];
    else if (value === '--snapshot') args.snapshot = argv[++i];
    else if (value === '--baseline') args.baseline = argv[++i];
    else if (value === '--profile') args.profile = argv[++i];
    else if (value === '--json') args.json = true;
    else if (value === '--allow-changes') args.allowChanges = true;
    else if (value === '--expected-main-sha') args.expectedMainSha = argv[++i];
    else if (value === '--help' || value === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.vault) {
    console.log('usage: node scripts/e2e-audit.mjs --vault <path> [--snapshot out.json] [--baseline in.json] [--profile empty|memoflow|phase2] [--allow-changes] [--json]');
    process.exit(args.help ? 0 : 2);
  }
  const vaultDir = path.resolve(args.vault);
  const info = await stat(vaultDir).catch(() => null);
  if (!info || !info.isDirectory()) {
    console.error(`vault 不存在或不是目录：${vaultDir}`);
    process.exit(2);
  }
  if (args.snapshot) {
    const snapshot = await snapshotVault(vaultDir);
    await writeFile(path.resolve(args.snapshot), JSON.stringify(snapshot, null, 2));
    console.log(`已写入基线：${path.resolve(args.snapshot)}（${Object.keys(snapshot.files).length} 个 Markdown 文件）`);
    return;
  }
  let baseline = null;
  if (args.baseline) baseline = JSON.parse(await readFile(path.resolve(args.baseline), 'utf8'));
  const result = await auditVault({ vaultDir, profile: args.profile, baseline, allowChanges: args.allowChanges, expectedMainSha: args.expectedMainSha });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(2);
  });
}
