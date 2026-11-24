'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { timestampTitle, parsePdfSelection, buildCitation, buildExtractContent, cleanExtractBody } = require('../src/data/extract.js');

test('timestampTitle produces a filesystem-safe local timestamp', () => {
  assert.equal(timestampTitle(new Date(2026, 10, 22, 4, 6, 7)), '2026-11-22 04-06-07');
});

test('parsePdfSelection understands PDF++ links and bare page fragments', () => {
  assert.deepEqual(
    parsePdfSelection('[[book.pdf#page=12&selection=4,0,5,20&color=yellow|book, page 12]]'),
    { target: 'book.pdf', page: 12, params: '&selection=4,0,5,20&color=yellow' },
  );
  assert.deepEqual(parsePdfSelection('quote with #page=7 fragment'), { target: null, page: 7, params: '' });
  assert.deepEqual(parsePdfSelection('no page here'), { target: null, page: null, params: '' });
});

test('buildCitation points at the PDF page when a vault PDF is available', () => {
  assert.equal(
    buildCitation({ sourceTitle: '学会提问', pdfPath: 'test/学会提问.pdf', page: 96 }),
    '[[test/学会提问.pdf#page=96|学会提问 · p.96]]',
  );
  assert.equal(
    buildCitation({ sourceTitle: '学会提问', pdfPath: null, page: 96 }),
    '[[学会提问#page=96|学会提问 · p.96]]',
  );
  assert.equal(
    buildCitation({ sourceTitle: '学会提问', page: null }),
    '[[学会提问|学会提问]]',
  );
});

test('buildExtractContent writes source, page and citation footer', () => {
  const content = buildExtractContent({
    sourceTitle: '学会提问',
    body: '海绵式思维相对被动。',
    priority: 51,
    interval: 8,
    nextReview: '30-11-2026',
    dateAdded: '22-11-2026',
    page: 96,
    citation: '[[test/学会提问.pdf#page=96|学会提问 · p.96]]',
  });
  assert.ok(content.startsWith('---\ntype: extract\nsource: "[[学会提问]]"'));
  assert.ok(content.includes('page: 96'));
  assert.ok(content.includes('date_added: 22-11-2026'));
  assert.ok(content.includes('海绵式思维相对被动。'));
  assert.ok(content.includes('**来源**：[[test/学会提问.pdf#page=96|学会提问 · p.96]]'));
  assert.ok(content.includes('cssclasses:\n  - memoflow-extract'));
});


test('cleanExtractBody unwraps copied PDF callouts', () => {
  const input = '> [!PDF] [被讨厌的勇气, p.7]\n> 原文第一行\n> 来源：[[x.pdf#page=7|p.7]]';
  assert.equal(cleanExtractBody(input), '原文第一行');
});

test('buildExtractContent adds parent only when explicitly provided', () => {
  const base = {
    sourceTitle: 'Root Source',
    body: 'passage',
    priority: 50,
    interval: 8,
    nextReview: '02-12-2026',
    dateAdded: '24-11-2026',
  };
  const old = buildExtractContent(base);
  assert.equal(old.includes('\nparent:'), false);
  assert.ok(old.startsWith('---\ntype: extract\nsource: "[[Root Source]]"\nstatus: pending'));
  const child = buildExtractContent({ ...base, parentTitle: 'Parent Extract' });
  assert.ok(child.startsWith('---\ntype: extract\nsource: "[[Root Source]]"\nparent: "[[Parent Extract]]"\nstatus: pending'));
});
