'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  splitContent,
  createRefineOperation,
  validateOperationIntegrity,
  createRestoreOperation,
  planRestore,
  makeState,
  canTransition,
  validateState,
  sha256Text,
  MAX_NOTE_BYTES,
  RefineError,
} = require('../src/data/refine-history.js');

const uuid = () => crypto.randomUUID();
const baseContent = '---\ntype: extract\nparent: "[[E1]]"\n---\nHello world\n';

function assertCode(fn, code) {
  return async () => {
    await assert.rejects(fn, error => error instanceof RefineError && error.code === code);
  };
}

test('split preserves exact LF frontmatter/body bytes', () => {
  const split = splitContent(baseContent);
  assert.equal(split.ok, true);
  assert.equal(split.hasFrontmatter, true);
  assert.equal(split.frontmatter, '---\ntype: extract\nparent: "[[E1]]"\n---\n');
  assert.equal(split.body, 'Hello world\n');
  assert.equal(split.prefix + split.body, baseContent);
  assert.equal(split.bodyStart, split.prefix.length);
});

test('split handles CRLF, BOM, no-frontmatter and empty body cases', () => {
  const crlf = '---\r\ntype: extract\r\n---\r\nbody\r\n';
  const c = splitContent(crlf);
  assert.equal(c.prefix + c.body, crlf);
  assert.equal(c.body, 'body\r\n');
  assert.equal(c.eol, '\r\n');

  const bom = '\uFEFF---\ntype: extract\n---\nbody';
  const b = splitContent(bom);
  assert.equal(b.prefix + b.body, bom);
  assert.equal(b.frontmatter.startsWith('---'), true);
  assert.equal(b.body, 'body');

  const none = splitContent('plain body\n');
  assert.equal(none.hasFrontmatter, false);
  assert.equal(none.body, 'plain body\n');
  assert.equal(none.bodyStart, 0);

  const emptyBody = splitContent('---\ntype: extract\n---\n');
  assert.equal(emptyBody.body, '');
  assert.equal(emptyBody.bodyStart, emptyBody.prefix.length);
});

test('split rejects malformed or unterminated frontmatter instead of guessing', () => {
  assert.throws(() => splitContent('---\ntype: extract\nbody'), error => error.code === 'MALFORMED_FRONTMATTER');
  assert.throws(() => splitContent('---foo\nbody'), error => error.code === 'MALFORMED_FRONTMATTER');
  assert.throws(() => splitContent('---'), error => error.code === 'MALFORMED_FRONTMATTER');
});

test('createRefineOperation stores exact before snapshot and expected after body', async () => {
  const operation = await createRefineOperation({
    operationId: uuid(),
    notePath: 'Extracts/E.md',
    fullContent: baseContent,
    selection: { start: 0, end: 5 },
    replacementText: 'Hi',
  });
  assert.equal(operation.before.fullContent, baseContent);
  assert.equal(operation.before.body, 'Hello world\n');
  assert.equal(operation.after.body, 'Hi world\n');
  assert.equal(operation.selection.selectedText, 'Hello');
  assert.equal(operation.selection.replacementText, 'Hi');
  assert.notEqual(operation.note.bodyHash, operation.after.bodyHash);
  await validateOperationIntegrity(operation);
});

test('selection must stay inside body and match the expected text', async () => {
  const op = await createRefineOperation({
    operationId: uuid(), notePath: 'E.md', fullContent: baseContent,
    selection: { start: 0, end: 5 }, replacementText: 'x',
  });
  await assert.rejects(() => createRefineOperation({
    operationId: uuid(), notePath: 'E.md', fullContent: baseContent,
    selection: { start: 0, end: 5, selectedText: 'Wrong' }, replacementText: 'x',
  }), error => error.code === 'SELECTION_MISMATCH');
  await assert.rejects(() => createRefineOperation({
    operationId: uuid(), notePath: 'E.md', fullContent: baseContent,
    selection: { start: -1, end: 5 }, replacementText: 'x',
  }), error => error.code === 'INVALID_SELECTION');
  await assert.rejects(() => createRefineOperation({
    operationId: uuid(), notePath: 'E.md', fullContent: baseContent,
    selection: { start: 0, end: 999 }, replacementText: 'x',
  }), error => error.code === 'INVALID_SELECTION');
  await validateOperationIntegrity(op);
});

test('note and history size limits reject before a record is produced', async () => {
  const huge = 'x'.repeat(MAX_NOTE_BYTES + 1);
  await assert.rejects(() => createRefineOperation({
    operationId: uuid(), notePath: 'E.md', fullContent: huge,
    selection: { start: 0, end: 1 }, replacementText: '',
  }), error => error.code === 'NOTE_TOO_LARGE');
});

test('integrity validation detects tampered body, hashes and selection', async () => {
  const operation = await createRefineOperation({
    operationId: uuid(), notePath: 'E.md', fullContent: baseContent,
    selection: { start: 0, end: 5 }, replacementText: 'Hi',
  });
  const badBody = JSON.parse(JSON.stringify(operation));
  badBody.after.body = 'tampered';
  await assert.rejects(() => validateOperationIntegrity(badBody), error => error.code === 'HISTORY_INTEGRITY');

  const badHash = JSON.parse(JSON.stringify(operation));
  badHash.note.fullHash = '0'.repeat(64);
  await assert.rejects(() => validateOperationIntegrity(badHash), error => error.code === 'HISTORY_INTEGRITY');

  const badSelection = JSON.parse(JSON.stringify(operation));
  badSelection.selection.selectedText = 'Wrong';
  await assert.rejects(() => validateOperationIntegrity(badSelection), error => error.code === 'HISTORY_INTEGRITY');
});

test('restore plan keeps current frontmatter and restores only the body', async () => {
  const latest = await createRefineOperation({
    operationId: uuid(), notePath: 'Extracts/E.md', fullContent: baseContent,
    selection: { start: 0, end: 5 }, replacementText: 'Hi',
  });
  const current = '---\ntype: extract\npriority: 77\n---\nHi world\n';
  const restore = await createRestoreOperation({
    operationId: uuid(),
    latestOperation: latest,
    currentContent: current,
    currentNotePath: 'Extracts/E.md',
  });
  assert.equal(restore.restoreOf, latest.operationId);
  assert.equal(restore.before.fullContent, current);
  assert.equal(restore.after.body, 'Hello world\n');
  const currentPrefix = splitContent(current).prefix;
  assert.equal(restore.after.frontmatterHash, await sha256Text(currentPrefix));
  assert.notEqual(restore.after.frontmatterHash, latest.note.frontmatterHash);
  assert.match(restore.after.body, /Hello world/);
  await validateOperationIntegrity(restore);
});

test('restore plan rejects a changed body and a different note path', async () => {
  const latest = await createRefineOperation({
    operationId: uuid(), notePath: 'Extracts/E.md', fullContent: baseContent,
    selection: { start: 0, end: 5 }, replacementText: 'Hi',
  });
  await assert.rejects(() => createRestoreOperation({
    operationId: uuid(), latestOperation: latest,
    currentContent: '---\ntype: extract\n---\nUser edited later\n',
    currentNotePath: 'Extracts/E.md',
  }), error => error.code === 'RESTORE_CONFLICT');
  await assert.rejects(() => createRestoreOperation({
    operationId: uuid(), latestOperation: latest,
    currentContent: '---\ntype: extract\n---\nHi world\n',
    currentNotePath: 'Extracts/Other.md',
  }), error => error.code === 'NOTE_PATH_MISMATCH');
});

test('state machine exposes only explicit safe transitions', () => {
  assert.equal(canTransition('prepared', 'applied'), true);
  assert.equal(canTransition('applied', 'verified'), true);
  assert.equal(canTransition('verified', 'restored'), true);
  assert.equal(canTransition('prepared', 'verified'), false);
  assert.equal(canTransition('verified', 'applied'), false);
  assert.equal(canTransition('restored', 'prepared'), false);
  const state = makeState(uuid(), 'prepared', '2026-11-25T00:00:00.000Z');
  assert.equal(validateState(state, state.operationId).status, 'prepared');
  assert.throws(() => makeState('not-uuid'), error => error.code === 'INVALID_OPERATION_ID');
});
