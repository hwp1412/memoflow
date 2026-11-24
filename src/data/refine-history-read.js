'use strict';

const {
  splitContent,
  requireCurrentExtractType,
  SOFT_OPERATION_LIMIT,
  isUnresolvedStatus,
  utf8Bytes,
} = require('./refine-history.js');

function eventLabel(operation) {
  return operation?.restoreOf ? '恢复' : '精简';
}

function snapshotBase(eventIndex, operation, side) {
  const prefix = `#${String(eventIndex).padStart(2, '0')}`;
  return {
    id: `${operation.operationId}:${side}`,
    label: `${prefix} ${eventLabel(operation)}${side === 'before' ? '前' : '后'}`,
    text: side === 'before' ? operation.before.body : operation.after.body,
    eventIndex,
    side,
    operationId: operation.operationId,
  };
}

// Build a read-only view model from validated store entries. It deliberately
// exposes event before/after snapshots separately; an event is not a single
// "version". Current content remains a distinct current snapshot.
function buildHistoryView({
  entries = [],
  currentContent,
  currentPath = null,
  currentDirty = false,
} = {}) {
  requireCurrentExtractType(currentContent);
  const split = splitContent(currentContent);
  const current = {
    id: 'current',
    label: '当前正文',
    text: split.body,
    fullText: currentContent,
    bodyBytes: utf8Bytes(split.body),
    dirty: Boolean(currentDirty),
    currentPath,
  };
  const events = [];
  const snapshots = [current];
  let bytes = 0;
  let unresolved = 0;
  entries.forEach((entry, index) => {
    const operation = entry.operation;
    const status = entry.state?.status || 'conflict';
    const before = snapshotBase(index + 1, operation, 'before');
    const after = snapshotBase(index + 1, operation, 'after');
    const type = eventLabel(operation);
    events.push({
      operationId: operation.operationId,
      index: index + 1,
      type,
      typeCode: operation.restoreOf ? 'restore' : 'refine',
      status,
      createdAt: operation.createdAt,
      before,
      after,
      restoreOf: operation.restoreOf || null,
      selectedText: operation.selection?.selectedText || '',
      replacementText: operation.selection?.replacementText || '',
    });
    snapshots.push(before, after);
    bytes += Number(operation.before?.bodyBytes) || 0;
    bytes += Number(operation.after?.bodyBytes) || 0;
    if (isUnresolvedStatus(status) || entry.state?.missingState) unresolved++;
  });
  return {
    current,
    events,
    snapshots,
    count: events.length,
    historyBytes: bytes,
    softLimitExceeded: events.length > SOFT_OPERATION_LIMIT,
    unresolved,
  };
}

module.exports = { buildHistoryView, eventLabel };
