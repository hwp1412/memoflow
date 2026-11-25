'use strict';

// PR-10 — dashboard model: queue, dates, modes, blockers.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDashboardModel } = require('../src/ui/scheduler-dashboard-model.js');
const { issueSyntheticRuntimeAuthorization } = require('../src/scheduling/index.js');
const { uuid } = require('./helpers/unified-fixtures.js');

function topic(seq, overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    mf_id: uuid(seq),
    mf_ideal_due: '2026-11-20',
    mf_not_before: null,
    mf_interval_days: 8,
    a_factor: 2.0,
    review_count: 3,
    mf_scheduler_version: 1,
    mf_revision: 1,
    estimated_minutes: 5,
    ...overrides,
  };
}

const TODAY = '2026-11-24';

test('the dashboard separates ideal due, not before and effective due', () => {
  const topics = [
    topic(1),
    topic(2, { mf_not_before: '2026-11-28' }),
    topic(3, { mf_ideal_due: '2026-12-10' }),
  ];
  const model = buildDashboardModel({ topics, today: TODAY, queueConfig: undefined, mode: undefined, dateFormat: 'DD-MM-YYYY' });
  assert.equal(model.mode, 'legacy');
  assert.equal(model.writeEnabled, false);

  const first = model.topics.find(view => view.stableId === uuid(1));
  const second = model.topics.find(view => view.stableId === uuid(2));
  assert.equal(first.effectiveDue, '2026-11-20');
  assert.equal(second.idealDue, '2026-11-20');
  assert.equal(second.notBefore, '2026-11-28');
  assert.equal(second.effectiveDue, '2026-11-28');
  assert.equal(second.nextReviewProjection, '28-11-2026');
});

test('the queue uses effective due, respects the budget and keeps backlog visible', () => {
  const topics = [
    topic(1),
    topic(2, { mf_not_before: '2026-11-28' }),
    topic(3, { mf_ideal_due: '2026-12-10' }),
    topic(4, { estimated_minutes: 120 }),
  ];
  const model = buildDashboardModel({ topics, today: TODAY, dateFormat: 'DD-MM-YYYY' });
  const selectedIds = model.queue.selected.map(entry => entry.stableId);
  assert.ok(selectedIds.includes(uuid(1)));
  assert.equal(model.queue.deferredByBudget.some(entry => entry.stableId === uuid(4)), true);
  assert.equal(model.queue.postponed.some(entry => entry.stableId === uuid(2)), true);
  assert.equal(model.queue.notYetDue.some(entry => entry.stableId === uuid(3)), true);
  assert.ok(model.queue.overdueCount >= 1);
});

test('cards are excluded and invalid topics are reported', () => {
  const topics = [
    topic(1),
    topic(2, { type: 'card' }),
    topic(3, { priority: 0 }),
  ];
  const model = buildDashboardModel({ topics, today: TODAY, dateFormat: 'DD-MM-YYYY' });
  assert.equal(model.cardsExcluded, 1);
  assert.equal(model.queue.invalid.length >= 1, true);
  assert.equal(model.topics.some(view => view.stableId === uuid(2)), false);
});

test('an incomplete unified runtime shows blockers and never enables writes', () => {
  const model = buildDashboardModel({
    topics: [topic(1)], today: TODAY, mode: { mode: 'unified' }, conditions: {}, dateFormat: 'DD-MM-YYYY',
  });
  assert.equal(model.allowed, false);
  assert.equal(model.writeEnabled, false);
  assert.ok(model.blockers.some(blocker => blocker.code === 'MIGRATION_INCOMPLETE'));
  assert.ok(model.blockers.some(blocker => blocker.code === 'RUNTIME_AUTHORIZATION_REQUIRED'));
});

test('even a fully authorized synthetic runtime keeps real writes disabled', () => {
  const conditions = {
    migrationComplete: true,
    pendingRecovery: false,
    singleWriterReady: true,
    backupVerified: true,
    userConfirmed: true,
    authorization: issueSyntheticRuntimeAuthorization(),
    storageSupportsCas: true,
  };
  const model = buildDashboardModel({
    topics: [topic(1)], today: TODAY, mode: { mode: 'unified' }, conditions, dateFormat: 'YYYY-MM-DD',
  });
  assert.equal(model.allowed, true);
  assert.equal(model.writeEnabled, false);
  assert.equal(model.topics[0].nextReviewProjection, '2026-11-20');
});

test('an unknown date format is reported, not guessed', () => {
  const model = buildDashboardModel({ topics: [topic(1)], today: TODAY, dateFormat: 'DD.MM.YYYY' });
  assert.equal(model.topics[0].nextReviewProjection, null);
  assert.equal(model.topics[0].projectionWarning, 'E_DATE_FORMAT_UNSUPPORTED');
});

test('migration and recovery summaries are surfaced', () => {
  const model = buildDashboardModel({
    topics: [topic(1)],
    today: TODAY,
    dateFormat: 'DD-MM-YYYY',
    migration: { planId: 'plan-1', summary: { migratable: 3, manualReview: 1 } },
    recovery: { pendingCount: 2 },
    mercy: { summary: { assignedCount: 4 } },
  });
  assert.equal(model.migration.summary.manualReview, 1);
  assert.equal(model.recovery.pendingCount, 2);
  assert.equal(model.mercy.summary.assignedCount, 4);
});

// ---- backlog accuracy (review fix 4) ------------------------------------

test('done, dismissed and postponed topics are excluded from the current backlog', () => {
  const topics = [
    topic(1, { mf_ideal_due: '2026-11-10' }),
    topic(2, { mf_ideal_due: '2026-11-10', status: 'done' }),
    topic(3, { mf_ideal_due: '2026-11-10', status: 'dismissed' }),
    topic(4, { mf_ideal_due: '2026-11-10', mf_not_before: '2026-12-01' }),
  ];
  const model = buildDashboardModel({ topics, today: TODAY, dateFormat: 'DD-MM-YYYY' });
  assert.equal(model.queue.overdueCount, 1, 'only the active, non-postponed topic is overdue');
  assert.equal(model.queue.idealOverdueCount, 2, 'ideal overdue includes the postponed one');
  assert.equal(model.queue.postponedOverdueCount, 1);
});

test('a future administrative postponement is not counted as current backlog', () => {
  const topics = [topic(1, { mf_ideal_due: '2026-11-01', mf_not_before: '2026-12-01' })];
  const model = buildDashboardModel({ topics, today: TODAY, dateFormat: 'DD-MM-YYYY' });
  assert.equal(model.queue.overdueCount, 0);
  assert.equal(model.queue.postponedOverdueCount, 1);
});
