'use strict';

// Host adapter for the three daily reading actions (HOST-ACTIONS-01):
// POSTPONE, MANUAL_SCHEDULE and SET_PRIORITY.
//
// Responsibilities, deliberately narrow:
//   * validate the user's parameters;
//   * build the MF-US-1 payload through the existing reading-action mapping
//     (`mapReadingAction`), so there is no second translation table;
//   * normalise the runtime/legacy outcome into something the UI can show
//     honestly (never a success message for conflict/uncertain/failed).
//
// It never writes Frontmatter and never computes scheduling itself: the actual
// write always happens behind the host scheduler service / Unified runtime.

const { mapReadingAction } = require('../scheduling/reading-integration.js');
const { isValidDateString } = require('../scheduling/dates.js');

// Host-facing names -> accepted reading-action map keys (reading-integration).
const MAP_ACTION = Object.freeze({
  postpone: 'postpone',
  schedule: 'manual-schedule',
  priority: 'set-priority',
});

const ACTION_KIND = Object.freeze({
  postpone: 'POSTPONE',
  schedule: 'MANUAL_SCHEDULE',
  priority: 'SET_PRIORITY',
});

const MAX_POSTPONE_DAYS = 3650;

function clampMessage(value) {
  return typeof value === 'string' ? value : null;
}

function validateParams(kind, params = {}) {
  if (kind === 'postpone') {
    const days = Number(params.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_POSTPONE_DAYS) {
      return { ok: false, code: 'E_POSTPONE_DAYS_INVALID', message: `延期天数必须是 1–${MAX_POSTPONE_DAYS} 的整数。` };
    }
    return { ok: true, value: { days } };
  }
  if (kind === 'schedule') {
    const idealDue = typeof params.idealDue === 'string' ? params.idealDue.trim() : '';
    if (!isValidDateString(idealDue)) {
      return { ok: false, code: 'E_MANUAL_DATE_INVALID', message: '手动排期需要一个合法的本地日历日期（YYYY-MM-DD）。' };
    }
    const reason = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : 'manual-schedule';
    return { ok: true, value: { idealDue, reason } };
  }
  if (kind === 'priority') {
    const priority = Number(params.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
      return { ok: false, code: 'E_PRIORITY_INVALID', message: '优先级必须是 1–100 的整数。' };
    }
    return { ok: true, value: { priority } };
  }
  return { ok: false, code: 'E_ACTION_UNKNOWN', message: `未知的阅读操作：${kind}` };
}

// Reuses the accepted reading-action map so payloads cannot drift from the
// event contract enforced by reading-integration.js.
function buildEventPayload(kind, params = {}) {
  const validated = validateParams(kind, params);
  if (!validated.ok) return validated;
  let mapped;
  try {
    mapped = mapReadingAction({ action: MAP_ACTION[kind], ...validated.value });
  } catch (error) {
    return { ok: false, code: (error && error.code) || 'E_ACTION_MAPPING_FAILED', message: error && error.message };
  }
  return { ok: true, type: mapped.type, payload: mapped.payload ?? null, value: validated.value };
}

function afterOf(outcome) {
  const record = outcome && outcome.record;
  const audit = record && record.audit;
  return (audit && audit.after) || null;
}

function successMessage(kind, outcome) {
  const after = afterOf(outcome);
  if (kind === 'postpone') {
    if (after && after.notBefore) return `已延期 · 最早可展示 ${after.notBefore}（理想到期 ${after.idealDue} 不变）`;
    return '已延期。';
  }
  if (kind === 'schedule') {
    return after && after.idealDue ? `已排期至 ${after.idealDue}` : '已重新排期。';
  }
  if (kind === 'priority') {
    return after && Number.isFinite(Number(after.priority)) ? `优先级 → P${after.priority}` : '优先级已更新。';
  }
  return '已完成。';
}

const NO_OP_MESSAGES = Object.freeze({
  NO_LATER_THAN_EXISTING: '未进一步推迟：已有更晚的延期日期。',
  NO_LATER_THAN_IDEAL: '未进一步推迟：理想到期日晚于目标日期，行政延期不会产生可见变化。',
  NO_STATE_CHANGE: '没有需要修改的字段。',
  SESSION_ONLY: '该操作只影响会话，不改变调度。',
});

// Normalises the host outcome for the UI. `legacy` means the legacy writer ran
// (it already showed its own legacy notification), so the adapter must not add
// a second, differently-worded one.
function describeOutcome(kind, outcome) {
  if (!outcome || typeof outcome.status !== 'string') {
    return { status: 'legacy', message: null, reason: null, writesPerformed: null, confirmed: false, outcome: outcome ?? null };
  }
  const status = outcome.status;
  if (status === 'applied') {
    return { status, message: successMessage(kind, outcome), reason: null, writesPerformed: outcome.writesPerformed === true, confirmed: true, outcome };
  }
  if (status === 'duplicate') {
    return {
      status,
      message: '该操作此前已完成（重复提交，未再次写入）。',
      reason: outcome.reason || null,
      writesPerformed: false,
      confirmed: true,
      outcome,
    };
  }
  if (status === 'no-op') {
    return {
      status,
      message: NO_OP_MESSAGES[outcome.reason] || clampMessage(outcome.text) || '没有可见变化。',
      reason: outcome.reason || null,
      writesPerformed: false,
      confirmed: false,
      outcome,
    };
  }
  if (status === 'conflict') {
    return {
      status,
      message: `写入被拒绝（${outcome.reason || 'E_CONFLICT'}）：笔记可能已被外部修改，请刷新后重试。`,
      reason: outcome.reason || null,
      writesPerformed: false,
      confirmed: false,
      outcome,
    };
  }
  if (status === 'uncertain') {
    return {
      status,
      message: '写入结果尚未确认，请核对笔记内容后重试；不要重复点击。',
      reason: outcome.reason || null,
      writesPerformed: outcome.writesPerformed === true ? true : null,
      confirmed: false,
      outcome,
    };
  }
  if (status === 'requires-manual-recovery') {
    return {
      status,
      message: `需要人工核对（${outcome.reason || 'MANUAL_RECOVERY'}）：请检查该笔记的调度字段。`,
      reason: outcome.reason || null,
      writesPerformed: outcome.writesPerformed === true ? true : null,
      confirmed: false,
      outcome,
    };
  }
  return {
    status: status || 'failed',
    message: `操作失败（${outcome.reason || 'E_ACTION_FAILED'}）。`,
    reason: outcome.reason || null,
    writesPerformed: outcome.writesPerformed === true ? true : null,
    confirmed: false,
    outcome,
  };
}

function shouldRefreshUI(result) {
  return result.status === 'applied' || result.status === 'duplicate' || result.status === 'legacy';
}

module.exports = {
  ACTION_KIND,
  MAX_POSTPONE_DAYS,
  validateParams,
  buildEventPayload,
  describeOutcome,
  shouldRefreshUI,
};
