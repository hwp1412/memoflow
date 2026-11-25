'use strict';

// PR-09 — persisted Mercy batch apply / partial retry / undo.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  previewMercy,
  prepareUnifiedMercyBatch,
  applyUnifiedMercyBatch,
  undoUnifiedMercyBatch,
  SyntheticUnifiedStorage,
  MemoryBatchStore,
  issueSyntheticUnifiedCapability,
  issueSyntheticMercyConfirmation,
  mercyBatchDigest,
} = require('../src/scheduling/index.js');
const { makeTopic, uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';

function mercyTopic(seq, overrides = {}) {
  const topic = makeTopic({ seq, ...overrides });
  const scheduling = {
    ...topic.entry.frontmatter,
    mf_id: topic.mfId,
    mf_revision: topic.entry.revision,
    estimated_minutes: 5,
    status: 'active',
    type: 'source',
  };
  return { topic, scheduling };
}

function setupMercy() {
  const first = mercyTopic(1, { frontmatter: { mf_ideal_due: '2026-11-20', priority: 10 } });
  const second = mercyTopic(2, { frontmatter: { mf_ideal_due: '2026-11-20', priority: 20 } });
  const storage = new SyntheticUnifiedStorage({
    [first.topic.path]: first.topic.entry,
    [second.topic.path]: second.topic.entry,
  });
  const batchStore = new MemoryBatchStore();
  const plan = previewMercy([first.scheduling, second.scheduling], { windowDays: 3, batchId: 'mercy-batch' }, TODAY);
  const batch = prepareUnifiedMercyBatch(plan, { batchId: 'mercy-batch', dateFormat: 'DD-MM-YYYY' });
  const deps = {
    mode: { mode: 'unified' },
    storage,
    batchStore,
    capability: issueSyntheticUnifiedCapability(),
    confirmation: issueSyntheticMercyConfirmation('mercy-batch', batch.previewDigest),
  };
  return { first, second, storage, batchStore, plan, batch, deps };
}

test('a preview becomes a persistent batch with revisions', () => {
  const context = setupMercy();
  assert.ok(context.batch.entries.length >= 1);
  for (const entry of context.batch.entries) {
    assert.equal(entry.revisionAfter, entry.revisionBefore + 1);
    assert.notEqual(entry.notBeforeAfter, entry.notBeforeBefore);
    assert.equal(typeof entry.topicId, 'string');
  }
});

test('applying the batch writes not_before and keeps interval/review count', () => {
  const context = setupMercy();
  const result = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(result.writesPerformed, true);
  assert.ok(['applied', 'partially-applied'].includes(result.batch.status));
  for (const entry of context.batch.entries) {
    const source = [context.first, context.second].find(candidate => candidate.topic.mfId === entry.topicId);
    const after = context.storage.read(source.topic.path).frontmatter;
    assert.equal(after.mf_not_before, entry.notBeforeAfter);
    assert.equal(after.mf_ideal_due, '2026-11-20');
    assert.equal(after.review_count, 3);
    assert.equal(after.mf_revision, entry.revisionAfter);
  }
});

test('re-applying a persisted batch does not extend the postponement', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const firstEntry = context.batch.entries[0];
  const afterFirst = context.storage.read(`Sources/1.md`).frontmatter.mf_not_before;

  const retry = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retry.writesPerformed, false);
  assert.equal(retry.batch.entries[0].status, 'applied');
  assert.equal(retry.counts.alreadyApplied, retry.batch.entries.length);
  assert.equal(context.storage.read(`Sources/1.md`).frontmatter.mf_not_before, afterFirst);
  assert.equal(firstEntry.topicId, uuid(1));
});

test('undo restores the previous not_before and is idempotent', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const undone = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(undone.writesPerformed, true);
  assert.ok(['rolled-back', 'partially-rolled-back'].includes(undone.batch.status));
  for (const path of ['Sources/1.md', 'Sources/2.md']) {
    const frontmatter = context.storage.read(path).frontmatter;
    assert.equal(frontmatter.mf_not_before, null);
    assert.equal(frontmatter.mf_revision, 3);
  }

  const again = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(again.writesPerformed, false);
  assert.equal(again.batch.entries[0].status, 'rolled-back');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_revision, 3);
});

test('undo refuses to overwrite a user edit after the batch', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = context.storage.read('Sources/1.md');
  context.storage.setFile('Sources/1.md', {
    ...entry,
    revision: 99,
    frontmatter: { ...entry.frontmatter, mf_revision: 99, priority: 5 },
  });

  const undone = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.ok(undone.batch.entries.some(item => item.status === 'conflict'));
  assert.equal(context.storage.read('Sources/1.md').frontmatter.priority, 5);
});

test('a missing topic makes the batch partial and retryable', () => {
  const context = setupMercy();
  const removed = context.batch.entries[1] || context.batch.entries[0];
  const removedPath = removed.topicId === uuid(1) ? 'Sources/1.md' : 'Sources/2.md';
  const saved = context.storage.read(removedPath);
  context.storage.files.delete(removedPath);
  context.storage.byId.delete(removed.topicId);

  const partial = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.ok(['partially-applied', 'failed'].includes(partial.batch.status));
  assert.ok(partial.batch.entries.some(item => item.status === 'failed'));

  context.storage.setFile(removedPath, saved);
  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.status, 'applied');
  assert.equal(retried.batch.entries.every(item => ['applied', 'already-applied'].includes(item.status)), true);
});

// ---- mercy target validation, preview binding and crash windows ----------

function rawBatch(entries, batchId = 'mercy-batch', dateFormat = 'DD-MM-YYYY') {
  const batch = {
    kind: 'mf-us-1-unified-mercy-batch',
    batchId,
    today: '2026-11-24',
    algorithmVersion: 1,
    dateFormat,
    entries: entries.map((entry, index) => ({
      operationId: `${batchId}:${entry.topicId ?? `dup-${index}`}`,
      topicId: entry.topicId ?? `dup-${index}`,
      notBeforeBefore: null,
      notBeforeAfter: '2026-11-25',
      revisionBefore: 1,
      revisionAfter: 2,
      status: 'pending',
      error: null,
      intent: null,
      ...entry,
    })),
    status: 'planned',
    writesPerformed: false,
    counts: {},
  };
  batch.previewDigest = mercyBatchDigest(batch);
  return batch;
}

function rawDeps(storage, batchStore, batch) {
  return {
    mode: { mode: 'unified' },
    storage,
    batchStore,
    capability: issueSyntheticUnifiedCapability(),
    confirmation: issueSyntheticMercyConfirmation(batch.batchId, batch.previewDigest),
  };
}

test('a Mercy batch can never target an SR card', () => {
  const card = makeTopic({ seq: 7, frontmatter: { type: 'card' }, path: 'Cards/C.md' });
  const storage = new SyntheticUnifiedStorage({ [card.path]: card.entry });
  const batchStore = new MemoryBatchStore();
  const batch = rawBatch([{ topicId: card.mfId }]);
  const result = applyUnifiedMercyBatch(batch, rawDeps(storage, batchStore, batch));
  assert.equal(result.batch.entries[0].status, 'failed');
  assert.equal(result.batch.entries[0].error.code, 'E_TOPIC_TYPE');
  assert.equal(storage.read(card.path).frontmatter.mf_not_before, null);
});

test('done, dismissed and un-migrated targets are refused', () => {
  for (const [name, frontmatter, expected] of [
    ['done', { status: 'done' }, 'E_TOPIC_NOT_ACTIVE'],
    ['dismissed', { status: 'dismissed' }, 'E_TOPIC_NOT_ACTIVE'],
    ['unmigrated', { mf_scheduler_version: undefined }, 'E_VERSION_NOT_PERSISTED'],
  ]) {
    const topic = makeTopic({ seq: 8, frontmatter });
    const storage = new SyntheticUnifiedStorage({ [topic.path]: topic.entry });
    const batchStore = new MemoryBatchStore();
    const batch = rawBatch([{ topicId: topic.mfId }]);
    const result = applyUnifiedMercyBatch(batch, rawDeps(storage, batchStore, batch));
    assert.equal(result.batch.entries[0].status, 'failed', name);
    assert.equal(result.batch.entries[0].error.code, expected, name);
    assert.equal(storage.read(topic.path).frontmatter.mf_not_before, null, name);
  }
});

test('a non-UUID mercy target is rejected before any write', () => {
  const storage = new SyntheticUnifiedStorage({});
  const batchStore = new MemoryBatchStore();
  const batch = rawBatch([{ topicId: 'not-a-uuid', operationId: 'mercy-batch:not-a-uuid' }]);
  assert.throws(() => applyUnifiedMercyBatch(batch, rawDeps(storage, batchStore, batch)),
    error => error.code === 'E_TOPIC_ID_INVALID');
});

test('a duplicate topic id or missing confirmation is rejected', () => {
  const context = setupMercy();
  const duplicate = rawBatch([{ topicId: uuid(1) }, { topicId: uuid(1) }]);
  assert.throws(() => applyUnifiedMercyBatch(duplicate, context.deps), error => error.code === 'E_BATCH_DUPLICATE_TOPIC');

  const noConfirmation = { ...context.deps };
  delete noConfirmation.confirmation;
  assert.throws(() => applyUnifiedMercyBatch(context.batch, noConfirmation), error => error.code === 'E_MERCY_CONFIRMATION_REQUIRED');
});

test('a not_before change after preview is stale even with the same revision', () => {
  const context = setupMercy();
  const entry = context.storage.read('Sources/1.md');
  context.storage.setFile('Sources/1.md', {
    ...entry,
    frontmatter: { ...entry.frontmatter, mf_not_before: '2026-11-26' },
  });
  const result = applyUnifiedMercyBatch(context.batch, context.deps);
  const first = result.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(first.status, 'conflict');
  assert.equal(first.error.code, 'E_PREVIEW_STALE');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_not_before, '2026-11-26');
});

test('the same batch id with different content is a conflict', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const other = rawBatch([{ topicId: uuid(1), notBeforeAfter: '2026-11-28' }]);
  assert.throws(() => applyUnifiedMercyBatch(other, context.deps), error => error.code === 'E_BATCH_ID_CONFLICT');
});

test('a partial write can be retried after the first topic applied', () => {
  const context = setupMercy();
  context.storage.failNextCas('Sources/2.md');
  const first = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(first.batch.entries.find(item => item.topicId === uuid(1)).status, 'applied');
  assert.equal(first.batch.entries.find(item => item.topicId === uuid(2)).status, 'failed');
  assert.equal(first.writesPerformed, true);

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.status, 'applied');
  assert.equal(retried.batch.entries.every(item => ['applied', 'already-applied'].includes(item.status)), true);
});

test('a read-back failure is uncertain and recovered without a second delay', () => {
  const context = setupMercy();
  context.storage.failNextReadAfterWrite('Sources/1.md');
  const first = applyUnifiedMercyBatch(context.batch, context.deps);
  const entryOne = first.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(entryOne.status, 'uncertain');
  assert.equal(first.batch.status, 'requires-manual-recovery');
  const postponed = context.storage.read('Sources/1.md').frontmatter.mf_not_before;

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.entries.find(item => item.topicId === uuid(1)).status, 'applied');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_not_before, postponed);
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_revision, 2);
});

test('a lost confirmation record is recovered from the persisted intent', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const persisted = context.batchStore.get('mercy-batch');
  const first = persisted.entries.find(item => item.topicId === uuid(1));
  first.status = 'pending';
  first.error = null;
  context.batchStore.put('mercy-batch', persisted);

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.entries.find(item => item.topicId === uuid(1)).status, 'applied');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_revision, 2);
});

test('a recreated batch store still sees an applied batch', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const reloaded = new MemoryBatchStore(context.batchStore.dump());
  const retried = applyUnifiedMercyBatch(context.batch, {
    ...context.deps,
    batchStore: reloaded,
  });
  assert.equal(retried.writesPerformed, false);
  assert.equal(retried.batch.entries.every(item => ['applied', 'already-applied'].includes(item.status)), true);
});

test('a user edit after a partial write is never overwritten', () => {
  const context = setupMercy();
  context.storage.failNextCas('Sources/2.md');
  applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = context.storage.read('Sources/1.md');
  context.storage.setFile('Sources/1.md', {
    ...entry,
    revision: 9,
    frontmatter: { ...entry.frontmatter, mf_revision: 9, mf_not_before: '2026-11-30' },
  });

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  const first = retried.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(first.status, 'conflict');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_not_before, '2026-11-30');
});

test('a partial undo can be continued', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  context.storage.failNextCas('Sources/1.md');
  const first = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(first.batch.entries.find(item => item.topicId === uuid(1)).status, 'failed');
  assert.equal(first.batch.entries.find(item => item.topicId === uuid(2)).status, 'rolled-back');

  const retried = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.entries.every(item => item.status === 'rolled-back'), true);
  assert.equal(retried.batch.status, 'rolled-back');
});

// ---- confirmation/preview binding, intent immutability, trusted undo -----

test('a confirmation is bound to the exact preview and cannot be reused after edits', () => {
  const context = setupMercy();
  for (const mutate of [
    batch => { batch.entries[0].notBeforeAfter = '2026-11-26'; },
    batch => { batch.entries[0].revisionBefore += 1; batch.entries[0].revisionAfter += 1; },
    batch => { batch.entries[0].topicId = uuid(3); batch.entries[0].operationId = `mercy-batch:${uuid(3)}`; },
  ]) {
    const tampered = JSON.parse(JSON.stringify(context.batch));
    mutate(tampered);
    assert.throws(() => applyUnifiedMercyBatch(tampered, context.deps), error => error.code === 'E_PREVIEW_INTEGRITY');
  }

  const recomputed = JSON.parse(JSON.stringify(context.batch));
  recomputed.entries[0].notBeforeAfter = '2026-11-27';
  recomputed.previewDigest = mercyBatchDigest(recomputed);
  assert.throws(() => applyUnifiedMercyBatch(recomputed, context.deps), error => error.code === 'E_MERCY_CONFIRMATION_MISMATCH');
});

test('a persisted intent is never regenerated on retry', () => {
  const context = setupMercy();
  context.storage.failNextReadAfterWrite('Sources/1.md');
  applyUnifiedMercyBatch(context.batch, context.deps);
  const persisted = context.batchStore.get('mercy-batch');
  const first = persisted.entries.find(item => item.topicId === uuid(1));
  const originalIntent = JSON.parse(JSON.stringify(first.intent));
  assert.equal(first.status, 'uncertain');

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  const retriedEntry = retried.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(retriedEntry.status, 'applied');
  assert.deepEqual(retriedEntry.intent, originalIntent);
});

test('a user edit after an uncertain write is a conflict, never absorbed', () => {
  const context = setupMercy();
  context.storage.failNextReadAfterWrite('Sources/1.md');
  applyUnifiedMercyBatch(context.batch, context.deps);
  const edited = context.storage.read('Sources/1.md');
  context.storage.setFile('Sources/1.md', { ...edited, body: `${edited.body}\nuser body edit` });

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = retried.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(entry.status, 'conflict');
  assert.equal(entry.error.code, 'E_EXTERNAL_EDIT');
  assert.equal(context.storage.read('Sources/1.md').body.includes('user body edit'), true);
});

test('a frontmatter edit with the same revision is still a conflict', () => {
  const context = setupMercy();
  context.storage.failNextReadAfterWrite('Sources/1.md');
  applyUnifiedMercyBatch(context.batch, context.deps);
  const edited = context.storage.read('Sources/1.md');
  context.storage.setFile('Sources/1.md', {
    ...edited,
    frontmatter: { ...edited.frontmatter, custom_field: 'user-value' },
  });

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = retried.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(entry.status, 'conflict');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.custom_field, 'user-value');
});

test('undo requires a trusted persisted applied batch', () => {
  const context = setupMercy();
  assert.throws(() => undoUnifiedMercyBatch(context.batch, context.deps), error => error.code === 'E_BATCH_NOT_PERSISTED');

  const forged = { ...context.batch, status: 'applied' };
  forged.entries = forged.entries.map(entry => ({ ...entry, status: 'applied' }));
  assert.throws(() => undoUnifiedMercyBatch(forged, context.deps), error => error.code === 'E_BATCH_NOT_PERSISTED');

  context.batchStore.put('mercy-batch', { ...context.batch, status: 'planned' });
  assert.throws(() => undoUnifiedMercyBatch(context.batch, context.deps), error => error.code === 'E_BATCH_NOT_APPLIED');
});

test('undo refuses body, unknown-field and revision changes after apply', () => {
  const cases = [
    storage => {
      const entry = storage.read('Sources/1.md');
      storage.setFile('Sources/1.md', { ...entry, body: `${entry.body}\nedited` });
    },
    storage => {
      const entry = storage.read('Sources/1.md');
      storage.setFile('Sources/1.md', { ...entry, frontmatter: { ...entry.frontmatter, custom: 'x' } });
    },
    storage => {
      const entry = storage.read('Sources/1.md');
      storage.setFile('Sources/1.md', {
        ...entry,
        revision: 99,
        frontmatter: { ...entry.frontmatter, mf_revision: 99 },
      });
    },
  ];
  for (const mutate of cases) {
    const context = setupMercy();
    applyUnifiedMercyBatch(context.batch, context.deps);
    mutate(context.storage);
    const undone = undoUnifiedMercyBatch(context.batch, context.deps);
    const first = undone.batch.entries.find(item => item.topicId === uuid(1));
    assert.equal(first.status, 'conflict');
  }
});

test('undo write success with failed confirmation is recovered from the undo intent', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  context.storage.failNextReadAfterWrite('Sources/1.md');
  const first = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(first.batch.entries.find(item => item.topicId === uuid(1)).status, 'uncertain');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_not_before, null);

  const retried = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.entries.find(item => item.topicId === uuid(1)).status, 'rolled-back');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.mf_revision, 3);
});

test('a not_before that already equals the original value is not trusted without undo evidence', () => {
  const context = setupMercy();
  applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = context.storage.read('Sources/1.md');
  context.storage.setFile('Sources/1.md', {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      mf_not_before: null,
      mf_revision: entry.frontmatter.mf_revision + 1,
    },
  });

  const undone = undoUnifiedMercyBatch(context.batch, context.deps);
  const first = undone.batch.entries.find(item => item.topicId === uuid(1));
  assert.equal(first.status, 'conflict');
  assert.equal(first.error.code, 'E_UNDO_EVIDENCE_MISSING');
});

// ---- next_review compatibility projection (final review fix) -------------

function singleTopicSetup(seq, { idealDue = '2026-11-20', dateFormat = 'DD-MM-YYYY', batchId = 'mercy-batch' } = {}) {
  const topic = makeTopic({ seq, frontmatter: { mf_ideal_due: idealDue } });
  const storage = new SyntheticUnifiedStorage({ [topic.path]: topic.entry });
  const batchStore = new MemoryBatchStore();
  const batch = rawBatch([{ topicId: topic.mfId, notBeforeBefore: null, notBeforeAfter: '2026-11-27' }], batchId, dateFormat);
  const deps = rawDeps(storage, batchStore, batch);
  return { topic, storage, batchStore, batch, deps };
}

test('Mercy apply and undo project next_review in DD-MM-YYYY', () => {
  const context = singleTopicSetup(5);
  const applied = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(applied.writesPerformed, true);
  let entry = context.storage.read('Sources/5.md');
  assert.equal(entry.frontmatter.mf_not_before, '2026-11-27');
  assert.equal(entry.frontmatter.next_review, '27-11-2026');
  assert.equal(entry.frontmatter.mf_ideal_due, '2026-11-20');
  assert.equal(entry.frontmatter.mf_interval_days, 8);
  assert.equal(entry.frontmatter.review_count, 3);

  const undone = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(undone.writesPerformed, true);
  entry = context.storage.read('Sources/5.md');
  assert.equal(entry.frontmatter.mf_not_before, null);
  assert.equal(entry.frontmatter.next_review, '20-11-2026');
});

test('Mercy projection follows YYYY-MM-DD as well', () => {
  const context = singleTopicSetup(6, { dateFormat: 'YYYY-MM-DD' });
  applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(context.storage.read('Sources/6.md').frontmatter.next_review, '2026-11-27');
  undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(context.storage.read('Sources/6.md').frontmatter.next_review, '2026-11-20');
});

test('an unsupported Vault date format is refused', () => {
  const context = setupMercy();
  assert.throws(
    () => prepareUnifiedMercyBatch(context.plan, { batchId: 'bad-format', dateFormat: 'DD.MM.YYYY' }),
    error => error.code === 'E_DATE_FORMAT_UNSUPPORTED'
  );
  const missing = rawBatch([{ topicId: uuid(1) }]);
  delete missing.dateFormat;
  assert.throws(() => applyUnifiedMercyBatch(missing, context.deps), error => error.code === 'E_DATE_FORMAT_UNSUPPORTED');
});

test('a delay that does not pass ideal due keeps the effective projection', () => {
  const context = singleTopicSetup(7, { idealDue: '2027-01-01' });
  applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = context.storage.read('Sources/7.md');
  assert.equal(entry.frontmatter.mf_not_before, '2026-11-27');
  assert.equal(entry.frontmatter.next_review, '01-01-2027');
});

test('next_review is part of the persisted intent and survives recovery', () => {
  const context = setupMercy();
  context.storage.failNextReadAfterWrite('Sources/1.md');
  applyUnifiedMercyBatch(context.batch, context.deps);
  const afterFirst = context.storage.read('Sources/1.md').frontmatter.next_review;

  const retried = applyUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(retried.batch.entries.find(item => item.topicId === uuid(1)).status, 'applied');
  assert.equal(context.storage.read('Sources/1.md').frontmatter.next_review, afterFirst);

  context.storage.failNextReadAfterWrite('Sources/1.md');
  undoUnifiedMercyBatch(context.batch, context.deps);
  const restored = context.storage.read('Sources/1.md').frontmatter.next_review;
  assert.equal(restored, '20-11-2026');
  const again = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(again.writesPerformed, false);
  assert.equal(context.storage.read('Sources/1.md').frontmatter.next_review, restored);
});

test('a user edit of next_review after apply blocks undo', () => {
  const context = singleTopicSetup(8);
  applyUnifiedMercyBatch(context.batch, context.deps);
  const entry = context.storage.read('Sources/8.md');
  context.storage.setFile('Sources/8.md', {
    ...entry,
    frontmatter: { ...entry.frontmatter, next_review: '01-01-2030' },
  });

  const undone = undoUnifiedMercyBatch(context.batch, context.deps);
  assert.equal(undone.batch.entries[0].status, 'conflict');
  assert.equal(undone.batch.entries[0].error.code, 'E_EXTERNAL_EDIT');
  assert.equal(context.storage.read('Sources/8.md').frontmatter.next_review, '01-01-2030');
});
