'use strict';

// PR-03 — daily queue, Priority, overdue compensation, stable sort and budget
// (SPEC A6.1-A6.3, A12, A13 T14).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  DEFAULT_QUEUE_CONFIG,
  SORT_KEYS,
  createQueueConfig,
  selectDailyQueue,
  compareQueueEntries,
  selectWithinBudget,
} = require('../src/scheduling/index.js');

const TODAY = '2026-11-24';

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function topic(overrides = {}) {
  const { id = 1, ...rest } = overrides;
  return {
    type: 'extract',
    status: 'active',
    priority: 50,
    mf_id: uuid(id),
    mf_ideal_due: TODAY,
    mf_not_before: null,
    ...rest,
  };
}

function ids(entries) {
  return entries.map(entry => entry.stableId);
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---- candidates and status handling (A6.1) --------------------------------

test('only active Source and Extract become candidates', () => {
  const result = selectDailyQueue([
    topic({ id: 1, type: 'source' }),
    topic({ id: 2, type: 'extract' }),
    topic({ id: 3, status: 'done' }),
    topic({ id: 4, status: 'dismissed' }),
    topic({ id: 5, status: 'inbox' }),
    topic({ id: 6, status: 'pending' }),
    topic({ id: 7, status: 'container' }),
    topic({ id: 8, type: 'card' }),
  ], undefined, TODAY);

  assert.equal(result.budget.candidateCount, 2);
  assert.deepEqual(ids(result.selected).sort(), [uuid(1), uuid(2)].sort());
  assert.deepEqual(result.excluded.map(item => item.status).sort(), ['dismissed', 'done']);
  assert.deepEqual(result.unsupported.map(item => item.status).sort(), ['container', 'inbox', 'pending']);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].code, 'E_TOPIC_TYPE');
});

test('a Card is never treated as a Source or Extract', () => {
  const result = selectDailyQueue([topic({ type: 'card', priority: 1 })], undefined, TODAY);
  assert.equal(result.selected.length, 0);
  assert.equal(result.invalid[0].code, 'E_TOPIC_TYPE');
});

test('topics that are not due yet never enter the queue', () => {
  const result = selectDailyQueue([
    topic({ id: 1, mf_ideal_due: '2026-11-25' }),
    topic({ id: 2, mf_ideal_due: '2026-12-31' }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 0);
  assert.equal(result.notYetDue.length, 2);
  assert.equal(result.budget.usedMinutes, 0);
});

test('a future administrative postponement hides a due topic without deleting the backlog', () => {
  const result = selectDailyQueue([
    topic({ id: 1, mf_ideal_due: '2026-11-20', mf_not_before: '2026-12-01' }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 0);
  assert.equal(result.postponed.length, 1);
  assert.equal(result.postponed[0].idealDue, '2026-11-20');
  assert.equal(result.postponed[0].effectiveDue, '2026-12-01');
  assert.equal(result.workload.days.find(day => day.date === '2026-11-20')?.idealDueCount ?? 0, 0);
  assert.equal(result.workload.totals.idealDueCount, 0);
});

test('a postponement that already expired becomes a candidate again', () => {
  const result = selectDailyQueue([
    topic({ id: 1, mf_ideal_due: '2026-11-20', mf_not_before: '2026-11-22' }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].effectiveDue, '2026-11-22');
});

test('invalid topics are reported per item instead of aborting the batch', () => {
  const result = selectDailyQueue([
    topic({ id: 1 }),
    null,
    topic({ id: 3, priority: 0 }),
    topic({ id: 4, priority: 101 }),
    topic({ id: 5, priority: '50' }),
    topic({ id: 6, mf_ideal_due: '2026-02-30' }),
    topic({ id: 7, mf_ideal_due: undefined }),
    topic({ id: 8, estimated_minutes: 0 }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 1);
  assert.deepEqual(result.invalid.map(item => item.code).sort(), [
    'E_DATE_FORMAT',
    'E_DATE_INVALID',
    'E_ESTIMATED_MINUTES_INVALID',
    'E_OBJECT_REQUIRED',
    'E_PRIORITY_RANGE',
    'E_PRIORITY_RANGE',
    'E_PRIORITY_TYPE',
  ].sort());
});

test('stable ids are required and duplicates are rejected', () => {
  const missing = selectDailyQueue([{ type: 'source', status: 'active', priority: 50, mf_ideal_due: TODAY }], undefined, TODAY);
  assert.equal(missing.invalid[0].code, 'E_QUEUE_ID_REQUIRED');

  const legacy = selectDailyQueue([
    { type: 'extract', status: 'active', priority: 50, mf_ideal_due: TODAY, stable_id: 'legacy:note-a' },
  ], undefined, TODAY);
  assert.equal(legacy.selected.length, 1);
  assert.equal(legacy.selected[0].stableId, 'legacy:note-a');

  const duplicate = selectDailyQueue([
    topic({ id: 9, mf_ideal_due: '2026-11-20' }),
    topic({ id: 9, mf_ideal_due: '2026-11-21' }),
  ], undefined, TODAY);
  assert.equal(duplicate.selected.length, 0);
  assert.equal(duplicate.invalid.filter(item => item.code === 'E_DUPLICATE_ID').length, 2);
});

test('a missing or malformed stable id is never silently invented', () => {
  const result = selectDailyQueue([
    { type: 'source', status: 'active', priority: 50, mf_ideal_due: TODAY, stable_id: '  ' },
  ], undefined, TODAY);
  assert.equal(result.invalid[0].code, 'E_STABLE_ID_INVALID');
  assert.equal(result.selected.length, 0);
});

// ---- Priority and overdue compensation (A6.2) -----------------------------

test('P1 is ranked before P50, P80 and P100', () => {
  const result = selectDailyQueue([
    topic({ id: 100, priority: 100 }),
    topic({ id: 80, priority: 80 }),
    topic({ id: 50, priority: 50 }),
    topic({ id: 1, priority: 1 }),
  ], undefined, TODAY);
  assert.deepEqual(result.selected.map(entry => entry.priority), [1, 50, 80, 100]);
});

test('overdue compensation: one level per seven days, capped at 20', () => {
  const cases = [
    [0, 0, 50],
    [6, 0, 50],
    [7, 1, 49],
    [13, 1, 49],
    [14, 2, 48],
    [140, 20, 30],
    [2000, 20, 30],
  ];
  for (const [overdueDays, ageBonus, effectivePriority] of cases) {
    const idealDue = new Date(Date.UTC(2026, 10, 24));
    idealDue.setUTCDate(idealDue.getUTCDate() - overdueDays);
    const iso = idealDue.toISOString().slice(0, 10);
    const result = selectDailyQueue([topic({ id: 1, priority: 50, mf_ideal_due: iso })], undefined, TODAY);
    const entry = result.selected[0] || result.deferredByBudget[0];
    assert.equal(entry.overdueDays, overdueDays, `overdue ${overdueDays}`);
    assert.equal(entry.ageBonus, ageBonus, `bonus ${overdueDays}`);
    assert.equal(entry.effectivePriority, effectivePriority, `effective ${overdueDays}`);
    assert.equal(entry.priority, 50, 'original priority stays untouched');
  }
});

test('effective priority never drops below 1', () => {
  const result = selectDailyQueue([topic({ id: 1, priority: 1, mf_ideal_due: '2026-01-01' })], undefined, TODAY);
  const entry = result.selected[0] || result.deferredByBudget[0];
  assert.equal(entry.ageBonus, 20);
  assert.equal(entry.effectivePriority, 1);
});

test('effective priority is a ranking value only and never written back', () => {
  const input = topic({ id: 1, priority: 50, mf_ideal_due: '2026-11-10' });
  const snapshot = JSON.parse(JSON.stringify(input));
  const result = selectDailyQueue([input], undefined, TODAY);
  assert.equal(result.selected[0].effectivePriority, 48);
  assert.equal(input.priority, 50);
  assert.deepEqual(input, snapshot);
});

test('changing Priority reorders the queue without touching Ideal Due', () => {
  const low = selectDailyQueue([
    topic({ id: 1, priority: 80 }),
    topic({ id: 2, priority: 20 }),
  ], undefined, TODAY);
  assert.deepEqual(low.selected.map(entry => entry.priority), [20, 80]);
  const changed = selectDailyQueue([
    topic({ id: 1, priority: 10 }),
    topic({ id: 2, priority: 20 }),
  ], undefined, TODAY);
  assert.deepEqual(changed.selected.map(entry => entry.priority), [10, 20]);
  assert.equal(changed.selected[0].idealDue, TODAY);
});

test('overdue compensation uses the effective due date, not the ideal one', () => {
  const result = selectDailyQueue([
    topic({ id: 1, priority: 50, mf_ideal_due: '2026-10-01', mf_not_before: '2026-11-23' }),
  ], undefined, TODAY);
  const entry = result.selected[0];
  assert.equal(entry.overdueDays, 1);
  assert.equal(entry.ageBonus, 0);
  assert.equal(entry.effectivePriority, 50);
});

// ---- stable ordering (A6.2, T14) -----------------------------------------

test('T14: equal priority and due date sort by stable id, not input order', () => {
  const forward = selectDailyQueue([
    topic({ id: 1 }), topic({ id: 2 }), topic({ id: 3 }),
  ], undefined, TODAY);
  const backward = selectDailyQueue([
    topic({ id: 3 }), topic({ id: 2 }), topic({ id: 1 }),
  ], undefined, TODAY);
  assert.deepEqual(ids(forward.selected), [uuid(1), uuid(2), uuid(3)]);
  assert.deepEqual(ids(backward.selected), [uuid(1), uuid(2), uuid(3)]);
});

test('the five sort keys decide in order', () => {
  const base = { type: 'extract', status: 'active', estimated_minutes: 1 };
  const entries = [
    { ...base, stableId: 'e', priority: 50, effectivePriority: 48, effectiveDue: '2026-11-20', createdDate: null },
    { ...base, stableId: 'd', priority: 50, effectivePriority: 48, effectiveDue: '2026-11-20', createdDate: '2026-01-01' },
    { ...base, stableId: 'c', priority: 50, effectivePriority: 48, effectiveDue: '2026-11-19', createdDate: null },
    { ...base, stableId: 'b', priority: 40, effectivePriority: 48, effectiveDue: '2026-12-01', createdDate: null },
    { ...base, stableId: 'a', priority: 60, effectivePriority: 47, effectiveDue: '2026-12-01', createdDate: null },
  ];
  const sorted = entries.slice().sort(compareQueueEntries).map(entry => entry.stableId);
  assert.deepEqual(sorted, ['a', 'b', 'c', 'd', 'e']);
});

test('a missing creation date sorts after a known one', () => {
  const result = selectDailyQueue([
    topic({ id: 1, date_added: undefined }),
    topic({ id: 2, date_added: '2026-01-05' }),
    topic({ id: 3, date_added: '2026-01-01' }),
  ], undefined, TODAY);
  assert.deepEqual(ids(result.selected), [uuid(3), uuid(2), uuid(1)]);
});

test('id ordering is code-unit based, not locale based', () => {
  const result = selectDailyQueue([
    { type: 'extract', status: 'active', priority: 50, mf_ideal_due: TODAY, stable_id: 'a-note' },
    { type: 'extract', status: 'active', priority: 50, mf_ideal_due: TODAY, stable_id: 'Z-note' },
  ], undefined, TODAY);
  // 'Z' (0x5A) sorts before 'a' (0x61) by code unit; localeCompare would differ.
  assert.deepEqual(result.selected.map(entry => entry.stableId), ['Z-note', 'a-note']);
});

test('permuting the input never changes the queue', () => {
  const pool = [
    topic({ id: 1, priority: 50 }),
    topic({ id: 2, priority: 44, mf_ideal_due: '2026-11-18' }),
    topic({ id: 3, priority: 44, mf_ideal_due: '2026-11-18' }),
    topic({ id: 4, priority: 90, estimated_minutes: 20 }),
  ];
  const reference = ids(selectDailyQueue(pool, undefined, TODAY).selected);
  for (const order of [[3, 1, 4, 2], [2, 4, 1, 3], [4, 3, 2, 1]]) {
    const permuted = order.map(index => pool[index - 1]);
    assert.deepEqual(ids(selectDailyQueue(permuted, undefined, TODAY).selected), reference);
  }
});

test('the comparator is a total order (antisymmetric and transitive)', () => {
  const entries = [
    { stableId: 'a', priority: 10, effectivePriority: 10, effectiveDue: '2026-11-20', createdDate: null },
    { stableId: 'b', priority: 10, effectivePriority: 10, effectiveDue: '2026-11-20', createdDate: '2026-01-01' },
    { stableId: 'c', priority: 20, effectivePriority: 18, effectiveDue: '2026-11-19', createdDate: null },
    { stableId: 'd', priority: 20, effectivePriority: 18, effectiveDue: '2026-11-19', createdDate: null },
  ];
  for (const left of entries) {
    for (const right of entries) {
      const forward = compareQueueEntries(left, right);
      const backward = compareQueueEntries(right, left);
      if (forward === 0) assert.equal(backward, 0);
      else assert.equal(Math.sign(forward), -Math.sign(backward));
    }
  }
  // A known creation date sorts before a missing one.
  assert.ok(compareQueueEntries(entries[0], entries[1]) > 0);
  assert.ok(compareQueueEntries(entries[1], entries[0]) < 0);
  assert.ok(compareQueueEntries(entries[1], entries[2]) < 0);
  assert.ok(compareQueueEntries(entries[0], entries[2]) < 0);
  assert.deepEqual([...SORT_KEYS], ['effectivePriority', 'priority', 'effectiveDue', 'createdDate', 'stableId']);
});

// ---- budget selection (A6.3) ---------------------------------------------

test('default costs and budget follow SPEC A6.3', () => {
  assert.equal(DEFAULT_QUEUE_CONFIG.dailyBudgetMinutes, 30);
  assert.deepEqual(DEFAULT_QUEUE_CONFIG.defaultMinutes, { source: 10, extract: 5 });
  assert.deepEqual(DEFAULT_QUEUE_CONFIG.customMinutesRange, { min: 1, max: 120 });
  const result = selectDailyQueue([
    topic({ id: 1, type: 'source' }),
    topic({ id: 2, type: 'extract' }),
  ], undefined, TODAY);
  const byId = Object.fromEntries(result.selected.map(entry => [entry.stableId, entry.estimatedMinutes]));
  assert.equal(byId[uuid(1)], 10);
  assert.equal(byId[uuid(2)], 5);
});

test('the SPEC example: a 40-minute task is skipped, 10 and 15 still fit', () => {
  const result = selectDailyQueue([
    topic({ id: 1, priority: 1, estimated_minutes: 40 }), // A
    topic({ id: 2, priority: 2, estimated_minutes: 10 }), // B
    topic({ id: 3, priority: 3, estimated_minutes: 15 }), // C
  ], undefined, TODAY);
  assert.deepEqual(ids(result.selected), [uuid(2), uuid(3)]);
  assert.equal(result.budget.usedMinutes, 25);
  assert.equal(result.budget.remainingMinutes, 5);
  assert.deepEqual(ids(result.deferredByBudget), [uuid(1)]);
  assert.equal(result.deferredByBudget[0].reason, 'NO_BUDGET_REMAINING');
  // The oversized topic keeps its original scheduling.
  assert.equal(result.deferredByBudget[0].idealDue, TODAY);
  assert.match(result.deferredByBudget[0].explain.text, /保持/);
});

test('a task that exactly fills the budget is selected', () => {
  const result = selectDailyQueue([
    topic({ id: 1, estimated_minutes: 10 }),
    topic({ id: 2, estimated_minutes: 10 }),
    topic({ id: 3, estimated_minutes: 10 }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 3);
  assert.equal(result.budget.usedMinutes, 30);
  assert.equal(result.budget.remainingMinutes, 0);
  assert.equal(result.deferredByBudget.length, 0);
});

test('when nothing fits, the queue is empty and the budget untouched', () => {
  const result = selectDailyQueue([
    topic({ id: 1, estimated_minutes: 40 }),
    topic({ id: 2, estimated_minutes: 31 }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 0);
  assert.equal(result.budget.usedMinutes, 0);
  assert.equal(result.deferredByBudget.length, 2);
});

test('custom costs are accepted at 1 and 120 minutes', () => {
  const result = selectDailyQueue([
    topic({ id: 1, estimated_minutes: 120 }),
  ], createQueueConfig({ dailyBudgetMinutes: 120 }), TODAY);
  assert.equal(result.selected.length, 1);
  const one = selectDailyQueue([topic({ id: 2, estimated_minutes: 1 })], undefined, TODAY);
  assert.equal(one.selected[0].estimatedMinutes, 1);
});

test('illegal custom costs are rejected per topic', () => {
  for (const cost of [0, 121, -1, NaN, 1.5, '5']) {
    const result = selectDailyQueue([topic({ id: 1, estimated_minutes: cost })], undefined, TODAY);
    assert.equal(result.selected.length, 0, String(cost));
    assert.equal(result.invalid[0].code, 'E_ESTIMATED_MINUTES_INVALID', String(cost));
  }
});

test('the budget is configurable within 1..1440 minutes (Q15)', () => {
  assert.equal(createQueueConfig({ dailyBudgetMinutes: 5 }).dailyBudgetMinutes, 5);
  assert.equal(createQueueConfig({ dailyBudgetMinutes: 1440 }).dailyBudgetMinutes, 1440);
  for (const budget of [0, 1441, 1.5, '30', null]) {
    expectCode(() => createQueueConfig({ dailyBudgetMinutes: budget }), 'E_QUEUE_BUDGET_INVALID');
  }
  expectCode(() => createQueueConfig({ defaultMinutes: { source: 1, extract: 1 } }), 'E_QUEUE_CONFIG_INVALID');
});

test('budget selection always terminates and is deterministic', () => {
  const input = [
    topic({ id: 1, estimated_minutes: 7 }),
    topic({ id: 2, estimated_minutes: 13 }),
    topic({ id: 3, estimated_minutes: 11 }),
    topic({ id: 4, estimated_minutes: 5 }),
  ];
  const first = selectDailyQueue(input, undefined, TODAY);
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(selectDailyQueue(input, undefined, TODAY), first);
  }
  const entries = input.map((item, index) => ({ stableId: uuid(index + 1), estimatedMinutes: item.estimated_minutes }));
  const { selected, deferred, usedMinutes } = selectWithinBudget(entries, 30);
  assert.equal(selected.length + deferred.length, 4);
  assert.ok(usedMinutes <= 30);
});

// ---- explanation (A12) ----------------------------------------------------

test('each queue entry explains why it is or is not selected', () => {
  const result = selectDailyQueue([
    topic({ id: 1, priority: 50, mf_ideal_due: '2026-11-10', estimated_minutes: 5 }),
    topic({ id: 2, priority: 80, estimated_minutes: 40 }),
    topic({ id: 3, mf_ideal_due: '2026-11-20', mf_not_before: '2026-12-01' }),
    topic({ id: 4, mf_ideal_due: '2026-12-10' }),
  ], undefined, TODAY);

  const chosen = result.selected[0];
  assert.match(chosen.explain.text, /逾期 14 天/);
  assert.match(chosen.explain.text, /补偿 2 级/);
  assert.match(chosen.explain.text, /有效优先级 48/);
  assert.match(chosen.explain.text, /已选入/);

  const deferred = result.deferredByBudget[0];
  assert.match(deferred.explain.text, /未选入/);
  assert.match(deferred.explain.text, /保持不变/);

  assert.match(result.postponed[0].explain.text, /行政延期/);
  assert.match(result.notYetDue[0].explain.text, /尚未到期/);
  assert.doesNotMatch(chosen.explain.text, /完成|学习成功/);
  assert.match(result.explain.text, /候选 2 个/);
});

// ---- dates and immutability ----------------------------------------------

test('date boundaries are handled with calendar arithmetic', () => {
  const monthEnd = selectDailyQueue([topic({ id: 1, mf_ideal_due: '2026-12-31' })], undefined, '2027-01-01');
  assert.equal(monthEnd.selected[0].overdueDays, 1);

  const leap = selectDailyQueue([topic({ id: 1, mf_ideal_due: '2028-02-29' })], undefined, '2028-03-01');
  assert.equal(leap.selected[0].overdueDays, 1);

  const dst = selectDailyQueue([topic({ id: 1, mf_ideal_due: '2026-03-08' })], undefined, '2026-03-09');
  assert.equal(dst.selected[0].overdueDays, 1);
});

test('inputs are never mutated and results are deterministic', () => {
  const topics = Object.freeze([
    Object.freeze(topic({ id: 1, priority: 30, mf_ideal_due: '2026-11-10' })),
    Object.freeze(topic({ id: 2, priority: 90 })),
  ]);
  const snapshot = JSON.parse(JSON.stringify(topics));
  const first = selectDailyQueue(topics, undefined, TODAY);
  for (let i = 0; i < 50; i++) assert.deepEqual(selectDailyQueue(topics, undefined, TODAY), first);
  assert.deepEqual(JSON.parse(JSON.stringify(topics)), snapshot);
});

test('invalid batch arguments throw instead of being swallowed', () => {
  expectCode(() => selectDailyQueue(null, undefined, TODAY), 'E_OBJECT_REQUIRED');
  expectCode(() => selectDailyQueue([], undefined, '2026-13-01'), 'E_DATE_INVALID');
  expectCode(() => selectDailyQueue([], { dailyBudgetMinutes: 0 }, TODAY), 'E_QUEUE_BUDGET_INVALID');
});

// ---- cross-status duplicate identity (owner review fix 2) ------------------

test('a stable id duplicated across statuses is rejected everywhere', () => {
  for (const status of ['done', 'dismissed', 'inbox', 'pending', 'container']) {
    const result = selectDailyQueue([
      topic({ id: 1, mf_ideal_due: TODAY }), // active
      topic({ id: 1, status, mf_ideal_due: TODAY }),
    ], undefined, TODAY);
    assert.equal(result.selected.length, 0, status);
    assert.equal(result.excluded.length, 0, status);
    assert.equal(result.unsupported.length, 0, status);
    const duplicates = result.invalid.filter(item => item.code === 'E_DUPLICATE_ID');
    assert.equal(duplicates.length, 2, status);
    assert.equal(duplicates[0].details.stableId, uuid(1));
  }
});

test('a duplicate pair does not block unrelated topics', () => {
  const result = selectDailyQueue([
    topic({ id: 1 }),
    topic({ id: 1, status: 'done' }),
    topic({ id: 2 }),
  ], undefined, TODAY);
  assert.deepEqual(ids(result.selected), [uuid(2)]);
  assert.equal(result.budget.candidateCount, 1);
  assert.equal(result.invalid.filter(item => item.code === 'E_DUPLICATE_ID').length, 2);
});

test('every occurrence of a triplicated id is reported', () => {
  const result = selectDailyQueue([
    topic({ id: 5 }),
    topic({ id: 5, status: 'pending' }),
    topic({ id: 5, status: 'done' }),
  ], undefined, TODAY);
  assert.equal(result.selected.length, 0);
  const duplicates = result.invalid.filter(item => item.code === 'E_DUPLICATE_ID');
  assert.equal(duplicates.length, 3);
  assert.equal(duplicates[0].details.occurrences, 3);
});

test('an invalid record with an unusable id does not block other topics', () => {
  const result = selectDailyQueue([
    topic({ id: 7, priority: 0 }),
    topic({ id: 8 }),
  ], undefined, TODAY);
  assert.deepEqual(ids(result.selected), [uuid(8)]);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].code, 'E_PRIORITY_RANGE');
});

test('the queue workload exposes overdue backlog in today\'s load', () => {
  const backlog = Array.from({ length: 10 }, (_, index) => topic({
    id: index + 1,
    mf_ideal_due: '2026-11-20',
    estimated_minutes: 10,
  }));
  const result = selectDailyQueue(backlog, undefined, TODAY);
  assert.equal(result.workload.days[0].backlogCount, 10);
  assert.equal(result.workload.days[0].backlogMinutes, 100);
  assert.equal(result.workload.days[0].availableMinutes, 100);
  assert.equal(result.workload.days[0].overloadMinutes, 70);
  assert.equal(result.workload.totals.idealBacklogCount, 10);
});
