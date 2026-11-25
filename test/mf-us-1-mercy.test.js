'use strict';

// PR-04 — Mercy allocation and preview (SPEC A7.1-A7.3, A9, A12).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  MERCY_WINDOWS,
  previewMercy,
  applyMercyBatch,
  createQueueConfig,
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
  return { windowDays: 7, batchId: 'batch-001', ...overrides };
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---- configuration and window --------------------------------------------

test('only the four specification windows are accepted', () => {
  assert.deepEqual([...MERCY_WINDOWS], [3, 7, 14, 30]);
  for (const windowDays of MERCY_WINDOWS) {
    const plan = previewMercy([topic(1)], config({ windowDays }), TODAY);
    assert.equal(plan.slots.length, windowDays);
    assert.equal(plan.windowDays, windowDays);
  }
  for (const windowDays of [1, 5, 0, 7.5, '7', null, undefined]) {
    expectCode(() => previewMercy([topic(1)], config({ windowDays }), TODAY), 'E_MERCY_WINDOW_INVALID');
  }
});

test('slots start tomorrow and never include today', () => {
  const plan = previewMercy([topic(1)], config({ windowDays: 3 }), TODAY);
  assert.deepEqual(plan.slots.map(slot => slot.date), ['2026-11-26', '2026-11-27', '2026-11-28']);
  assert.equal(plan.slots.every(slot => slot.date !== TODAY), true);
});

test('slots follow the calendar across month, year, leap and DST boundaries', () => {
  const monthEnd = previewMercy([topic(1)], config({ windowDays: 3 }), '2026-12-30');
  assert.deepEqual(monthEnd.slots.map(slot => slot.date), ['2026-12-31', '2027-01-01', '2027-01-02']);

  const leap = previewMercy([topic(1)], config({ windowDays: 3 }), '2028-02-28');
  assert.deepEqual(leap.slots.map(slot => slot.date), ['2028-02-29', '2028-03-01', '2028-03-02']);

  const dst = previewMercy([topic(1)], config({ windowDays: 3 }), '2026-03-07');
  assert.deepEqual(dst.slots.map(slot => slot.date), ['2026-03-08', '2026-03-09', '2026-03-10']);
});

test('the batch id must be supplied by the caller', () => {
  for (const batchId of [undefined, null, '', '  ', ' padded', 123]) {
    expectCode(() => previewMercy([topic(1)], { windowDays: 7, batchId }, TODAY), 'E_MERCY_BATCH_ID_INVALID');
  }
  expectCode(() => previewMercy([topic(1)], { windowDays: 7 }, TODAY), 'E_MERCY_BATCH_ID_INVALID');
});

test('unknown mercy settings and invalid budgets are rejected', () => {
  expectCode(() => previewMercy([topic(1)], config({ random: true }), TODAY), 'E_MERCY_CONFIG_INVALID');
  expectCode(() => previewMercy([topic(1)], config({ dailyBudgetMinutes: 0 }), TODAY), 'E_QUEUE_BUDGET_INVALID');
  const custom = previewMercy([topic(1)], config({ dailyBudgetMinutes: 5 }), TODAY);
  assert.equal(custom.slots[0].budgetMinutes, 5);
});

// ---- ordering -------------------------------------------------------------

test('Mercy sorts by raw Priority, then Ideal Due, then stable id', () => {
  const plan = previewMercy([
    topic(3, { priority: 50, mf_ideal_due: '2026-11-01' }),
    topic(2, { priority: 10, mf_ideal_due: '2026-11-05' }),
    topic(1, { priority: 10, mf_ideal_due: '2026-11-01' }),
    topic(4, { priority: 10, mf_ideal_due: '2026-11-01' }),
  ], config({ windowDays: 7 }), TODAY);
  assert.deepEqual(plan.items.map(item => item.stableId), [uuid(1), uuid(4), uuid(2), uuid(3)]);
});

test('permuting the input never changes the plan', () => {
  const pool = [
    topic(1, { priority: 20, estimated_minutes: 10 }),
    topic(2, { priority: 10, estimated_minutes: 15 }),
    topic(3, { priority: 10 }),
  ];
  const reference = previewMercy(pool, config(), TODAY);
  for (const order of [[2, 0, 1], [1, 2, 0], [0, 1, 2]]) {
    const plan = previewMercy(order.map(index => pool[index]), config(), TODAY);
    assert.deepEqual(plan.items.map(item => [item.stableId, item.slotDate]), reference.items.map(item => [item.stableId, item.slotDate]));
    assert.deepEqual(plan.slots, reference.slots);
  }
});

// ---- capacity -------------------------------------------------------------

test('each topic takes the earliest slot that can hold it', () => {
  const plan = previewMercy([
    topic(1, { priority: 1, estimated_minutes: 10 }),
    topic(2, { priority: 2, estimated_minutes: 10 }),
    topic(3, { priority: 3, estimated_minutes: 15 }),
  ], config({ windowDays: 3 }), TODAY);
  assert.deepEqual(plan.items.map(item => item.slotDate), ['2026-11-26', '2026-11-26', '2026-11-27']);
  assert.deepEqual(plan.slots.map(slot => slot.plannedMinutes), [20, 15, 0]);
  assert.equal(plan.slots.every(slot => slot.overloaded === false), true);
});

test('a task larger than the daily budget is overloaded, never dropped', () => {
  const plan = previewMercy([
    topic(1, { estimated_minutes: 40 }),
    topic(2, { estimated_minutes: 5 }),
  ], config({ windowDays: 3 }), TODAY);
  const first = plan.items[0];
  assert.equal(first.slotDate, '2026-11-26');
  assert.equal(first.overloaded, true);
  assert.equal(plan.slots[0].plannedMinutes, 40);
  assert.equal(plan.slots[0].overloadMinutes, 10);
  assert.equal(plan.items[1].slotDate, '2026-11-27'); // 26 cannot hold 5 more
  assert.equal(plan.summary.overloadedSlotCount, 1);
});

test('a task that exactly fills the budget uses that slot without overload', () => {
  const plan = previewMercy([
    topic(1, { estimated_minutes: 30 }),
    topic(2, { estimated_minutes: 5 }),
  ], config({ windowDays: 3 }), TODAY);
  assert.equal(plan.items[0].slotDate, '2026-11-26');
  assert.equal(plan.items[0].overloaded, false);
  assert.equal(plan.items[1].slotDate, '2026-11-27');
});

test('when every slot overflows, the least-loaded (earliest on ties) slot is used', () => {
  const plan = previewMercy([
    topic(1, { priority: 1, estimated_minutes: 25 }),
    topic(2, { priority: 2, estimated_minutes: 25 }),
    topic(3, { priority: 3, estimated_minutes: 25 }),
    topic(4, { priority: 4, estimated_minutes: 10 }),
  ], config({ windowDays: 3 }), TODAY);
  // The first three fill one slot each; the fourth fits nowhere and lands on
  // the least-loaded slot — all are 25 minutes, so the earliest one wins.
  assert.deepEqual(plan.items.map(item => item.slotDate), ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-26']);
  assert.deepEqual(plan.slots.map(slot => slot.plannedMinutes), [35, 25, 25]);
  assert.equal(plan.items[3].overloaded, true);
});

test('all slots overloaded keeps every topic in the plan', () => {
  const plan = previewMercy([
    topic(1, { estimated_minutes: 40 }),
    topic(2, { estimated_minutes: 40 }),
    topic(3, { estimated_minutes: 40 }),
  ], config({ windowDays: 3, dailyBudgetMinutes: 30 }), TODAY);
  assert.equal(plan.items.length, 3);
  assert.equal(plan.slots.reduce((total, slot) => total + slot.topicCount, 0), 3);
  assert.equal(plan.slots.every(slot => slot.overloaded), true);
});

// ---- administrative and identity boundaries ------------------------------

test('an existing postponement is never pulled earlier and never consumes slot capacity', () => {
  const plan = previewMercy([
    topic(1),
    topic(2, { mf_ideal_due: '2026-11-01', mf_not_before: '2026-12-10' }),
  ], config(), TODAY);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.existingPostponements.length, 1);
  assert.equal(plan.existingPostponements[0].stableId, uuid(2));
  assert.equal(plan.existingPostponements[0].notBefore, '2026-12-10');
  assert.equal(plan.slots.reduce((total, slot) => total + slot.plannedMinutes, 0), 5);
});

test('topics that are not overdue are excluded from Mercy', () => {
  const plan = previewMercy([topic(1, { mf_ideal_due: '2026-12-20' })], config(), TODAY);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.notOverdue.length, 1);
  assert.equal(plan.notOverdue[0].reason, 'NOT_OVERDUE');
});

test('cards, completed, legacy and invalid topics are reported, not allocated', () => {
  const plan = previewMercy([
    topic(1, { type: 'card' }),
    topic(2, { status: 'done' }),
    topic(3, { status: 'pending' }),
    topic(4, { priority: 0 }),
    topic(5),
  ], config(), TODAY);
  assert.deepEqual(plan.items.map(item => item.stableId), [uuid(5)]);
  assert.equal(plan.invalid.some(entry => entry.code === 'E_TOPIC_TYPE'), true);
  assert.equal(plan.excluded.some(entry => entry.status === 'done'), true);
  assert.equal(plan.unsupported.some(entry => entry.status === 'pending'), true);
  assert.equal(plan.invalid.some(entry => entry.code === 'E_PRIORITY_RANGE'), true);
});

test('duplicate identities and missing revisions are reported', () => {
  const duplicate = previewMercy([
    topic(1),
    topic(1, { priority: 10 }),
  ], config(), TODAY);
  assert.equal(duplicate.items.length, 0);
  assert.equal(duplicate.invalid.filter(entry => entry.code === 'E_DUPLICATE_ID').length, 2);

  const noRevision = topic(2);
  delete noRevision.mf_revision;
  const missing = previewMercy([noRevision], config(), TODAY);
  assert.equal(missing.items.length, 0);
  assert.equal(missing.invalid[0].code, 'E_REVISION_INVALID');
});

// ---- preview contract -----------------------------------------------------

test('the plan carries before/after dates and revision information', () => {
  const plan = previewMercy([topic(1, { mf_revision: 4 })], config(), TODAY);
  const item = plan.items[0];
  assert.equal(item.priority, 50);
  assert.equal(item.idealDue, '2026-11-01');
  assert.equal(item.notBeforeBefore, null);
  assert.equal(item.notBeforeAfter, '2026-11-26');
  assert.equal(item.effectiveDueBefore, '2026-11-01');
  assert.equal(item.effectiveDueAfter, '2026-11-26');
  assert.equal(item.revisionBefore, 4);
  assert.equal(item.revisionAfter, 5);
  assert.equal(item.changed, true);
  assert.equal(item.status, 'assigned');
});

test('the plan never touches learning state and never mutates its input', () => {
  const topics = Object.freeze([Object.freeze(topic(1, { mf_revision: 2 }))]);
  const snapshot = JSON.parse(JSON.stringify(topics));
  const plan = previewMercy(topics, config(), TODAY);
  assert.deepEqual(JSON.parse(JSON.stringify(topics)), snapshot);
  assert.equal(plan.items[0].revisionBefore, 2);
  assert.equal(plan.status, 'planned');
});

test('the plan is deterministic and explains its decisions', () => {
  const topics = [topic(1, { priority: 10 }), topic(2, { priority: 20 })];
  const first = previewMercy(topics, config(), TODAY);
  for (let i = 0; i < 50; i++) assert.deepEqual(previewMercy(topics, config(), TODAY), first);
  assert.match(first.explain.text, /批次 batch-001/);
  assert.match(first.explain.text, /窗口 7 天/);
  assert.match(first.explain.text, /每日预算 30 分钟/);
  assert.equal(first.summary.highestPriorityDelayed.priority, 10);
});

test('a plan that assigns nothing is reported as a no-op', () => {
  const plan = previewMercy([topic(1, { mf_ideal_due: '2026-12-20' })], config(), TODAY);
  assert.equal(plan.status, 'noop');
  assert.equal(plan.summary.assignedCount, 0);
});

test('manual application of the preview is explicit (no implicit writes)', () => {
  const topics = [topic(1)];
  const plan = previewMercy(topics, config(), TODAY);
  assert.equal(plan.items[0].notBeforeAfter, '2026-11-26');
  // The preview alone changed nothing…
  assert.equal(topics[0].mf_not_before, null);
  assert.equal(topics[0].mf_revision, 0);
  // …only an explicit apply does.
  const applied = applyMercyBatch(plan, topics, TODAY);
  assert.equal(applied.topics[0].mf_not_before, '2026-11-26');
  assert.equal(applied.topics[0].mf_revision, 1);
});

test('invalid arguments are rejected at the boundary', () => {
  expectCode(() => previewMercy(null, config(), TODAY), 'E_OBJECT_REQUIRED');
  expectCode(() => previewMercy([topic(1)], config(), '2026-13-01'), 'E_DATE_INVALID');
  expectCode(() => previewMercy([topic(1)], null, TODAY), 'E_MERCY_CONFIG_INVALID');
  assert.equal(createQueueConfig({ dailyBudgetMinutes: 30 }).dailyBudgetMinutes, 30);
});
