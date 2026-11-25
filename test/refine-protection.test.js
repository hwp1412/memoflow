'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertProtectedStructureUnchanged,
  structureSignature,
} = require('../src/data/refine-editor.js');

test('normal body changes are allowed', () => {
  assert.equal(assertProtectedStructureUnchanged('Alpha beta\n', 'Gamma delta\n'), true);
});

test('same protected structures allow normal text changes', () => {
  const current = '| A | B |\n|---|---|\n| 1 | 2 |\n\nAlpha [[Target]]\n';
  const target = '| A | B |\n|---|---|\n| 1 | 2 |\n\nChanged [[Target]]\n';
  assert.equal(assertProtectedStructureUnchanged(current, target), true);
});

test('table structure/content change is rejected', () => {
  const current = '| A | B |\n|---|---|\n| 1 | 2 |\n';
  const target = '| A | B |\n|---|---|\n| 1 | 3 |\n';
  assert.throws(
    () => assertProtectedStructureUnchanged(current, target),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
});

test('link target changes are rejected even when marker count is equal', () => {
  const current = '[[One]] and [two](https://a.example)\n';
  const target = '[[One]] and [two](https://b.example)\n';
  assert.throws(
    () => assertProtectedStructureUnchanged(current, target),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
});

test('inline card and SR content changes are rejected', () => {
  const current = 'Q::A <!--SR:2026-01-01--> ==cloze==\n';
  const target = 'Q::B <!--SR:2026-01-01--> ==cloze==\n';
  assert.throws(
    () => assertProtectedStructureUnchanged(current, target, { inline_cards: { qa_regex: '^Q::.*$' } }),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
  assert.throws(
    () => assertProtectedStructureUnchanged('<!--SR:a-->\n', '<!--SR:b-->\n'),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
});

test('same signature is stable and ambiguous fences are rejected', () => {
  const body = '```js\nconst a = 1;\n```\nText\n';
  assert.equal(structureSignature(body), structureSignature(`${body} more\n`));
  assert.throws(
    () => assertProtectedStructureUnchanged(body, '```js\nconst a = 1;\n'),
    error => error.code === 'PROTECTED_STRUCTURE_AMBIGUOUS',
  );
});

test('reference-style links and definitions are protected by exact target', () => {
  const current = '[text][ref]\n\n[ref]: https://a.example\n';
  assert.equal(assertProtectedStructureUnchanged(current, current.replace('normal', 'normal')), true);
  assert.throws(
    () => assertProtectedStructureUnchanged(current, '[text][ref]\n\n[ref]: https://b.example\n'),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
  assert.throws(
    () => assertProtectedStructureUnchanged(current, '[other][ref]\n\n[ref]: https://a.example\n'),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
});

test('autolinks and HTML href/src changes are rejected', () => {
  assert.throws(
    () => assertProtectedStructureUnchanged('<https://a.example>\n', '<https://b.example>\n'),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
  assert.throws(
    () => assertProtectedStructureUnchanged('<a href="https://a.example">x</a>\n', '<a href="https://b.example">x</a>\n'),
    error => error.code === 'PROTECTED_STRUCTURE_CHANGED',
  );
});

test('escaped wiki/link text remains protected and unclosed wiki is ambiguous', () => {
  assert.equal(assertProtectedStructureUnchanged('[[A\\]B]]\n', '[[A\\]B]]\n'), true);
  assert.throws(
    () => assertProtectedStructureUnchanged('[[unclosed\n', '[[unclosed\n'),
    error => error.code === 'PROTECTED_STRUCTURE_AMBIGUOUS',
  );
});
