'use strict';

// Durable ledger boundary for the plugin data store (PR-10B).
//
// The store is loaded once, validated and then used synchronously by
// PersistentEventLedger; every mutation must be flushed explicitly. A failed
// flush is reported, never treated as durable. Real data.json is not touched in
// this branch; tests use an injected fake data store.

const { fail } = require('../scheduling/errors.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');
const { stableStringify } = require('../scheduling/migration-hash.js');

const LEDGER_FORMAT_VERSION = 1;
const RECORD_STATUSES = new Set(['prepared', 'applied', 'failed', 'uncertain', 'conflict', 'requires-manual-recovery']);
const BLOCKING_STATUSES = new Set(['prepared', 'uncertain', 'conflict', 'requires-manual-recovery']);

function validateSnapshot(snapshot) {
  if (snapshot == null) return { records: {}, diagnostics: [] };
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('E_LEDGER_CORRUPT', 'the ledger snapshot is not an object');
  }
  if (snapshot.version !== LEDGER_FORMAT_VERSION) {
    fail('E_LEDGER_VERSION_UNSUPPORTED', 'unsupported ledger format version', { version: snapshot.version });
  }
  if (!snapshot.records || typeof snapshot.records !== 'object' || Array.isArray(snapshot.records)) {
    fail('E_LEDGER_CORRUPT', 'ledger records must be an object');
  }
  const diagnostics = [];
  const records = {};
  for (const [eventId, record] of Object.entries(snapshot.records)) {
    if (!record || typeof record !== 'object' || record.eventId !== eventId
      || record.topicId == null || !isPersistentUuid(record.topicId)
      || typeof record.fingerprint !== 'string' || !record.fingerprint
      || !RECORD_STATUSES.has(record.status)) {
      diagnostics.push({ code: 'E_LEDGER_RECORD_CORRUPT', eventId });
      continue;
    }
    records[eventId] = record;
  }
  return { records, diagnostics };
}

class PluginDataLedgerStore {
  constructor(records = {}, { onChange = null } = {}) {
    this.records = new Map(Object.entries(records).map(([eventId, record]) => [eventId, JSON.parse(JSON.stringify(record))]));
    this.onChange = typeof onChange === 'function' ? onChange : null;
  }

  get(eventId) {
    const record = this.records.get(eventId);
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  put(eventId, record) {
    this.records.set(eventId, JSON.parse(JSON.stringify(record)));
    if (this.onChange) this.onChange();
  }

  delete(eventId) {
    const deleted = this.records.delete(eventId);
    if (deleted && this.onChange) this.onChange();
    return deleted;
  }

  blockedTopicIds() {
    return [...new Set([...this.records.values()]
      .filter(record => BLOCKING_STATUSES.has(record.status))
      .map(record => record.topicId))];
  }

  dump() {
    return Object.fromEntries([...this.records].map(([eventId, record]) => [eventId, JSON.parse(JSON.stringify(record))]));
  }

  serialize() {
    return { version: LEDGER_FORMAT_VERSION, records: this.dump() };
  }
}

// Synthetic keyed abstraction (fake data store tests). A separate adapter maps
// the real Obsidian Plugin API signatures.
function createKeyedDataStore(data = {}) {
  return {
    async loadData(key) { return data[key] ?? null; },
    async saveData(key, value) { data[key] = JSON.parse(JSON.stringify(value)); },
  };
}

// Maps Obsidian's Plugin.loadData()/saveData(data) signatures. Ledger data is
// namespaced; other settings/Refine state are merged from the latest snapshot
// and never overwritten by the ledger.
function createObsidianPluginDataStore(plugin, { defaultKey = 'mfUs1Ledger' } = {}) {
  if (!plugin || typeof plugin.loadData !== 'function' || typeof plugin.saveData !== 'function') {
    fail('E_LEDGER_STORE_REQUIRED', 'a plugin with loadData()/saveData(data) is required');
  }
  return {
    async loadData(key = defaultKey) {
      const all = await plugin.loadData();
      return all && typeof all === 'object' ? (all[key] ?? null) : null;
    },
    async saveData(key = defaultKey, value) {
      const current = await plugin.loadData();
      const base = current && typeof current === 'object' ? current : {};
      await plugin.saveData({ ...base, [key]: value });
    },
  };
}

async function openPluginDataLedger({ dataStore, key = 'mf-us1-ledger', expectExisting = false } = {}) {
  if (!dataStore || typeof dataStore.loadData !== 'function' || typeof dataStore.saveData !== 'function') {
    fail('E_LEDGER_STORE_REQUIRED', 'loadData/saveData are required');
  }
  const raw = await dataStore.loadData(key);
  if (raw == null && expectExisting) {
    fail('E_LEDGER_MISSING', 'an existing ledger was expected but is missing; refusing to continue');
  }
  const { records, diagnostics } = validateSnapshot(raw);
  let dirty = false;
  const store = new PluginDataLedgerStore(records, { onChange: () => { dirty = true; } });
  return {
    store,
    diagnostics,
    healthy: diagnostics.length === 0,
    blockedTopicIds: store.blockedTopicIds(),
    fresh: raw == null,
    markDirty() { dirty = true; },
    async flush() {
      try {
        await dataStore.saveData(key, store.serialize());
        dirty = false;
        return { ok: true };
      } catch (error) {
        return { ok: false, code: 'E_LEDGER_SAVE_FAILED', message: error && error.message };
      }
    },
    isDirty() { return dirty; },
  };
}

module.exports = {
  LEDGER_FORMAT_VERSION,
  PluginDataLedgerStore,
  createKeyedDataStore,
  createObsidianPluginDataStore,
  openPluginDataLedger,
  validateSnapshot,
};
