'use strict';

// Deterministic fixtures for the MF-US-1 offline simulation (PR-05).
//
// Everything here is synthetic and in-memory. No vault, no clock, no network:
// dates are explicit, random draws come from a seeded PRNG, and stable ids are
// derived from a monotonically increasing counter so a run can be reproduced
// from (seed, scenario, algorithm version) alone.

const {
  initializeTopic,
  addCalendarDays,
  calendarDayDifference,
  compareDate,
} = require('../../../src/scheduling/index.js');

const ALGORITHM_VERSION = 1;

// mulberry32: tiny, fast, deterministic.
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function uuid(seq) {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

// A full, valid MF-US-1 topic built through the production initializer so the
// simulation exercises the real initial-interval code, then adjusted to the
// scenario's synthetic history.
function makeTopic(options) {
  const {
    seq,
    type = 'extract',
    priority = 50,
    today,
    idealDue,
    status = 'active',
    estimatedMinutes,
    intervalDays,
    aFactor,
    reviewCount = 0,
    revision = 0,
    lastReviewed = null,
    notBefore = null,
    dateAdded,
    schedulerVersion = ALGORITHM_VERSION,
  } = options;

  const created = initializeTopic({ type, priority, mfId: uuid(seq) }, undefined, today).topic;
  const topic = { ...created };
  if (idealDue != null) topic.mf_ideal_due = idealDue;
  if (intervalDays != null) topic.mf_interval_days = intervalDays;
  if (aFactor != null) topic.a_factor = aFactor;
  if (estimatedMinutes != null) topic.estimated_minutes = estimatedMinutes;
  if (notBefore !== null) topic.mf_not_before = notBefore;
  if (reviewCount !== 0) topic.review_count = reviewCount;
  if (revision !== 0) { topic.mf_revision = revision; }
  if (lastReviewed != null) topic.last_reviewed = lastReviewed;
  if (dateAdded != null) topic.date_added = dateAdded;
  if (status !== 'active') topic.status = status;
  if (schedulerVersion !== ALGORITHM_VERSION) topic.mf_scheduler_version = schedulerVersion;
  return topic;
}

function offsetDate(base, days) {
  return addCalendarDays(base, days);
}

function makeEvent(seq, type, topic, { today, payload = null, expectedRevision } = {}) {
  return {
    eventId: uuid(900000 + seq),
    topicId: topic.mf_id,
    type,
    expectedRevision: expectedRevision == null ? topic.mf_revision : expectedRevision,
    algorithmVersion: ALGORITHM_VERSION,
    calendarDate: today,
    payload,
  };
}

// Mixed population used by the scale / comparison scenarios.
function mixedPopulation({ seed, count, startDate, rng = createRng(seed), seqOffset = 0 }) {
  const topics = [];
  for (let index = 0; index < count; index += 1) {
    const type = rng() < 0.4 ? 'source' : 'extract';
    const priority = 1 + Math.floor(rng() * 100);
    const dueOffset = Math.floor(rng() * 61) - 30; // -30..+30 days from start
    const roll = rng();
    const status = roll < 0.04 ? 'done' : roll < 0.07 ? 'dismissed' : roll < 0.09 ? 'pending' : 'active';
    const customCost = rng() < 0.25 ? 1 + Math.floor(rng() * 120) : undefined;
    topics.push(makeTopic({
      seq: seqOffset + index + 1,
      type,
      priority,
      today: startDate,
      idealDue: offsetDate(startDate, dueOffset),
      status,
      estimatedMinutes: customCost,
      intervalDays: 1 + Math.floor(rng() * 60),
      reviewCount: Math.floor(rng() * 4),
      dateAdded: offsetDate(startDate, -Math.floor(rng() * 120)),
    }));
  }
  return topics;
}

function summarizeTopics(topics) {
  return {
    total: topics.length,
    active: topics.filter(topic => topic.status === 'active').length,
    source: topics.filter(topic => topic.type === 'source').length,
    extract: topics.filter(topic => topic.type === 'extract').length,
    withCustomCost: topics.filter(topic => topic.estimated_minutes != null).length,
    idealOverdue: topics.filter(topic => topic.status === 'active' && compareDate(topic.mf_ideal_due, offsetDate(topic.mf_ideal_due, 0)) <= 0).length,
  };
}

module.exports = {
  ALGORITHM_VERSION,
  createRng,
  uuid,
  pick,
  makeTopic,
  makeEvent,
  offsetDate,
  mixedPopulation,
  summarizeTopics,
  addCalendarDays,
  calendarDayDifference,
  compareDate,
};
