'use strict';

// Obsidian storage adapter contract and Fake Vault implementation (PR-10).
//
// The real Obsidian `processFrontMatter()` is a read-modify-write API: it does
// NOT provide a cross-process compare-and-swap. The fake adapter therefore
// advertises supportsAtomicCas=false, and the unified gate must refuse it.
// A separate atomic fake adapter exists only for synthetic integration tests.

const { fail } = require('../scheduling/errors.js');
const { sha256Hex } = require('../scheduling/migration-hash.js');
const { isValidDateString } = require('../scheduling/dates.js');
const { renderContent } = require('../scheduling/unified-store-contract.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');

const DATE_FORMATS = Object.freeze(['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);

function requireDateFormat(dateFormat) {
  if (typeof dateFormat !== 'string' || !DATE_FORMATS.includes(dateFormat)) {
    fail('E_DATE_FORMAT_UNSUPPORTED', 'an explicit supported Vault date format is required', { dateFormat });
  }
  return dateFormat;
}

function formatDate(iso, dateFormat) {
  if (!DATE_FORMATS.includes(dateFormat)) fail('E_DATE_FORMAT_UNSUPPORTED', 'unsupported date format', { dateFormat });
  if (!isValidDateString(iso)) fail('E_DATE_INVALID', 'invalid date', { value: iso });
  const [year, month, day] = iso.split('-');
  switch (dateFormat) {
    case 'YYYY-MM-DD': return `${year}-${month}-${day}`;
    case 'MM-DD-YYYY': return `${month}-${day}-${year}`;
    case 'DD/MM/YYYY': return `${day}/${month}/${year}`;
    case 'MM/DD/YYYY': return `${month}/${day}/${year}`;
    case 'DD-MM-YYYY': return `${day}-${month}-${year}`;
    default: return fail('E_DATE_FORMAT_UNSUPPORTED', 'unsupported date format', { dateFormat });
  }
}

class FakeObsidianVault {
  constructor(files = {}) {
    this.files = new Map();
    this.beforeWrite = null;
    for (const [path, entry] of Object.entries(files)) this.setFile(path, entry);
  }

  setFile(path, entry) {
    const frontmatter = { ...(entry.frontmatter || {}) };
    const body = typeof entry.body === 'string' ? entry.body : '';
    this.files.set(path, {
      path,
      frontmatter,
      body,
      revision: Number.isInteger(entry.revision) ? entry.revision : (Number.isInteger(frontmatter.mf_revision) ? frontmatter.mf_revision : null),
      content: renderContent(frontmatter, body),
    });
  }

  read(path) {
    const entry = this.files.get(path);
    if (!entry) return null;
    return {
      path,
      frontmatter: { ...entry.frontmatter },
      body: entry.body,
      revision: entry.revision,
      content: entry.content,
      hash: sha256Hex(entry.content),
    };
  }

  // Mirrors Obsidian's read-modify-write API; not atomic across processes.
  processFrontMatter(path, mutator) {
    const entry = this.files.get(path);
    if (!entry) fail('E_FILE_MISSING', 'file not found', { path });
    if (typeof this.beforeWrite === 'function') this.beforeWrite(path);
    const frontmatter = { ...entry.frontmatter };
    mutator(frontmatter);
    this.setFile(path, {
      frontmatter,
      body: entry.body,
      revision: Number.isInteger(entry.revision) ? entry.revision + 1 : entry.revision,
    });
    return this.read(path);
  }

  rename(oldPath, newPath) {
    const entry = this.files.get(oldPath);
    if (!entry) fail('E_FILE_MISSING', 'file not found', { path: oldPath });
    if (this.files.has(newPath)) fail('E_FILE_EXISTS', 'target path already exists', { path: newPath });
    this.files.delete(oldPath);
    this.files.set(newPath, { ...entry, path: newPath });
  }

  list() {
    return [...this.files.keys()];
  }
}

function assertMfId(frontmatter, path) {
  const mfId = frontmatter.mf_id;
  if (mfId == null) return null;
  if (!isPersistentUuid(mfId)) fail('E_ID_FORMAT', 'invalid persisted mf_id', { path });
  return mfId;
}

function buildAdapter(vault, dateFormat, { atomic }) {
  requireDateFormat(dateFormat);

  const adapter = {
    kind: atomic ? 'fake-atomic-vault' : 'fake-obsidian-vault',
    supportsAtomicCas: atomic,
    dateFormat,

    readSnapshot(path) {
      const snapshot = vault.read(path);
      if (!snapshot) return null;
      const mfId = assertMfId(snapshot.frontmatter, path);
      return { ...snapshot, mfId };
    },

    locateByTopicId(topicId) {
      if (!isPersistentUuid(topicId)) fail('E_TOPIC_ID_INVALID', 'topic id must be a persistent UUID');
      const matches = vault.list().filter(path => {
        const entry = vault.read(path);
        return entry && entry.frontmatter.mf_id === topicId;
      });
      if (matches.length === 0) return { snapshot: null, duplicates: [] };
      if (matches.length > 1) return { snapshot: null, duplicates: matches };
      return { snapshot: this.readSnapshot(matches[0]), duplicates: [] };
    },

    verifySnapshot(snapshot, { expectedHash, expectedRevision }) {
      if (!snapshot) return { ok: false, code: 'E_FILE_MISSING' };
      if (expectedHash && snapshot.hash !== expectedHash) return { ok: false, code: 'E_SNAPSHOT_MISMATCH' };
      if (expectedRevision != null && snapshot.revision !== expectedRevision) {
        return { ok: false, code: 'E_REVISION_MISMATCH' };
      }
      return { ok: true };
    },

    // Legacy-compatible write path. It verifies the snapshot, then does a
    // read-modify-write; the caller must understand the race is not closed.
    writeFrontMatterLegacy(path, expected, mutator) {
      const snapshot = this.readSnapshot(path);
      const verification = this.verifySnapshot(snapshot, expected);
      if (!verification.ok) return verification;
      const next = vault.processFrontMatter(path, mutator);
      return { ok: true, atomic: false, snapshot: next, warning: 'NON_ATOMIC_FRONTMATTER_WRITE' };
    },

    formatEffectiveDue(iso) {
      return formatDate(iso, dateFormat);
    },
  };

  if (atomic) {
    adapter.compareAndSwap = (path, { expectedHash, expectedRevision, nextFrontmatter, nextBody, nextRevision }) => {
      const snapshot = adapter.readSnapshot(path);
      const verification = adapter.verifySnapshot(snapshot, { expectedHash, expectedRevision });
      if (!verification.ok) return verification;
      vault.setFile(path, {
        frontmatter: nextFrontmatter,
        body: nextBody ?? snapshot.body,
        revision: nextRevision ?? (snapshot.revision == null ? snapshot.revision : snapshot.revision + 1),
      });
      return { ok: true, snapshot: adapter.readSnapshot(path) };
    };
  }

  return adapter;
}

function createFakeVaultAdapter({ vault, dateFormat }) {
  return buildAdapter(vault, dateFormat, { atomic: false });
}

function createFakeAtomicVaultAdapter({ vault, dateFormat }) {
  return buildAdapter(vault, dateFormat, { atomic: true });
}

// Unified runtime requires a storage with a real CAS contract. The Obsidian
// adapter intentionally reports false, so unified writes fail closed there until
// a reviewed adapter with genuine atomicity exists.
function assertUnifiedStorageReady(adapter) {
  if (!adapter || adapter.supportsAtomicCas !== true) {
    fail('E_STORAGE_WITHOUT_CAS', 'unified writes require a storage with a real compare-and-swap contract', {
      adapter: adapter ? adapter.kind : null,
    });
  }
  return adapter;
}

module.exports = {
  DATE_FORMATS,
  FakeObsidianVault,
  createFakeVaultAdapter,
  createFakeAtomicVaultAdapter,
  assertUnifiedStorageReady,
  formatDate,
};
