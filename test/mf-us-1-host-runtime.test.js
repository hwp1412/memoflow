'use strict';

// P2-US1-HOST-RUNTIME-01 — async production host chain, from the real plugin
// entry to MF-US-1, the Obsidian adapter, the ledger and back.
//
// Only Mock Obsidian + in-memory data are used: no real Vault, no Obsidian.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PersistentEventLedger, MemoryLedgerStore, issueSyntheticUnifiedCapability } = require('../src/scheduling/index.js');
const { createAsyncHostRuntime } = require('../src/integration/host-async-runtime.js');
const { createObsidianAsyncTopicStorage, createVaultTopicResolver, frontmatterFromContent } = require('../src/integration/host-async-storage.js');
const { openPluginDataLedger, createKeyedDataStore } = require('../src/integration/plugin-data-ledger-store.js');
const { issueSyntheticHostAuthorization } = require('../src/integration/host-runtime.js');
const { createPlugin, makeFile, getNotices } = require('./helpers/obsidian-mock.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';
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
    type: 'source',
    status: 'active',
    priority: 50,
    interval: 3,
    a_factor: 1.5,
    review_count: 0,
    last_reviewed: '',
    next_review: '2026-11-27',
    date_added: '2026-10-01',
    mf_id: id,
    mf_parent_id: 'null',
    mf_root_id: 'null',
    mf_ideal_due: '2026-11-27',
    mf_not_before: 'null',
    mf_interval_days: 3,
    mf_last_event_id: 'null',
    mf_revision: 0,
    mf_scheduler_version: 1,
    custom_field: 'keep-me',
    ...overrides,
  };
}

function addTopic(app, path, id, overrides = {}) {
  return makeFile(app, path, topicFm(id, overrides), '# Body\n\nKeep this paragraph exactly.\n');
}

function content(app, file) {
  return app.vault.readContent(file);
}

function fmOf(app, file) {
  return frontmatterFromContent(content(app, file)).frontmatter;
}

async function harness({ saveHook = null, mode = 'unified', authorization = issueSyntheticHostAuthorization(), conditions = CONDITIONS } = {}) {
  const { plugin, app } = createPlugin();
  plugin.settings.mf_us1_mode = mode;
  const dataStore = createKeyedDataStore({});
  const opened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const storage = createObsidianAsyncTopicStorage({
    app,
    resolveFile: createVaultTopicResolver({ app }),
    dateFormat: DATE_FORMAT,
  });
  let saves = 0;
  const persist = async records => {
    saves += 1;
    if (typeof saveHook === 'function') {
      const decision = saveHook(saves, records);
      if (decision) return decision;
    }
    opened.store.replace(records);
    return opened.flush();
  };
  const runtime = createAsyncHostRuntime({
    mode,
    conditions,
    authorization,
    storage,
    ledger,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: DATE_FORMAT,
    persist,
  });
  plugin.__mfUs1UnifiedTransport = request => runtime.execute(request);
  return { plugin, app, runtime, ledger, opened, storage, dataStore, saveCount: () => saves };
}

// ---- 1. real host entry → algorithm → async storage → ledger --------------

test('a real host grading entry applies one Unified event end to end', async () => {
  const { plugin, app, ledger } = await harness();
  const id = uuid(1);
  const file = addTopic(app, 'Sources/A.md', id);
  let legacyCalls = 0;
  plugin._gradeTopicLegacy = () => { legacyCalls += 1; throw new Error('legacy writer must not run in unified mode'); };

  const result = await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  assert.ok(result);
  assert.equal(legacyCalls, 0, 'the unified path must never call the Toolkit legacy writer');

  const fm = fmOf(app, file);
  assert.equal(fm.mf_revision, 1);
  assert.equal(fm.review_count, 1);
  assert.ok(fm.mf_interval_days > 3, 'ADVANCED must extend the interval');
  assert.match(String(fm.mf_last_event_id), /^[0-9a-f-]{36}$/);
  assert.equal(fm.status, 'active');
  assert.equal(fm.custom_field, 'keep-me');
  assert.match(content(app, file), /Keep this paragraph exactly\./);

  const record = ledger.get(fm.mf_last_event_id);
  assert.equal(record.status, 'applied');
  assert.equal(record.writesPerformed, true);
});

test('the same eventId retried does not review twice', async () => {
  const { plugin, app, ledger, runtime } = await harness();
  const file = addTopic(app, 'Sources/B.md', uuid(2));
  await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  const afterFirst = fmOf(app, file);
  const before = content(app, file);

  const replay = await runtime.execute({
    eventId: afterFirst.mf_last_event_id,
    topicId: afterFirst.mf_id,
    type: 'ADVANCED',
    payload: null,
    expectedRevision: 0,
    today: TODAY,
    calendarDate: TODAY,
    algorithmVersion: 1,
    dateFormat: DATE_FORMAT,
  });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.writesPerformed, false);
  assert.equal(content(app, file), before);
  assert.equal(fmOf(app, file).review_count, 1);
  assert.equal(ledger.get(afterFirst.mf_last_event_id).status, 'applied');
});

// ---- 3. intent persistence failure ---------------------------------------

test('a failed intent save leaves the topic untouched', async () => {
  const { plugin, app } = await harness({ saveHook: () => ({ ok: false, code: 'E_LEDGER_SAVE_FAILED' }) });
  const file = addTopic(app, 'Sources/C.md', uuid(3));
  const before = content(app, file);
  const result = await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  assert.equal(result.writesPerformed, false);
  assert.ok(['E_INTENT_PERSIST_FAILED', 'E_LEDGER_SAVE_FAILED'].includes(result.reason));
  assert.equal(content(app, file), before, 'no byte may change before the intent is durable');
});

// ---- 4. applied but ledger confirmation fails ----------------------------

test('a ledger save failure after the write is uncertain and recovers without re-review', async () => {
  const { plugin, app, dataStore } = await harness({
    saveHook: count => (count === 2 ? { ok: false, code: 'E_LEDGER_SAVE_FAILED' } : null),
  });
  const file = addTopic(app, 'Sources/D.md', uuid(4));
  const result = await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.requiresManualRecovery, true);
  assert.equal(result.writesPerformed, true);
  const afterWrite = fmOf(app, file);
  assert.equal(afterWrite.mf_revision, 1);

  // Restart: reload the durable ledger and reconcile against real bytes.
  const reopened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  const ledger2 = new PersistentEventLedger(new MemoryLedgerStore(reopened.store.dump()));
  const runtime2 = createAsyncHostRuntime({
    mode: 'unified',
    conditions: CONDITIONS,
    authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT }),
    ledger: ledger2,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: DATE_FORMAT,
    persist: async records => { reopened.store.replace(records); return reopened.flush(); },
  });
  const recovery = await runtime2.recover();
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recovered[0].status, 'applied');
  const fm = fmOf(app, file);
  assert.equal(fm.mf_revision, 1, 'recovery must not bump the revision again');
  assert.equal(fm.review_count, 1, 'recovery must not review twice');
});

// ---- 5. external edit / revision conflict --------------------------------

test('an external revision change is a conflict and is never overwritten', async () => {
  const { plugin, app } = await harness();
  const file = addTopic(app, 'Sources/E.md', uuid(5));
  const staleFm = fmOf(app, file);
  // External writer bumps the persisted revision before the host event runs.
  await app.vault.process(file, data => data.replace('mf_revision: 0', 'mf_revision: 1'));
  const before = content(app, file);
  const result = await plugin._gradeTopic(file, staleFm, TODAY);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_REVISION_MISMATCH');
  assert.equal(content(app, file), before);
});

// ---- 6. restart idempotency ----------------------------------------------

test('a restart with a duplicate eventId returns duplicate without writing', async () => {
  const { plugin, app, ledger, dataStore } = await harness();
  const file = addTopic(app, 'Sources/F.md', uuid(6));
  await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  const applied = fmOf(app, file);
  const before = content(app, file);

  const reopened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  const ledger2 = new PersistentEventLedger(new MemoryLedgerStore(reopened.store.dump()));
  assert.equal(ledger2.get(applied.mf_last_event_id).status, 'applied');

  const runtime2 = createAsyncHostRuntime({
    mode: 'unified',
    conditions: CONDITIONS,
    authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT }),
    ledger: ledger2,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: DATE_FORMAT,
    persist: async records => { reopened.store.replace(records); return reopened.flush(); },
  });
  const result = await runtime2.execute({
    eventId: applied.mf_last_event_id,
    topicId: applied.mf_id,
    type: 'ADVANCED',
    payload: null,
    expectedRevision: 0,
    today: TODAY,
    calendarDate: TODAY,
    algorithmVersion: 1,
    dateFormat: DATE_FORMAT,
  });
  assert.equal(result.status, 'duplicate');
  assert.equal(content(app, file), before);
  assert.equal(ledger.get(applied.mf_last_event_id).status, 'applied');
});

// ---- 7. production gate --------------------------------------------------

test('without the synthetic authorization the host entry fails closed and writes nothing', async () => {
  const { plugin, app } = await harness({ authorization: null });
  const file = addTopic(app, 'Sources/G.md', uuid(7));
  const before = content(app, file);
  await assert.rejects(
    () => plugin._gradeTopic(file, fmOf(app, file), TODAY),
    error => error.code === 'E_HOST_MODE_BLOCKED'
      || (error.blockers || []).includes('RUNTIME_AUTHORIZATION_REQUIRED'),
  );
  assert.equal(content(app, file), before);
});

test('a unified setting without an injected transport still refuses and never runs legacy', async () => {
  const { plugin, app } = await harness();
  delete plugin.__mfUs1UnifiedTransport;
  plugin._mfUs1HostInstance = null;
  const file = addTopic(app, 'Sources/H.md', uuid(8));
  const before = content(app, file);
  let legacyCalls = 0;
  plugin._gradeTopicLegacy = () => { legacyCalls += 1; return { ok: true }; };
  await assert.rejects(
    () => plugin._gradeTopic(file, fmOf(app, file), TODAY),
    error => error.code === 'E_UNIFIED_NOT_AUTHORIZED',
  );
  assert.equal(legacyCalls, 0);
  assert.equal(content(app, file), before);
});

// ---- 8. legacy default unchanged ----------------------------------------

test('the default legacy mode still routes through the legacy implementation', async () => {
  const { plugin, app } = await harness({ mode: 'legacy' });
  const file = addTopic(app, 'Sources/I.md', uuid(9));
  let legacyCalls = 0;
  plugin._gradeTopicLegacy = () => { legacyCalls += 1; return { ok: true }; };
  await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  assert.equal(legacyCalls, 1);
});

// ---- 9. Card is not a scheduling object ----------------------------------

test('a card never enters the unified host transport', async () => {
  const { plugin, app, saveCount } = await harness();
  const card = makeFile(app, 'Cards/C1.md', { type: 'card', status: 'active', mf_id: uuid(10), mf_revision: 0 }, '# card\n');
  app.activeFile = card;
  plugin._gradeTopicLegacy = () => { throw new Error('card must not be graded as a topic'); };
  const result = await plugin.endSession();
  assert.equal(result, undefined);
  assert.equal(saveCount(), 0);
  assert.match(getNotices(app).join('\n'), /Cards finish automatically|not a reading topic/);
});

// ---- 10. response shape honesty ------------------------------------------

test('recovery reports retryable when the file still matches the pre-event snapshot', async () => {
  const { app, dataStore } = await harness();
  const file = addTopic(app, 'Sources/J.md', uuid(11));
  // No write ever happened, but a prepared record survived (crash before CAS).
  const reopened = await openPluginDataLedger({ dataStore, key: 'mfUs1Ledger' });
  const store = new MemoryLedgerStore(reopened.store.dump());
  const ledger = new PersistentEventLedger(store);
  const topic = fmOf(app, file);
  const { sha256Hex } = require('../src/scheduling/migration-hash.js');
  ledger.prepare({
    eventId: uuid(12), topicId: topic.mf_id, type: 'ADVANCED', payload: null,
    expectedRevision: 0, algorithmVersion: 1, today: TODAY, calendarDate: TODAY,
    dateFormat: DATE_FORMAT, configDigest: sha256Hex('null'),
  }, {
    beforeHash: sha256Hex(content(app, file)),
    expectedAfterHash: sha256Hex('never-written'),
    fields: {},
    before: {},
    after: {},
  });
  const runtime = createAsyncHostRuntime({
    mode: 'unified',
    conditions: CONDITIONS,
    authorization: issueSyntheticHostAuthorization(),
    storage: createObsidianAsyncTopicStorage({ app, resolveFile: createVaultTopicResolver({ app }), dateFormat: DATE_FORMAT }),
    ledger,
    capability: issueSyntheticUnifiedCapability(),
    dateFormat: DATE_FORMAT,
    persist: async () => ({ ok: true }),
  });
  const recovery = await runtime.recover();
  assert.equal(recovery.recovered[0].status, 'retryable');
});

// ---- creation → first review (vertical slice) ----------------------------

test('a Source created through the host gateway becomes a valid Unified topic', async () => {
  const { plugin, app, ledger } = await harness();
  const { issueSyntheticCreationAuthorization } = require('../src/integration/topic-creation-host.js');
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();

  const path = 'Sources/K.md';
  const content = [
    '---',
    'type: source',
    'source_type: article',
    'status: active',
    'priority: 50',
    'next_review: 2026-11-27',
    'interval: 3',
    'a_factor: 2.0',
    'review_count: 0',
    'last_reviewed:',
    'date_added: 2026-11-24',
    'tags:',
    '  - incremental-reading',
    '  - ir/source',
    '---',
    '',
    '# K',
    '',
  ].join('\n');
  const creation = await plugin._mfUs1CreateTopicFromHost({
    requestId: `source:${path}`,
    kind: 'source',
    priority: 50,
    path,
    content,
  });
  assert.equal(creation.handled, true);
  assert.equal(creation.outcome.status, 'applied');

  const file = app.vault.getAbstractFileByPath(path);
  const fm = fmOf(app, file);
  assert.match(fm.mf_id, /^[0-9a-f-]{36}$/);
  assert.equal(fm.mf_revision, 0);

  const graded = await plugin._gradeTopic(file, fm, TODAY);
  assert.equal(graded.status, 'applied');
  const after = fmOf(app, file);
  assert.equal(after.mf_id, fm.mf_id, 'creation and first review share the same identity');
  assert.equal(after.mf_revision, 1);
  assert.equal(after.review_count, 1);
  assert.equal(ledger.get(after.mf_last_event_id).status, 'applied');
});

// ---- nested YAML (tags lists) is preserved, never rewritten ---------------

test('a note with a tags list keeps those bytes while the event is applied', async () => {
  const { plugin, app } = await harness();
  const file = addTopic(app, 'Sources/L.md', uuid(13));
  const original = content(app, file).replace('custom_field: keep-me', 'tags:\n  - incremental-reading\n  - ir/source\nnested_block:\n  child: x');
  await app.vault.process(file, () => original);
  await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  const after = content(app, file);
  assert.ok(after.includes('tags:\n  - incremental-reading\n  - ir/source\n'));
  assert.ok(after.includes('nested_block:\n  child: x'));
  assert.equal(fmOf(app, file).mf_revision, 1);
});

test('a structured scheduling field is refused instead of being flattened', async () => {
  const { plugin, app, storage } = await harness();
  const file = addTopic(app, 'Sources/M.md', uuid(14));
  const original = content(app, file).replace('priority: 50', 'priority:\n  nested: 1');
  await app.vault.process(file, () => original);
  const { sha256Hex } = require('../src/scheduling/migration-hash.js');
  const result = await storage.compareAndSwap(uuid(14), {
    expectedHash: sha256Hex(original),
    expectedRevision: 0,
    updates: { priority: 60 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_FIELD_STRUCTURED');
  assert.equal(content(app, file), original);
});

test('comments and quoted values in Frontmatter survive a Unified event', async () => {
  const { plugin, app } = await harness();
  const file = addTopic(app, 'Sources/R.md', uuid(15));
  const original = content(app, file).replace(
    'custom_field: keep-me',
    '# keep this comment\ncustom_field: "00123"\nquoted: "a: b # c"',
  );
  await app.vault.process(file, () => original);
  await plugin._gradeTopic(file, fmOf(app, file), TODAY);
  const after = content(app, file);
  assert.ok(after.includes('# keep this comment'));
  assert.ok(after.includes('custom_field: "00123"'));
  assert.ok(after.includes('quoted: "a: b # c"'));
  assert.equal(fmOf(app, file).mf_revision, 1);
});
