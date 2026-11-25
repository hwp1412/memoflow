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
  const batch = prepareUnifiedMercyBatch(plan, { batchId: 'mercy-batch' });
  const deps = {
    mode: { mode: 'unified' },
    storage,
    batchStore,
    capability: issueSyntheticUnifiedCapability(),
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
