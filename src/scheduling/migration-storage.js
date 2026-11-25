'use strict';

// Injected storage for migration tests (PR-08). Only instances registered by
// this module are accepted; a plain object with getFile/write cannot pass,
// because the registry is a module-private WeakSet.

const { fail } = require('./errors.js');

const TRUSTED_STORAGE = new WeakSet();
const TRUSTED_BACKUP_STORES = new WeakSet();

class MemoryStorage {
  constructor(files = {}) {
    this.files = new Map();
    this.writeFailures = new Map();
    this.verifyFailures = new Map();
    this.verifyAfterWrite = new Map();
    for (const [path, value] of Object.entries(files)) {
      if (typeof value === 'string') this.setFile(path, value, null);
      else if (value && typeof value === 'object') this.setFile(path, String(value.content), value.revision ?? null);
    }
    TRUSTED_STORAGE.add(this);
  }

  setFile(path, content, revision = null) {
    if (typeof path !== 'string' || !path) fail('E_OBJECT_REQUIRED', 'storage path must be a non-empty string', { field: 'path' });
    if (typeof content !== 'string') fail('E_OBJECT_REQUIRED', 'storage content must be a string', { field: 'content' });
    this.files.set(path, { content, revision: revision ?? null });
  }

  getFile(path) {
    const file = this.files.get(path);
    if (!file) return null;
    const remaining = this.verifyFailures.get(path) || 0;
    if (remaining > 0) {
      this.verifyFailures.set(path, remaining - 1);
      // Simulates a read-back that does not match what was written.
      return { path, content: `${file.content}\u0000verify-failure`, revision: file.revision };
    }
    return { path, content: file.content, revision: file.revision };
  }

  read(path) {
    const file = this.files.get(path);
    return file ? file.content : null;
  }

  write(path, content, revision = null) {
    const remaining = this.writeFailures.get(path) || 0;
    if (remaining > 0) {
      this.writeFailures.set(path, remaining - 1);
      fail('E_STORAGE_WRITE_FAILED', `injected write failure for ${path}`, { path });
    }
    this.files.set(path, { content, revision: revision ?? null });
    const pendingVerify = this.verifyAfterWrite.get(path) || 0;
    if (pendingVerify > 0) {
      this.verifyFailures.set(path, pendingVerify);
      this.verifyAfterWrite.delete(path);
    }
  }

  failNextWrite(path, count = 1) {
    this.writeFailures.set(path, count);
  }

  failNextVerify(path, count = 1) {
    this.verifyFailures.set(path, count);
  }

  failNextVerifyAfterWrite(path, count = 1) {
    this.verifyAfterWrite.set(path, count);
  }

  corrupt(path, content) {
    const file = this.files.get(path);
    this.files.set(path, { content, revision: file ? file.revision : null });
  }

  snapshot() {
    return Object.fromEntries([...this.files].map(([path, file]) => [path, { ...file }]));
  }
}

class MemoryBackupStore {
  constructor() {
    this.records = new Map();
    this.batches = new Map();
    TRUSTED_BACKUP_STORES.add(this);
  }

  put(batch) {
    this.records.set(batch.batchId, batch);
  }

  get(batchId) {
    return this.records.get(batchId) || null;
  }

  has(batchId) {
    return this.records.has(batchId);
  }

  putBatch(batch) {
    this.batches.set(batch.batchId, batch);
  }

  getBatch(batchId) {
    return this.batches.get(batchId) || null;
  }

  corrupt(batchId) {
    const batch = this.records.get(batchId);
    if (!batch || !batch.entries.length) return false;
    batch.entries[0].content += '\ncorrupted';
    batch.verified = false;
    return true;
  }

  remove(batchId) {
    return this.records.delete(batchId);
  }
}

function assertTrustedStorage(storage) {
  if (!storage || !TRUSTED_STORAGE.has(storage)) {
    fail('E_STORAGE_UNTRUSTED', 'migration only accepts the built-in MemoryStorage instance', {});
  }
  return storage;
}

function assertTrustedBackupStore(store) {
  if (!store || !TRUSTED_BACKUP_STORES.has(store)) {
    fail('E_BACKUP_STORE_UNTRUSTED', 'migration only accepts the built-in MemoryBackupStore instance', {});
  }
  return store;
}

module.exports = {
  MemoryStorage,
  MemoryBackupStore,
  assertTrustedStorage,
  assertTrustedBackupStore,
};
