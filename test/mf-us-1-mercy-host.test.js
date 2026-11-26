'use strict';

// MF-US-1 — Mercy host orchestration (preview -> confirm -> apply -> undo).
//
// Pure contract tests only: fake applyItem/undoItem/store, no Obsidian, no I/O.
// The host never allocates on its own (that is `previewMercy`), never writes a
// vault, and changes nothing but `mf_not_before` intent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SchedulingError } = require('../src/scheduling/errors.js');
const {
  buildMercyPreview,
  confirmMercyPreview,
  applyMercyHost,
  undoMercyHost,
  describeMercyOutcome,
} = require('../src/integration/mercy-host.js');

const TODAY = '2026-11-25';
const NEXT_DAY = '2026-11-26';

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function topic(n, overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    path: `Sources/T${n}.md`,
    basename: `T${n}`,
    mf_id: uuid(n),
    mf_ideal_due: '2026-11-01',
    mf_not_before: null,
    mf_interval_days: 5,
    a_factor: 1.5,
    review_count: 3,
    last_reviewed: '2026-10-20',
    mf_revision: 0,
    mf_scheduler_version: 1,
    estimated_minutes: 5,
    ...overrides,
  };
}

function makePreview(overrides = {}) {
  return buildMercyPreview({
    topics: [topic(1), topic(2), topic(3)],
    today: TODAY,
    windowDays: 7,
    budgetPerDay: 60,
    config: { batchId: 'mercy-host-1' },
    ...overrides,
  });
}

function createStore({ failPrepared = null, failFinal = null } = {}) {
  const saves = [];
  return {
    saves,
    async save(record) {
      saves.push(record);
      const failure = record.status === 'prepared' ? failPrepared : failFinal;
      if (failure === 'throw') throw Object.assign(new Error('store down'), { code: 'E_STORE_WRITE' });
      if (failure === 'refuse') return { ok: false, code: 'E_STORE_REFUSED' };
      return { ok: true };
    },
  };
}

async function expectCodeRejects(factory, code) {
  await assert.rejects(factory, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function itemKeys(item) {
  return Object.keys(item).sort();
}

// ---- preview -------------------------------------------------------------

test('preview is deterministic, read-only and only carries real allocations', () => {
  const topics = [topic(1, { priority: 20 }), topic(2), topic(3, { estimated_minutes: 10 })];
  const before = JSON.parse(JSON.stringify(topics));

  const first = buildMercyPreview({
    topics, today: TODAY, windowDays: 3, budgetPerDay: 60, config: { batchId: 'batch-a' },
  });
  const second = buildMercyPreview({
    topics: [...topics].reverse(), today: TODAY, windowDays: 3, budgetPerDay: 60, config: { batchId: 'batch-a' },
  });

  assert.deepEqual(topics, before, 'input topics must never be mutated');
  assert.equal(first.batchId, 'batch-a');
  assert.equal(first.previewDigest, second.previewDigest, 'digest must not depend on input order');
  assert.deepEqual(first.items, second.items);
  assert.deepEqual(first.slots, second.slots);

  assert.equal(first.plan.kind, 'MERCY');
  assert.equal(first.plan.batchId, first.batchId);
  assert.equal(first.plan.today, TODAY);
  assert.equal(first.plan.items.length, first.items.length);
  assert.equal(first.summary.assignedCount, first.items.length);
  assert.equal(first.summary.itemCount, first.items.length);

  for (const item of first.items) {
    assert.deepEqual(itemKeys(item), ['basename', 'currentNotBefore', 'notBefore', 'path', 'topicId']);
    assert.notEqual(item.notBefore, item.currentNotBefore, 'only changed allocations are confirmed');
    assert.ok(item.path && item.basename);
  }
});

test('a derived batch id is deterministic without a caller-provided config', () => {
  const topics = [topic(1), topic(2)];
  const first = buildMercyPreview({ topics, today: TODAY, windowDays: 7, budgetPerDay: 60 });
  const second = buildMercyPreview({ topics: [...topics].reverse(), today: TODAY, windowDays: 7, budgetPerDay: 60 });
  assert.equal(first.batchId, second.batchId);
  assert.equal(first.previewDigest, second.previewDigest);
  assert.match(first.batchId, /^mercy-[0-9a-f]{24}$/);
});

// ---- tampering -----------------------------------------------------------

test('a tampered item set, digest, day or plan is rejected before any item runs', async () => {
  const preview = makePreview();
  const confirmation = confirmMercyPreview(preview);
  let calls = 0;
  const applyItem = async () => {
    calls += 1;
    return { status: 'applied' };
  };

  const tamperedItems = JSON.parse(JSON.stringify(preview));
  tamperedItems.items[0].notBefore = '2030-01-01';
  await expectCodeRejects(
    () => applyMercyHost({ preview: tamperedItems, confirmation, today: TODAY, applyItem }),
    'E_PREVIEW_INTEGRITY',
  );

  const tamperedCurrent = JSON.parse(JSON.stringify(preview));
  tamperedCurrent.items[0].currentNotBefore = '2026-11-30';
  await expectCodeRejects(
    () => applyMercyHost({ preview: tamperedCurrent, confirmation, today: TODAY, applyItem }),
    'E_PREVIEW_INTEGRITY',
  );

  const tamperedDigest = { ...preview, previewDigest: '0'.repeat(64) };
  await expectCodeRejects(
    () => applyMercyHost({ preview: tamperedDigest, confirmation, today: TODAY, applyItem }),
    'E_PREVIEW_INTEGRITY',
  );

  const tamperedDay = { ...preview, today: NEXT_DAY };
  await expectCodeRejects(
    () => applyMercyHost({ preview: tamperedDay, confirmation, today: TODAY, applyItem }),
    'E_PREVIEW_INTEGRITY',
  );

  const tamperedPlan = { ...preview, plan: { ...preview.plan, items: preview.plan.items.slice(0, 1) } };
  await expectCodeRejects(
    () => applyMercyHost({ preview: tamperedPlan, confirmation, today: TODAY, applyItem }),
    'E_MERCY_PLAN_INVALID',
  );

  assert.equal(calls, 0, 'a rejected preview must never reach applyItem');
});

// ---- confirmation --------------------------------------------------------

test('only a module-issued confirmation object is accepted', async () => {
  const preview = makePreview();
  const valid = confirmMercyPreview(preview);
  const other = makePreview({ topics: [topic(1), topic(2)], config: { batchId: 'mercy-host-2' } });
  const otherConfirmation = confirmMercyPreview(other);

  let calls = 0;
  const applyItem = async () => {
    calls += 1;
    return { status: 'applied' };
  };

  const forged = Object.freeze({
    kind: 'mercy-preview-confirmation',
    batchId: preview.batchId,
    previewDigest: preview.previewDigest,
  });
  await expectCodeRejects(
    () => applyMercyHost({ preview, confirmation: forged, today: TODAY, applyItem }),
    'E_MERCY_CONFIRMATION_REQUIRED',
  );
  await expectCodeRejects(
    () => applyMercyHost({ preview, confirmation: { ...valid }, today: TODAY, applyItem }),
    'E_MERCY_CONFIRMATION_REQUIRED',
  );
  await expectCodeRejects(
    () => applyMercyHost({ preview, confirmation: null, today: TODAY, applyItem }),
    'E_MERCY_CONFIRMATION_REQUIRED',
  );
  await expectCodeRejects(
    () => applyMercyHost({ preview, confirmation: otherConfirmation, today: TODAY, applyItem }),
    'E_MERCY_CONFIRMATION_MISMATCH',
  );

  assert.equal(calls, 0);
});

test('a preview from a previous day is stale and never applied', async () => {
  const preview = makePreview();
  const confirmation = confirmMercyPreview(preview);
  let calls = 0;
  const applyItem = async () => {
    calls += 1;
    return { status: 'applied' };
  };

  await expectCodeRejects(
    () => applyMercyHost({ preview, confirmation, today: NEXT_DAY, applyItem }),
    'E_MERCY_PLAN_STALE',
  );
  assert.equal(calls, 0);
});

// ---- durability of the intent -------------------------------------------

test('a non-durable intent blocks every write', async () => {
  const preview = makePreview();
  const confirmation = confirmMercyPreview(preview);
  let calls = 0;
  const applyItem = async () => {
    calls += 1;
    return { status: 'applied' };
  };

  for (const failPrepared of ['throw', 'refuse']) {
    const store = createStore({ failPrepared });
    const outcome = await applyMercyHost({ preview, confirmation, today: TODAY, applyItem, store });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.reason, 'E_MERCY_INTENT_NOT_DURABLE');
    assert.equal(outcome.durable, false);
    assert.equal(outcome.total, 0);
    assert.equal(outcome.results.length, 0);
    assert.deepEqual(outcome.counts, {
      applied: 0, duplicate: 0, noOp: 0, skipped: 0, blocked: 0, conflict: 0, failed: 0, uncertain: 0,
    });
    assert.equal(store.saves.length, 1);
    assert.equal(store.saves[0].status, 'prepared');
    assert.equal(store.saves[0].batchId, preview.batchId);
    assert.deepEqual(
      store.saves[0].items.map(item => item.topicId).sort(),
      preview.items.map(item => item.topicId).sort(),
    );
    // The persisted intent is a pure mf_not_before intent: no scheduling field
    // other than not_before is carried into the write path.
    for (const item of store.saves[0].items) {
      assert.deepEqual(itemKeys(item), ['basename', 'currentNotBefore', 'notBefore', 'path', 'topicId']);
    }
    assert.equal(outcome.items.length, preview.items.length);
    const report = describeMercyOutcome(outcome);
    assert.equal(report.nonAtomic, true);
    assert.match(report.message, /未执行任何写入/);
  }

  assert.equal(calls, 0, 'applyItem must never run when the intent was not durable');
});

// ---- partial success / uncertain ----------------------------------------

test('partial success keeps honest counts and a non-atomic report', async () => {
  const preview = makePreview();
  const confirmation = confirmMercyPreview(preview);
  const store = createStore();
  const calls = [];

  const outcome = await applyMercyHost({
    preview,
    confirmation,
    today: TODAY,
    store,
    applyItem: async item => {
      calls.push(item.topicId);
      if (item.topicId === uuid(2)) return { status: 'conflict', reason: 'E_REVISION_MISMATCH' };
      return { status: 'applied' };
    },
  });

  assert.equal(outcome.status, 'partial');
  assert.notEqual(outcome.status, 'applied');
  assert.deepEqual(outcome.counts, {
    applied: 2, duplicate: 0, noOp: 0, skipped: 0, blocked: 0, conflict: 1, failed: 0, uncertain: 0,
  });
  assert.equal(outcome.total, 3);
  assert.equal(outcome.batchId, preview.batchId);
  assert.equal(outcome.previewDigest, preview.previewDigest);
  assert.deepEqual(calls, [uuid(1), uuid(2), uuid(3)], 'execution is sequential and deterministic');

  assert.equal(store.saves.length, 2);
  assert.equal(store.saves[0].status, 'prepared');
  assert.equal(store.saves[1].status, 'partial');
  assert.equal(store.saves[1].total, 3);

  const report = describeMercyOutcome(outcome);
  assert.equal(report.nonAtomic, true);
  assert.match(report.message, /非原子/);
  assert.match(report.message, /冲突 1/);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /T2/);
});

test('an uncertain item keeps the batch uncertain, never success', async () => {
  const preview = makePreview({ topics: [topic(1), topic(2)] });
  const confirmation = confirmMercyPreview(preview);

  const outcome = await applyMercyHost({
    preview,
    confirmation,
    today: TODAY,
    applyItem: async item => (item.topicId === uuid(2)
      ? { status: 'uncertain', reason: 'E_WRITE_UNVERIFIED' }
      : { status: 'applied' }),
  });

  assert.equal(outcome.status, 'uncertain');
  assert.notEqual(outcome.status, 'applied');
  assert.equal(outcome.counts.uncertain, 1);
  assert.equal(outcome.counts.applied, 1);

  const report = describeMercyOutcome(outcome);
  assert.equal(report.nonAtomic, true);
  assert.match(report.message, /未确认 1/);
});

test('a requires-manual-recovery result is reported as uncertain', async () => {
  const preview = makePreview({ topics: [topic(1)] });
  const confirmation = confirmMercyPreview(preview);
  const outcome = await applyMercyHost({
    preview,
    confirmation,
    today: TODAY,
    applyItem: async () => ({ status: 'requires-manual-recovery', reason: 'E_WRITE_UNVERIFIED' }),
  });
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.counts.uncertain, 1);
});

// ---- duplicate apply -----------------------------------------------------

test('a duplicate apply re-runs the batch and double-writes nothing', async () => {
  const preview = makePreview({ topics: [topic(1), topic(2)] });
  const confirmation = confirmMercyPreview(preview);
  const written = new Set();
  const applyItem = async item => {
    if (written.has(item.topicId)) return { status: 'duplicate', reason: 'ALREADY_APPLIED' };
    written.add(item.topicId);
    return { status: 'applied' };
  };
  const store = createStore();

  // Chosen behaviour: the same confirmation may be applied again; idempotency
  // is delegated to the per-item CAS behind applyItem, which reports
  // `duplicate` (counted as success by the shared batch protocol).
  const first = await applyMercyHost({ preview, confirmation, today: TODAY, applyItem, store });
  assert.equal(first.status, 'applied');
  assert.equal(first.counts.applied, 2);

  const second = await applyMercyHost({ preview, confirmation, today: TODAY, applyItem, store });
  assert.equal(second.status, 'applied');
  assert.equal(second.counts.applied, 0);
  assert.equal(second.counts.duplicate, 2);
  assert.equal(written.size, 2, 'a re-run must not write the same item twice');
  assert.equal(store.saves.length, 4);
});

// ---- undo ----------------------------------------------------------------

test('undo restores only recorded applied items and a conflict writes nothing', async () => {
  const preview = makePreview();
  const confirmation = confirmMercyPreview(preview);

  const batch = await applyMercyHost({
    preview,
    confirmation,
    today: TODAY,
    applyItem: async item => (item.topicId === uuid(2)
      ? { status: 'conflict', reason: 'E_REVISION_MISMATCH' }
      : { status: 'applied' }),
  });
  assert.equal(batch.status, 'partial');

  const undoCalls = [];
  let writes = 0;
  const undoOutcome = await undoMercyHost({
    batch,
    confirmation,
    undoItem: async item => {
      undoCalls.push(item);
      if (item.topicId === uuid(3)) {
        // The user changed the revision after the batch: no restore write.
        return { status: 'conflict', reason: 'E_REVISION_MISMATCH' };
      }
      writes += 1;
      return { status: 'applied', restored: item.currentNotBefore };
    },
  });

  assert.deepEqual(undoCalls.map(item => item.topicId), [uuid(1), uuid(3)], 'a conflicted item is not undone');
  for (const item of undoCalls) {
    assert.deepEqual(itemKeys(item), ['basename', 'currentNotBefore', 'notBefore', 'path', 'topicId']);
    assert.equal('interval' in item, false);
    assert.equal('a_factor' in item, false);
    assert.equal('review_count' in item, false);
    assert.equal('mf_interval_days' in item, false);
  }
  assert.equal(writes, 1, 'the revision conflict must not write');
  assert.equal(undoOutcome.status, 'partial');
  assert.deepEqual(undoOutcome.counts, {
    applied: 1, duplicate: 0, noOp: 0, skipped: 0, blocked: 0, conflict: 1, failed: 0, uncertain: 0,
  });
  assert.equal(undoOutcome.restoredCount, 1);
  assert.equal(undoOutcome.batchId, batch.batchId);
  assert.equal(undoOutcome.previewDigest, batch.previewDigest);
  assert.equal(undoOutcome.operation, 'undo');

  const report = describeMercyOutcome(undoOutcome);
  assert.equal(report.nonAtomic, true);
});

test('undo rejects a forged confirmation before touching any item', async () => {
  const preview = makePreview();
  const confirmation = confirmMercyPreview(preview);
  const batch = await applyMercyHost({
    preview,
    confirmation,
    today: TODAY,
    applyItem: async () => ({ status: 'applied' }),
  });

  let calls = 0;
  const undoItem = async () => {
    calls += 1;
    return { status: 'applied' };
  };

  const forged = Object.freeze({
    kind: 'mercy-preview-confirmation',
    batchId: batch.batchId,
    previewDigest: batch.previewDigest,
  });
  await expectCodeRejects(
    () => undoMercyHost({ batch, confirmation: forged, undoItem }),
    'E_MERCY_CONFIRMATION_REQUIRED',
  );
  await expectCodeRejects(
    () => undoMercyHost({ batch, confirmation: { ...confirmation }, undoItem }),
    'E_MERCY_CONFIRMATION_REQUIRED',
  );

  const other = makePreview({ topics: [topic(1)], config: { batchId: 'mercy-host-3' } });
  await expectCodeRejects(
    () => undoMercyHost({ batch, confirmation: confirmMercyPreview(other), undoItem }),
    'E_MERCY_CONFIRMATION_MISMATCH',
  );
  assert.equal(calls, 0);
});

test('undo with no recorded applied items is a clean no-op', async () => {
  const preview = makePreview({ topics: [topic(1), topic(2)] });
  const confirmation = confirmMercyPreview(preview);
  const batch = await applyMercyHost({
    preview,
    confirmation,
    today: TODAY,
    applyItem: async () => ({ status: 'conflict', reason: 'E_PREVIEW_STALE' }),
  });
  assert.equal(batch.status, 'failed');

  let calls = 0;
  const undoOutcome = await undoMercyHost({
    batch,
    confirmation,
    undoItem: async () => {
      calls += 1;
      return { status: 'applied' };
    },
  });
  assert.equal(calls, 0);
  assert.equal(undoOutcome.status, 'no-op');
  assert.equal(undoOutcome.total, 0);
});

// ---- final persist -------------------------------------------------------

test('a failed final persist downgrades the batch to uncertain, never applied', async () => {
  for (const failFinal of ['throw', 'refuse']) {
    const preview = makePreview({ topics: [topic(1), topic(2)] });
    const confirmation = confirmMercyPreview(preview);
    const store = createStore({ failFinal });
    let calls = 0;

    const outcome = await applyMercyHost({
      preview,
      confirmation,
      today: TODAY,
      store,
      applyItem: async () => {
        calls += 1;
        return { status: 'applied' };
      },
    });

    assert.equal(calls, 2, 'items did run before the final persist failed');
    assert.equal(outcome.status, 'uncertain');
    assert.notEqual(outcome.status, 'applied');
    assert.equal(outcome.reason, 'E_MERCY_RESULT_NOT_DURABLE');
    assert.equal(outcome.durable, false);
    assert.equal(store.saves.length, 2);
    assert.equal(store.saves[0].status, 'prepared');
    assert.equal(store.saves[1].status, 'applied', 'the attempted final record keeps the observed status');

    const report = describeMercyOutcome(outcome);
    assert.equal(report.nonAtomic, true);
    assert.match(report.message, /未能持久化/);
  }
});
