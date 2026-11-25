'use strict';

// Pure due-date semantics for MF-US-1 (SPEC A2.4, A12).
//
// The authoritative scheduling fields are mf_ideal_due and mf_interval_days;
// mf_not_before is only an administrative floor. "Ideally overdue", "available
// now" and "hidden by a postponement" are reported separately so a real backlog
// can never be disguised by moving a date.

const { fail } = require('./errors.js');
const { assertPlainObject, validateTopic } = require('./schema.js');
const { assertDateString, compareDate, calendarDayDifference, maxDate } = require('./dates.js');

// SPEC A2.4: effective_due = mf_ideal_due when mf_not_before is null,
// otherwise max(mf_ideal_due, mf_not_before).
//
// The *FromDates variants are the same calculation over already-resolved
// dates, for callers (the queue) that validate their own minimal topic shape.
// effectiveDue/dueState keep their PR-02 contract unchanged.
function effectiveDueFromDates(idealDue, notBefore) {
  assertDateString(idealDue, 'mf_ideal_due');
  if (notBefore == null) return idealDue;
  return maxDate(idealDue, assertDateString(notBefore, 'mf_not_before'));
}

function dueStateFromDates(idealDue, notBefore, today) {
  assertDateString(idealDue, 'mf_ideal_due');
  if (notBefore != null) assertDateString(notBefore, 'mf_not_before');
  assertDateString(today, 'today');
  const effective = notBefore == null ? idealDue : maxDate(idealDue, notBefore);
  const idealOverdue = compareDate(idealDue, today) < 0;
  const available = compareDate(effective, today) <= 0;
  // Ideally due today or earlier, but an administrative floor hides it now.
  const postponedOnly = !available && compareDate(idealDue, today) <= 0;
  return {
    idealDue,
    notBefore: notBefore ?? null,
    effectiveDue: effective,
    overdueDays: Math.max(0, calendarDayDifference(today, effective)),
    idealOverdue,
    available,
    postponedOnly,
    notYetDue: !available && !postponedOnly,
  };
}

// SPEC A2.4/A6.4: counts that must stay separate. Invalid topics are reported
// by the caller (adapter) — this function throws instead of skipping silently.
function summarizeDue(topics, today) {
  if (!Array.isArray(topics)) {
    fail('E_OBJECT_REQUIRED', 'summarizeDue expects an array of topics', { field: 'topics' });
  }
  assertDateString(today, 'today');
  const counts = {
    total: topics.length,
    idealOverdue: 0,
    available: 0,
    postponedOnly: 0,
    notYetDue: 0,
    maxOverdueDays: 0,
  };
  for (const topic of topics) {
    const state = dueState(topic, today);
    if (state.idealOverdue) counts.idealOverdue += 1;
    if (state.available) counts.available += 1;
    if (state.postponedOnly) counts.postponedOnly += 1;
    if (state.notYetDue) counts.notYetDue += 1;
    if (state.overdueDays > counts.maxOverdueDays) counts.maxOverdueDays = state.overdueDays;
  }
  return counts;
}

function effectiveDue(topic) {
  validateTopic(topic);
  return effectiveDueFromDates(topic.mf_ideal_due, topic.mf_not_before);
}

function dueState(topic, today) {
  validateTopic(topic);
  return dueStateFromDates(topic.mf_ideal_due, topic.mf_not_before, today);
}

function isAvailable(topic, today) {
  return dueState(topic, today).available;
}

module.exports = { effectiveDue, effectiveDueFromDates, dueState, dueStateFromDates, summarizeDue, isAvailable };
