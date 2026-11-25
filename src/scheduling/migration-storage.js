'use strict';

// Injected storage for migration tests (PR-08). This is the ONLY storage the
// migration executor accepts. There is deliberately no adapter that would touch
// a real vault or Obsidian; a future PR must provide its own reviewed adapter.

const { fail } = require('./errors.js');

class MemoryStorage {
  constructor(files = {}) {
    this.files = new Map();
    this.writeFailures = new Map();
    for (const [path, value] of Object.entries(files)) {
      if (typeof value === 'string') this.setFile(path, value, null);
      else if (value && typeof value === 'object') this.setFile(path, String(value.content), value.revision ?? null);
    }
  }

  setFile(path, content, revision = null) {
    if (typeof path !== 'string' || !path) fail('E_OBJECT_REQUIRED', 'storage path must be a non-empty string', { field: 'path' });
    if (typeof content !== 'string') fail('E_OBJECT_REQUIRED', 'storage content must be a string', { field: 'content' });
    this.files.set(path, { content, revision: revision ?? null });
  }

  getFile(path) {
    const file = this.files.get(path);
    return file ? { path, content: file.content, revision: file.revision } : null;
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
  }

  failNextWrite(path, count = 1) {
    this.writeFailures.set(path, count);
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

module.exports = { MemoryStorage, MemoryBackupStore };
