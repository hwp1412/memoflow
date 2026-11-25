'use strict';

// Pure scheduling explanation (PR-10, SPEC A9/A12). Reuses the accepted
// interval/initial/due functions instead of re-implementing formulas.

const { initialIntervalDays } = require('./initial.js');
const { explainNextInterval } = require('./interval.js');
const { effectiveDue } = require('./due.js');

function explainSchedule(topic, config = undefined) {
  const initial = initialIntervalDays({ type: topic.type, priority: topic.priority }, config);
  const next = explainNextInterval({ mf_interval_days: topic.mf_interval_days, a_factor: topic.a_factor }, config);
  const effective = effectiveDue(topic);
  const notBeforeApplies = topic.mf_not_before != null && topic.mf_not_before !== topic.mf_ideal_due;
  return {
    text: [
      `首次排期：P${topic.priority} ${topic.type} 初始间隔 ${initial} 天（Priority 基准 × 类型系数，half-up 取整并钳制）。`,
      next.text,
      `理想到期 ${topic.mf_ideal_due}；最早可展示 ${topic.mf_not_before ?? '无'}；Effective Due ${effective}${notBeforeApplies ? '（由行政延期决定）' : ''}。`,
      'Skip 只移动会话指针；Postpone 与 Mercy 属于行政延期，不计有效评阅。',
      '旧数据若 Interval 可能被历史行政操作改写，其真实学习间隔无法反推。',
    ].join('\n'),
    data: {
      priority: topic.priority,
      type: topic.type,
      initialIntervalDays: initial,
      currentIntervalDays: topic.mf_interval_days,
      aFactor: topic.a_factor,
      nextIntervalDays: next.data.nextIntervalDays,
      idealDue: topic.mf_ideal_due,
      notBefore: topic.mf_not_before ?? null,
      effectiveDue: effective,
      notBeforeApplies,
      reviewCount: topic.review_count,
    },
  };
}

module.exports = { explainSchedule };
