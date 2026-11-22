'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeCardInput, validateCardInput, buildCardPrefill, convertAnkiCloze, countClozeCards } = require('../src/data/card.js');

test('basic cards require both question and answer', () => {
  assert.equal(validateCardInput({ format: 'basic', question: 'Q', answer: '' }).ok, false);
  const result = validateCardInput({ format: 'basic', question: '  问题  ', answer: '  答案  ' });
  assert.equal(result.ok, true);
  assert.equal(result.value.question, '问题');
  assert.equal(result.value.answer, '答案');
});

test('cloze cards require an ==highlight== marker and ignore answer', () => {
  assert.equal(validateCardInput({ format: 'cloze', question: '没有填空' }).ok, false);
  const result = validateCardInput({ format: 'cloze', question: '海绵式思维是==被动==的', answer: 'ignored' });
  assert.equal(result.ok, true);
  assert.equal(result.value.format, 'cloze');
  assert.equal(result.value.answer, '');
});

test('normalizeCardInput trims CRLF and defaults unknown formats to basic', () => {
  const value = normalizeCardInput({ format: 'unknown', question: ' A\r\nB ', answer: ' C ' });
  assert.equal(value.format, 'basic');
  assert.equal(value.question, 'A\nB');
  assert.equal(value.answer, 'C');
});

test('buildCardPrefill prefers selection and strips frontmatter', () => {
  assert.equal(buildCardPrefill('---\ntype: extract\n---\n正文', '选中的文字'), '选中的文字');
  const prefill = buildCardPrefill('---\ntype: extract\n---\n## 标题\n**正文**内容', '', 80);
  assert.ok(prefill.includes('正文内容'));
  assert.ok(!prefill.includes('type:'));
});


test('Anki-style C1/C2/C3 markers convert to SR cloze syntax and count cards', () => {
  const input = 'C1 {{c1::主动}} 提问，C2 {{c2::评价::提示}} 论证。';
  const normalized = convertAnkiCloze(input);
  assert.equal(normalized, 'C1 ==1;;主动== 提问，C2 ==2;;评价;;提示== 论证。');
  assert.equal(countClozeCards(input), 2);
  const result = validateCardInput({ format: 'cloze', question: input });
  assert.equal(result.ok, true);
  assert.equal(result.value.question, normalized);
});


test('reverse card format is preserved and needs an answer', () => {
  const normalized = normalizeCardInput({ format: 'reverse', question: 'Q', answer: 'A' });
  assert.equal(normalized.format, 'reverse');
  const result = validateCardInput({ format: 'reverse', question: 'Q', answer: 'A' });
  assert.equal(result.ok, true);
  assert.equal(result.value.format, 'reverse');
  assert.equal(validateCardInput({ format: 'reverse', question: 'Q' }).ok, false);
});
