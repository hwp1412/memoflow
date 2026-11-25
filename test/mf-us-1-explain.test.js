'use strict';

// PR-10 — pure explainSchedule (SPEC A9/A12).

const test = require('node:test');
const assert = require('node:assert/strict');

const { explainSchedule } = require('../src/scheduling/index.js');

const TOPIC = {
  type: 'source',
  priority: 50,
  mf_interval_days: 8,
  a_factor: 2.0,
  mf_ideal_due: '2026-11-20',
  mf_not_before: '2026-11-28',
  review_count: 3,
  mf_id: '00000000-0000-4000-8000-000000000001',
  mf_revision: 1,
  mf_scheduler_version: 1,
  status: 'active',
  mf_revision: 1,
};

test('explains the initial interval from priority and type factor', () => {
  const explanation = explainSchedule({ ...TOPIC, review_count: 0 });
  assert.equal(explanation.data.initialIntervalDays, 3);
  assert.equal(explanation.data.nextIntervalDays, 16);
  assert.match(explanation.text, /首次排期/);
  assert.match(explanation.text, /类型系数/);
});

test('an Extract uses the smaller type factor', () => {
  const explanation = explainSchedule({ ...TOPIC, type: 'extract' });
  assert.equal(explanation.data.initialIntervalDays, 2);
});

test('ideal due, not before and effective due are explained separately', () => {
  const explanation = explainSchedule(TOPIC);
  assert.equal(explanation.data.idealDue, '2026-11-20');
  assert.equal(explanation.data.notBefore, '2026-11-28');
  assert.equal(explanation.data.effectiveDue, '2026-11-28');
  assert.equal(explanation.data.notBeforeApplies, true);
  assert.match(explanation.text, /行政延期/);
});

test('the explanation never calls postponement learning success', () => {
  const explanation = explainSchedule(TOPIC);
  assert.match(explanation.text, /不计有效评阅/);
  assert.doesNotMatch(explanation.text, /学习成功|已掌握/);
});

test('legacy data limitations are disclosed', () => {
  const explanation = explainSchedule(TOPIC);
  assert.match(explanation.text, /旧数据/);
  assert.match(explanation.text, /无法反推/);
});

// ---- notBefore semantics (review fix 4) ---------------------------------

test('an earlier or equal not_before does not claim an administrative delay', () => {
  for (const notBefore of ['2026-11-10', '2026-11-20']) {
    const explanation = explainSchedule({ ...TOPIC, mf_not_before: notBefore });
    assert.equal(explanation.data.notBeforeApplies, false, notBefore);
    assert.equal(explanation.data.effectiveDue, '2026-11-20', notBefore);
    assert.doesNotMatch(explanation.text, /由行政延期决定/, notBefore);
    assert.match(explanation.text, /不构成延期/, notBefore);
  }
});

test('a later not_before does claim the delay', () => {
  const explanation = explainSchedule({ ...TOPIC, mf_not_before: '2026-11-28' });
  assert.equal(explanation.data.notBeforeApplies, true);
  assert.equal(explanation.data.effectiveDue, '2026-11-28');
  assert.match(explanation.text, /由行政延期决定/);
});
