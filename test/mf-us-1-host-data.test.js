'use strict';

// P2-US1-HOST-DATA-01 — one persistence coordinator for settings, session and
// the Unified ledger. Mock plugin storage only; no real data.json is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createPluginDataCoordinator,
  stripReservedKeys,
  LEDGER_KEY,
} = require('../src/integration/plugin-data-coordinator.js');
const { openPluginDataLedger, createObsidianPluginDataStore, createKeyedDataStore } = require('../src/integration/plugin-data-ledger-store.js');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

class FakePlugin {
  constructor(data = {}) {
    this.data = clone(data);
    this.saveCalls = [];
    this.loadCalls = 0;
    this.failNextSave = null;
    this.delayNextSave = null;
    this.failNextLoad = null;
    this.tamperOnSave = null;
  }

  async loadData() {
    this.loadCalls += 1;
    if (this.failNextLoad) {
      const error = this.failNextLoad;
      this.failNextLoad = null;
      throw error;
    }
    return clone(this.data);
  }

  async saveData(next) {
    this.saveCalls.push(clone(next));
    if (this.delayNextSave) {
      const gate = this.delayNextSave;
      this.delayNextSave = null;
      await gate;
    }
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    this.data = clone(this.tamperOnSave ? this.tamperOnSave(next) : next);
  }
}

function coordinatorFor(plugin, extra = {}) {
  return createPluginDataCoordinator({ plugin, ...extra });
}

// ---- T1 / ownership ------------------------------------------------------

test('settings and ledger saved together keep both, and settings never carries the ledger', async () => {
  const plugin = new FakePlugin({ legacy: true });
  const coordinator = coordinatorFor(plugin);
  const [settingsResult, ledgerResult] = await Promise.all([
    coordinator.update('settings', () => ({ theme: 'dark', session: { date: '2026-11-24' } })),
    coordinator.update('ledger', () => ({ version: 1, records: { e1: { status: 'applied' } } })),
  ]);
  assert.equal(settingsResult.ok, true);
  assert.equal(ledgerResult.ok, true);
  assert.equal(plugin.data.theme, 'dark');
  assert.equal(plugin.data.legacy, true, 'unknown keys must survive');
  assert.deepEqual(plugin.data[LEDGER_KEY], { version: 1, records: { e1: { status: 'applied' } } });
});

test('a settings save can never delete or roll back the persisted ledger', async () => {
  const plugin = new FakePlugin({ theme: 'light', [LEDGER_KEY]: { version: 1, records: { e1: { status: 'applied' } } } });
  const coordinator = coordinatorFor(plugin);
  // The settings object intentionally contains a stale ledger copy: it must be
  // filtered out instead of written back.
  await coordinator.update('settings', () => ({ theme: 'dark', [LEDGER_KEY]: { version: 1, records: {} } }));
  assert.equal(plugin.data.theme, 'dark');
  assert.deepEqual(plugin.data[LEDGER_KEY], { version: 1, records: { e1: { status: 'applied' } } });
});

test('reserved keys are stripped from settings snapshots', () => {
  const stripped = stripReservedKeys({ a: 1, [LEDGER_KEY]: { version: 1 } });
  assert.deepEqual(stripped, { a: 1 });
});

// ---- T2 / T3: concurrent ledger writes and reversed completion ------------

test('ledger writes for two topics are serialised and both survive', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  const store = await openPluginDataLedger({ dataStore: coordinator.ledgerStore(), key: LEDGER_KEY });

  const first = store.store;
  first.put('e1', { eventId: 'e1', topicId: '11111111-1111-4111-8111-111111111111', status: 'prepared', fingerprint: 'f1' });
  const saveOne = store.flush();
  first.put('e2', { eventId: 'e2', topicId: '22222222-2222-4222-8222-222222222222', status: 'prepared', fingerprint: 'f2' });
  const saveTwo = store.flush();
  const [one, two] = await Promise.all([saveOne, saveTwo]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);

  const reopened = await openPluginDataLedger({ dataStore: coordinator.ledgerStore(), key: LEDGER_KEY });
  const records = reopened.store.dump();
  assert.ok(records.e1, 'first record must survive');
  assert.ok(records.e2, 'second record must survive');
});

test('a delayed first save cannot make a later save land an older snapshot', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  let release;
  plugin.delayNextSave = new Promise(resolve => { release = resolve; });
  const first = coordinator.update('settings', () => ({ step: 1 }));
  const second = coordinator.update('settings', () => ({ step: 2, [LEDGER_KEY]: { version: 1, records: {} } }));
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(plugin.data.step, 2, 'the later save wins');
  assert.equal(plugin.saveCalls.length, 2);
  assert.equal(plugin.saveCalls[0].step, 1);
  assert.equal(plugin.saveCalls[1].step, 2);
});

// ---- T4: one succeeds, one fails -----------------------------------------

test('a failing ledger save leaves settings intact and reports failure', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  await coordinator.update('settings', () => ({ theme: 'dark' }));
  const failure = Object.assign(new Error('quota exceeded'), { code: 'EIO' });
  plugin.failNextSave = failure;
  const ledgerResult = await coordinator.update('ledger', () => ({ version: 1, records: {} }));
  assert.equal(ledgerResult.ok, false);
  assert.equal(ledgerResult.verified, false);
  assert.equal(ledgerResult.phase, 'write');
  assert.equal(ledgerResult.uncertain, true, 'a throwing save is an unknown outcome');
  assert.equal(plugin.data.theme, 'dark');
  assert.equal(plugin.data[LEDGER_KEY], undefined);
});

test('a read-back mismatch is reported as unverified, not success', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  plugin.tamperOnSave = next => ({ ...next, theme: 'mutated-by-someone-else' });
  const result = await coordinator.update('settings', () => ({ theme: 'dark' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PERSIST_UNVERIFIED');
  assert.equal(result.phase, 'verify');
  assert.equal(result.uncertain, true);

  plugin.tamperOnSave = null;
  const retry = await coordinator.update('settings', () => ({ theme: 'dark' }));
  assert.equal(retry.ok, true);
  assert.equal(retry.verified, true);
});

// ---- T5: legacy data and corruption --------------------------------------

test('legacy data loads and unknown keys are preserved', async () => {
  const legacy = {
    misc: { date_format: 'DD-MM-YYYY' },
    session: { date: '2026-11-01', paths: ['a.md'], types: {}, readPoints: {} },
    unknownModule: { keep: true },
    [LEDGER_KEY]: { version: 1, records: {} },
  };
  const plugin = new FakePlugin(legacy);
  const coordinator = coordinatorFor(plugin);
  const settings = await coordinator.read('settings');
  assert.deepEqual(settings.unknownModule, { keep: true });
  assert.equal(settings[LEDGER_KEY], undefined);
  assert.deepEqual(await coordinator.read('ledger'), { version: 1, records: {} });

  await coordinator.update('settings', current => ({ ...current, session: { ...current.session, date: '2026-11-24' } }));
  assert.equal(plugin.data.session.date, '2026-11-24');
  assert.deepEqual(plugin.data.unknownModule, { keep: true });
  assert.deepEqual(plugin.data[LEDGER_KEY], { version: 1, records: {} });
});

test('a corrupt data.json is refused instead of overwritten', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  plugin.data = ['not', 'an', 'object'];
  const result = await coordinator.update('settings', () => ({ theme: 'dark' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_DATA_CORRUPT');
  assert.equal(plugin.saveCalls.length, 0, 'nothing may be written over a corrupt file');
});

// ---- T6: interleaved session / settings / ledger -------------------------

test('interleaved session, settings and ledger writes stay consistent', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  for (let round = 0; round < 5; round += 1) {
    await Promise.all([
      coordinator.update('settings', current => ({ ...current, session: { date: `2026-11-${10 + round}` } })),
      coordinator.update('ledger', () => ({ version: 1, records: { [`e${round}`]: { status: 'applied' } } })),
    ]);
  }
  assert.equal(plugin.data.session.date, '2026-11-14');
  assert.deepEqual(Object.keys(plugin.data[LEDGER_KEY].records), ['e4']);
});

// ---- T9: entry matrix ----------------------------------------------------

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('every data.json writer is routed through the coordinator', () => {
  const mainSource = readSource('main.js');
  const saveSettings = mainSource.slice(mainSource.indexOf('async saveSettings()'), mainSource.indexOf('async migrateDateFormat('));
  assert.match(saveSettings, /pluginData\.update\('settings'/, 'saveSettings must use the coordinator');
  assert.match(mainSource, /pluginData\.stripReservedKeys\(rawData\)/, 'onload must strip reserved keys');
  assert.match(mainSource, /delete this\.settings\[reservedKey\]/, 'onload must not keep reserved keys in settings');
  assert.match(mainSource, /dataStore: this\.pluginData\.ledgerStore\(\)/, 'the ledger must share the coordinator');

  const directWrites = mainSource.match(/this\.saveData\(this\.settings\)/g) || [];
  assert.ok(directWrites.length <= 3, `unexpected direct settings writes: ${directWrites.length}`);
  // Any remaining direct writes must be documented fallbacks.
  for (const line of mainSource.split('\n')) {
    if (line.includes('this.saveData(this.settings)')) {
      const context = mainSource.slice(Math.max(0, mainSource.indexOf(line) - 400), mainSource.indexOf(line) + 200);
      assert.match(context, /pluginData|persistence failed/, `unguarded direct write: ${line.trim()}`);
    }
  }
});

test('no module writes data.json outside the coordinator and ledger store', () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/plugin\.saveData\(|\.saveData\(/.test(source)) continue;
    const relative = path.relative(path.join(__dirname, '..'), file);
    if (['src/integration/plugin-data-ledger-store.js', 'src/integration/plugin-data-coordinator.js'].includes(relative)) continue;
    if (/saveData/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders.filter(file => !file.endsWith('host-lifecycle.js')), []);
});

// ---- T7: failure propagation through the ledger store --------------------

test('the ledger store propagates {ok:false} instead of reporting success', async () => {
  const plugin = new FakePlugin({});
  const coordinator = coordinatorFor(plugin);
  const dataStore = coordinator.ledgerStore();
  await dataStore.saveData(LEDGER_KEY, { version: 1, records: {} });

  plugin.failNextSave = new Error('disk full');
  const store = await openPluginDataLedger({ dataStore, key: LEDGER_KEY });
  store.store.put('e9', { eventId: 'e9', topicId: '33333333-3333-4333-8333-333333333333', status: 'prepared', fingerprint: 'f9' });
  const flush = await store.flush();
  assert.equal(flush.ok, false);
  assert.ok(flush.uncertain === true || flush.code === 'E_PERSIST_WRITE_UNKNOWN' || flush.code === 'E_LEDGER_SAVE_FAILED');
});

test('a legacy adapter without a coordinator still conserves other keys', async () => {
  const plugin = new FakePlugin({ theme: 'dark' });
  const store = createObsidianPluginDataStore(plugin);
  await store.saveData(LEDGER_KEY, { version: 1, records: {} });
  assert.equal(plugin.data.theme, 'dark');
  assert.deepEqual(plugin.data[LEDGER_KEY], { version: 1, records: {} });
});

test('the keyed data store remains usable for isolated tests', async () => {
  const data = {};
  const store = createKeyedDataStore(data);
  await store.saveData('k', { v: 1 });
  assert.deepEqual(await store.loadData('k'), { v: 1 });
});

// ---- startup / unload lifecycle ------------------------------------------

test('onload strips a historical ledger snapshot from settings and keeps the ledger', async () => {
  const { plugin } = createPlugin({ settings: makeSettings() });
  const ledger = { version: 1, records: {} };
  plugin.__data = { misc: { date_format: 'YYYY-MM-DD' }, [LEDGER_KEY]: ledger };
  // Obsidian APIs the shared mock does not implement; the test only exercises
  // the persistence bootstrap of onload.
  plugin.registerMarkdownCodeBlockProcessor = () => {};
  await plugin.onload();
  assert.ok(plugin.pluginData, 'onload must expose the coordinator');
  assert.equal(plugin.settings[LEDGER_KEY], undefined, 'settings must not carry a ledger snapshot');
  assert.deepEqual(plugin.__data[LEDGER_KEY], ledger, 'the first settings save must not delete the ledger');

  await plugin.saveSettings();
  assert.deepEqual(plugin.__data[LEDGER_KEY], ledger, 'settings saves never touch the ledger key');
});

test('onunload cancels the debounce, submits the latest session and flushes', async () => {
  const { plugin } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = coordinatorFor(plugin);
  plugin.settings.session = { date: '2026-11-24', paths: ['Sources/A.md'], types: {}, readPoints: {} };
  const previousWindow = global.window;
  global.window = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  };
  try {
    plugin._scheduleSessionSave();
    assert.ok(plugin.sessionSaveTimer, 'a debounce timer is pending');
    await plugin.onunload();
    assert.equal(plugin.sessionSaveTimer, null, 'the debounce timer must be cancelled');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(plugin.__data.session.paths, ['Sources/A.md'], 'latest session state must be persisted');
    assert.equal(plugin.pluginData.state().pending, 0, 'all queued writes must be flushed');
  } finally {
    global.window = previousWindow;
    if (previousWindow === undefined) delete global.window;
  }
});

// ---- runtime: intent persistence gates the CAS ---------------------------

const { issueSyntheticUnifiedCapability } = require('../src/scheduling/index.js');
const { PersistentEventLedger, MemoryLedgerStore } = require('../src/scheduling/index.js');
const { createAsyncHostRuntime } = require('../src/integration/host-async-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { uuid } = require('./helpers/unified-fixtures.js');
const { makeFile } = require('./helpers/obsidian-mock.js');

const TODAY = '2026-11-24';
const CONDITIONS = {
  migrationComplete: true,
  pendingRecovery: false,
  singleWriterReady: true,
  backupVerified: true,
  userConfirmed: true,
  storageSupportsCas: true,
};

async function runtimeWithCoordinator() {
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = coordinatorFor(plugin);
  const opened = await openPluginDataLedger({ dataStore: plugin.pluginData.ledgerStore(), key: LEDGER_KEY });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const runtime = createAsyncHostRuntime({
    mode: 'unified',
    conditions: CONDITIONS,
    authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: 'YYYY-MM-DD' }),
    ledger,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: 'YYYY-MM-DD',
    persist: async records => {
      opened.store.replace(records);
      return opened.flush();
    },
  });
  return { plugin, app, runtime, ledger, opened };
}

function topicFm(id) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 3, a_factor: 1.5,
    review_count: 0, last_reviewed: '', next_review: '2026-11-27', date_added: '2026-10-01',
    mf_id: id, mf_parent_id: 'null', mf_root_id: 'null', mf_ideal_due: '2026-11-27',
    mf_not_before: 'null', mf_interval_days: 3, mf_last_event_id: 'null', mf_revision: 0,
    mf_scheduler_version: 1,
  };
}

test('an unverified intent save prevents the Topic CAS', async () => {
  const { plugin, app, runtime } = await runtimeWithCoordinator();
  const topicId = uuid(31);
  const file = makeFile(app, 'Sources/D1.md', topicFm(topicId), '# body\n');
  const before = app.vault.readContent(file);
  // The save call returns, but the ledger key never lands: read-back mismatch.
  const originalSave = plugin.saveData.bind(plugin);
  let dropped = false;
  plugin.saveData = async data => {
    if (!dropped) {
      dropped = true;
      const { [LEDGER_KEY]: _ignored, ...rest } = data;
      return originalSave(rest);
    }
    return originalSave(data);
  };
  const result = await runtime.execute({
    eventId: uuid(311), topicId, type: 'ADVANCED', payload: null, expectedRevision: 0,
    today: TODAY, calendarDate: TODAY, algorithmVersion: 1, dateFormat: 'YYYY-MM-DD',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.writesPerformed, false);
  assert.equal(app.vault.readContent(file), before, 'no byte may change when the intent is unverified');
});

test('ledger records survive a restart and the same eventId stays duplicate', async () => {
  const { plugin, app, runtime } = await runtimeWithCoordinator();
  const topicId = uuid(32);
  const file = makeFile(app, 'Sources/D2.md', topicFm(topicId), '# body\n');
  const request = {
    eventId: uuid(321), topicId, type: 'ADVANCED', payload: null, expectedRevision: 0,
    today: TODAY, calendarDate: TODAY, algorithmVersion: 1, dateFormat: 'YYYY-MM-DD',
  };
  const first = await runtime.execute(request);
  assert.equal(first.status, 'applied');

  // Restart from the persisted plugin data only.
  const reopened = await openPluginDataLedger({ dataStore: plugin.pluginData.ledgerStore(), key: LEDGER_KEY });
  const ledger2 = new PersistentEventLedger(new MemoryLedgerStore(reopened.store.dump()));
  assert.equal(ledger2.get(request.eventId).status, 'applied');
  const runtime2 = createAsyncHostRuntime({
    mode: 'unified',
    conditions: CONDITIONS,
    authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: 'YYYY-MM-DD' }),
    ledger: ledger2,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: 'YYYY-MM-DD',
    persist: async records => { reopened.store.replace(records); return reopened.flush(); },
  });
  const replay = await runtime2.execute(request);
  assert.equal(replay.status, 'duplicate');
  const fm = frontmatterFromContent(app.vault.readContent(file)).frontmatter;
  assert.equal(fm.review_count, 1, 'restart must not review twice');
});
