'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createRefineOperation,
  createRestoreOperation,
  makeState,
} = require('../src/data/refine-history.js');
const { buildHistoryView } = require('../src/data/refine-history-read.js');

const NOTE = 'Extracts/History.md';
const A = '---\ntype: extract\npriority: 50\n---\nAlpha beta\n';
const B = '---\ntype: extract\npriority: 50\n---\nAlpha\n';
const C = '---\ntype: extract\npriority: 50\n---\nAlpha gamma\n';

async function refine(fullContent, replacement, start = 0, end = 5) {
  return createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath: NOTE,
    fullContent,
    selection: { start, end },
    replacementText: replacement,
  });
}

function entry(operation, status) {
  return { operation, state: makeState(operation.operationId, status) };
}

test('no history still exposes a distinct current body snapshot', () => {
  const view = buildHistoryView({ entries: [], currentContent: A, currentPath: NOTE });
  assert.equal(view.count, 0);
  assert.equal(view.current.label, '当前正文');
  assert.equal(view.current.text, 'Alpha beta\n');
  assert.deepEqual(view.events, []);
  assert.deepEqual(view.snapshots.map(s => s.id), ['current']);
});

test('a refine event exposes separate before/after snapshots, not a single version', async () => {
  const op = await refine(A, 'Hi');
  const view = buildHistoryView({ entries: [entry(op, 'verified')], currentContent: B, currentPath: NOTE });
  assert.equal(view.count, 1);
  assert.equal(view.events[0].type, '精简');
  assert.equal(view.events[0].before.text, 'Alpha beta\n');
  assert.equal(view.events[0].after.text, 'Hi beta\n');
  assert.deepEqual(view.snapshots.map(s => s.label), ['当前正文', '#01 精简前', '#01 精简后']);
});

test('refine and restore events remain distinct and are sorted by store order', async () => {
  const op = await refine(A, 'Hi');
  const restore = await createRestoreOperation({
    operationId: crypto.randomUUID(),
    latestOperation: op,
    currentContent: '---\ntype: extract\npriority: 50\n---\nHi beta\n',
    currentNotePath: NOTE,
  });
  const view = buildHistoryView({
    entries: [entry(op, 'verified'), entry(restore, 'restored')],
    currentContent: A,
    currentPath: NOTE,
  });
  assert.equal(view.count, 2);
  assert.deepEqual(view.events.map(e => e.type), ['精简', '恢复']);
  assert.equal(view.events[1].typeCode, 'restore');
  assert.equal(view.events[1].after.text, 'Alpha beta\n');
  assert.equal(view.events[1].restoreOf, op.operationId);
});

test('current dirty and unresolved state are explicit in the view', async () => {
  const op = await refine(A, 'Hi');
  const view = buildHistoryView({
    entries: [entry(op, 'prepared')],
    currentContent: C,
    currentPath: NOTE,
    currentDirty: true,
  });
  assert.equal(view.current.dirty, true);
  assert.equal(view.unresolved, 1);
  assert.equal(view.events[0].status, 'prepared');
});

test('history capacity is reported without any cleanup action', async () => {
  const entries = [];
  for (let i = 0; i < 21; i++) {
    entries.push(entry(await refine(A, `Hi ${i}`), 'verified'));
  }
  const view = buildHistoryView({ entries, currentContent: B, currentPath: NOTE });
  assert.equal(view.count, 21);
  assert.equal(view.softLimitExceeded, true);
  assert.ok(view.historyBytes > 0);
});

test('current content must be a valid Extract before a history view is built', () => {
  assert.throws(
    () => buildHistoryView({ entries: [], currentContent: '---\ntype: source\n---\nbody\n' }),
    error => error.code === 'CURRENT_TYPE_UNSUPPORTED',
  );
});

test('history-view source uses safe text rendering concepts, not HTML injection', () => {
  const fs = require('node:fs');
  const modal = fs.readFileSync(require.resolve('../src/views/refine-history-modal.js'), 'utf8');
  assert.equal(/innerHTML|insertAdjacentHTML|document\.write/.test(modal), false);
});

test('pending restore, corrupt entries and orphan paths are explicit diagnostics', async () => {
  const op = await refine(A, 'Hi');
  const restore = await createRestoreOperation({
    operationId: crypto.randomUUID(),
    latestOperation: op,
    currentContent: '---\ntype: extract\npriority: 50\n---\nHi beta\n',
    currentNotePath: NOTE,
  });
  const view = buildHistoryView({
    entries: [entry(op, 'verified'), entry(restore, 'verified')],
    currentContent: B,
    currentPath: NOTE,
    errors: [{ operationId: 'bad-op', code: 'HISTORY_CORRUPT' }],
    orphanPaths: ['Old/History.md'],
    trust: { ok: false, code: 'CURRENT_BODY_NOT_TRUSTED' },
    currentDirty: true,
  });
  assert.equal(view.pending, 1);
  assert.equal(view.unresolved, 1);
  assert.equal(view.errors.length, 1);
  assert.deepEqual(view.orphanPaths, ['Old/History.md']);
  assert.equal(view.trust.ok, false);
  assert.equal(view.events[1].statusLabel, '待收尾');
});
