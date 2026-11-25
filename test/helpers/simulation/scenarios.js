'use strict';

// A13.2 scenario catalogue for the MF-US-1 offline simulation.
//
// Every scenario is deterministic given its seed and parameters. Scenario
// builders return plain data (state + metrics); assertions live in the test
// files so this module stays reusable from scripts and docs.

const {
  createRng,
  uuid,
  makeTopic,
  offsetDate,
  mixedPopulation,
} = require('./fixtures.js');
const { simulate } = require('./runner.js');
const { simulateLegacy } = require('./legacy-reference.js');
const {
  selectDailyQueue,
  createQueueConfig,
  createEventLedger,
  applyEventWithLedger,
  previewMercy,
  applyMercyBatch,
  undoMercyBatch,
} = require('../../../src/scheduling/index.js');

const START = '2026-01-05';

// ---- S01: topic scale -----------------------------------------------------

function scenarioS01({ seed = 11, scale, days }) {
  const topics = mixedPopulation({ seed, count: scale, startDate: START });
  const result = simulate({ seed, topics, days, startDate: START });
  return { id: 'S01', scale, days, topics, result };
}

// ---- S02: twenty new extracts per day -------------------------------------

function scenarioS02({ seed = 22, baseCount = 100, days = 60, perDay = 20 } = {}) {
  const rng = createRng(seed);
  const base = mixedPopulation({ seed, count: baseCount, startDate: START });
  const parent = makeTopic({ seq: 500000, type: 'source', priority: 50, today: START, idealDue: START });
  let sequence = 600000;
  const created = [];
  const dailyAdd = ({ date }) => {
    const batch = [];
    for (let index = 0; index < perDay; index += 1) {
      sequence += 1;
      const child = makeTopic({
        seq: sequence,
        type: 'extract',
        priority: 40 + Math.floor(rng() * 40),
        today: date,
        idealDue: date,
        estimatedMinutes: 5,
      });
      child.mf_parent_id = parent.mf_id;
      child.mf_root_id = parent.mf_id;
      batch.push(child);
      created.push(child.mf_id);
    }
    return batch;
  };
  const parentBefore = JSON.parse(JSON.stringify(parent));
  const result = simulate({ seed, topics: [parent, ...base], days, startDate: START, dailyAdd });
  const parentAfter = result.topics.find(topic => topic.mf_id === parent.mf_id);
  return { id: 'S02', days, perDay, created, parentBefore, parentAfter, result };
}

// ---- S03: fourteen days without study -------------------------------------

function scenarioS03({ seed = 33, days = 45, gapStart = 10, gapLength = 14 } = {}) {
  const topics = mixedPopulation({ seed, count: 300, startDate: START });
  const skipWhen = ({ offset }) => offset >= gapStart && offset < gapStart + gapLength;
  const result = simulate({ seed, topics, days, startDate: START, skipWhen });
  return { id: 'S03', days, gapStart, gapLength, result };
}

// ---- S04: five-level recursive extracts -----------------------------------

function scenarioS04({ seed = 44, days = 20 } = {}) {
  // The source is deliberately not due during the run, so the only activity is
  // on the extract chain: any change to the source would be an implicit effect.
  const source = makeTopic({ seq: 700001, type: 'source', priority: 50, today: START, idealDue: offsetDate(START, 30), estimatedMinutes: 10 });
  const sourceBefore = JSON.parse(JSON.stringify(source));
  const chain = [source];
  for (let level = 1; level <= 4; level += 1) {
    const parent = chain[chain.length - 1];
    const child = makeTopic({
      seq: 700001 + level,
      type: 'extract',
      priority: 30 + level,
      today: START,
      idealDue: START,
      estimatedMinutes: 5,
      reviewCount: level - 1,
    });
    child.mf_parent_id = parent.mf_id;
    child.mf_root_id = source.mf_id;
    chain.push(child);
  }
  const before = chain.map(topic => JSON.parse(JSON.stringify(topic)));
  const result = simulate({ seed, topics: chain, days, startDate: START });
  return { id: 'S04', chain, before, sourceBefore, result };
}

// ---- S05: daily time budget ----------------------------------------------

function scenarioS05({ seed = 55, days = 5 } = {}) {
  const topics = [];
  for (let index = 0; index < 3; index += 1) {
    topics.push(makeTopic({ seq: 800000 + index, type: 'source', priority: 10 + index, today: START, idealDue: START }));
  }
  for (let index = 0; index < 10; index += 1) {
    topics.push(makeTopic({ seq: 800100 + index, type: 'extract', priority: 40 + index, today: START, idealDue: START }));
  }
  const large = makeTopic({ seq: 800900, type: 'source', priority: 1, today: START, idealDue: START, estimatedMinutes: 120 });
  topics.push(large);

  const day0 = selectDailyQueue(topics, undefined, START);
  const result = simulate({ seed, topics, days, startDate: START });
  return { id: 'S05', topics, large, day0, result };
}

// ---- S06: priority backlog and starvation --------------------------------

function scenarioS06({ seed = 66, days = 60, high = 20, low = 200 } = {}) {
  const topics = [];
  for (let index = 0; index < high; index += 1) {
    topics.push(makeTopic({
      seq: 900000 + index,
      type: 'extract',
      priority: 1 + (index % 20),
      today: START,
      idealDue: offsetDate(START, -10 - (index % 5)),
      estimatedMinutes: 5,
    }));
  }
  for (let index = 0; index < low; index += 1) {
    topics.push(makeTopic({
      seq: 910000 + index,
      type: 'extract',
      priority: 90 + (index % 11),
      today: START,
      idealDue: offsetDate(START, -5 - (index % 17)),
      estimatedMinutes: 5,
    }));
  }
  let sequence = 920000;
  const dailyAdd = ({ date }) => {
    const batch = [];
    for (let index = 0; index < 2; index += 1) {
      sequence += 1;
      batch.push(makeTopic({
        seq: sequence,
        type: 'extract',
        priority: 5,
        today: date,
        idealDue: date,
        estimatedMinutes: 5,
      }));
    }
    return batch;
  };
  const result = simulate({ seed, topics, days, startDate: START, dailyAdd });
  return { id: 'S06', days, high, low, result };
}

// ---- S07: batch Mercy and undo -------------------------------------------

function scenarioS07({ seed = 77 } = {}) {
  const make = (n, overrides = {}) => makeTopic({
    seq: 930000 + n,
    type: 'extract',
    priority: 20 + n,
    today: START,
    idealDue: offsetDate(START, -6),
    estimatedMinutes: 10,
    ...overrides,
  });

  const topics = [make(1), make(2, { mf_not_before: offsetDate(START, -1) }), make(3), make(4)];
  const config = { windowDays: 7, batchId: 'sim-mercy-1' };
  const plan = previewMercy(topics, config, START);
  const applied = applyMercyBatch(plan, topics, START);

  // One item is edited after the preview (revision bump) -> partial batch.
  const edited = applied.topics.map((topic, index) => (index === 0
    ? { ...topic, mf_revision: topic.mf_revision + 1 }
    : topic));
  const plan2 = previewMercy(topics, { ...config, batchId: 'sim-mercy-2' }, START);
  const partial = applyMercyBatch(plan2, [topics[0], ...topics.slice(1)], START);
  const partialEdited = applyMercyBatch(plan2, [edited[0], ...topics.slice(1)], START);

  // Undo the successful batch, then resume a partial undo.
  const undone = undoMercyBatch(applied.batch, applied.topics, START);
  const firstUndo = undoMercyBatch(applied.batch, [applied.topics[0]], START);
  const resumed = undoMercyBatch(firstUndo.batch, [firstUndo.topics[0], ...applied.topics.slice(1)], START);

  // Stale preview: applying on the next day must be refused.
  let staleError = null;
  try {
    applyMercyBatch(plan, topics, offsetDate(START, 1));
  } catch (error) {
    staleError = error.code;
  }

  // Duplicate identity at apply time.
  const duplicateApply = applyMercyBatch(plan, [...topics, { ...topics[1] }], START);

  // Window variants.
  const windows = {};
  for (const windowDays of [3, 7, 14, 30]) {
    const variant = previewMercy(topics, { windowDays, batchId: `sim-w${windowDays}` }, START);
    windows[windowDays] = variant.slots.map(slot => slot.date);
  }

  return {
    id: 'S07',
    topics,
    plan,
    applied,
    partial,
    partialEdited,
    undone,
    firstUndo,
    resumed,
    staleError,
    duplicateApply,
    windows,
  };
}

// ---- S08: anomalies and conflicts ----------------------------------------

function scenarioS08({ seed = 88 } = {}) {
  const valid1 = makeTopic({ seq: 940001, type: 'extract', priority: 30, today: START, idealDue: START });
  const valid2 = makeTopic({ seq: 940002, type: 'extract', priority: 40, today: START, idealDue: START });
  const card = makeTopic({ seq: 940003, type: 'extract', priority: 10, today: START, idealDue: START });
  card.type = 'card';
  const badPriority = makeTopic({ seq: 940004, type: 'extract', priority: 50, today: START, idealDue: START });
  badPriority.priority = 0;
  const badDate = makeTopic({ seq: 940005, type: 'extract', priority: 50, today: START, idealDue: START });
  badDate.mf_ideal_due = '2026-02-30';
  const missingId = makeTopic({ seq: 940006, type: 'extract', priority: 50, today: START, idealDue: START });
  delete missingId.mf_id;
  const duplicateA = makeTopic({ seq: 940007, type: 'extract', priority: 50, today: START, idealDue: START });
  const duplicateB = { ...duplicateA, priority: 60 };
  const renamed = makeTopic({ seq: 940008, type: 'extract', priority: 45, today: START, idealDue: START });
  renamed.date_added = START;

  const topics = [valid1, valid2, card, badPriority, badDate, missingId, duplicateA, duplicateB, renamed];
  const queue = selectDailyQueue(topics, undefined, START);

  // Event anomalies through the in-memory ledger: duplicate replay (E1 -> E2
  // -> E1) and a stale revision.
  const event1 = {
    eventId: uuid(950001),
    topicId: valid1.mf_id,
    type: 'ADVANCED',
    expectedRevision: valid1.mf_revision,
    algorithmVersion: 1,
    calendarDate: START,
  };
  const event2 = {
    eventId: uuid(950002),
    topicId: valid1.mf_id,
    type: 'ADVANCED',
    expectedRevision: valid1.mf_revision + 1,
    algorithmVersion: 1,
    calendarDate: START,
  };
  const first = applyEventWithLedger(createEventLedger(), valid1, event1, undefined, START);
  const second = applyEventWithLedger(first.ledger, first.topic, event2, undefined, START);
  const replay = applyEventWithLedger(second.ledger, second.topic, event1, undefined, START);

  let revisionConflict = null;
  try {
    applyEventWithLedger(createEventLedger(), { ...valid1, mf_revision: 3 }, { ...event1, expectedRevision: 1 }, undefined, START);
  } catch (error) {
    revisionConflict = error.code;
  }

  return {
    id: 'S08',
    topics,
    queue,
    events: {
      firstApplied: first.result.applied,
      secondApplied: second.result.applied,
      replayDuplicate: replay.duplicate,
      reviewCount: replay.topic.review_count,
    },
    revisionConflict,
  };
}

// ---- Legacy vs Unified comparison ----------------------------------------

function scenarioComparison({ seed = 99, count = 300, days = 90 } = {}) {
  const topics = mixedPopulation({ seed, count, startDate: START });
  const unified = simulate({ seed, topics, days, startDate: START });
  const legacy = simulateLegacy({ topics, days, startDate: START });
  return { id: 'CMP', seed, count, days, unified, legacy };
}

const SCENARIOS = Object.freeze({
  S01: scenarioS01,
  S02: scenarioS02,
  S03: scenarioS03,
  S04: scenarioS04,
  S05: scenarioS05,
  S06: scenarioS06,
  S07: scenarioS07,
  S08: scenarioS08,
  CMP: scenarioComparison,
});

module.exports = {
  START,
  SCENARIOS,
  scenarioS01,
  scenarioS02,
  scenarioS03,
  scenarioS04,
  scenarioS05,
  scenarioS06,
  scenarioS07,
  scenarioS08,
  scenarioComparison,
};
