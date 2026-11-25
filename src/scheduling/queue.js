'use strict';

// MF-US-1 daily queue (SPEC A6, A12, A13 T14).
//
// Pure: takes normalised topics plus an explicit `today`, returns a decision
// snapshot. It never writes to a topic, never reads a clock and never touches a
// vault. Effective Priority is a ranking value only and is never written back.
//
// Ordering is a deterministic five-key total order (A6.2):
//   1. effectivePriority asc   2. priority asc   3. effectiveDue asc
//   4. createdDate asc (missing last)   5. stable id by code unit (locale free)

const { fail, isSchedulingError } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const {
  isPlainObject,
  validateTopicType,
  validatePriority,
  validateStatus,
  validateStableId,
  validateUuid,
  validateEstimatedMinutes,
} = require('./schema.js');
const { assertDateString, compareDate } = require('./dates.js');
const { dueStateFromDates } = require('./due.js');
const { assertQueueConfig } = require('./queue-config.js');
const { forecastFromEntries } = require('./workload.js');

const ACTIVE_STATUS = 'active';
const EXCLUDED_STATUSES = Object.freeze(['done', 'dismissed']);
const LEGACY_STATUSES = Object.freeze(['inbox', 'pending', 'container']);

const SORT_KEYS = Object.freeze(['effectivePriority', 'priority', 'effectiveDue', 'createdDate', 'stableId']);

// SPEC A6.2
const AGE_BONUS_PERIOD_DAYS = 7;
const AGE_BONUS_MAX = 20;

const TYPE_LABELS = Object.freeze({ source: '来源', extract: '摘录' });

function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

function resolveStableId(topic) {
  if (topic.mf_id != null) return validateUuid(topic.mf_id, 'mf_id');
  if (topic.stable_id != null) return validateStableId(topic.stable_id, 'stable_id');
  fail('E_QUEUE_ID_REQUIRED', 'topic needs mf_id or a caller-provided stable_id; the queue never mints identities', {
    field: 'mf_id',
  });
}

function invalidFromError(error, index) {
  if (!isSchedulingError(error)) throw error;
  return { index, code: error.code, message: error.message, details: error.details };
}

// Classify one input. Errors become per-topic diagnostics, never a thrown
// batch failure, so one broken note cannot hide the rest of the queue.
//
// Identity is resolved BEFORE the business fields (owner review): a Source /
// Extract whose Priority, dates or estimated cost are illegal still has a
// perfectly readable stable id, so it must take part in duplicate detection.
// Only a record whose identity itself cannot be read is excluded from it.
function analyzeTopic(topic, index, config, today) {
  let identity = null;
  try {
    if (!isPlainObject(topic)) {
      fail('E_OBJECT_REQUIRED', 'topic must be a plain object', { index });
    }
    // validateTopicType rejects cards and unknown types, so they never obtain
    // an MF-US-1 identity and can never block a Source/Extract.
    const type = validateTopicType(topic.type);
    identity = { stableId: resolveStableId(topic), type };
  } catch (error) {
    return { invalid: invalidFromError(error, index) };
  }

  try {
    const type = identity.type;
    const stableId = identity.stableId;
    const status = validateStatus(topic.status);

    if (EXCLUDED_STATUSES.includes(status)) {
      return { identity, excluded: { index, stableId, type, status, reason: 'STATUS_NOT_ACTIVE' } };
    }
    if (LEGACY_STATUSES.includes(status)) {
      return {
        identity,
        unsupported: {
          index,
          stableId,
          type,
          status,
          code: 'E_STATUS_UNSUPPORTED',
          reason: 'LEGACY_STATUS',
        },
      };
    }

    const priority = validatePriority(topic.priority);
    const idealDue = assertDateString(topic.mf_ideal_due, 'mf_ideal_due');
    const notBefore = topic.mf_not_before == null ? null : assertDateString(topic.mf_not_before, 'mf_not_before');
    const createdDate = topic.date_added == null ? null : assertDateString(topic.date_added, 'date_added');
    const estimatedMinutes = topic.estimated_minutes == null
      ? config.defaultMinutes[type]
      : validateEstimatedMinutes(topic.estimated_minutes);

    const due = dueStateFromDates(idealDue, notBefore, today);
    const overdueDays = due.overdueDays;
    const ageBonus = Math.min(AGE_BONUS_MAX, Math.floor(overdueDays / AGE_BONUS_PERIOD_DAYS));
    const effectivePriority = Math.max(1, priority - ageBonus);

    const entry = {
      index,
      stableId,
      type,
      status,
      priority,
      idealDue,
      notBefore,
      effectiveDue: due.effectiveDue,
      overdueDays,
      ageBonus,
      effectivePriority,
      estimatedMinutes,
      createdDate,
    };

    if (due.available) return { identity, entry, bucket: 'candidate' };
    if (due.postponedOnly) return { identity, entry, bucket: 'postponed' };
    return { identity, entry, bucket: 'notYetDue' };
  } catch (error) {
    const invalid = invalidFromError(error, index);
    // Keep the resolved identity so the duplicate check still sees this record.
    invalid.stableId = identity.stableId;
    return { identity, invalid };
  }
}

function compareIds(left, right) {
  // Code-unit order: deterministic and locale independent.
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareQueueEntries(left, right) {
  if (left.effectivePriority !== right.effectivePriority) return left.effectivePriority - right.effectivePriority;
  if (left.priority !== right.priority) return left.priority - right.priority;
  const dueDifference = compareDate(left.effectiveDue, right.effectiveDue);
  if (dueDifference !== 0) return dueDifference;
  if (left.createdDate !== right.createdDate) {
    if (left.createdDate == null) return 1; // unknown creation date sorts last
    if (right.createdDate == null) return -1;
    const createdDifference = compareDate(left.createdDate, right.createdDate);
    if (createdDifference !== 0) return createdDifference;
  }
  return compareIds(left.stableId, right.stableId);
}

// SPEC A6.3. A single ordered pass is provably equivalent to "repeatedly take
// the highest-ranked task that still fits": the remaining budget only shrinks
// and task costs are fixed, so an item that did not fit earlier can never fit
// later. The pass is linear and always terminates.
function selectWithinBudget(sorted, budgetMinutes) {
  let remaining = budgetMinutes;
  const selected = [];
  const deferred = [];
  for (const entry of sorted) {
    entry.remainingBefore = remaining;
    if (entry.estimatedMinutes <= remaining) {
      remaining -= entry.estimatedMinutes;
      entry.selected = true;
      entry.reason = 'SELECTED';
      entry.remainingAfter = remaining;
      selected.push(entry);
    } else {
      entry.selected = false;
      entry.reason = 'NO_BUDGET_REMAINING';
      entry.remainingAfter = remaining;
      deferred.push(entry);
    }
  }
  return { selected, deferred, usedMinutes: budgetMinutes - remaining, remainingMinutes: remaining };
}

function candidateExplanation(entry) {
  const notBefore = entry.notBefore ? `（行政延期至 ${entry.notBefore}）` : '';
  const decision = entry.selected
    ? `已选入，本次扣减后剩余预算 ${entry.remainingAfter} 分钟`
    : `未选入：剩余预算 ${entry.remainingBefore} 分钟不足以容纳 ${entry.estimatedMinutes} 分钟；原始排期、间隔与评阅历史保持不变`;
  return `${typeLabel(entry.type)} P${entry.priority}：理想到期 ${entry.idealDue}${notBefore}，实际可展示 ${entry.effectiveDue}；逾期 ${entry.overdueDays} 天，补偿 ${entry.ageBonus} 级 → 有效优先级 ${entry.effectivePriority}；预计 ${entry.estimatedMinutes} 分钟；${decision}。`;
}

function postponedExplanation(entry) {
  return `${typeLabel(entry.type)} P${entry.priority}：理想到期 ${entry.idealDue}，因行政延期暂不可展示（最早 ${entry.effectiveDue}）；真实间隔与评阅历史未变。`;
}

function notYetDueExplanation(entry) {
  return `${typeLabel(entry.type)} P${entry.priority}：理想到期 ${entry.idealDue}，尚未到期，不进入普通每日队列。`;
}

function publicEntry(entry, { rank = null, reason = null, text = '' } = {}) {
  return {
    stableId: entry.stableId,
    type: entry.type,
    status: entry.status,
    priority: entry.priority,
    idealDue: entry.idealDue,
    notBefore: entry.notBefore,
    effectiveDue: entry.effectiveDue,
    overdueDays: entry.overdueDays,
    ageBonus: entry.ageBonus,
    effectivePriority: entry.effectivePriority,
    estimatedMinutes: entry.estimatedMinutes,
    createdDate: entry.createdDate,
    selected: Boolean(entry.selected),
    reason: reason || entry.reason,
    rank,
    explain: {
      text,
      data: {
        priority: entry.priority,
        ageBonus: entry.ageBonus,
        effectivePriority: entry.effectivePriority,
        overdueDays: entry.overdueDays,
        idealDue: entry.idealDue,
        notBefore: entry.notBefore,
        effectiveDue: entry.effectiveDue,
        estimatedMinutes: entry.estimatedMinutes,
        selected: Boolean(entry.selected),
        reason: reason || entry.reason,
      },
    },
  };
}

function emptyResult(config, today, workload) {
  return {
    algorithmVersion: ALGORITHM_VERSION,
    today,
    queueConfig: config,
    selected: [],
    deferredByBudget: [],
    postponed: [],
    notYetDue: [],
    excluded: [],
    unsupported: [],
    invalid: [],
    budget: {
      budgetMinutes: config.dailyBudgetMinutes,
      usedMinutes: 0,
      remainingMinutes: config.dailyBudgetMinutes,
      selectedCount: 0,
      candidateCount: 0,
      deferredCount: 0,
    },
    workload,
    explain: { text: '今日队列：没有可调度的 Source / Extract。', data: { sortKeys: SORT_KEYS } },
  };
}

// SPEC A6 / A9 — the daily queue entry point.
function selectDailyQueue(topics, config = undefined, today = undefined) {
  const cfg = assertQueueConfig(config);
  assertDateString(today, 'today');
  if (!Array.isArray(topics)) {
    fail('E_OBJECT_REQUIRED', 'selectDailyQueue expects an array of topics', { field: 'topics' });
  }

  const accepted = [];
  const excluded = [];
  const unsupported = [];
  const invalid = [];
  const identities = [];

  topics.forEach((topic, index) => {
    const analysis = analyzeTopic(topic, index, cfg, today);
    if (analysis.identity) {
      identities.push({ stableId: analysis.identity.stableId, index });
    }
    if (analysis.invalid) invalid.push(analysis.invalid);
    else if (analysis.excluded) excluded.push(analysis.excluded);
    else if (analysis.unsupported) unsupported.push(analysis.unsupported);
    else accepted.push(analysis);
  });

  // Duplicate ids are ambiguous regardless of status: an id used by an active
  // topic and by a done/legacy topic is still one identity. Detection therefore
  // spans every topic whose id could be resolved (accepted + excluded +
  // unsupported), reports each occurrence, and removes all of them. Topics with
  // an unresolvable id stay ordinary invalid records and never influence others.
  // Every record whose identity could be read takes part — including records
  // that are invalid for other reasons. The duplicate check therefore cannot be
  // bypassed by making the colliding twin's Priority/date/cost illegal.
  const idCounts = new Map();
  for (const record of identities) {
    idCounts.set(record.stableId, (idCounts.get(record.stableId) || 0) + 1);
  }
  const duplicatedIds = new Set();
  for (const [stableId, count] of idCounts) {
    if (count > 1) duplicatedIds.add(stableId);
  }
  for (const record of identities) {
    if (!duplicatedIds.has(record.stableId)) continue;
    invalid.push({
      index: record.index,
      code: 'E_DUPLICATE_ID',
      message: `stable id "${record.stableId}" is used by more than one topic`,
      details: { stableId: record.stableId, occurrences: idCounts.get(record.stableId) },
    });
  }

  const dedupedAccepted = accepted.filter(item => !duplicatedIds.has(item.entry.stableId));
  const keptExcluded = excluded.filter(item => !duplicatedIds.has(item.stableId));
  const keptUnsupported = unsupported.filter(item => !duplicatedIds.has(item.stableId));
  const dedupedCandidates = dedupedAccepted.filter(item => item.bucket === 'candidate');
  const dedupedPostponed = dedupedAccepted.filter(item => item.bucket === 'postponed');
  const dedupedNotYetDue = dedupedAccepted.filter(item => item.bucket === 'notYetDue');

  const sortedCandidates = dedupedCandidates
    .map(item => item.entry)
    .sort(compareQueueEntries);
  sortedCandidates.forEach((entry, index) => { entry.rank = index + 1; });

  const selection = selectWithinBudget(sortedCandidates, cfg.dailyBudgetMinutes);

  const selectedEntries = selection.selected.map(entry => publicEntry(entry, {
    rank: entry.rank,
    text: candidateExplanation(entry),
  }));
  const deferredEntries = selection.deferred.map(entry => publicEntry(entry, {
    rank: entry.rank,
    text: candidateExplanation(entry),
  }));

  const postponedEntries = dedupedPostponed
    .map(item => item.entry)
    .sort((left, right) => compareDate(left.effectiveDue, right.effectiveDue) || compareIds(left.stableId, right.stableId))
    .map(entry => publicEntry(entry, { reason: 'POSTPONED', text: postponedExplanation(entry) }));

  const notYetDueEntries = dedupedNotYetDue
    .map(item => item.entry)
    .sort((left, right) => compareDate(left.idealDue, right.idealDue) || compareIds(left.stableId, right.stableId))
    .map(entry => publicEntry(entry, { reason: 'NOT_YET_DUE', text: notYetDueExplanation(entry) }));

  const excludedEntries = keptExcluded
    .slice()
    .sort((left, right) => compareIds(left.stableId, right.stableId))
    .map(item => ({
      stableId: item.stableId,
      type: item.type,
      status: item.status,
      reason: item.reason,
      explain: { text: `状态 ${item.status}，不参与每日阅读队列（未计评阅）。`, data: { status: item.status } },
    }));

  const unsupportedEntries = keptUnsupported
    .slice()
    .sort((left, right) => compareIds(left.stableId, right.stableId))
    .map(item => ({
      stableId: item.stableId,
      type: item.type,
      status: item.status,
      code: item.code,
      reason: item.reason,
      explain: { text: `状态 ${item.status} 需要兼容适配器映射后才能调度（SPEC A8）。`, data: { status: item.status } },
    }));

  invalid.sort((left, right) => {
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    return left.index - right.index;
  });

  const acceptedEntries = sortedCandidates
    .concat(dedupedPostponed.map(item => item.entry))
    .concat(dedupedNotYetDue.map(item => item.entry));
  const workload = forecastFromEntries(acceptedEntries, cfg, today);

  if (topics.length === 0) return emptyResult(cfg, today, workload);

  const result = {
    algorithmVersion: ALGORITHM_VERSION,
    today,
    queueConfig: cfg,
    selected: selectedEntries,
    deferredByBudget: deferredEntries,
    postponed: postponedEntries,
    notYetDue: notYetDueEntries,
    excluded: excludedEntries,
    unsupported: unsupportedEntries,
    invalid,
    budget: {
      budgetMinutes: cfg.dailyBudgetMinutes,
      usedMinutes: selection.usedMinutes,
      remainingMinutes: selection.remainingMinutes,
      selectedCount: selectedEntries.length,
      candidateCount: sortedCandidates.length,
      deferredCount: deferredEntries.length,
    },
    workload,
  };

  result.explain = {
    text: `今日队列：候选 ${sortedCandidates.length} 个，选入 ${selectedEntries.length} 个，用时 ${selection.usedMinutes}/${cfg.dailyBudgetMinutes} 分钟；超预算 ${deferredEntries.length} 个，行政延期 ${postponedEntries.length} 个，未到期 ${notYetDueEntries.length} 个，其他状态 ${excludedEntries.length + unsupportedEntries.length} 个，非法 ${invalid.length} 个。`,
    data: {
      sortKeys: SORT_KEYS,
      budget: result.budget,
      counts: {
        candidates: sortedCandidates.length,
        selected: selectedEntries.length,
        deferred: deferredEntries.length,
        postponed: postponedEntries.length,
        notYetDue: notYetDueEntries.length,
        excluded: excludedEntries.length,
        unsupported: unsupportedEntries.length,
        invalid: invalid.length,
      },
    },
  };

  return result;
}

module.exports = {
  ACTIVE_STATUS,
  EXCLUDED_STATUSES,
  LEGACY_STATUSES,
  SORT_KEYS,
  AGE_BONUS_PERIOD_DAYS,
  AGE_BONUS_MAX,
  compareQueueEntries,
  compareStableIds: compareIds,
  resolveStableId,
  selectWithinBudget,
  analyzeTopic,
  selectDailyQueue,
};
