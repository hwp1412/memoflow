'use strict';

// Synthetic storage contracts for the Unified writer (PR-09).
//
// Only instances registered in module-private WeakSets are accepted. A plain
// object with the right methods cannot impersonate a store, and the synthetic
// write capability cannot be forged with {authorized:true}. Real Obsidian
// storage needs a separately reviewed adapter (PR-10).

const { fail } = require('./errors.js');
const { sha256Hex } = require('./migration-hash.js');

const TRUSTED_TOPIC_STORES = new WeakSet();
const TRUSTED_LEDGER_STORES = new WeakSet();
const TRUSTED_BATCH_STORES = new WeakSet();
const SYNTHETIC_CAPABILITIES = new WeakSet();
const MERCY_CONFIRMATIONS = new WeakSet();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function renderContent(frontmatter, body) {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value === null ? 'null' : value}`);
  return ['---', ...lines, '---', body ?? ''].join('\n');
}

class SyntheticUnifiedStorage {
  constructor(files = {}) {
    this.files = new Map();
    this.byId = new Map();
    this.readFailures = new Map();
    this.readFailuresAfterWrite = new Map();
    this.casFailures = new Map();
    this.beforeCas = null;
    for (const [path, entry] of Object.entries(files)) this.setFile(path, entry);
    TRUSTED_TOPIC_STORES.add(this);
  }

  setFile(path, entry) {
    if (typeof path !== 'string' || !path) fail('E_OBJECT_REQUIRED', 'storage path must be a non-empty string', { field: 'path' });
    if (!entry || typeof entry !== 'object') fail('E_OBJECT_REQUIRED', 'storage entry must be an object', { field: 'entry' });
    const frontmatter = clone(entry.frontmatter || {});
    const body = typeof entry.body === 'string' ? entry.body : '';
    const previous = this.files.get(path);
    if (previous && previous.mfId) this._unindex(previous.mfId, path);
    const mfId = entry.mfId || frontmatter.mf_id || null;
    this.files.set(path, {
      path,
      mfId,
      revision: Number.isInteger(entry.revision) ? entry.revision : (Number.isInteger(frontmatter.mf_revision) ? frontmatter.mf_revision : null),
      frontmatter,
      body,
      content: renderContent(frontmatter, body),
    });
    if (mfId) this._index(mfId, path);
  }

  _index(mfId, path) {
    if (!this.byId.has(mfId)) this.byId.set(mfId, new Set());
    this.byId.get(mfId).add(path);
  }

  _unindex(mfId, path) {
    const paths = this.byId.get(mfId);
    if (!paths) return;
    paths.delete(path);
    if (paths.size === 0) this.byId.delete(mfId);
  }

  read(path) {
    const remaining = this.readFailures.get(path) || 0;
    if (remaining > 0) {
      this.readFailures.set(path, remaining - 1);
      fail('E_STORAGE_READ_FAILED', `injected read failure for ${path}`, { path });
    }
    const entry = this.files.get(path);
    if (!entry) return null;
    return { ...entry, frontmatter: clone(entry.frontmatter) };
  }

  findByTopicId(topicId) {
    const paths = this.byId.get(topicId) ? [...this.byId.get(topicId)] : [];
    if (paths.length === 0) return { entry: null, duplicates: [] };
    if (paths.length > 1) return { entry: null, duplicates: paths };
    return { entry: this.read(paths[0]), duplicates: [] };
  }

  // In-process atomic compare-and-swap for the synthetic backend. This is NOT a
  // claim that Obsidian's frontmatter API offers cross-process CAS.
  compareAndSwap(path, { expectedHash, expectedRevision, nextFrontmatter, nextBody, nextRevision }) {
    if (typeof this.beforeCas === 'function') this.beforeCas(path);
    const remainingFailures = this.casFailures.get(path) || 0;
    if (remainingFailures > 0) {
      this.casFailures.set(path, remainingFailures - 1);
      return { ok: false, code: 'E_STORAGE_WRITE_FAILED' };
    }
    const entry = this.files.get(path);
    if (!entry) return { ok: false, code: 'E_FILE_MISSING' };
    if (typeof expectedHash === 'string' && sha256Hex(entry.content) !== expectedHash) {
      return { ok: false, code: 'E_SNAPSHOT_MISMATCH' };
    }
    if (expectedRevision != null && entry.revision !== expectedRevision) {
      return { ok: false, code: 'E_REVISION_MISMATCH' };
    }
    const frontmatter = clone(nextFrontmatter);
    const body = typeof nextBody === 'string' ? nextBody : entry.body;
    if (entry.mfId) this._unindex(entry.mfId, path);
    const nextId = frontmatter.mf_id || entry.mfId;
    this.files.set(path, {
      path,
      mfId: nextId,
      revision: nextRevision ?? (entry.revision == null ? entry.revision : entry.revision + 1),
      frontmatter,
      body,
      content: renderContent(frontmatter, body),
    });
    if (nextId) this._index(nextId, path);
    const pending = this.readFailuresAfterWrite.get(path) || 0;
    if (pending > 0) {
      this.readFailures.set(path, pending);
      this.readFailuresAfterWrite.delete(path);
    }
    return { ok: true, entry: this.files.get(path) };
  }

  corrupt(path, content) {
    const entry = this.files.get(path);
    if (!entry) return false;
    this.files.set(path, { ...entry, content });
    return true;
  }

  failNextRead(path, count = 1) {
    this.readFailures.set(path, count);
  }

  failNextReadAfterWrite(path, count = 1) {
    this.readFailuresAfterWrite.set(path, count);
  }

  failNextCas(path, count = 1) {
    this.casFailures.set(path, count);
  }

  dump() {
    return Object.fromEntries([...this.files].map(([path, entry]) => [path, clone(entry)]));
  }
}

class MemoryLedgerStore {
  constructor(records = {}) {
    this.records = new Map();
    for (const [eventId, record] of Object.entries(records)) this.records.set(eventId, clone(record));
    TRUSTED_LEDGER_STORES.add(this);
  }

  get(eventId) {
    const record = this.records.get(eventId);
    return record ? clone(record) : null;
  }

  put(eventId, record) {
    this.records.set(eventId, clone(record));
  }

  dump() {
    return Object.fromEntries([...this.records].map(([eventId, record]) => [eventId, clone(record)]));
  }

  corrupt(eventId) {
    const record = this.records.get(eventId);
    if (!record) return false;
    record.status = 'corrupted';
    return true;
  }
}

class MemoryBatchStore {
  constructor(batches = {}) {
    this.batches = new Map();
    for (const [batchId, batch] of Object.entries(batches)) this.batches.set(batchId, clone(batch));
    TRUSTED_BATCH_STORES.add(this);
  }

  get(batchId) {
    const batch = this.batches.get(batchId);
    return batch ? clone(batch) : null;
  }

  put(batchId, batch) {
    this.batches.set(batchId, clone(batch));
  }

  dump() {
    return Object.fromEntries([...this.batches].map(([batchId, batch]) => [batchId, clone(batch)]));
  }
}

function assertTrustedTopicStorage(storage) {
  if (!storage || !TRUSTED_TOPIC_STORES.has(storage)) {
    fail('E_STORAGE_UNTRUSTED', 'unified writer only accepts the synthetic topic storage', {});
  }
  return storage;
}

function assertTrustedLedgerStore(store) {
  if (!store || !TRUSTED_LEDGER_STORES.has(store)) {
    fail('E_LEDGER_STORE_UNTRUSTED', 'unified writer only accepts the synthetic ledger store', {});
  }
  return store;
}

function assertTrustedBatchStore(store) {
  if (!store || !TRUSTED_BATCH_STORES.has(store)) {
    fail('E_BATCH_STORE_UNTRUSTED', 'unified writer only accepts the synthetic batch store', {});
  }
  return store;
}

// A test-only capability. It cannot be forged through request fields, and it
// does not enable Unified in the real plugin.
function issueSyntheticUnifiedCapability(label = 'synthetic-test') {
  const capability = Object.freeze({ kind: 'synthetic-unified-capability', label });
  SYNTHETIC_CAPABILITIES.add(capability);
  return capability;
}

function issueSyntheticMercyConfirmation(batchId, previewDigest) {
  if (typeof batchId !== 'string' || !batchId) fail('E_BATCH_ID_REQUIRED', 'a mercy confirmation needs a batch id');
  if (typeof previewDigest !== 'string' || !previewDigest) {
    fail('E_PREVIEW_DIGEST_REQUIRED', 'a mercy confirmation must bind the preview digest');
  }
  const confirmation = Object.freeze({ kind: 'synthetic-mercy-confirmation', batchId, previewDigest });
  MERCY_CONFIRMATIONS.add(confirmation);
  return confirmation;
}

function assertSyntheticMercyConfirmation(confirmation, batchId, previewDigest) {
  if (!confirmation || !MERCY_CONFIRMATIONS.has(confirmation) || confirmation.batchId !== batchId) {
    fail('E_MERCY_CONFIRMATION_REQUIRED', 'mercy writes require an explicit trusted preview confirmation', { batchId });
  }
  if (confirmation.previewDigest !== previewDigest) {
    fail('E_MERCY_CONFIRMATION_MISMATCH', 'the confirmation does not belong to this exact preview', { batchId });
  }
  return confirmation;
}

function assertSyntheticUnifiedCapability(capability) {
  if (!capability || !SYNTHETIC_CAPABILITIES.has(capability)) {
    fail('E_UNIFIED_NOT_AUTHORIZED', 'unified writes require a trusted synthetic capability', {});
  }
  return capability;
}

module.exports = {
  renderContent,
  SyntheticUnifiedStorage,
  MemoryLedgerStore,
  MemoryBatchStore,
  assertTrustedTopicStorage,
  assertTrustedLedgerStore,
  assertTrustedBatchStore,
  issueSyntheticUnifiedCapability,
  assertSyntheticUnifiedCapability,
  issueSyntheticMercyConfirmation,
  assertSyntheticMercyConfirmation,
};
