'use strict';

// PR-05 — cross-module properties over PR-01..PR-04 (SPEC A13.1).

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulate } = require('./helpers/simulation/runner.js');
const {
  makeTopic, makeEvent, createRng, offsetDate,
} = require('./helpers/simulation/fixtures.js');
const { simulateLegacy } = require('./helpers/simulation/legacy-reference.js');
const { scenarioS01, scenarioS07, scenarioS08 } = require('./helpers/simulation/scenarios.js');
const {
  applyEvent,
  applyEventWithLedger,
  createEventLedger,
  selectDailyQueue,
  previewMercy,
  applyMercyBatch,
  undoMercyBatch,
  initialIntervalDays,
  createQueueConfig,
} = require('../src/scheduling/index.js');

const START = '2026-01-05';

test('the same seed reproduces the same simulation, including generated intake', () => {
  function run() {
    const rng = createRng(4242);
    let sequence = 0;
    const topics = [makeTopic({ seq: 1, type: 'extract', priority: 40, today: START, idealDue: START })];
    return simulate({
      seed: 4242,
      topics,
      days: 30,
      startDate: START,
      dailyAdd: ({ date }) => {
        sequence += 1;
        return [makeTopic({
          seq: 100 + sequence,
          type: 'extract',
          priority: 20 + Math.floor(rng() * 60),
          today: date,
          idealDue: date,
        })];
      },
    });
  }
  const first = run();
  const second = run();
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.topics, second.topics);
  assert.deepEqual(first.daily, second.daily);
});

test('simulation never mutates a frozen input topic', () => {
  const topics = Object.freeze([
    Object.freeze(makeTopic({ seq: 11, type: 'extract', priority: 30, today: START, idealDue: START })),
    Object.freeze(makeTopic({ seq: 12, type: 'source', priority: 70, today: START, idealDue: offsetDate(START, -5) })),
  ]);
  const snapshot = JSON.parse(JSON.stringify(topics));
  simulate({ seed: 1, topics, days: 10, startDate: START });
  assert.deepEqual(JSON.parse(JSON.stringify(topics)), snapshot);
});

test('SKIP, POSTPONE and Mercy never count as a review', () => {
  const topic = makeTopic({ seq: 21, type: 'extract', priority: 50, today: START, idealDue: START, reviewCount: 2, lastReviewed: '2025-12-20' });
  const before = {
    review_count: topic.review_count,
    last_reviewed: topic.last_reviewed,
    mf_interval_days: topic.mf_interval_days,
    a_factor: topic.a_factor,
    mf_ideal_due: topic.mf_ideal_due,
  };

  const skipped = applyEvent(topic, makeEvent(1, 'SKIP', topic, { today: START }), undefined, START);
  assert.equal(skipped.reviewApplied, false);
  assert.equal(skipped.topic.review_count, before.review_count);

  const postponed = applyEvent(topic, makeEvent(2, 'POSTPONE', topic, { today: START, payload: { days: 7 } }), undefined, START);
  assert.equal(postponed.reviewApplied, false);
  assert.equal(postponed.topic.review_count, before.review_count);

  const plan = previewMercy([{ ...topic, mf_not_before: null }], { windowDays: 3, batchId: 'p' }, START);
  const applied = applyMercyBatch(plan, [{ ...topic, mf_not_before: null }], START);
  assert.equal(applied.batch.status, 'applied');
  const after = applied.topics[0];
  assert.equal(after.review_count, before.review_count);
  assert.equal(after.last_reviewed, before.last_reviewed);
  assert.equal(after.mf_interval_days, before.mf_interval_days);
  assert.equal(after.a_factor, before.a_factor);
  assert.equal(after.mf_ideal_due, before.mf_ideal_due);
});

test('a finished or dismissed topic never comes back on its own', () => {
  const done = makeTopic({ seq: 31, type: 'extract', priority: 10, today: START, idealDue: START, status: 'done' });
  const dismissed = makeTopic({ seq: 32, type: 'extract', priority: 10, today: START, idealDue: START, status: 'dismissed' });
  for (let day = 0; day < 10; day += 1) {
    const queue = selectDailyQueue([done, dismissed], undefined, offsetDate(START, day));
    assert.equal(queue.selected.length, 0);
  }
});

test('a Card never enters the reading queue', () => {
  const card = makeTopic({ seq: 41, type: 'extract', priority: 1, today: START, idealDue: START });
  card.type = 'card';
  const valid = makeTopic({ seq: 42, type: 'extract', priority: 50, today: START, idealDue: START });
  const queue = selectDailyQueue([card, valid], undefined, START);
  assert.deepEqual(queue.selected.map(entry => entry.stableId), [valid.mf_id]);
  assert.equal(queue.invalid[0].code, 'E_TOPIC_TYPE');
});

test('the reading budget is never exceeded across a simulation', () => {
  const run = scenarioS01({ scale: 200, days: 60 });
  for (const day of run.result.daily) {
    assert.ok(day.usedMinutes <= day.budgetMinutes, day.date);
    assert.ok(day.selectedCount >= 0);
  }
});

test('an idempotent retry never counts the review twice', () => {
  const topic = makeTopic({ seq: 51, type: 'extract', priority: 50, today: START, idealDue: START });
  const event = makeEvent(900, 'ADVANCED', topic, { today: START });
  const first = applyEventWithLedger(createEventLedger(), topic, event, undefined, START);
  const second = applyEventWithLedger(first.ledger, first.topic, event, undefined, START);
  assert.equal(first.topic.review_count, 1);
  assert.equal(second.duplicate, true);
  assert.equal(second.topic.review_count, 1);
  assert.equal(second.topic.mf_revision, 1);
});

test('a Mercy undo never overwrites a later user change', () => {
  const topic = makeTopic({ seq: 61, type: 'extract', priority: 40, today: START, idealDue: START });
  const plan = previewMercy([topic], { windowDays: 3, batchId: 'undo-guard' }, START);
  const applied = applyMercyBatch(plan, [topic], START);
  const edited = { ...applied.topics[0], mf_revision: applied.topics[0].mf_revision + 1, priority: 5 };
  const undone = undoMercyBatch(applied.batch, [edited], START);
  assert.equal(undone.results[0].status, 'conflict');
  assert.equal(undone.topics[0].priority, 5);
  assert.equal(undone.topics[0].mf_not_before, applied.topics[0].mf_not_before);
});

test('invalid records never pollute valid topics', () => {
  const run = scenarioS08();
  const valid = run.topics.filter(topic => topic.mf_id && ['source', 'extract'].includes(topic.type) && topic.status === 'active' && topic.priority >= 1 && topic.priority <= 100);
  const snapshots = valid.map(topic => JSON.parse(JSON.stringify(topic)));
  selectDailyQueue(run.topics, undefined, START);
  valid.forEach((topic, index) => assert.deepEqual(JSON.parse(JSON.stringify(topic)), snapshots[index]));
});

test('initial interval is monotonic in Priority for both types', () => {
  for (const type of ['source', 'extract']) {
    let previous = -Infinity;
    for (let priority = 1; priority <= 100; priority += 1) {
      const value = initialIntervalDays({ type, priority });
      assert.ok(value >= previous, `${type} P${priority}`);
      previous = value;
    }
  }
});

test('every topic produced by a simulation stays inside the scheduling bounds', () => {
  const run = scenarioS01({ scale: 300, days: 90 });
  for (const topic of run.result.topics) {
    assert.ok(Number.isInteger(topic.mf_interval_days) && topic.mf_interval_days >= 1 && topic.mf_interval_days <= 3650);
    assert.ok(topic.a_factor >= 1.1 && topic.a_factor <= 3);
    assert.ok(topic.priority >= 1 && topic.priority <= 100);
    assert.ok(Number.isInteger(topic.mf_revision) && topic.mf_revision >= 0);
  }
});

test('the Legacy proxy is deterministic and never asserts Unified equivalence', () => {
  const topics = [
    makeTopic({ seq: 71, type: 'source', priority: 20, today: START, idealDue: START }),
    makeTopic({ seq: 72, type: 'extract', priority: 80, today: START, idealDue: START }),
  ];
  const first = simulateLegacy({ topics, days: 30, startDate: START });
  const second = simulateLegacy({ topics, days: 30, startDate: START });
  assert.deepEqual(first.metrics, second.metrics);
  assert.equal(first.proxy, true);
  assert.ok(first.proxyLimitations.length >= 3);
});

// Keep an explicit seed reference in the file so failures can be reproduced.
test('documented seeds remain runnable', () => {
  const run = scenarioS01({ seed: 11, scale: 50, days: 30 });
  assert.ok(run.result.metrics.m01Waiting.reviewEvents > 0);
  assert.deepEqual(scenarioS01({ seed: 11, scale: 50, days: 30 }).result.metrics, run.result.metrics);
});
