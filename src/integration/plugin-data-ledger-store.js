'use strict';

// Durable ledger boundary for the plugin data store (PR-10B).
//
// The store is loaded once, validated and then used synchronously by
// PersistentEventLedger; every mutation must be flushed explicitly. A failed
// flush is reported, never treated as durable. Real data.json is not touched in
// this branch; tests use an injected fake data store.

const { fail } = require('../scheduling/errors.js');
const { stableStringify } = require('../scheduling/migration-hash.js');

const LEDGER_FORMAT_VERSION = 1;

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
    if (!record || typeof record !== 'object' || record.eventId !== eventId) {
      diagnostics.push({ code: 'E_LEDGER_RECORD_CORRUPT', eventId });
      continue;
    }
    records[eventId] = record;
  }
  return { records, diagnostics };
}

class PluginDataLedgerStore {
  constructor(records = {}) {
    this.records = new Map(Object.entries(records).map(([eventId, record]) => [eventId, JSON.parse(JSON.stringify(record))]));
  }

  get(eventId) {
    const record = this.records.get(eventId);
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  put(eventId, record) {
    this.records.set(eventId, JSON.parse(JSON.stringify(record)));
  }

  dump() {
    return Object.fromEntries([...this.records].map(([eventId, record]) => [eventId, JSON.parse(JSON.stringify(record))]));
  }

  serialize() {
    return { version: LEDGER_FORMAT_VERSION, records: this.dump() };
  }
}

async function openPluginDataLedger({ dataStore, key = 'mf-us1-ledger' } = {}) {
  if (!dataStore || typeof dataStore.loadData !== 'function' || typeof dataStore.saveData !== 'function') {
    fail('E_LEDGER_STORE_REQUIRED', 'loadData/saveData are required');
  }
  const raw = await dataStore.loadData(key);
  const { records, diagnostics } = validateSnapshot(raw);
  const store = new PluginDataLedgerStore(records);
  let dirty = false;
  return {
    store,
    diagnostics,
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

module.exports = { LEDGER_FORMAT_VERSION, PluginDataLedgerStore, openPluginDataLedger, validateSnapshot };
