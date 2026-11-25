'use strict';

// PR-04 — Mercy batch application and safe undo (SPEC A7.2-A7.3, A11, A13 T16).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  previewMercy,
  applyMercyBatch,
  undoMercyBatch,
} = require('../src/scheduling/index.js');

const TODAY = '2026-11-25';

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function topic(n, overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    mf_id: uuid(n),
    mf_ideal_due: '2026-11-01',
    mf_not_before: null,
    mf_interval_days: 5,
    a_factor: 1.5,
    review_count: 3,
    last_reviewed: '2026-10-20',
    mf_revision: 0,
    mf_scheduler_version: 1,
    mf_last_event_id: null,
    mf_parent_id: null,
    mf_root_id: null,
    estimated_minutes: 5,
    ...overrides,
  };
}

function config(overrides = {}) {
  return { windowDays: 3, batchId: 'batch-undo', ...overrides };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError);
    assert.equal(error.code, code);
    return true;
  });
}

function planFor(topics, overrides) {
  return previewMercy(topics, config(overrides), TODAY);
}

test('T16: undo restores each item\'s original mf_not_before (null included)', () => {
  const topics = [
    topic(1, { mf_not_before: null }),
    topic(2, { mf_not_before: '2026-11-20' }),
  ];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  assert.deepEqual(applied.topics.map(item => item.mf_not_before), ['2026-11-26', '2026-11-26']);

  const undone = undoMercyBatch(applied.batch, applied.topics, TODAY);
  assert.deepEqual(undone.results.map(result => result.status), ['undone', 'undone']);
  assert.deepEqual(undone.topics.map(item => item.mf_not_before), [null, '2026-11-20']);
  assert.deepEqual(undone.topics.map(item => item.mf_revision), [2, 2]);
  assert.equal(undone.batch.status, 'undone');
});

test('apply and undo leave every learning field untouched', () => {
  const topics = [topic(1, { priority: 17, mf_interval_days: 9, a_factor: 2.2, review_count: 7, last_reviewed: '2026-09-09' })];
  const before = JSON.parse(JSON.stringify(topics[0]));

  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  const afterApply = applied.topics[0];
  assert.equal(afterApply.mf_interval_days, before.mf_interval_days);
  assert.equal(afterApply.a_factor, before.a_factor);
  assert.equal(afterApply.review_count, before.review_count);
  assert.equal(afterApply.last_reviewed, before.last_reviewed);
  assert.equal(afterApply.priority, before.priority);
  assert.equal(afterApply.mf_ideal_due, before.mf_ideal_due);
  assert.equal(afterApply.mf_not_before, '2026-11-26');
  assert.equal(afterApply.mf_revision, 1);

  const undone = undoMercyBatch(applied.batch, applied.topics, TODAY);
  const afterUndo = undone.topics[0];
  for (const field of ['mf_interval_days', 'a_factor', 'review_count', 'last_reviewed', 'priority', 'mf_ideal_due']) {
    assert.equal(afterUndo[field], before[field], field);
  }
  assert.equal(afterUndo.mf_not_before, null);
});

test('a revision mismatch at apply time is a conflict, not an overwrite', () => {
  const topics = [topic(1), topic(2)];
  const plan = planFor(topics);
  // The user changed topic 1 after the preview.
  const edited = [{ ...topics[0], mf_revision: 1, priority: 10 }, topics[1]];
  const applied = applyMercyBatch(plan, edited, TODAY);

  assert.equal(applied.results[0].status, 'conflict');
  assert.equal(applied.results[0].reason, 'REVISION_MISMATCH');
  assert.equal(applied.results[1].status, 'applied');
  assert.equal(applied.topics[0].mf_not_before, null);
  assert.equal(applied.topics[0].priority, 10);
  assert.equal(applied.topics[1].mf_not_before, '2026-11-26');
  assert.equal(applied.batch.status, 'partially-applied');
  assert.equal(applied.summary.appliedCount, 1);
  assert.equal(applied.summary.conflictCount, 1);
});

test('an external mf_not_before change without a revision bump is a conflict', () => {
  const topics = [topic(1)];
  const plan = planFor(topics);
  const edited = [{ ...topics[0], mf_not_before: '2026-11-22' }];
  const applied = applyMercyBatch(plan, edited, TODAY);
  assert.equal(applied.results[0].status, 'conflict');
  assert.equal(applied.results[0].reason, 'NOT_BEFORE_CHANGED');
  assert.equal(applied.topics[0].mf_not_before, '2026-11-22');
});

test('a missing topic is reported and the rest of the batch still applies', () => {
  const topics = [topic(1), topic(2)];
  const plan = planFor(topics);
  const applied = applyMercyBatch(plan, [topics[1]], TODAY);
  assert.equal(applied.results[0].status, 'missing');
  assert.equal(applied.results[1].status, 'applied');
  assert.equal(applied.batch.status, 'partially-applied');
});

test('undo skips items the user changed after the batch and restores the rest', () => {
  const topics = [topic(1), topic(2)];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);

  // The user advances topic 1 afterwards.
  const edited = [
    { ...applied.topics[0], mf_revision: applied.topics[0].mf_revision + 1, mf_not_before: null, last_reviewed: '2026-11-26' },
    applied.topics[1],
  ];
  const undone = undoMercyBatch(applied.batch, edited, TODAY);

  assert.equal(undone.results[0].status, 'conflict');
  assert.equal(undone.results[0].reason, 'REVISION_MISMATCH');
  assert.equal(undone.results[1].status, 'undone');
  assert.equal(undone.topics[0].mf_not_before, null); // user's state kept
  assert.equal(undone.topics[1].mf_not_before, null);
  assert.equal(undone.batch.status, 'partially-undone');
  assert.equal(undone.summary.undoneCount, 1);
  assert.equal(undone.summary.conflictCount, 1);
});

test('undo reports a missing topic without losing the other restores', () => {
  const topics = [topic(1), topic(2)];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  const undone = undoMercyBatch(applied.batch, [applied.topics[0]], TODAY);
  assert.equal(undone.results[0].status, 'undone');
  assert.equal(undone.results[1].status, 'missing');
  assert.equal(undone.topics[0].mf_not_before, null);
});

test('repeated undo changes nothing', () => {
  const topics = [topic(1)];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  const first = undoMercyBatch(applied.batch, applied.topics, TODAY);
  const revisions = first.topics.map(item => item.mf_revision);

  const second = undoMercyBatch(first.batch, first.topics, TODAY);
  assert.deepEqual(second.results.map(result => result.status), ['already-undone']);
  assert.deepEqual(second.topics.map(item => item.mf_revision), revisions);
  assert.deepEqual(second.topics.map(item => item.mf_not_before), [null]);
});

test('a no-op plan item is applied and undone without any revision change', () => {
  const plan = {
    batchId: 'batch-noop',
    today: TODAY,
    windowDays: 3,
    items: [{
      stableId: uuid(1),
      status: 'noop',
      revisionBefore: 0,
      notBeforeBefore: null,
      effectiveDueBefore: '2026-11-01',
    }],
  };
  const topics = [topic(1)];
  const applied = applyMercyBatch(plan, topics, TODAY);
  assert.equal(applied.results[0].status, 'noop');
  assert.equal(applied.batch.status, 'noop');
  assert.equal(applied.topics[0].mf_revision, 0);
  assert.equal(applied.topics[0].mf_not_before, null);

  const undone = undoMercyBatch(applied.batch, applied.topics, TODAY);
  assert.equal(undone.results[0].status, 'nothing-to-undo');
  assert.equal(undone.topics[0].mf_revision, 0);
});

test('the batch record carries the audit fields needed for a later adapter', () => {
  const applied = applyMercyBatch(planFor([topic(1)]), [topic(1)], TODAY);
  assert.equal(applied.batch.batchId, 'batch-undo');
  assert.equal(applied.batch.algorithmVersion, 1);
  assert.equal(applied.batch.appliedOn, TODAY);
  assert.equal(applied.batch.windowDays, 3);
  assert.equal(applied.batch.status, 'applied');
  const item = applied.batch.items[0];
  assert.equal(item.applyStatus, 'applied');
  assert.equal(item.stableId, uuid(1));
  assert.equal(item.revisionBefore, 0);
  assert.equal(item.revisionAfter, 1);
  assert.equal(item.notBeforeBefore, null);
  assert.equal(item.notBeforeAfter, '2026-11-26');
  assert.equal(item.effectiveDueBefore, '2026-11-01');
  assert.equal(item.effectiveDueAfter, '2026-11-26');
});

test('frozen inputs work and are never mutated', () => {
  const topics = Object.freeze([Object.freeze(topic(1))]);
  const plan = planFor(topics);
  const applied = applyMercyBatch(plan, topics, TODAY);
  assert.equal(topics[0].mf_not_before, null);
  assert.equal(applied.topics[0].mf_not_before, '2026-11-26');
  const undone = undoMercyBatch(applied.batch, applied.topics, TODAY);
  assert.equal(undone.topics[0].mf_not_before, null);
});

test('invalid plans and batches are rejected at the boundary', () => {
  expectCode(() => applyMercyBatch(null, [topic(1)], TODAY), 'E_MERCY_PLAN_INVALID');
  expectCode(() => applyMercyBatch({ batchId: 'b', items: [{ stableId: uuid(1), status: 'weird' }] }, [topic(1)], TODAY), 'E_MERCY_PLAN_INVALID');
  expectCode(() => undoMercyBatch(null, [topic(1)], TODAY), 'E_MERCY_BATCH_INVALID');
  expectCode(() => undoMercyBatch({ batchId: 'b' }, [topic(1)], TODAY), 'E_MERCY_BATCH_INVALID');
});

// ---- batch identity safety (review fix 1) ---------------------------------

test('duplicate ids appearing after the preview reject only the affected item', () => {
  const topics = [topic(1), topic(2)];
  const plan = planFor(topics);
  // The caller's snapshot now contains two notes with the same stable id.
  const snapshot = [topics[0], topics[1], { ...topics[0], priority: 20 }];
  const applied = applyMercyBatch(plan, snapshot, TODAY);

  assert.equal(applied.results[0].status, 'conflict');
  assert.equal(applied.results[0].reason, 'DUPLICATE_ID');
  assert.equal(applied.results[1].status, 'applied');
  assert.equal(applied.topics[0].mf_not_before, null, 'ambiguous item is untouched');
  assert.equal(applied.topics[1].mf_not_before, '2026-11-26');
  assert.equal(applied.batch.status, 'partially-applied');
});

test('duplicate ids appearing before undo reject only the affected item', () => {
  const topics = [topic(1), topic(2)];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  const snapshot = [applied.topics[0], applied.topics[1], { ...applied.topics[0] }];
  const undone = undoMercyBatch(applied.batch, snapshot, TODAY);

  assert.equal(undone.results[0].status, 'conflict');
  assert.equal(undone.results[0].reason, 'DUPLICATE_ID');
  assert.equal(undone.results[1].status, 'undone');
  assert.equal(undone.topics[0].mf_not_before, '2026-11-26', 'ambiguous item is untouched');
  assert.equal(undone.topics[1].mf_not_before, null);
  assert.equal(undone.batch.status, 'partially-undone');
});

// ---- resumable undo (review fix 2) ---------------------------------------

test('partial undo resumes: A undone, B missing, B returns, undo again', () => {
  const topics = [topic(1), topic(2)];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  assert.deepEqual(applied.topics.map(item => item.mf_not_before), ['2026-11-26', '2026-11-26']);

  // First pass: only A is present, so B is missing.
  const first = undoMercyBatch(applied.batch, [applied.topics[0]], TODAY);
  assert.deepEqual(first.results.map(result => result.status), ['undone', 'missing']);
  assert.equal(first.batch.status, 'partially-undone');
  assert.equal(first.summary.pendingCount, 1);
  const restoredA = first.topics[0];
  const aRevision = restoredA.mf_revision;
  assert.equal(restoredA.mf_not_before, null);

  // B comes back in its post-apply state; retrying the same batch finishes it.
  const second = undoMercyBatch(first.batch, [restoredA, applied.topics[1]], TODAY);
  assert.deepEqual(second.results.map(result => result.status), ['already-undone', 'undone']);
  assert.equal(second.topics[0].mf_revision, aRevision, 'no second revision bump for A');
  assert.equal(second.topics[0].mf_not_before, null);
  assert.equal(second.topics[1].mf_not_before, null);
  assert.equal(second.batch.status, 'undone');
  assert.equal(second.summary.pendingCount, 0);
});

test('a partially undone batch keeps unfinished items validated against the current revision', () => {
  const topics = [topic(1), topic(2)];
  const applied = applyMercyBatch(planFor(topics), topics, TODAY);
  const first = undoMercyBatch(applied.batch, [applied.topics[0]], TODAY);

  // The user edits B before the retry: undo must not overwrite it.
  const editedB = { ...applied.topics[1], mf_revision: applied.topics[1].mf_revision + 1 };
  const second = undoMercyBatch(first.batch, [first.topics[0], editedB], TODAY);
  assert.equal(second.results[0].status, 'already-undone');
  assert.equal(second.results[1].status, 'conflict');
  assert.equal(second.results[1].reason, 'REVISION_MISMATCH');
  assert.equal(second.batch.status, 'partially-undone');
  assert.equal(second.summary.pendingCount, 1);
});

// ---- stale preview protection (review fix 3) ------------------------------

test('a preview generated for another day is refused', () => {
  const topics = [topic(1)];
  const plan = planFor(topics);
  expectCode(() => applyMercyBatch(plan, topics, '2026-11-26'), 'E_MERCY_PLAN_STALE');
  // The same plan still applies on its own day.
  assert.equal(applyMercyBatch(plan, topics, TODAY).summary.appliedCount, 1);
});

test('a plan without a preview day is refused', () => {
  const plan = { batchId: 'b', windowDays: 3, items: [] };
  expectCode(() => applyMercyBatch(plan, [topic(1)], TODAY), 'E_MERCY_PLAN_STALE');
});

test('a topic that stopped being schedulable is not applied', () => {
  const topics = [topic(1), topic(2)];
  const plan = planFor(topics);
  const applied = applyMercyBatch(plan, [{ ...topics[0], status: 'done' }, topics[1]], TODAY);
  assert.equal(applied.results[0].status, 'conflict');
  assert.equal(applied.results[0].reason, 'NOT_SCHEDULABLE');
  assert.equal(applied.topics[0].mf_not_before, null);
  assert.equal(applied.results[1].status, 'applied');
});

test('authoritative fields changed without a revision bump are conflicts', () => {
  const cases = [
    [{ priority: 20 }, 'PRIORITY_CHANGED'],
    [{ mf_ideal_due: '2026-11-02' }, 'IDEAL_DUE_CHANGED'],
    [{ mf_not_before: '2026-11-03' }, 'NOT_BEFORE_CHANGED'],
    [{ type: 'card' }, 'NOT_SCHEDULABLE'],
  ];
  for (const [overrides, reason] of cases) {
    const topics = [topic(1)];
    const plan = planFor(topics);
    const applied = applyMercyBatch(plan, [{ ...topics[0], ...overrides }], TODAY);
    assert.equal(applied.results[0].status, 'conflict', reason);
    assert.equal(applied.results[0].reason, reason);
    assert.equal(applied.summary.appliedCount, 0, reason);
  }
});
