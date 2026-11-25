'use strict';

// Synthetic fixtures for the Unified writer tests (PR-09).

const {
  SyntheticUnifiedStorage,
  MemoryLedgerStore,
  MemoryBatchStore,
  PersistentEventLedger,
  issueSyntheticUnifiedCapability,
} = require('../../src/scheduling/index.js');

function uuid(seq) {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function makeTopic(overrides = {}) {
  const seq = overrides.seq ?? 1;
  const mfId = overrides.mfId ?? uuid(seq);
  const revision = overrides.revision ?? 1;
  const frontmatter = {
    type: 'source',
    status: 'active',
    priority: 50,
    a_factor: 2.0,
    review_count: 3,
    last_reviewed: '2026-11-01',
    mf_id: mfId,
    mf_revision: revision,
    mf_scheduler_version: 1,
    mf_ideal_due: '2026-11-24',
    mf_not_before: null,
    mf_interval_days: 8,
    ...overrides.frontmatter,
  };
  return {
    mfId,
    path: overrides.path ?? `Sources/${seq}.md`,
    entry: {
      mfId,
      revision,
      frontmatter,
      body: overrides.body ?? 'Body text\nsecond line',
    },
  };
}

function setup(overrides = {}) {
  const topic = makeTopic(overrides);
  const files = overrides.files ?? { [topic.path]: topic.entry };
  const storage = new SyntheticUnifiedStorage(files);
  const store = new MemoryLedgerStore(overrides.records ?? {});
  const batchStore = new MemoryBatchStore(overrides.batches ?? {});
  const ledger = new PersistentEventLedger(store);
  const capability = overrides.capability ?? issueSyntheticUnifiedCapability();
  const deps = {
    mode: overrides.mode ?? { mode: 'unified' },
    storage,
    ledger,
    capability,
    ...overrides.deps,
  };
  return { topic, storage, store, batchStore, ledger, capability, deps };
}

function makeRequest(topic, overrides = {}) {
  return {
    eventId: overrides.eventId ?? uuid(1000),
    topicId: overrides.topicId ?? topic.mfId,
    type: overrides.type ?? 'ADVANCED',
    payload: overrides.payload,
    expectedRevision: overrides.expectedRevision ?? 1,
    algorithmVersion: overrides.algorithmVersion ?? 1,
    today: overrides.today ?? '2026-11-24',
    calendarDate: overrides.calendarDate,
    ...overrides,
  };
}

module.exports = { uuid, makeTopic, setup, makeRequest };
