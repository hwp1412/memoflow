'use strict';

// Read-only relations for legacy Source/Extract trees (PR-06, SPEC A3.4, A8).
//
// Relations are resolved inside one caller-provided metadata snapshot. Links are
// matched against the snapshot's paths and basenames only: a title is never
// treated as a stable identity, and two notes that share a basename are
// reported as ambiguous instead of being merged.
//
// Nothing here reads a vault, mutates a note or creates a parent.

function normalizeLinkValue(value) {
  if (value == null) return null;
  let text = String(value).trim();
  if (!text) return null;
  const wiki = text.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki) text = wiki[1];
  text = text.split('|')[0].split('#')[0].trim();
  return text || null;
}

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  if (!path) return null;
  if (path.toLowerCase().endsWith('.md')) path = path.slice(0, -3);
  return path.toLowerCase();
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name) return null;
  return name.toLowerCase();
}

function buildIndex(entries) {
  const byPath = new Map();
  const byName = new Map();
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (path && !byPath.has(path)) byPath.set(path, entry);
    const name = normalizeName(entry.basename) || (path ? path.split('/').pop() : null);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(entry);
  }
  return { byPath, byName };
}

function resolveTarget(link, index) {
  const path = normalizePath(link);
  if (path && path.includes('/')) {
    const match = index.byPath.get(path);
    return match ? { entry: match } : { missing: true };
  }
  const name = normalizeName(link);
  const matches = (name && index.byName.get(name)) || [];
  if (matches.length === 0) return { missing: true };
  if (matches.length > 1) return { ambiguous: true, candidates: matches.map(match => match.id) };
  return { entry: matches[0] };
}

// entries: [{ id, identity, path, basename, raw }]
function resolveRelations(entries) {
  const index = buildIndex(entries);
  const byId = new Map();
  const issues = { orphans: [], ambiguous: [], selfReferences: [], cycles: [] };

  for (const entry of entries) {
    const raw = entry.raw || {};
    const result = {
      id: entry.id,
      parentId: null,
      parentKind: null,
      rootId: entry.id,
      depth: 0,
      status: 'ok',
      link: null,
      persistent: Boolean(entry.identity && entry.identity.persistent),
      treeRoot: raw.tree_root === true,
    };

    if (result.treeRoot) {
      result.status = 'root';
      byId.set(entry.id, result);
      continue;
    }

    // Legacy effective parent: explicit `parent`, then `source` fallback
    // (mirrors tree-core.effectiveParent).
    const link = normalizeLinkValue(raw.parent) || normalizeLinkValue(raw.source);
    result.link = link;
    if (!link) {
      result.status = 'root';
      byId.set(entry.id, result);
      continue;
    }

    const resolved = resolveTarget(link, index);
    if (resolved.missing) {
      result.status = 'orphan';
      issues.orphans.push({ id: entry.id, link });
      byId.set(entry.id, result);
      continue;
    }
    if (resolved.ambiguous) {
      result.status = 'ambiguous';
      issues.ambiguous.push({ id: entry.id, link, candidates: resolved.candidates });
      byId.set(entry.id, result);
      continue;
    }
    if (resolved.entry.id === entry.id) {
      result.status = 'self';
      issues.selfReferences.push({ id: entry.id, link });
      byId.set(entry.id, result);
      continue;
    }

    result.parentId = resolved.entry.id;
    result.parentKind = resolved.entry.identity && resolved.entry.identity.persistent ? 'persistent' : 'temporary';
    result.persistent = Boolean(result.persistent && result.parentKind === 'persistent');
    byId.set(entry.id, result);
  }

  // Depth and root via parent chains; cycles are detected on the way.
  const state = new Map();
  function walk(id) {
    const node = byId.get(id);
    if (!node) return { depth: 0, rootId: null };
    if (state.get(id) === 'done') return { depth: node.depth, rootId: node.rootId };
    if (state.get(id) === 'visiting') {
      node.status = 'cycle';
      issues.cycles.push({ id, cycle: true });
      return { depth: 0, rootId: null };
    }
    state.set(id, 'visiting');
    if (!node.parentId) {
      node.rootId = id;
      node.depth = 0;
      state.set(id, 'done');
      return { depth: 0, rootId: id };
    }
    const parent = walk(node.parentId);
    if (parent.rootId == null) {
      node.status = 'cycle';
      issues.cycles.push({ id, parentId: node.parentId });
      node.rootId = null;
      node.depth = 0;
      state.set(id, 'done');
      return { depth: 0, rootId: null };
    }
    node.rootId = parent.rootId;
    node.depth = parent.depth + 1;
    state.set(id, 'done');
    return { depth: node.depth, rootId: node.rootId };
  }
  for (const entry of entries) walk(entry.id);

  // Mark every node whose chain reaches a cycle as invalid as well.
  for (const entry of entries) {
    const node = byId.get(entry.id);
    if (node && node.rootId == null && node.status !== 'cycle') {
      node.status = 'cycle';
      issues.cycles.push({ id: entry.id, derived: true });
    }
  }

  return { byId, issues };
}

module.exports = { normalizeLinkValue, normalizePath, normalizeName, buildIndex, resolveTarget, resolveRelations };
