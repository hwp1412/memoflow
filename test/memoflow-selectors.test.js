'use strict';

const test = require('node:test');
const assert = require('node:assert');
const selectors = require('../src/data/selectors.js');
const text = require('../src/data/text.js');
const treeCore = require('../tree-core.js');
const { buildDemoModel, buildEmptyModel } = require('../src/data/demo.js');

const settings = { misc: { date_format: 'DD-MM-YYYY' } };
const today = new Date(2026, 10, 22);
today.setHours(0, 0, 0, 0);

function row(basename, fm) {
  return { tfile: { path: `Sources/${basename}.md`, basename }, fm };
}

const rows = [
  row('逾期来源', { type: 'source', status: 'active', priority: 10, next_review: '20-11-2026', interval: 5, a_factor: 1.6, last_reviewed: '22-11-2026' }),
  row('今日摘录', { type: 'extract', status: 'active', priority: 20, next_review: '22-11-2026', interval: 3, a_factor: 2.0, source: '[[逾期来源]]' }),
  row('未来来源', { type: 'source', status: 'active', priority: 60, next_review: '25-11-2026', interval: 8, a_factor: 1.4 }),
  row('新摘录', { type: 'extract', status: 'pending', priority: 30, source: '[[未来来源]]' }),
  row('卡片一', { type: 'card', status: 'active', priority: 40, source: '[[今日摘录]]' }),
  row('已完成', { type: 'source', status: 'done', next_review: '20-11-2026' }),
  row('坏日期', { type: 'extract', status: 'active', next_review: 'not-a-date' }),
];

test('buildCounts separates due, overdue, new items and cards', () => {
  const counts = selectors.buildCounts(rows, today, settings);
  assert.equal(counts.due, 2);
  assert.equal(counts.overdue, 1);
  assert.equal(counts.todayDue, 1);
  assert.equal(counts.newItems, 2);
  assert.equal(counts.cards, 1);
  assert.equal(counts.reviewedToday, 1);
});

test('buildQueue sorts overdue before today and future', () => {
  const queue = selectors.buildQueue(rows, today, settings);
  assert.equal(queue.length, 6);
  assert.equal(queue[0].basename, '逾期来源');
  assert.equal(queue[0].isOverdue, true);
  const names = queue.map(item => item.basename);
  assert.ok(names.indexOf('今日摘录') < names.indexOf('未来来源'));
  assert.equal(queue.find(item => item.basename === '卡片一').dueLabel, '卡片');
});

test('buildForecast folds overdue into today and keeps future days', () => {
  const forecast = selectors.buildForecast(rows, today, settings, 7);
  assert.equal(forecast.length, 7);
  assert.equal(forecast[0].count, 2);
  assert.equal(forecast[3].count, 1);
  assert.equal(forecast[0].isToday, true);
});

test('parseReviewLog and computeStreak work with the upstream log shape', () => {
  const log = [
    '# Review Log',
    '| Date | Element | Type | Grade | Interval |',
    '| --- | --- | --- | --- | --- |',
    '| 22-11-2026 | [[今日摘录]] | extract | — | 3 |',
    '| 21-11-2026 | [[逾期来源]] | source | — | 5 |',
    '| 20-11-2026 | [[未来来源]] | source | — | 8 |',
    '| 18-11-2026 | [[新摘录]] | extract | — | 1 |',
  ].join('\n');
  const entries = selectors.parseReviewLog(log, settings);
  assert.equal(entries.length, 4);
  assert.equal(selectors.computeStreak(entries, today), 3);
  const activity = selectors.buildActivity(entries, today, 14);
  assert.equal(activity.items.length, 14);
  assert.equal(activity.items[13].count, 1);
});

test('buildTree aggregates due counts and caps visible children', () => {
  const pages = [
    { path: 'cat', basename: '阅读主题', fm: { type: 'category', tree_root: true } },
    { path: 's1', basename: '来源一', fm: { type: 'source', parent: '[[阅读主题]]', next_review: '22-11-2026', priority: 10 } },
    { path: 'e1', basename: '摘录一', fm: { type: 'extract', parent: '[[来源一]]', next_review: '20-11-2026', priority: 10 } },
    { path: 's2', basename: '来源二', fm: { type: 'source', parent: '[[阅读主题]]', next_review: '25-11-2026', priority: 20 } },
  ];
  const index = treeCore.buildTreeIndex(pages);
  const tree = selectors.buildTree(index, today, settings, 8);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].basename, '阅读主题');
  assert.equal(tree[0].dueCount, 2);
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].basename, '来源一');
  assert.equal(tree[0].children[0].dueCount, 2);
});

test('buildSources surfaces PDF sources before non-PDF sources', () => {
  const sourceRows = [
    row('无 PDF 来源', { type: 'source', status: 'active', last_reviewed: '22-11-2026', total_pages: 100, read_point: 50 }),
    row('有 PDF 来源', { type: 'source', status: 'active', last_reviewed: '20-11-2026', total_pages: 200, read_point: 20, pdf_vault_path: 'book.pdf' }),
  ];
  const sources = selectors.buildSources(sourceRows, settings);
  assert.equal(sources[0].basename, '有 PDF 来源');
  assert.equal(sources[0].hasPdf, true);
});

test('extractExcerpt strips frontmatter, callouts and markdown', () => {
  const content = [
    '---',
    'type: extract',
    '---',
    '> [!PDF|yellow] [[book.pdf#page=12]]',
    '## 海绵式思维',
    '**海绵式思维**相对被动，==它并不需要你绞尽脑汁==。',
    '见 [[学会提问]] 与 [链接](https://example.com)。',
  ].join('\n');
  const excerpt = text.extractExcerpt(content, 120);
  assert.ok(excerpt.includes('海绵式思维相对被动'));
  assert.ok(!excerpt.includes('---'));
  assert.ok(!excerpt.includes('type:'));
  assert.ok(!excerpt.includes('[!PDF'));
  assert.ok(!excerpt.includes('[['));
});

test('demo model is internally consistent and relative to today', () => {
  const model = buildDemoModel(today, { isMobile: true });
  assert.equal(model.demo, true);
  assert.equal(model.isMobile, true);
  assert.equal(model.counts.due, 8);
  assert.equal(model.counts.overdue, 4);
  assert.equal(model.counts.todayDue, 4);
  assert.equal(model.counts.newItems, 3);
  assert.equal(model.counts.cards, 2);
  assert.equal(model.counts.cardsDue, 2);
  assert.equal(model.srReady, true);
  assert.equal(model.queue.length, 20);
  assert.equal(model.queue[0].basename, '学会提问 Extract 1');
  assert.equal(model.tree.length, 2);
  assert.equal(model.forecast.length, 7);
  assert.equal(model.activity.length, 14);
  assert.equal(model.sources.length, 3);
  assert.equal(model.recent.length, 3);
  assert.ok(model.progress > 0 && model.progress < 1);
});

test('empty model has zero counts and stable shape', () => {
  const model = buildEmptyModel(today, { isMobile: false });
  assert.equal(model.counts.due, 0);
  assert.equal(model.counts.cardsDue, 0);
  assert.equal(model.srReady, false);
  assert.equal(model.queue.length, 0);
  assert.equal(model.tree.length, 0);
  assert.equal(model.forecast.length, 7);
  assert.equal(model.activity.length, 14);
  assert.equal(model.demo, false);
});
