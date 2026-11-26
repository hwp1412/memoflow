'use strict';

// P2-US1 QUEUE-SOURCE — unified queue / dashboard / reading-session data source.
//
// Synthetic rows only: no vault, no filesystem, no clock. The tests pin the
// read-side authority split (mf_* only in unified mode), the diagnostics for
// excluded legacy/card rows, the pure queue ordering/budget/effective-due
// behaviour and the dashboard/session projections.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUnifiedQueue,
  buildUnifiedDashboardModel,
  sessionItemsFromQueue,
} = require('../src/integration/unified-queue-source.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';

function file(path) {
  const name = path.split('/').pop();
  return { path, basename: name.endsWith('.md') ? name.slice(0, -3) : name };
}

// Fully migrated row. The stale `interval` / `next_review` values are
// deliberately far in the future / wrong: a unified read must ignore them.
function unifiedFm(overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    a_factor: 2.0,
    review_count: 3,
    date_added: '2026-10-01',
    interval: 999,
    next_review: '2030-01-01',
    mf_id: uuid(1),
    mf_revision: 3,
    mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-20',
    mf_not_before: null,
    mf_interval_days: 8,
    ...overrides,
  };
}

function row(path, overrides = {}) {
  return { tfile: file(path), fm: unifiedFm(overrides) };
}

function legacyRow(path, overrides = {}) {
  return {
    file: file(path),
    fm: {
      type: 'source',
      status: 'active',
      priority: 20,
      a_factor: 1.5,
      review_count: 2,
      date_added: '2026-10-01',
      interval: 8,
      next_review: '2026-11-01',
      ...overrides,
    },
  };
}

// ---- unified authority ---------------------------------------------------

test('unified mode queues a migrated Source/Extract pair from mf_* fields', () => {
  const rows = [
    row('Sources/High.md', { mf_id: uuid(1), priority: 10, mf_interval_days: 5 }),
    row('Extracts/Low.md', { mf_id: uuid(2), type: 'extract', priority: 80, mf_interval_days: 2 }),
  ];
  const result = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY, config: { dailyBudgetMinutes: 30 } });

  assert.equal(result.source.mode, 'unified');
  assert.equal(result.source.queued, 2);
  assert.equal(result.source.excluded, 0);
  assert.equal(result.projections.length, 2);
  assert.deepEqual(result.projections.map(item => item.authority), ['unified', 'unified']);

  // Priority dominates the ordering (A6.2): P10 source before P80 extract.
  assert.deepEqual(result.queue.selected.map(entry => entry.stableId), [uuid(1), uuid(2)]);
  assert.deepEqual(result.queue.selected.map(entry => entry.priority), [10, 80]);
  // effectiveDue comes from mf_ideal_due, not the stale legacy next_review.
  assert.equal(result.queue.selected[0].idealDue, '2026-11-20');
  assert.equal(result.queue.selected[0].effectiveDue, '2026-11-20');
  assert.equal(result.queue.selected[0].path, 'Sources/High.md');
  assert.equal(result.queue.selected[0].basename, 'High');
  assert.equal(result.queue.budget.usedMinutes, 15);
});

test('a fully migrated row is writable but a done topic is left to the queue status rules', () => {
  const rows = [
    row('Sources/Active.md', { mf_id: uuid(1) }),
    row('Sources/Done.md', { mf_id: uuid(2), status: 'done' }),
  ];
  const result = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });
  assert.equal(result.source.queued, 2, 'a done topic is still a readable authoritative projection');
  assert.deepEqual(result.queue.selected.map(entry => entry.stableId), [uuid(1)]);
  assert.deepEqual(result.queue.excluded.map(entry => entry.stableId), [uuid(2)]);
  assert.equal(result.queue.excluded[0].reason, 'STATUS_NOT_ACTIVE');
});

test('unified mode excludes a legacy-only note and reports it as a diagnostic', () => {
  const rows = [
    legacyRow('Notes/Old.md'),
    row('Sources/New.md', { mf_id: uuid(3) }),
  ];
  const result = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });

  assert.equal(result.source.queued, 1);
  assert.equal(result.source.excluded, 1);
  assert.deepEqual(result.queue.selected.map(entry => entry.stableId), [uuid(3)]);

  assert.equal(result.diagnostics.length, 1);
  const diagnostic = result.diagnostics[0];
  assert.deepEqual(Object.keys(diagnostic).sort(), ['basename', 'blockers', 'code', 'path']);
  assert.equal(diagnostic.path, 'Notes/Old.md');
  assert.equal(diagnostic.basename, 'Old');
  assert.equal(diagnostic.code, 'LEGACY_NOT_MIGRATED');
  assert.ok(diagnostic.blockers.includes('ID_NOT_PERSISTED'));
  assert.ok(diagnostic.blockers.includes('REVISION_NOT_PERSISTED'));
  // The legacy row was removed before the queue: no invented scheduling error.
  assert.equal(result.queue.invalid.length, 0);
  assert.equal(result.queue.selected.some(entry => entry.type === 'source' && entry.stableId !== uuid(3)), false);
});

test('unified mode excludes cards with a CARD diagnostic', () => {
  const rows = [row('Cards/Card.md', { type: 'card', mf_id: uuid(9) })];
  const result = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });

  assert.equal(result.source.queued, 0);
  assert.equal(result.source.excluded, 1);
  assert.equal(result.queue.selected.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'CARD');
  assert.deepEqual(result.diagnostics[0].blockers, ['CARD']);
  assert.equal(result.queue.invalid.length, 0);
});

test('unified mode excludes unsupported status rows with their P0 blocker', () => {
  const rows = [row('Sources/Inbox.md', { mf_id: uuid(4), status: 'inbox' })];
  const result = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });
  assert.equal(result.source.queued, 0);
  assert.equal(result.diagnostics[0].code, 'STATUS_UNSUPPORTED');
});

test('unified mode uses mf_not_before as the effective display floor', () => {
  const rows = [row('Sources/Postponed.md', {
    mf_id: uuid(5),
    mf_ideal_due: '2026-11-20',
    mf_not_before: '2026-12-01',
  })];

  const hidden = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });
  assert.equal(hidden.queue.selected.length, 0);
  assert.equal(hidden.queue.postponed.length, 1);
  assert.equal(hidden.queue.postponed[0].idealDue, '2026-11-20');
  assert.equal(hidden.queue.postponed[0].effectiveDue, '2026-12-01');

  const due = buildUnifiedQueue({ rows, mode: 'unified', today: '2026-12-02' });
  assert.equal(due.queue.selected.length, 1);
  assert.equal(due.queue.selected[0].effectiveDue, '2026-12-01');
});

test('a tiny daily budget selects only the leading candidates and defers the rest', () => {
  const rows = [
    row('Sources/P10.md', { mf_id: uuid(5), priority: 10 }),
    row('Sources/P20.md', { mf_id: uuid(6), priority: 20 }),
    row('Sources/P30.md', { mf_id: uuid(7), priority: 30 }),
  ];
  const result = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY, config: { dailyBudgetMinutes: 12 } });

  assert.equal(result.queue.selected.length, 1);
  assert.equal(result.queue.selected[0].stableId, uuid(5));
  assert.deepEqual(result.queue.deferredByBudget.map(entry => entry.stableId), [uuid(6), uuid(7)]);
  assert.equal(result.queue.deferredByBudget[0].reason, 'NO_BUDGET_REMAINING');
  assert.deepEqual(result.queue.budget, {
    budgetMinutes: 12,
    usedMinutes: 10,
    remainingMinutes: 2,
    selectedCount: 1,
    candidateCount: 3,
    deferredCount: 2,
  });
});

test('an empty row set is a legal empty queue', () => {
  const result = buildUnifiedQueue({ rows: [], mode: 'unified', today: TODAY });
  assert.deepEqual(result.source, { mode: 'unified', queued: 0, excluded: 0 });
  assert.equal(result.queue.selected.length, 0);
  assert.equal(result.queue.budget.budgetMinutes, 30);
  assert.deepEqual(result.projections, []);
  assert.deepEqual(result.diagnostics, []);
});

test('an unsupported mode is refused instead of guessing an authority', () => {
  assert.throws(
    () => buildUnifiedQueue({ rows: [], mode: 'shadow', today: TODAY }),
    error => error.code === 'E_QUEUE_SOURCE_MODE',
  );
});

// ---- legacy parity -------------------------------------------------------

test('legacy mode still yields the legacy-projected queue for parity', () => {
  const rows = [
    legacyRow('Notes/Old-A.md'),
    legacyRow('Notes/Old-B.md', { type: 'extract', status: 'done', priority: 10 }),
  ];
  const result = buildUnifiedQueue({ rows, mode: 'legacy', today: TODAY });

  assert.equal(result.source.mode, 'legacy');
  assert.equal(result.source.queued, 1);
  assert.equal(result.source.excluded, 1);
  assert.equal(result.projections[0].authority, 'legacy');
  assert.equal(result.projections[0].writable, false);
  assert.equal(result.projections[0].idealDue, '2026-11-01');

  const selected = result.queue.selected[0];
  assert.equal(selected.stableId, 'legacy:Notes/Old-A.md');
  assert.equal(selected.priority, 20);
  assert.equal(selected.effectiveDue, '2026-11-01');
  assert.equal(selected.estimatedMinutes, 10);

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'STATUS_NOT_ACTIVE');

  // The temporary id namespace is caller-controlled and read-only.
  const namespaced = buildUnifiedQueue({ rows, mode: 'legacy', today: TODAY, legacyTempId: 'parity' });
  assert.equal(namespaced.queue.selected[0].stableId, 'parity:Notes/Old-A.md');
});

// ---- purity and dashboard ------------------------------------------------

test('input rows are never mutated by any source or dashboard build', () => {
  const rows = [
    row('Sources/Active.md', { mf_id: uuid(1) }),
    row('Cards/Card.md', { type: 'card', mf_id: uuid(2) }),
    legacyRow('Notes/Old.md'),
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));

  buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });
  buildUnifiedQueue({ rows, mode: 'legacy', today: TODAY });
  buildUnifiedDashboardModel({ rows, mode: 'unified', today: TODAY, dateFormat: 'YYYY-MM-DD' });

  assert.deepEqual(rows, snapshot);
});

test('dashboard model carries authoritative mf_* data and excludes cards', () => {
  const rows = [
    row('Sources/Dash.md', { mf_id: uuid(8), mf_interval_days: 7 }),
    row('Cards/Card.md', { type: 'card', mf_id: uuid(9) }),
    legacyRow('Notes/Old.md'),
  ];
  const { model, queue, diagnostics } = buildUnifiedDashboardModel({
    rows,
    mode: 'unified',
    today: TODAY,
    config: { dailyBudgetMinutes: 25 },
    dateFormat: 'DD-MM-YYYY',
  });

  assert.equal(model.mode, 'unified');
  assert.equal(model.projectionAuthority, 'unified');
  assert.equal(model.writeEnabled, false);
  assert.ok(Array.isArray(model.blockers), 'unified runtime still reports its blockers');
  assert.deepEqual(Object.keys(model.queue.budget).sort(), [
    'budgetMinutes', 'candidateCount', 'deferredCount', 'remainingMinutes', 'selectedCount', 'usedMinutes',
  ]);
  assert.equal(model.queue.budget.budgetMinutes, 25);

  assert.deepEqual(model.queue.selected.map(entry => entry.stableId), [uuid(8)]);
  assert.equal(model.queue.selected.some(entry => entry.type === 'card'), false);

  assert.equal(model.topics.length, 1);
  const view = model.topics[0];
  assert.equal(view.stableId, uuid(8));
  // Q4: the dashboard reads mf_interval_days, never the legacy `interval` (999).
  assert.equal(view.intervalDays, 7);
  assert.equal(view.authority, 'unified');
  assert.deepEqual(view.blockers, []);
  assert.equal(view.nextReviewProjection, '20-11-2026');

  assert.equal(model.cardsExcluded, 1);
  assert.deepEqual(diagnostics.map(item => item.code).sort(), ['CARD', 'LEGACY_NOT_MIGRATED']);
  assert.equal(queue.selected.length, 1);
  assert.equal(queue.selected[0].path, 'Sources/Dash.md');
});

// ---- reading session -----------------------------------------------------

test('session items follow the selected queue order and never include cards', () => {
  const rows = [
    row('Sources/S1.md', { mf_id: uuid(11), priority: 10 }),
    row('Extracts/E2.md', { mf_id: uuid(12), type: 'extract', priority: 10, mf_interval_days: 2 }),
    row('Cards/C3.md', { type: 'card', mf_id: uuid(13) }),
  ];
  const { queue } = buildUnifiedQueue({ rows, mode: 'unified', today: TODAY });
  const items = sessionItemsFromQueue(queue);

  assert.deepEqual(items.map(item => item.type), ['source', 'extract']);
  assert.deepEqual(items.map(item => item.rank), queue.selected.map(entry => entry.rank));
  assert.deepEqual(items.map(item => item.path), ['Sources/S1.md', 'Extracts/E2.md']);
  assert.deepEqual(items.map(item => item.basename), ['S1', 'E2']);
  assert.equal(items.some(item => item.type === 'card'), false);
  assert.deepEqual(Object.keys(items[0]).sort(), [
    'basename', 'effectiveDue', 'path', 'priority', 'rank', 'type',
  ]);
});

test('session items defend against a fabricated card entry and derive missing basenames', () => {
  const items = sessionItemsFromQueue({
    selected: [
      { stableId: 'card-1', type: 'card', priority: 1, rank: 1 },
      { stableId: 'x', type: 'source', priority: 5, effectiveDue: '2026-11-20', rank: 2 },
      { stableId: 'y', type: 'extract', priority: 6, effectiveDue: '2026-11-21', rank: 3, path: 'Sources/B.md', basename: 'B' },
    ],
  });
  assert.deepEqual(items.map(item => item.rank), [2, 3]);
  assert.equal(items[0].path, null);
  assert.equal(items[0].basename, null);
  assert.equal(items[1].basename, 'B');
  assert.deepEqual(sessionItemsFromQueue(null), []);
  assert.deepEqual(sessionItemsFromQueue({}), []);
});
