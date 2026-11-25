'use strict';

// PR-10B — durable ledger boundary, restart and recovery (fake data store).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openPluginDataLedger,
  validateSnapshot,
  LEDGER_FORMAT_VERSION,
} = require('../src/integration/plugin-data-ledger-store.js');
const {
  executeUnifiedEvent,
  reconcileUnifiedEvent,
  PersistentEventLedger,
  MemoryLedgerStore,
  SyntheticUnifiedStorage,
  issueSyntheticUnifiedCapability,
  sha256Hex,
} = require('../src/scheduling/index.js');
const { makeTopic, makeRequest, uuid } = require('./helpers/unified-fixtures.js');

class FakeDataStore {
  constructor(initial = {}) {
    this.data = JSON.parse(JSON.stringify(initial));
    this.failSave = false;
  }

  async loadData(key) {
    return this.data[key] ?? null;
  }

  async saveData(key, value) {
    if (this.failSave) throw new Error('disk full');
    this.data[key] = JSON.parse(JSON.stringify(value));
  }
}

function depsFor(topic, ledger) {
  const storage = new SyntheticUnifiedStorage({ [topic.path]: topic.entry });
  return {
    storage,
    ledger,
    deps: {
      mode: { mode: 'unified' },
      storage,
      ledger,
      capability: issueSyntheticUnifiedCapability(),
    },
  };
}

test('the ledger snapshot is versioned, serializable and reloadable', async () => {
  const dataStore = new FakeDataStore();
  const opened = await openPluginDataLedger({ dataStore, key: 'ledger' });
  assert.deepEqual(opened.diagnostics, []);
  opened.store.put('e1', { eventId: 'e1', status: 'applied' });
  assert.deepEqual(await opened.flush(), { ok: true });
  assert.equal(dataStore.data.ledger.version, LEDGER_FORMAT_VERSION);

  const reloaded = await openPluginDataLedger({ dataStore, key: 'ledger' });
  assert.equal(reloaded.store.get('e1').status, 'applied');
});

test('a corrupt version or record is diagnosed', () => {
  assert.throws(() => validateSnapshot({ version: 99, records: {} }), error => error.code === 'E_LEDGER_VERSION_UNSUPPORTED');
  const result = validateSnapshot({ version: 1, records: { e1: { status: 'applied' }, e2: { eventId: 'e2' } } });
  assert.equal(Object.keys(result.records).length, 1);
  assert.equal(result.diagnostics[0].code, 'E_LEDGER_RECORD_CORRUPT');
});

test('a failed flush is reported instead of claimed durable', async () => {
  const dataStore = new FakeDataStore();
  const opened = await openPluginDataLedger({ dataStore });
  dataStore.failSave = true;
  assert.deepEqual(await opened.flush(), { ok: false, code: 'E_LEDGER_SAVE_FAILED', message: 'disk full' });
});

test('E1 -> E2 -> E1 stays idempotent across a ledger reload', async () => {
  const topic = makeTopic({ seq: 1 });
  const memory = new MemoryLedgerStore();
  const ledger = new PersistentEventLedger(memory);
  const context = depsFor(topic, ledger);
  const e1 = makeRequest(topic, { eventId: uuid(1001) });
  const e2 = makeRequest(topic, { eventId: uuid(1002), expectedRevision: 2, today: '2026-11-25', calendarDate: '2026-11-25' });
  assert.equal(executeUnifiedEvent(e1, context.deps).status, 'applied');
  assert.equal(executeUnifiedEvent(e2, context.deps).status, 'applied');

  const dataStore = new FakeDataStore({ ledger: { version: 1, records: memory.dump() } });
  const opened = await openPluginDataLedger({ dataStore, key: 'ledger' });
  const reloaded = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const replay = executeUnifiedEvent({ ...e1, expectedRevision: 1 }, { ...context.deps, ledger: reloaded });
  assert.equal(replay.status, 'duplicate');
  assert.equal(context.storage.read(topic.path).frontmatter.review_count, 5);
});

test('a prepared record survives reload and reconciles to applied', async () => {
  const topic = makeTopic({ seq: 2 });
  const memory = new MemoryLedgerStore();
  const ledger = new PersistentEventLedger(memory);
  const context = depsFor(topic, ledger);
  const request = makeRequest(topic, { eventId: uuid(1003) });
  executeUnifiedEvent(request, context.deps);

  const record = memory.get(request.eventId);
  const persisted = { ...record, status: 'prepared', afterHash: null };
  const dataStore = new FakeDataStore({ ledger: { version: 1, records: { [request.eventId]: persisted } } });
  const opened = await openPluginDataLedger({ dataStore, key: 'ledger' });
  const reloaded = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));

  const reconciled = reconcileUnifiedEvent(request.eventId, { storage: context.storage, ledger: reloaded });
  assert.equal(reconciled.status, 'applied');
  assert.equal(reconciled.writesPerformed, false);
  assert.equal(context.storage.read(topic.path).frontmatter.review_count, 4);
});

test('a body or path never appears in the persisted ledger', async () => {
  const topic = makeTopic({ seq: 3 });
  const memory = new MemoryLedgerStore();
  const ledger = new PersistentEventLedger(memory);
  const context = depsFor(topic, ledger);
  const request = makeRequest(topic, { eventId: uuid(1004) });
  executeUnifiedEvent(request, context.deps);

  const serialized = JSON.stringify({ version: 1, records: memory.dump() });
  assert.equal(serialized.includes('Body text'), false);
  assert.equal(serialized.includes('Sources/'), false);
});
