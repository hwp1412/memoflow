'use strict';

// PR-09 — concurrency, snapshot and identity checks for the Unified writer.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeUnifiedEvent,
  PersistentEventLedger,
  SyntheticUnifiedStorage,
  issueSyntheticUnifiedCapability,
} = require('../src/scheduling/index.js');
const { setup, makeRequest, makeTopic, uuid } = require('./helpers/unified-fixtures.js');

test('two events with the same expected revision: only the first writes', () => {
  const context = setup();
  const first = makeRequest(context.topic, { eventId: uuid(2001) });
  const second = makeRequest(context.topic, { eventId: uuid(2002) });
  assert.equal(executeUnifiedEvent(first, context.deps).status, 'applied');
  const blocked = executeUnifiedEvent(second, context.deps);
  assert.equal(blocked.status, 'conflict');
  assert.equal(blocked.reason, 'E_REVISION_MISMATCH');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('two writer instances sharing a ledger store never double-apply one event', () => {
  const context = setup();
  const request = makeRequest(context.topic);
  assert.equal(executeUnifiedEvent(request, context.deps).status, 'applied');

  const secondLedger = new PersistentEventLedger(context.store);
  const replay = executeUnifiedEvent(request, { ...context.deps, ledger: secondLedger });
  assert.equal(replay.status, 'duplicate');
  assert.equal(context.storage.read(context.topic.path).frontmatter.review_count, 4);
});

test('an external content edit before commit is a snapshot conflict', () => {
  const context = setup();
  const before = context.storage.read(context.topic.path);
  context.storage.beforeCas = (path) => {
    context.storage.beforeCas = null;
    context.storage.corrupt(path, `${before.content}\nexternal edit`);
  };
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_SNAPSHOT_MISMATCH');
  assert.equal(result.writesPerformed, false);
});

test('identical content with a changed revision is still a conflict', () => {
  const context = setup();
  const entry = context.storage.read(context.topic.path);
  context.storage.setFile(context.topic.path, { ...entry, revision: 99, frontmatter: { ...entry.frontmatter, mf_revision: 99 } });
  const result = executeUnifiedEvent(makeRequest(context.topic), context.deps);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_REVISION_MISMATCH');
});

test('two files sharing one mf_id are refused', () => {
  const first = makeTopic({ seq: 1 });
  const second = makeTopic({ seq: 2, mfId: first.mfId, path: 'Clones/A-copy.md' });
  const storage = new SyntheticUnifiedStorage({
    [first.path]: first.entry,
    [second.path]: second.entry,
  });
  const result = executeUnifiedEvent(makeRequest(first), {
    mode: { mode: 'unified' },
    storage,
    ledger: new PersistentEventLedger(new (require('../src/scheduling/index.js').MemoryLedgerStore)()),
    capability: issueSyntheticUnifiedCapability(),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'E_DUPLICATE_TOPIC_ID');
});

test('a plain object cannot impersonate the synthetic storage', () => {
  const context = setup();
  const fake = {
    environment: 'memory',
    authorized: true,
    findByTopicId() { throw new Error('must not be called'); },
    read() { throw new Error('must not be called'); },
    compareAndSwap() { throw new Error('must not be called'); },
  };
  assert.throws(() => executeUnifiedEvent(makeRequest(context.topic), { ...context.deps, storage: fake }),
    error => error.code === 'E_STORAGE_UNTRUSTED');
});
