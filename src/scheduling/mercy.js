'use strict';

// MF-US-1 Mercy allocation and preview (SPEC A7.1-A7.3, A9, A12).
//
// Mercy is an administrative load operation, never a review. The pure core only
// proposes `mf_not_before` changes: it never touches mf_interval_days, a_factor,
// review_count, last_reviewed, mf_ideal_due or priority, and it never writes to
// a vault. Automatic Mercy stays off: nothing here is triggered implicitly.
//
// Allocation rule (A7.2), implemented verbatim:
//   1. sort by raw Priority, Ideal Due, stable id (ascending);
//   2. W slots start TOMORROW (today is never a slot);
//   3. for each topic take the earliest slot that can hold its estimated cost;
//   4. if no slot can hold it, take the least-loaded slot (ties: earlier date)
//      and mark the overload instead of dropping the topic;
//   5. never move an existing postponement earlier.

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { assertDateString, addCalendarDays, compareDate, maxDate } = require('./dates.js');
const { validateRevision } = require('./schema.js');
const { createQueueConfig } = require('./queue-config.js');
const { selectDailyQueue, compareStableIds, resolveStableId } = require('./queue.js');

const MERCY_WINDOWS = Object.freeze([3, 7, 14, 30]);
const MERCY_CONFIG_KEYS = Object.freeze(['windowDays', 'batchId', 'dailyBudgetMinutes']);
const BATCH_ID_MAX = 200;

function assertMercyConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('E_MERCY_CONFIG_INVALID', 'mercy config must be a plain object with windowDays and batchId', {
      field: 'config',
    });
  }
  for (const key of Object.keys(config)) {
    if (!MERCY_CONFIG_KEYS.includes(key)) {
      fail('E_MERCY_CONFIG_INVALID', `mercy config.${key} is not a known setting`, { key });
    }
  }
  if (!MERCY_WINDOWS.includes(config.windowDays)) {
    fail('E_MERCY_WINDOW_INVALID', `windowDays must be one of ${MERCY_WINDOWS.join(', ')}`, {
      field: 'windowDays',
      value: config.windowDays,
    });
  }
  const batchId = config.batchId;
  if (typeof batchId !== 'string' || batchId.length === 0 || batchId.length > BATCH_ID_MAX || batchId !== batchId.trim()) {
    fail('E_MERCY_BATCH_ID_INVALID', `batchId must be a trimmed string of 1..${BATCH_ID_MAX} characters`, {
      field: 'batchId',
      value: batchId,
    });
  }
  const queueConfig = config.dailyBudgetMinutes === undefined
    ? createQueueConfig()
    : createQueueConfig({ dailyBudgetMinutes: config.dailyBudgetMinutes });
  return { windowDays: config.windowDays, batchId, queueConfig };
}

function effectiveDueOf(idealDue, notBefore) {
  if (notBefore == null) return idealDue;
  return maxDate(idealDue, notBefore);
}

function pickSlot(slots, cost) {
  for (const slot of slots) {
    if (slot.plannedMinutes + cost <= slot.budgetMinutes) return { slot, overloaded: false };
  }
  let chosen = slots[0];
  for (const slot of slots) {
    if (slot.plannedMinutes < chosen.plannedMinutes) chosen = slot;
    else if (slot.plannedMinutes === chosen.plannedMinutes && compareDate(slot.date, chosen.date) < 0) chosen = slot;
  }
  return { slot: chosen, overloaded: true };
}

// SPEC A7.2/A7.3 — read-only plan. Nothing is written, nothing is mutated.
function previewMercy(topics, config, today = undefined) {
  const cfg = assertMercyConfig(config);
  assertDateString(today, 'today');
  if (!Array.isArray(topics)) {
    fail('E_OBJECT_REQUIRED', 'previewMercy expects an array of topics', { field: 'topics' });
  }

  // Reuse the verified queue layer for filtering, identity, duplicate and field
  // validation; Mercy adds only the allocation on top.
  const queueResult = selectDailyQueue(topics, cfg.queueConfig, today);

  const topicById = new Map();
  topics.forEach(topic => {
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)) return;
    try {
      topicById.set(resolveStableId(topic), topic);
    } catch {
      // Unreadable identity: the queue already reported it as invalid.
    }
  });

  const invalid = queueResult.invalid.slice();
  const candidates = [];
  for (const entry of [...queueResult.selected, ...queueResult.deferredByBudget]) {
    const topic = topicById.get(entry.stableId);
    if (!topic) {
      invalid.push({
        index: -1,
        code: 'E_MERCY_TOPIC_MISSING',
        message: `topic ${entry.stableId} was reported by the queue but not found in the input`,
        details: { stableId: entry.stableId },
      });
      continue;
    }
    try {
      validateRevision(topic.mf_revision, 'mf_revision');
    } catch (error) {
      invalid.push({
        index: -1,
        code: error.code,
        message: error.message,
        details: { ...error.details, stableId: entry.stableId },
      });
      continue;
    }
    candidates.push({ entry, topic });
  }

  // A7.2 step 1: raw Priority, then Ideal Due, then stable id.
  candidates.sort((left, right) => {
    if (left.entry.priority !== right.entry.priority) return left.entry.priority - right.entry.priority;
    const dueDifference = compareDate(left.entry.idealDue, right.entry.idealDue);
    if (dueDifference !== 0) return dueDifference;
    return compareStableIds(left.entry.stableId, right.entry.stableId);
  });

  // A7.2 step 2: W calendar slots starting tomorrow.
  const slots = [];
  for (let offset = 1; offset <= cfg.windowDays; offset += 1) {
    slots.push({
      date: addCalendarDays(today, offset),
      budgetMinutes: cfg.queueConfig.dailyBudgetMinutes,
      plannedMinutes: 0,
      topicCount: 0,
      overloadMinutes: 0,
      overloaded: false,
    });
  }

  const items = [];
  const pinnedItems = [];
  for (const { entry, topic } of candidates) {
    const oldNotBefore = topic.mf_not_before ?? null;
    const idealDue = topic.mf_ideal_due;

    // A real candidate is available today, so an existing floor can only be in
    // the past. The guard still refuses to pull a future postponement earlier.
    let movedEarlier = false;
    let slot;
    let overloaded;
    if (oldNotBefore != null && compareDate(oldNotBefore, today) > 0) {
      movedEarlier = true;
      slot = null;
      overloaded = false;
    } else {
      const picked = pickSlot(slots, entry.estimatedMinutes);
      slot = picked.slot;
      overloaded = picked.overloaded;
      slot.plannedMinutes += entry.estimatedMinutes;
      slot.topicCount += 1;
    }

    const proposed = slot ? slot.date : oldNotBefore;
    const newNotBefore = oldNotBefore == null || slot == null
      ? proposed
      : maxDate(oldNotBefore, proposed);
    const changed = newNotBefore !== oldNotBefore && !movedEarlier;
    const effectiveDueBefore = effectiveDueOf(idealDue, oldNotBefore);
    const effectiveDueAfter = effectiveDueOf(idealDue, newNotBefore);

    const item = {
      stableId: entry.stableId,
      type: entry.type,
      priority: entry.priority,
      idealDue,
      notBeforeBefore: oldNotBefore,
      notBeforeAfter: newNotBefore,
      effectiveDueBefore,
      effectiveDueAfter,
      estimatedMinutes: entry.estimatedMinutes,
      slotDate: slot ? slot.date : null,
      revisionBefore: topic.mf_revision,
      revisionAfter: changed ? topic.mf_revision + 1 : topic.mf_revision,
      changed,
      overloaded,
      movedEarlier,
      status: movedEarlier ? 'pinned' : (changed ? 'assigned' : 'noop'),
      explain: {
        text: movedEarlier
          ? `P${entry.priority} ${entry.stableId}：已有行政延期 ${oldNotBefore} 晚于窗口，Mercy 不会提前它；不计入窗口容量。`
          : `P${entry.priority} ${entry.stableId}：理想到期 ${idealDue}，原 not_before ${oldNotBefore == null ? '无' : oldNotBefore}，分配至 ${newNotBefore}；预计 ${entry.estimatedMinutes} 分钟；有效到期 ${effectiveDueBefore} → ${effectiveDueAfter}；${changed ? `revision ${topic.mf_revision} → ${topic.mf_revision + 1}` : '无调度状态变化'}。`,
        data: {
          type: entry.type,
          priority: entry.priority,
          idealDue,
          notBeforeBefore: oldNotBefore,
          notBeforeAfter: newNotBefore,
          effectiveDueBefore,
          effectiveDueAfter,
          estimatedMinutes: entry.estimatedMinutes,
          slotDate: slot ? slot.date : null,
          changed,
          overloaded,
          status: movedEarlier ? 'pinned' : (changed ? 'assigned' : 'noop'),
        },
      },
    };
    if (movedEarlier) pinnedItems.push(item);
    else items.push(item);
  }

  for (const slot of slots) {
    slot.overloadMinutes = Math.max(0, slot.plannedMinutes - slot.budgetMinutes);
    slot.overloaded = slot.overloadMinutes > 0;
  }
  for (const item of items) {
    if (!item.slotDate) continue;
    const slot = slots.find(candidate => candidate.date === item.slotDate);
    item.overloaded = Boolean(slot && slot.overloaded);
    item.explain.data.overloaded = item.overloaded;
  }

  const assigned = items.filter(item => item.status === 'assigned');
  const unchanged = items.filter(item => item.status === 'noop');
  const pinned = pinnedItems;
  const delayed = assigned
    .slice()
    .sort((left, right) => left.priority - right.priority || compareStableIds(left.stableId, right.stableId))
    .map(item => ({ stableId: item.stableId, priority: item.priority, from: item.effectiveDueBefore, to: item.effectiveDueAfter }));

  const overloadedSlots = slots.filter(slot => slot.overloaded);
  const status = assigned.length === 0 ? 'noop' : 'planned';

  const result = {
    algorithmVersion: ALGORITHM_VERSION,
    today,
    batchId: cfg.batchId,
    windowDays: cfg.windowDays,
    queueConfig: cfg.queueConfig,
    slots,
    items,
    assigned,
    unchanged,
    pinned,
    notOverdue: queueResult.notYetDue.map(entry => ({
      stableId: entry.stableId,
      priority: entry.priority,
      idealDue: entry.idealDue,
      reason: 'NOT_OVERDUE',
    })),
    existingPostponements: queueResult.postponed.map(entry => ({
      stableId: entry.stableId,
      priority: entry.priority,
      idealDue: entry.idealDue,
      notBefore: entry.notBefore,
      effectiveDue: entry.effectiveDue,
      reason: 'EXISTING_POSTPONEMENT',
    })),
    excluded: queueResult.excluded,
    unsupported: queueResult.unsupported,
    invalid,
    summary: {
      candidateCount: candidates.length,
      assignedCount: assigned.length,
      unchangedCount: unchanged.length,
      pinnedCount: pinned.length,
      notOverdueCount: queueResult.notYetDue.length,
      existingPostponementCount: queueResult.postponed.length,
      overloadedSlotCount: overloadedSlots.length,
      totalPlannedMinutes: slots.reduce((total, slot) => total + slot.plannedMinutes, 0),
      totalBudgetMinutes: slots.reduce((total, slot) => total + slot.budgetMinutes, 0),
      highestPriorityDelayed: delayed[0] || null,
      delayed,
    },
    status,
  };

  const highest = result.summary.highestPriorityDelayed;
  result.explain = {
    text: `Mercy 预览（批次 ${cfg.batchId}）：窗口 ${cfg.windowDays} 天（${slots[0] ? slots[0].date : '-'}..${slots[slots.length - 1] ? slots[slots.length - 1].date : '-'}），每日预算 ${cfg.queueConfig.dailyBudgetMinutes} 分钟；候选 ${candidates.length} 个，可分配 ${assigned.length} 个，无变化 ${unchanged.length} 个，固定延期 ${pinned.length} 个；超载 ${overloadedSlots.length} 天。${highest ? `最高优先级被延期：P${highest.priority} ${highest.stableId} ${highest.from} → ${highest.to}。` : ''}`,
    data: {
      batchId: cfg.batchId,
      windowDays: cfg.windowDays,
      budgetMinutes: cfg.queueConfig.dailyBudgetMinutes,
      slots: slots.map(slot => ({ date: slot.date, plannedMinutes: slot.plannedMinutes, topicCount: slot.topicCount, overloadMinutes: slot.overloadMinutes })),
      summary: result.summary,
    },
  };

  return result;
}

module.exports = {
  MERCY_WINDOWS,
  BATCH_ID_MAX,
  assertMercyConfig,
  effectiveDueOf,
  pickSlot,
  previewMercy,
};
