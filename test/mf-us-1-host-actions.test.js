'use strict';

// P2-US1-HOST-ACTIONS-01 — POSTPONE / MANUAL_SCHEDULE / SET_PRIORITY through
// the real host entries. Mock Obsidian, synthetic topics, isolated storage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PersistentEventLedger, MemoryLedgerStore, issueSyntheticUnifiedCapability, addCalendarDays, selectDailyQueue } = require('../src/scheduling/index.js');
const { createAsyncHostRuntime } = require('../src/integration/host-async-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { openPluginDataLedger } = require('../src/integration/plugin-data-ledger-store.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { createPlugin, makeFile, makeSettings, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const DATE_FORMAT = 'YYYY-MM-DD';
const CONDITIONS = {
  migrationComplete: true,
  pendingRecovery: false,
  singleWriterReady: true,
  backupVerified: true,
  userConfirmed: true,
  storageSupportsCas: true,
};

function topicFm(id, overrides = {}) {
  return {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 1.6,
    review_count: 3, last_reviewed: '2026-10-01', next_review: '2026-11-20',
    date_added: '2026-09-01',
    mf_id: id, mf_parent_id: 'null', mf_root_id: 'null',
    mf_ideal_due: '2026-11-20', mf_not_before: 'null', mf_interval_days: 8,
    mf_last_event_id: 'null', mf_revision: 0, mf_scheduler_version: 1,
    ...overrides,
  };
}

function fmOf(app, file) {
  return frontmatterFromContent(app.vault.readContent(file)).frontmatter;
}

async function harness({ mode = 'unified', saveHook = null, authorization = issueSyntheticHostAuthorization() } = {}) {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.settings.mf_us1_mode = mode;
  plugin.pluginData = createPluginDataCoordinator({ plugin, notice: () => {} });
  const opened = await openPluginDataLedger({ dataStore: plugin.pluginData.ledgerStore(), key: 'mfUs1Ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const storage = createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT });
  let saves = 0;
  let releasePending = null;
  const persist = async records => {
    saves += 1;
    if (typeof saveHook === 'function') {
      const decision = await saveHook(saves);
      if (releasePending) { const release = releasePending; releasePending = null; await release; }
      if (decision) return decision;
    }
    opened.store.replace(records);
    return opened.flush();
  };
  const runtime = createAsyncHostRuntime({
    mode, conditions: CONDITIONS, authorization, storage, ledger,
    capability: issueSyntheticUnifiedCapability(), dateFormat: DATE_FORMAT, persist,
  });
  plugin.__mfUs1UnifiedTransport = request => runtime.execute(request);
  return { plugin, app, runtime, ledger, opened, storage, saveCount: () => saves };
}

function advanceDate(plugin, days) {
  const base = new Date(`${plugin._todayKey()}T00:00:00`);
  base.setDate(base.getDate() + days);
  return plugin.mfUs1TestIso ? plugin.mfUs1TestIso(base) : isoOf(base);
}

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ---- POSTPONE ------------------------------------------------------------

test('reading-bar postpone writes mf_not_before and leaves learning fields untouched', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/A.md', topicFm(uuid(1)), '# body\n');
  const before = fmOf(app, file);
  const target = plugin._todayKey();

  const result = await plugin._postponeReadingFile(file, 3);
  assert.equal(result.status, 'applied');

  const after = fmOf(app, file);
  assert.equal(after.mf_not_before, addCalendarDays(target, 3) > after.mf_ideal_due ? addCalendarDays(target, 3) : after.mf_ideal_due);
  assert.equal(after.mf_interval_days, before.mf_interval_days, 'interval must not change');
  assert.equal(Number(after.a_factor), Number(before.a_factor), 'A-Factor must not change');
  assert.equal(Number(after.review_count), Number(before.review_count), 'review count must not change');
  assert.equal(after.mf_ideal_due, before.mf_ideal_due, 'ideal due must not change');
  assert.equal(after.last_reviewed, before.last_reviewed, 'last reviewed must not change');
  assert.equal(Number(after.mf_revision), 1);
});

test('postponing twice never brings an existing not_before date forward', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/B.md', topicFm(uuid(2)), '# body\n');
  await plugin._postponeReadingFile(file, 14);
  const first = fmOf(app, file).mf_not_before;
  const second = await plugin._postponeReadingFile(file, 1);
  assert.equal(second.status, 'no-op');
  assert.equal(second.reason, 'NO_LATER_THAN_EXISTING');
  assert.equal(fmOf(app, file).mf_not_before, first);
  assert.equal(Number(fmOf(app, file).mf_revision), 1, 'a no-op does not bump the revision');
});

test('the menu postpone entry shares the same host entry', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/C.md', topicFm(uuid(3)), '# body\n');
  const result = await plugin.postponeFile(file, 2);
  assert.equal(result.status, 'applied');
  assert.equal(Number(fmOf(app, file).mf_revision), 1);
});

// ---- MANUAL_SCHEDULE -----------------------------------------------------

test('manual schedule sets ideal due, clears a stale not_before and keeps the interval', async () => {
  const { plugin, app, opened } = await harness();
  const file = makeFile(app, 'Sources/D.md', topicFm(uuid(4), { mf_not_before: '2026-12-20' }), '# body\n');
  const target = '2026-12-10';
  const result = await plugin.scheduleFile(file, target);
  assert.equal(result.status, 'applied');
  const after = fmOf(app, file);
  assert.equal(after.mf_ideal_due, target);
  assert.equal(after.mf_not_before, null, 'stale administrative delay must be cleared');
  assert.equal(after.mf_interval_days, 8, 'real interval must survive');
  assert.equal(Number(after.review_count), 3, 'review history must survive');

  // The manual override reason must survive in the durable ledger record.
  const record = Object.values(opened.store.dump()).find(item => item.type === 'MANUAL_SCHEDULE');
  assert.ok(record, 'a MANUAL_SCHEDULE record must be persisted');
  assert.equal(record.status, 'applied');
  assert.equal(record.payload.reason, 'manual-schedule');
  assert.equal(record.payload.idealDue, target);
  assert.equal(record.audit.after.idealDue, target);
});

test('the popover manual-schedule prompt cancels without an event', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/E.md', topicFm(uuid(5)), '# body\n');
  const before = app.vault.readContent(file);
  app.__promptState.texts = ['']; // user confirms empty input = cancel
  const result = await plugin._promptManualSchedule(file);
  assert.equal(result, null);
  assert.equal(app.vault.readContent(file), before);
});

test('the popover manual-schedule prompt accepts a relative offset', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/F.md', topicFm(uuid(6)), '# body\n');
  app.__promptState.texts = ['+7'];
  const result = await plugin._promptManualSchedule(file);
  assert.equal(result.status, 'applied');
  assert.equal(fmOf(app, file).mf_ideal_due, addCalendarDays(plugin._todayKey(), 7));
});

// ---- SET_PRIORITY --------------------------------------------------------

for (const kind of ['source', 'extract']) {
  test(`set priority on a ${kind} changes only the priority`, async () => {
    const { plugin, app } = await harness();
    const file = makeFile(app, `${kind === 'source' ? 'Sources' : 'Extracts'}/${kind}.md`,
      topicFm(uuid(kind === 'source' ? 10 : 11), { type: kind }), '# body\n');
    const before = fmOf(app, file);
    const result = await plugin.setPriorityFile(file, 12);
    assert.equal(result.status, 'applied');
    const after = fmOf(app, file);
    assert.equal(Number(after.priority), 12);
    assert.equal(after.mf_interval_days, before.mf_interval_days);
    assert.equal(Number(after.a_factor), Number(before.a_factor));
    assert.equal(after.mf_ideal_due, before.mf_ideal_due);
    assert.equal(Number(after.review_count), Number(before.review_count));
    assert.equal(Number(after.mf_revision), 1);
  });
}

test('a priority change immediately affects the MF-US-1 queue ordering', async () => {
  const { plugin, app } = await harness();
  const first = makeFile(app, 'Sources/P1.md', topicFm(uuid(12), { priority: 80, mf_ideal_due: '2026-11-20' }), '# a\n');
  makeFile(app, 'Sources/P2.md', topicFm(uuid(13), { priority: 40, mf_ideal_due: '2026-11-20' }), '# b\n');
  await plugin.setPriorityFile(first, 10);
  const topics = ['Sources/P1.md', 'Sources/P2.md'].map(p => {
    const file = app.vault.getAbstractFileByPath(p);
    return { path: p, ...fmOf(app, file) };
  });
  const queue = selectDailyQueue(topics, undefined, '2026-11-25');
  const order = queue.selected.map(item => item.stableId);
  assert.equal(order[0], uuid(12), 'raised priority must sort first');
});

test('an invalid priority or postpone value is rejected before any write', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/G.md', topicFm(uuid(14)), '# body\n');
  const before = app.vault.readContent(file);
  assert.equal((await plugin.setPriorityFile(file, 0)).status, 'failed');
  assert.equal((await plugin.setPriorityFile(file, 101)).status, 'failed');
  assert.equal((await plugin.postponeFile(file, 0)).status, 'failed');
  assert.equal((await plugin.scheduleFile(file, '2026-13-40')).status, 'failed');
  assert.equal(app.vault.readContent(file), before);
});

// ---- safety paths --------------------------------------------------------

test('an external edit between read and CAS is a conflict and is never overwritten', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/H.md', topicFm(uuid(15)), '# body\n');
  const originalProcess = app.vault.process.bind(app.vault);
  let injected = false;
  app.vault.process = async (target, fn) => {
    if (!injected) {
      // Simulate another writer touching the file after the runtime read it.
      injected = true;
      const entry = app.vault.entries.get(target.path);
      entry.content = entry.content.replace('mf_revision: 0', 'mf_revision: 9');
      entry.frontmatter = { ...entry.frontmatter, mf_revision: 9 };
    }
    return originalProcess(target, fn);
  };
  const result = await plugin.setPriorityFile(file, 25);
  assert.equal(result.status, 'conflict');
  const after = app.vault.readContent(file);
  assert.ok(after.includes('mf_revision: 9'), 'the external edit must survive untouched');
  assert.equal(after.includes('priority: 25'), false);
  app.vault.process = originalProcess;
});

test('an intent save failure prevents any field change', async () => {
  const { plugin, app } = await harness({ saveHook: () => ({ ok: false, code: 'E_LEDGER_SAVE_FAILED' }) });
  const file = makeFile(app, 'Sources/I.md', topicFm(uuid(16)), '# body\n');
  const before = app.vault.readContent(file);
  const result = await plugin.postponeFile(file, 3);
  assert.equal(result.status, 'failed');
  assert.equal(app.vault.readContent(file), before);
});

test('a result-confirmation failure is uncertain and shows no success', async () => {
  const { plugin, app } = await harness({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const file = makeFile(app, 'Sources/J.md', topicFm(uuid(17)), '# body\n');
  getNotices(app).length = 0;
  const result = await plugin.setPriorityFile(file, 30);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.confirmed, false);
  assert.doesNotMatch(result.message, /优先级 → P30/);
  assert.match(result.message, /尚未确认/);
});

test('a restart recovers the uncertain priority without double applying', async () => {
  const { plugin, app, opened } = await harness({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const file = makeFile(app, 'Sources/K.md', topicFm(uuid(18)), '# body\n');
  const result = await plugin.setPriorityFile(file, 33, { quiet: true });
  assert.equal(result.status, 'uncertain');

  const reopened = await openPluginDataLedger({ dataStore: plugin.pluginData.ledgerStore(), key: 'mfUs1Ledger' });
  const ledger2 = new PersistentEventLedger(new MemoryLedgerStore(reopened.store.dump()));
  const runtime2 = createAsyncHostRuntime({
    mode: 'unified', conditions: CONDITIONS, authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT }),
    ledger: ledger2, capability: issueSyntheticUnifiedCapability(), dateFormat: DATE_FORMAT,
    persist: async records => { reopened.store.replace(records); return reopened.flush(); },
  });
  const recovery = await runtime2.recover();
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recovered[0].status, 'applied');
  const after = fmOf(app, file);
  assert.equal(Number(after.priority), 33);
  assert.equal(Number(after.mf_revision), 1, 'recovery must not apply twice');
  assert.equal(ledger2.get(fmOf(app, file).mf_last_event_id).status, 'applied');
});

// ---- mode isolation ------------------------------------------------------

test('legacy mode keeps the legacy postpone fields and never writes mf_not_before', async () => {
  const { plugin, app } = await harness({ mode: 'legacy' });
  const file = makeFile(app, 'Sources/L.md', topicFm(uuid(19)), '# body\n');
  const before = app.vault.readFm(file);
  const result = await plugin._postponeReadingFile(file, 3);
  assert.equal(result.status, 'legacy');
  const after = app.vault.readFm(file);
  assert.notEqual(after.next_review, before.next_review);
  assert.equal(String(after.mf_not_before), 'null', 'legacy writer must not touch MF-US-1 fields');
  assert.equal(Number(after.mf_revision), 0);
});

test('unified mode never calls the legacy writer', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/M.md', topicFm(uuid(20)), '# body\n');
  let legacyCalls = 0;
  const original = plugin._postponeLegacyWrite.bind(plugin);
  plugin._postponeLegacyWrite = (...args) => { legacyCalls += 1; return original(...args); };
  await plugin._postponeReadingFile(file, 4);
  assert.equal(legacyCalls, 0);
});

test('shadow mode still runs the legacy writer and writes nothing new', async () => {
  const { plugin, app, opened } = await harness({ mode: 'shadow' });
  const file = makeFile(app, 'Sources/N.md', topicFm(uuid(21)), '# body\n');
  const result = await plugin._postponeReadingFile(file, 2);
  assert.equal(result.status, 'legacy');
  const after = app.vault.readFm(file);
  assert.equal(String(after.mf_not_before), 'null');
  assert.equal(Number(after.mf_revision), 0);
  assert.equal(Object.keys(opened.store.dump()).length, 0, 'shadow writes no ledger record');
});

// ---- Card / boost --------------------------------------------------------

test('a card is refused before any write', async () => {
  const { plugin, app } = await harness();
  const card = makeFile(app, 'Cards/C1.md', { type: 'card', status: 'active', mf_id: uuid(22), mf_revision: 0 }, '# card\n');
  const before = app.vault.readContent(card);
  const result = await plugin.setPriorityFile(card, 20);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'E_TOPIC_NOT_SCHEDULABLE');
  assert.equal(app.vault.readContent(card), before);
});

test('boost in unified mode routes to batch events and writes nothing without authorization', async () => {
  const { plugin, app } = await harness({ authorization: null });
  const file = makeFile(app, 'Sources/O.md', topicFm(uuid(23)), '# body\n');
  app.activeFile = file;
  app.__promptState.quality = 5;
  app.__promptState.confirm = true;
  const before = app.vault.readContent(file);
  const result = await plugin.boost();
  // Without a host authorization the per-node SET_PRIORITY events fail closed;
  // the legacy writer must never run.
  assert.ok(result === null || result.status !== 'applied', JSON.stringify(result && result.status));
  assert.equal(app.vault.readContent(file), before);
});

// ---- static wiring -------------------------------------------------------

test('every UI surface for the three actions routes through the host entries', () => {
  const root = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const srcSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(srcSource, /async _postponeReadingFile\(file, days\) \{\s*return this\.postponeFile\(/);
  assert.match(srcSource, /case 'schedule':\s*await this\._promptManualSchedule\(file\)/);
  assert.match(srcSource, /add\('手动排期…', 'schedule'\)/);
  assert.match(srcSource, /this\.setPriorityFile\(file, next, \{/);
  assert.match(mainSource, /async postponeFile\(/);
  assert.match(mainSource, /async scheduleFile\(/);
  assert.match(mainSource, /async setPriorityFile\(/);
  assert.match(mainSource, /async boostUnified\(/);
  assert.match(mainSource, /applyBoostBatch\(/);
});

// ---- 1. session behaviour behind _runReadingAction('postpone') -----------

async function sessionCounters(plugin, app) {
  const counters = { consumed: 0, next: 0 };
  plugin._activateReadingFile = async () => {};
  plugin._nextSessionTarget = () => null;
  plugin.consumeSessionItem = async () => { counters.consumed += 1; };
  plugin._openNextSessionTarget = async () => { counters.next += 1; };
  return counters;
}

test('an applied postpone advances the session once', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/S1.md', topicFm(uuid(30)), '# body\n');
  const counters = await sessionCounters(plugin, app);
  await plugin._runReadingAction('postpone', file, { days: 1 });
  assert.deepEqual(counters, { consumed: 1, next: 1 });
});

test('a failed postpone keeps the reader on the current topic', async () => {
  const { plugin, app } = await harness({ saveHook: () => ({ ok: false, code: 'E_LEDGER_SAVE_FAILED' }) });
  const file = makeFile(app, 'Sources/S2.md', topicFm(uuid(31)), '# body\n');
  const counters = await sessionCounters(plugin, app);
  const notices = getNotices(app);
  notices.length = 0;
  await plugin._runReadingAction('postpone', file, { days: 2 });
  assert.deepEqual(counters, { consumed: 0, next: 0 });
  assert.doesNotMatch(notices.join('\n'), /已延期/);
});

test('a conflicting postpone does not advance or claim success', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/S3.md', topicFm(uuid(32)), '# body\n');
  const counters = await sessionCounters(plugin, app);
  const originalProcess = app.vault.process.bind(app.vault);
  let injected = false;
  app.vault.process = async (target, fn) => {
    if (!injected) {
      injected = true;
      const entry = app.vault.entries.get(target.path);
      entry.content = entry.content.replace('mf_revision: 0', 'mf_revision: 7');
      entry.frontmatter = { ...entry.frontmatter, mf_revision: 7 };
    }
    return originalProcess(target, fn);
  };
  const notices = getNotices(app);
  notices.length = 0;
  await plugin._runReadingAction('postpone', file, { days: 2 });
  app.vault.process = originalProcess;
  assert.deepEqual(counters, { consumed: 0, next: 0 });
  assert.doesNotMatch(notices.join('\n'), /已延期/);
  assert.match(notices.join('\n'), /写入被拒绝/);
});

test('an uncertain postpone does not advance and says so', async () => {
  const { plugin, app } = await harness({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const file = makeFile(app, 'Sources/S4.md', topicFm(uuid(33)), '# body\n');
  const counters = await sessionCounters(plugin, app);
  const notices = getNotices(app);
  notices.length = 0;
  await plugin._runReadingAction('postpone', file, { days: 2 });
  assert.deepEqual(counters, { consumed: 0, next: 0 });
  assert.match(notices.join('\n'), /尚未确认/);
});

test('a no-op postpone (already postponed further) does not advance', async () => {
  const { plugin, app } = await harness();
  const file = makeFile(app, 'Sources/S5.md', topicFm(uuid(34)), '# body\n');
  const counters = await sessionCounters(plugin, app);
  await plugin._runReadingAction('postpone', file, { days: 14 });
  assert.deepEqual(counters, { consumed: 1, next: 1 });
  await plugin._runReadingAction('postpone', file, { days: 1 });
  assert.deepEqual(counters, { consumed: 1, next: 1 }, 'a no-op must not advance again');
});

// ---- 3. UI retry after uncertain ----------------------------------------

test('after an uncertain write the next click is blocked, and recovery does not double apply', async () => {
  const { plugin, app, runtime } = await harness({ saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null) });
  const file = makeFile(app, 'Sources/S6.md', topicFm(uuid(35)), '# body\n');
  const first = await plugin.postponeFile(file, 5, { quiet: true });
  assert.equal(first.status, 'uncertain');
  const notBeforeAfterFirst = fmOf(app, file).mf_not_before;
  assert.ok(notBeforeAfterFirst);

  const retryWhileUnresolved = await plugin.postponeFile(file, 5, { quiet: true });
  assert.equal(retryWhileUnresolved.status, 'requires-manual-recovery');
  assert.equal(retryWhileUnresolved.reason, 'E_TOPIC_INTENT_STATE_UNKNOWN');
  assert.equal(fmOf(app, file).mf_not_before, notBeforeAfterFirst, 'the blocked retry wrote nothing');

  const recovery = await runtime.recover();
  assert.equal(recovery.recovered[0].status, 'applied');
  const revisionAfterRecovery = Number(fmOf(app, file).mf_revision);

  const retryAfterRecovery = await plugin.postponeFile(file, 5, { quiet: true });
  assert.equal(retryAfterRecovery.status, 'no-op', 'rerunning the same postpone cannot move the date twice');
  assert.equal(fmOf(app, file).mf_not_before, notBeforeAfterFirst);
  assert.equal(Number(fmOf(app, file).mf_revision), revisionAfterRecovery, 'a no-op does not bump the revision again');
});
