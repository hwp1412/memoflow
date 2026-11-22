'use strict';

const text = require('./text.js');

function normalizeCardInput({ format = 'basic', question = '', answer = '' } = {}) {
  const normalizedFormat = format === 'cloze' || format === 'reverse' ? format : 'basic';
  return {
    format: normalizedFormat,
    question: String(question == null ? '' : question).replace(/\r\n/g, '\n').trim(),
    answer: String(answer == null ? '' : answer).replace(/\r\n/g, '\n').trim(),
  };
}

function convertAnkiCloze(question) {
  return String(question || '').replace(
    /\{\{c(\d+)::([\s\S]*?)(?:::(.*?))?\}\}/g,
    (_match, seq, answer, hint) => `==${seq};;${String(answer).trim()}${hint ? `;;${String(hint).trim()}` : ''}==`,
  );
}

function hasClozeMarker(question) {
  return /==[^=\n]+==/.test(convertAnkiCloze(question));
}

function countClozeCards(question) {
  const normalized = convertAnkiCloze(question);
  const sequences = new Set();
  for (const match of normalized.matchAll(/==(\d+);;/g)) sequences.add(Number(match[1]));
  if (!sequences.size && /==[^=\n]+==/.test(normalized)) return 1;
  return sequences.size;
}

function validateCardInput(input) {
  const value = normalizeCardInput(input);
  if (!value.question) {
    return { ok: false, message: '问题 / 正文不能为空。', value };
  }
  if (value.format === 'cloze') {
    value.question = convertAnkiCloze(value.question);
    if (!hasClozeMarker(value.question)) {
      return { ok: false, message: 'Cloze 卡片需要用 {{c1::答案}} 或 ==关键词== 标出至少一处填空。', value };
    }
    value.answer = '';
    return { ok: true, value };
  }
  if (!value.answer) {
    return { ok: false, message: '基础问答/双向卡片需要填写答案。', value };
  }
  return { ok: true, value };
}

function buildCardPrefill(body, selection = '', maxLength = 400) {
  const selected = String(selection == null ? '' : selection).trim();
  if (selected) return selected.slice(0, Math.max(20, Number(maxLength) || 400)).trim();
  const stripped = text.stripMarkdown(body);
  return stripped.slice(0, Math.max(20, Number(maxLength) || 400)).trim();
}

module.exports = { normalizeCardInput, validateCardInput, buildCardPrefill, hasClozeMarker, convertAnkiCloze, countClozeCards };
