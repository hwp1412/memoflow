'use strict';

// PR-10B — durable ledger boundary, restart and recovery (fake data store).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openPluginDataLedger,
  createObsidianPluginDataStore,
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

function validRecord(eventId = 'e1') {
  return { eventId, topicId: uuid(9), fingerprint: 'a'.repeat(64), status: 'applied' };
}

test('the ledger snapshot is versioned, serializable and reloadable', async () => {
  const dataStore = new FakeDataStore();
  const opened = await openPluginDataLedger({ dataStore, key: 'ledger' });
  assert.deepEqual(opened.diagnostics, []);
  opened.store.put('e1', validRecord());
  assert.equal(opened.isDirty(), true);
  assert.deepEqual(await opened.flush(), { ok: true });
  assert.equal(opened.isDirty(), false);
  assert.equal(dataStore.data.ledger.version, LEDGER_FORMAT_VERSION);

  const reloaded = await openPluginDataLedger({ dataStore, key: 'ledger' });
  assert.equal(reloaded.store.get('e1').status, 'applied');
  assert.equal(reloaded.healthy, true);
});

test('a corrupt version or record is diagnosed', () => {
  assert.throws(() => validateSnapshot({ version: 99, records: {} }), error => error.code === 'E_LEDGER_VERSION_UNSUPPORTED');
  const result = validateSnapshot({
    version: 1,
    records: {
      e1: { eventId: 'e1', status: 'applied' },
      e2: { eventId: 'e2' },
      e3: validRecord('e3'),
    },
  });
  assert.deepEqual(Object.keys(result.records), ['e3']);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].code, 'E_LEDGER_RECORD_CORRUPT');
});

test('a failed flush is reported instead of claimed durable and stays dirty', async () => {
  const dataStore = new FakeDataStore();
  const opened = await openPluginDataLedger({ dataStore });
  opened.store.put('e1', validRecord());
  dataStore.failSave = true;
  assert.deepEqual(await opened.flush(), { ok: false, code: 'E_LEDGER_SAVE_FAILED', message: 'disk full' });
  assert.equal(opened.isDirty(), true);
});

test('an expected ledger missing on startup is refused', async () => {
  const dataStore = new FakeDataStore();
  await assert.rejects(openPluginDataLedger({ dataStore, expectExisting: true }),
    error => error.code === 'E_LEDGER_MISSING');
});

test('a corrupt ledger is unhealthy and blocks its topics', async () => {
  const dataStore = new FakeDataStore({
    ledger: {
      version: 1,
      records: {
        broken: { eventId: 'broken' },
        pending: { eventId: 'pending', topicId: uuid(10), fingerprint: 'b'.repeat(64), status: 'prepared' },
      },
    },
  });
  const opened = await openPluginDataLedger({ dataStore, key: 'ledger' });
  assert.equal(opened.healthy, false);
  assert.ok(opened.diagnostics.some(diagnostic => diagnostic.eventId === 'broken'));
  assert.deepEqual(opened.blockedTopicIds, [uuid(10)]);
});

test('the Obsidian Plugin API adapter preserves unrelated settings and namespaces the ledger', async () => {
  const pluginData = {
    settings: { dateFormat: 'DD-MM-YYYY', keep: true },
    refine: { history: ['keep-me'] },
  };
  const plugin = {
    async loadData() { return JSON.parse(JSON.stringify(pluginData)); },
    async saveData(data) { Object.keys(pluginData).forEach(key => delete pluginData[key]); Object.assign(pluginData, JSON.parse(JSON.stringify(data))); },
  };
  const dataStore = createObsidianPluginDataStore(plugin, { key: 'mfUs1Ledger' });
  const opened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  opened.store.put('e1', validRecord());
  assert.deepEqual(await opened.flush(), { ok: true });
  assert.deepEqual(pluginData.settings, { dateFormat: 'DD-MM-YYYY', keep: true });
  assert.deepEqual(pluginData.refine, { history: ['keep-me'] });
  assert.equal(pluginData.mfUs1Ledger.version, 1);

  const reloaded = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  assert.equal(reloaded.store.get('e1').status, 'applied');
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
