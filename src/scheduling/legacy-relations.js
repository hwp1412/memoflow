'use strict';

// Read-only relations for legacy Source/Extract trees (PR-06, SPEC A3.4, A8).
//
// Relations are resolved inside one caller-provided metadata snapshot. Links are
// matched against the snapshot's paths and basenames only: a title is never
// treated as a stable identity, and two notes that share a basename (or a path)
// are reported as ambiguous instead of picking the first one.
//
// Persistence is evaluated over the WHOLE ancestor chain:
//   parentPersistent  the direct parent has a persisted UUID identity
//   chainPersistent   this node and every ancestor have persisted UUIDs
// A temporary ancestor therefore never turns a descendant's root into a formal
// candidate, even when the direct parent is persistent.

const { isPersistentUuid } = require('./legacy-identity.js');

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

function identityKey(id) {
  return typeof id === 'string' ? id.toLowerCase() : null;
}

function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildIndex(entries) {
  const byPath = new Map();
  const byName = new Map();
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (path) pushTo(byPath, path, entry);
    const name = normalizeName(entry.basename) || (path ? path.split('/').pop() : null);
    if (name) pushTo(byName, name, entry);
  }
  return { byPath, byName };
}

function resolveTarget(link, index) {
  const path = normalizePath(link);
  if (path && path.includes('/')) {
    const matches = index.byPath.get(path) || [];
    if (matches.length === 0) return { missing: true };
    if (matches.length > 1) return { ambiguous: true, candidates: matches.map(match => match.id) };
    return { entry: matches[0] };
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
  const idCounts = new Map();
  for (const entry of entries) {
    const key = identityKey(entry.id);
    if (!key) continue;
    idCounts.set(key, (idCounts.get(key) || 0) + 1);
  }
  const duplicateIds = new Set();
  for (const [key, count] of idCounts) {
    if (count > 1) duplicateIds.add(key);
  }

  const byId = new Map();
  const issues = { orphans: [], ambiguous: [], selfReferences: [], cycles: [], duplicateIds: [] };

  for (const entry of entries) {
    const key = identityKey(entry.id);
    if (!key) continue;
    const raw = entry.raw || {};
    const result = {
      id: entry.id,
      identityPersistent: Boolean(entry.identity && entry.identity.persistent),
      parentId: null,
      parentPersistent: false,
      chainPersistent: false,
      rootId: null,
      depth: 0,
      status: 'ok',
      link: null,
      treeRoot: raw.tree_root === true,
    };

    if (duplicateIds.has(key)) {
      result.status = 'duplicate';
      issues.duplicateIds.push({ id: entry.id, occurrences: idCounts.get(key) });
      byId.set(key, result);
      continue;
    }

    if (result.treeRoot) {
      result.status = 'root';
      result.rootId = entry.id;
      result.chainPersistent = result.identityPersistent;
      byId.set(key, result);
      continue;
    }

    // Legacy effective parent: explicit `parent`, then `source` fallback
    // (mirrors tree-core.effectiveParent).
    const link = normalizeLinkValue(raw.parent) || normalizeLinkValue(raw.source);
    result.link = link;
    if (!link) {
      result.status = 'root';
      result.rootId = entry.id;
      result.chainPersistent = result.identityPersistent;
      byId.set(key, result);
      continue;
    }

    const resolved = resolveTarget(link, index);
    if (resolved.missing) {
      result.status = 'orphan';
      issues.orphans.push({ id: entry.id, link });
      byId.set(key, result);
      continue;
    }
    if (resolved.ambiguous) {
      result.status = 'ambiguous';
      issues.ambiguous.push({ id: entry.id, link, candidates: resolved.candidates });
      byId.set(key, result);
      continue;
    }
    if (identityKey(resolved.entry.id) === key) {
      result.status = 'self';
      issues.selfReferences.push({ id: entry.id, link });
      byId.set(key, result);
      continue;
    }

    result.parentId = resolved.entry.id;
    byId.set(key, result);
  }

  // Depth, root and chain persistence, with cycle detection.
  const state = new Map();
  function walk(key) {
    const node = byId.get(key);
    if (!node) return { chainPersistent: false, rootId: null, status: 'orphan', depth: 0 };
    if (state.get(key) === 'done') {
      return { chainPersistent: node.chainPersistent, rootId: node.rootId, status: node.status, depth: node.depth };
    }
    if (state.get(key) === 'visiting') {
      node.status = 'cycle';
      node.chainPersistent = false;
      node.rootId = null;
      issues.cycles.push({ id: node.id, cycle: true });
      state.set(key, 'done');
      return { chainPersistent: false, rootId: null, status: 'cycle', depth: 0 };
    }
    state.set(key, 'visiting');

    if (!node.parentId) {
      // Root or an already-failed node (orphan/ambiguous/duplicate).
      state.set(key, 'done');
      if (node.status === 'root') {
        node.rootId = node.id;
        node.depth = 0;
        node.chainPersistent = node.identityPersistent;
      } else {
        node.rootId = null;
        node.chainPersistent = false;
      }
      return { chainPersistent: node.chainPersistent, rootId: node.rootId, status: node.status, depth: node.depth };
    }

    const parent = walk(identityKey(node.parentId));
    if (parent.status !== 'root' && parent.status !== 'ok') {
      // An unresolved ancestor poisons the whole chain; keep the diagnosis.
      node.status = parent.status;
      node.chainPersistent = false;
      node.parentPersistent = false;
      node.rootId = null;
      node.depth = 0;
      if (parent.status === 'cycle') issues.cycles.push({ id: node.id, derived: true });
      state.set(key, 'done');
      return { chainPersistent: false, rootId: null, status: node.status, depth: 0 };
    }

    node.parentPersistent = Boolean(
      parent.chainPersistent
      || (parent.status === 'root' && parent.chainPersistent)
    );
    // A parent is directly persistent when its own identity is a UUID, even if
    // its own ancestors are not.
    const parentNode = byId.get(identityKey(node.parentId));
    node.parentPersistent = Boolean(parentNode && parentNode.identityPersistent);
    node.chainPersistent = Boolean(node.identityPersistent && parent.chainPersistent);
    node.rootId = parent.rootId;
    node.depth = parent.depth + 1;
    state.set(key, 'done');
    return { chainPersistent: node.chainPersistent, rootId: node.rootId, status: node.status, depth: node.depth };
  }

  for (const entry of entries) {
    const key = identityKey(entry.id);
    if (key) walk(key);
  }

  return { byId, issues };
}

module.exports = {
  normalizeLinkValue,
  normalizePath,
  normalizeName,
  identityKey,
  buildIndex,
  resolveTarget,
  resolveRelations,
};
