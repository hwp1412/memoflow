'use strict';

// Read-only identity resolution for legacy MemoFlow / Toolkit notes (PR-06).
//
// A legacy note usually has no persisted mf_id. The adapter may derive a
// deterministic TEMPORARY identity so a snapshot can be analysed and relations
// can be resolved inside one read, but a temporary id:
//   * is never a UUID (so it can never be mistaken for a persisted mf_id);
//   * is never written back anywhere;
//   * does not survive renaming (it is derived from the snapshot path/title);
//   * must not be used for real event writes or persistent Mercy.
//
// No randomness, no clock, no filesystem.

const { UUID_RE } = require('./schema.js');

function fnv1a(text) {
  let hash = 0x811c9dc5;
  const source = String(text);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function temporaryId(seed) {
  return `temp-${fnv1a(seed)}`;
}

function isPersistentUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Resolve one raw snapshot's identity. Never throws for bad data: the caller
// classifies the result.
function resolveIdentity(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'missing', id: null, source: null, persistent: false, renameStable: false, error: 'E_OBJECT_REQUIRED' };
  }

  if (raw.mf_id != null) {
    if (!isPersistentUuid(raw.mf_id)) {
      return { kind: 'invalid', id: null, source: 'mf_id', persistent: false, renameStable: false, error: 'E_ID_FORMAT', raw: raw.mf_id };
    }
    return { kind: 'persistent', id: raw.mf_id, source: 'mf_id', persistent: true, renameStable: true };
  }

  const path = typeof raw.path === 'string' && raw.path.trim() !== '' ? raw.path.trim() : null;
  if (path) {
    return {
      kind: 'temporary',
      id: temporaryId(`path:${path.toLowerCase()}`),
      source: 'snapshot_path',
      persistent: false,
      renameStable: false,
      warning: 'TEMP_ID_FROM_PATH',
    };
  }

  const title = typeof raw.basename === 'string' && raw.basename.trim() !== ''
    ? raw.basename.trim()
    : (typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : null);
  if (title) {
    return {
      kind: 'temporary',
      id: temporaryId(`title:${title.toLowerCase()}`),
      source: 'title',
      persistent: false,
      renameStable: false,
      warning: 'TEMP_ID_FROM_TITLE',
    };
  }

  return { kind: 'missing', id: null, source: null, persistent: false, renameStable: false, error: 'E_LEGACY_ID_UNAVAILABLE' };
}

// Detect ids that appear more than once in a snapshot (persistent or temporary).
function findIdentityCollisions(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const id = entry.identity && entry.identity.id;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const collisions = new Map();
  for (const [id, count] of counts) {
    if (count > 1) collisions.set(id, count);
  }
  return collisions;
}

module.exports = { fnv1a, temporaryId, isPersistentUuid, resolveIdentity, findIdentityCollisions };
