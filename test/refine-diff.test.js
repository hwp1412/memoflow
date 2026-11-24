'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, diffStats } = require('../src/data/refine-diff.js');

test('line diff preserves equal context and marks insert/delete', () => {
  const rows = diffLines('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');
  assert.deepEqual(rows.map(row => [row.type, row.text]), [
    ['equal', 'alpha'],
    ['del', 'beta'],
    ['ins', 'BETA'],
    ['equal', 'gamma'],
  ]);
  assert.deepEqual(diffStats(rows), { added: 1, removed: 1, equal: 2 });
});

test('line diff handles prefixes, suffixes and no-change input', () => {
  assert.deepEqual(diffLines('one\ntwo', 'one\ntwo'), [
    { type: 'equal', text: 'one' },
    { type: 'equal', text: 'two' },
  ]);
  const rows = diffLines('a\nb\nc\nd', 'a\nc\nd');
  assert.deepEqual(rows.map(row => row.type), ['equal', 'del', 'equal', 'equal']);
});

test('line diff normalizes CRLF for display only', () => {
  const rows = diffLines('a\r\nb\r\n', 'a\r\nc\r\n');
  assert.deepEqual(rows.map(row => row.text), ['a', 'b', 'c', '']);
});

test('very large changes fall back without quadratic work or HTML', () => {
  const before = Array.from({ length: 1500 }, (_, i) => `old-${i}`).join('\n');
  const after = Array.from({ length: 1500 }, (_, i) => `new-${i}`).join('\n');
  const rows = diffLines(before, after, { maxCells: 1000, maxLines: 100 });
  assert.ok(rows.some(row => row.type === 'del'));
  assert.ok(rows.some(row => row.type === 'ins'));
  assert.ok(rows.every(row => typeof row.text === 'string'));
});

test('diff rendering source never contains HTML parsing', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/data/refine-diff.js'), 'utf8');
  assert.equal(/innerHTML|insertAdjacentHTML|document\.write/.test(source), false);
});
