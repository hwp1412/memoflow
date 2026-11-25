'use strict';

// PR-04 — Mercy properties and preliminary performance (SPEC A7, A13 T16, A14).

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  addCalendarDays,
  compareDate,
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
    type: n % 4 === 0 ? 'source' : 'extract',
    status: 'active',
    priority: (n % 45) + 5,
    mf_id: uuid(n),
    mf_ideal_due: '2026-11-01',
    mf_not_before: null,
    mf_interval_days: 5,
    a_factor: 1.5,
    review_count: 2,
    last_reviewed: '2026-10-01',
    mf_revision: 0,
    mf_scheduler_version: 1,
    estimated_minutes: 5,
    ...overrides,
  };
}

function preview(topics, overrides = {}) {
  return previewMercy(topics, { windowDays: 7, batchId: 'prop-batch', ...overrides }, TODAY);
}

test('identical inputs always produce identical plans', () => {
  const topics = [topic(1), topic(2, { priority: 9 }), topic(3, { estimated_minutes: 20 })];
  const first = preview(topics);
  for (let i = 0; i < 100; i++) assert.deepEqual(preview(topics), first);
});

test('permuting the input never changes the allocation', () => {
  const pool = Array.from({ length: 30 }, (_, index) => topic(index + 1));
  const reference = preview(pool);
  const shuffled = pool.slice().reverse();
  const other = preview(shuffled);
  assert.deepEqual(
    other.items.map(item => [item.stableId, item.slotDate]),
    reference.items.map(item => [item.stableId, item.slotDate])
  );
  assert.deepEqual(other.slots.map(slot => slot.plannedMinutes), reference.slots.map(slot => slot.plannedMinutes));
});

test('capacity: a slot is either within budget or explicitly overloaded', () => {
  const topics = Array.from({ length: 50 }, (_, index) => topic(index + 1, {
    estimated_minutes: 1 + ((index * 7) % 40),
  }));
  const plan = preview(topics, { dailyBudgetMinutes: 30 });
  for (const slot of plan.slots) {
    if (slot.overloaded) assert.ok(slot.plannedMinutes > slot.budgetMinutes, slot.date);
    else assert.ok(slot.plannedMinutes <= slot.budgetMinutes, slot.date);
    assert.equal(slot.overloadMinutes, Math.max(0, slot.plannedMinutes - slot.budgetMinutes));
  }
});

test('every assigned item is moved later, inside the window, and counted once', () => {
  const topics = Array.from({ length: 25 }, (_, index) => topic(index + 1));
  const plan = preview(topics);

  const slotDates = new Set(plan.slots.map(slot => slot.date));
  const lastSlot = addCalendarDays(TODAY, plan.windowDays);
  for (const item of plan.items) {
    assert.equal(item.status, 'assigned');
    assert.ok(compareDate(item.notBeforeAfter, item.notBeforeBefore ?? '1970-01-01') > 0);
    assert.ok(slotDates.has(item.slotDate));
    assert.ok(compareDate(item.slotDate, TODAY) > 0);
    assert.ok(compareDate(item.slotDate, lastSlot) <= 0);
    assert.ok(compareDate(item.effectiveDueAfter, item.effectiveDueBefore) >= 0);
  }
  const counted = plan.slots.reduce((total, slot) => total + slot.topicCount, 0);
  assert.equal(counted, plan.items.length);
});

test('apply increments revision exactly once per applied item and never for no-ops', () => {
  const topics = Array.from({ length: 10 }, (_, index) => topic(index + 1, { mf_revision: index }));
  const plan = preview(topics);
  const applied = applyMercyBatch(plan, topics, TODAY);

  for (const result of applied.results) {
    if (result.status === 'applied') assert.equal(result.revisionAfter, result.revisionBefore + 1);
    if (result.status === 'noop') assert.equal(result.revisionAfter, result.revisionBefore);
  }
  for (const topicItem of applied.topics) {
    const original = topics.find(item => item.mf_id === topicItem.mf_id);
    assert.ok(topicItem.mf_revision === original.mf_revision + 1);
  }
});

test('apply then undo restores every protected field', () => {
  const topics = Array.from({ length: 8 }, (_, index) => topic(index + 1, {
    mf_revision: index,
    priority: 10 + index,
    mf_not_before: index % 2 === 0 ? null : '2026-11-10',
  }));
  const snapshot = JSON.parse(JSON.stringify(topics));

  const applied = applyMercyBatch(preview(topics), topics, TODAY);
  const undone = undoMercyBatch(applied.batch, applied.topics, TODAY);

  assert.deepEqual(undone.topics.map(item => item.mf_not_before), snapshot.map(item => item.mf_not_before));
  for (let index = 0; index < snapshot.length; index += 1) {
    for (const field of ['mf_interval_days', 'a_factor', 'review_count', 'last_reviewed', 'priority', 'mf_ideal_due', 'mf_id', 'type', 'status']) {
      assert.equal(undone.topics[index][field], snapshot[index][field], `${field} #${index}`);
    }
    // Only the revision advanced, by two (apply + undo).
    assert.equal(undone.topics[index].mf_revision, snapshot[index].mf_revision + 2);
  }
});

test('10,000 topics are planned and applied within a reasonable budget', () => {
  const topics = Array.from({ length: 10000 }, (_, index) => topic(index + 1, {
    priority: (index % 100) + 1,
    estimated_minutes: 5,
  }));

  const previewStart = performance.now();
  const plan = preview(topics);
  const previewMs = performance.now() - previewStart;

  const applyStart = performance.now();
  const applied = applyMercyBatch(plan, topics, TODAY);
  const applyMs = performance.now() - applyStart;

  assert.equal(plan.items.length, 10000);
  assert.equal(applied.summary.appliedCount, 10000);
  assert.ok(previewMs < 1000, `preview took ${previewMs.toFixed(1)}ms`);
  assert.ok(applyMs < 1000, `apply took ${applyMs.toFixed(1)}ms`);
  console.log(`[perf] mercy preview 10k: ${previewMs.toFixed(1)}ms, apply: ${applyMs.toFixed(1)}ms`);
});
