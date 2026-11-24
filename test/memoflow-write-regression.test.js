'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dateCore = require('../date-core.js');
const topicCore = require('../topic-core.js');
const {
  createPlugin,
  makeFile,
  makeSettings,
  withFrozenDate,
  flushAsync,
} = require('./helpers/obsidian-mock.js');

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function addDays(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return dateCore.formatDate(date, 'YYYY-MM-DD');
}

function setup(t, overrides = {}) {
  const date = withFrozenDate(t);
  const today = dateCore.formatDate(date, 'YYYY-MM-DD');
  const settings = makeSettings(overrides, today);
  const { plugin, app } = createPlugin({ settings, today });
  return { plugin, app, date, today, settings };
}

function expectedAF(fm, settings, readPoint) {
  const raw = topicCore.progressAwareAFactor(fm, settings, { readPoint });
  return round4(Math.max(settings.scheduling.a_factor_min, Math.min(settings.scheduling.a_factor_max, raw)));
}

function writesFor(app, file) {
  return app.fileManager.writes.filter(entry => entry.file.path === file.path);
}

function logContent(app) {
  return app.vault.readContent(app.vault.getAbstractFileByPath('Review Log.md'));
}

test('first source grade writes the expected 0.1 scheduling fields and log row', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Source.md', {
    type: 'source',
    status: 'active',
    priority: 50,
    interval: 0,
    review_count: 0,
    a_factor: 1.5,
    next_review: '2026-11-20',
    last_reviewed: '2026-11-20',
    read_point: 1,
    total_pages: 500,
    custom_field: 'keep-me',
  }, '# Source\n\nbody\n');
  app.activeFile = file;
  app.__promptState.texts = ['96'];
  app.__promptState.quality = 1;
  const before = app.vault.readFm(file);
  const expectedA = expectedAF(before, plugin.settings, 96);
  const ok = await plugin._gradeTopic(file, before, today);
  await flushAsync();
  assert.equal(ok, true);
  const after = app.vault.readFm(file);
  assert.equal(after.interval, 8);
  assert.equal(after.review_count, 1);
  assert.equal(after.next_review, addDays(today, 8));
  assert.equal(after.last_reviewed, today);
  assert.equal(after.read_point, 96);
  assert.equal(after.a_factor, expectedA);
  assert.equal(after.custom_field, 'keep-me');
  assert.equal(after.status, 'active');
  assert.equal(writesFor(app, file).length, 1);
  assert.equal(app.vault.appendCalls.length, 1);
  const log = logContent(app);
  assert.match(log, new RegExp(`\\| ${today} \\| \\[\\[Source\\]\\] \\| source \\| — \\|`));
  assert.match(log, new RegExp(`\\| 1\\.5 \\| ${expectedA} \\|`));
  assert.deepEqual(app.__promptState.calls.map(call => call.type), ['text', 'suggest']);
});

test('second source grade uses interval x A-Factor rather than the first interval', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Revisit.md', {
    type: 'source',
    status: 'active',
    priority: 50,
    interval: 3,
    review_count: 1,
    a_factor: 1.5,
    next_review: '2026-11-20',
    last_reviewed: '2026-11-20',
    read_point: 96,
    total_pages: 500,
  }, '# Revisit\n');
  app.activeFile = file;
  app.__promptState.texts = ['100'];
  app.__promptState.quality = 1;
  const before = app.vault.readFm(file);
  const expectedA = expectedAF(before, plugin.settings, 100);
  const expectedInterval = Math.max(1, Math.round(3 * expectedA));
  const ok = await plugin._gradeTopic(file, before, today);
  await flushAsync();
  assert.equal(ok, true);
  const after = app.vault.readFm(file);
  assert.equal(after.interval, expectedInterval);
  assert.notEqual(after.interval, 8);
  assert.equal(after.review_count, 2);
  assert.equal(after.read_point, 100);
  assert.equal(after.next_review, addDays(today, expectedInterval));
  assert.equal(writesFor(app, file).length, 1);
});

test('cancelling the page prompt writes nothing', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/CancelPage.md', {
    type: 'source', status: 'active', priority: 50, interval: 4, review_count: 2,
    a_factor: 1.5, read_point: 10, total_pages: 100, next_review: '2026-11-20',
  }, '# Body\n');
  app.activeFile = file;
  app.__promptState.texts = [null];
  app.__promptState.quality = 1;
  const beforeFm = app.vault.readFm(file);
  const beforeBody = app.vault.readBody(file);
  const result = await plugin._gradeTopic(file, beforeFm, today);
  await flushAsync();
  assert.equal(result, undefined);
  assert.deepEqual(app.vault.readFm(file), beforeFm);
  assert.equal(app.vault.readBody(file), beforeBody);
  assert.equal(writesFor(app, file).length, 0);
  assert.equal(app.vault.appendCalls.length, 0);
});

test('invalid page input writes nothing', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/InvalidPage.md', {
    type: 'source', status: 'active', priority: 50, interval: 4, review_count: 2,
    a_factor: 1.5, read_point: 10, total_pages: 100, next_review: '2026-11-20',
  }, '# Body\n');
  app.activeFile = file;
  app.__promptState.texts = ['0'];
  app.__promptState.quality = 1;
  const result = await plugin._gradeTopic(file, app.vault.readFm(file), today);
  await flushAsync();
  assert.equal(result, undefined);
  assert.equal(writesFor(app, file).length, 0);
  assert.equal(app.vault.appendCalls.length, 0);
});

test('Markdown marker is NOT written when the line prompt is declined and quality is cancelled', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Markdown.md', {
    type: 'source', status: 'active', priority: 50, interval: 0, review_count: 0,
    a_factor: 1.5, read_point_line: 1, next_review: '2026-11-20',
  }, '# Markdown\n\nline one\nline two\nline three\n');
  app.activeFile = file;
  app.leaves.markdown = [{ view: { file, editor: { getCursor: () => ({ line: 5 }) } } }];
  app.__promptState.confirm = false;
  app.__promptState.quality = null;
  const beforeFm = app.vault.readFm(file);
  const beforeBody = app.vault.readBody(file);
  const result = await plugin._gradeTopic(file, beforeFm, today);
  await flushAsync();
  assert.equal(result, undefined);
  assert.deepEqual(app.vault.readFm(file), beforeFm);
  assert.equal(app.vault.readBody(file), beforeBody);
  assert.equal(writesFor(app, file).length, 0);
  assert.equal(app.vault.processCalls.length, 0);
  assert.equal(app.vault.appendCalls.length, 0);
});

test('Markdown marker is written before quality cancellation (0.1 legacy behavior)', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/MarkdownCancel.md', {
    type: 'source', status: 'active', priority: 50, interval: 0, review_count: 0,
    a_factor: 1.5, read_point_line: 1, next_review: '2026-11-20',
  }, '# Markdown\n\nline one\nline two\nline three\n');
  app.activeFile = file;
  app.leaves.markdown = [{ view: { file, editor: { getCursor: () => ({ line: 5 }) } } }];
  app.__promptState.confirm = true;
  app.__promptState.quality = null;
  const beforeFm = app.vault.readFm(file);
  const beforeBody = app.vault.readBody(file);
  const result = await plugin._gradeTopic(file, beforeFm, today);
  await flushAsync();
  assert.equal(result, undefined);
  assert.deepEqual(app.vault.readFm(file), beforeFm);
  assert.notEqual(app.vault.readBody(file), beforeBody);
  assert.match(app.vault.readBody(file), /📍<!--ir-readpoint-->/);
  assert.equal(writesFor(app, file).length, 0);
  assert.equal(app.vault.processCalls.length, 1);
  assert.equal(app.vault.appendCalls.length, 0);
});

test('Extract review does not grow its interval when stall_guard blocks progress', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Extracts/Stalled.md', {
    type: 'extract', status: 'active', priority: 50, interval: 3, review_count: 1,
    a_factor: 2, next_review: '2026-11-20', last_reviewed: '2026-11-20',
  }, 'An extract without progress fields.\n');
  app.activeFile = file;
  app.__promptState.quality = 1;
  const before = app.vault.readFm(file);
  const ok = await plugin._gradeTopic(file, before, today);
  await flushAsync();
  assert.equal(ok, true);
  const after = app.vault.readFm(file);
  assert.equal(after.interval, 3);
  assert.equal(after.review_count, 2);
  assert.equal(after.a_factor, 2);
  assert.equal(after.next_review, addDays(today, 3));
  assert.equal(after.read_point, undefined);
  assert.equal(writesFor(app, file).length, 1);
});

test('Extract review grows when stall_guard is disabled', async (t) => {
  const { plugin, app, today } = setup(t, { scheduling: { stall_guard: false } });
  const file = makeFile(app, 'Extracts/Growing.md', {
    type: 'extract', status: 'active', priority: 50, interval: 3, review_count: 1,
    a_factor: 2, next_review: '2026-11-20', last_reviewed: '2026-11-20',
  }, 'An extract without progress fields.\n');
  app.activeFile = file;
  app.__promptState.quality = 1;
  const ok = await plugin._gradeTopic(file, app.vault.readFm(file), today);
  await flushAsync();
  assert.equal(ok, true);
  const after = app.vault.readFm(file);
  assert.equal(after.interval, 6);
  assert.equal(after.review_count, 2);
  assert.equal(after.next_review, addDays(today, 6));
  assert.equal(writesFor(app, file).length, 1);
});

test('quality Speed up changes the A-Factor while keeping the first interval', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Speed.md', {
    type: 'source', status: 'active', priority: 50, interval: 0, review_count: 0,
    a_factor: 1.5, read_point: 1, total_pages: 500, next_review: '2026-11-20',
  }, '# Speed\n');
  app.activeFile = file;
  app.__promptState.texts = ['96'];
  app.__promptState.quality = 0.95;
  const before = app.vault.readFm(file);
  const base = topicCore.progressAwareAFactor(before, plugin.settings, { readPoint: 96 });
  const expected = round4(Math.max(plugin.settings.scheduling.a_factor_min, Math.min(plugin.settings.scheduling.a_factor_max, base * 0.95)));
  await plugin._gradeTopic(file, before, today);
  const after = app.vault.readFm(file);
  assert.equal(after.a_factor, expected);
  assert.equal(after.interval, 8);
  assert.notEqual(after.a_factor, expectedAF(before, plugin.settings, 96));
});

test('pending source becomes active when graded', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Pending.md', {
    type: 'source', status: 'pending', priority: 50, interval: 4, review_count: 1,
    a_factor: 1.5, read_point: 10, total_pages: 100, next_review: '2026-11-20',
  }, '# Pending\n');
  app.activeFile = file;
  app.__promptState.texts = ['20'];
  app.__promptState.quality = 1;
  await plugin._gradeTopic(file, app.vault.readFm(file), today);
  assert.equal(app.vault.readFm(file).status, 'active');
});

test('grading a source at its final page marks it done and clears future scheduling', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/LastPage.md', {
    type: 'source', status: 'active', priority: 50, interval: 3, review_count: 1,
    a_factor: 1.5, read_point: 99, total_pages: 100, next_review: '2026-11-20',
  }, '# Last\n');
  app.activeFile = file;
  app.__promptState.texts = ['100'];
  app.__promptState.quality = 1;
  app.__promptState.confirm = true;
  const ok = await plugin._gradeTopic(file, app.vault.readFm(file), today);
  await flushAsync();
  assert.equal(ok, true);
  const after = app.vault.readFm(file);
  assert.equal(after.status, 'done');
  assert.equal(after.date_done, today);
  assert.equal(after.last_reviewed, today);
  assert.equal(after.read_point, 100);
  assert.equal(after.review_count, 2);
  assert.equal(after.next_review, undefined);
  assert.equal(after.interval, undefined);
  assert.equal(app.vault.appendCalls.length, 1);
});

test('a failed Review Log append does not roll back the scheduling write', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/LogFailure.md', {
    type: 'source', status: 'active', priority: 50, interval: 3, review_count: 1,
    a_factor: 1.5, read_point: 96, total_pages: 500, next_review: '2026-11-20',
  }, '# Log\n');
  app.activeFile = file;
  app.__promptState.texts = ['100'];
  app.__promptState.quality = 1;
  app.vault.appendError = new Error('log disk full');
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { console.error = originalError; });
  const ok = await plugin._gradeTopic(file, app.vault.readFm(file), today);
  await flushAsync();
  assert.equal(ok, true);
  assert.equal(writesFor(app, file).length, 1);
  assert.equal(app.vault.appendCalls.length, 0);
  assert.ok(errors.some(args => String(args[0]).includes('review-log append failed')));
  assert.equal(app.vault.readContent(app.vault.getAbstractFileByPath('Review Log.md')).includes('LogFailure'), false);
});

test('postpone writes next_review and interval=days (0.1 legacy behavior)', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Postpone.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, review_count: 3,
    a_factor: 1.5, read_point: 40, total_pages: 100, next_review: '2026-11-20',
  }, '# Postpone\n');
  await plugin._postponeReadingFile(file, 3);
  const after = app.vault.readFm(file);
  assert.equal(after.next_review, addDays(today, 3));
  assert.equal(after.interval, 3);
  assert.equal(after.review_count, 3);
  assert.equal(after.read_point, 40);
  assert.equal(writesFor(app, file).length, 1);
  assert.equal(app.vault.appendCalls.length, 0);
});

test('Mercy spreads overdue topics and overwrites interval with the offset (0.1 legacy behavior)', async (t) => {
  const { plugin, app, today } = setup(t);
  const files = [10, 50, 80].map(priority => makeFile(app, `Sources/Mercy-${priority}.md`, {
    type: 'source', status: 'active', priority, interval: 5, review_count: 2,
    a_factor: 1.5, read_point: 10, total_pages: 100, next_review: '2026-11-20',
  }, `# Mercy ${priority}\n`));
  const rows = files.map(tfile => ({ tfile, fm: app.vault.readFm(tfile) }));
  const untouched = makeFile(app, 'Sources/Mercy-Untouched.md', {
    type: 'source', status: 'active', priority: 1, interval: 5, review_count: 2,
    a_factor: 1.5, next_review: '2026-12-30',
  }, '# Untouched\n');
  await plugin.spreadOverdue(rows, 7);
  const after = files.map(tfile => app.vault.readFm(tfile));
  assert.deepEqual(after.map(fm => fm.interval), [1, 2, 4]);
  assert.deepEqual(after.map(fm => fm.next_review), [today, addDays(today, 2), addDays(today, 4)]);
  assert.equal(after[0].review_count, 2);
  assert.equal(app.vault.readFm(untouched).interval, 5);
  for (const tfile of files) assert.equal(writesFor(app, tfile).length, 1);
  assert.equal(writesFor(app, untouched).length, 0);
});

test('markPathsDone completes a source and removes only future scheduling', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Sources/Done.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, review_count: 3,
    a_factor: 1.5, read_point: 40, total_pages: 100, next_review: '2026-11-20',
    last_reviewed: '2026-11-20', custom_field: 'keep',
  }, '# Done\n');
  const changed = await plugin.markPathsDone([file.path], { confirm: false });
  assert.equal(changed, 1);
  const after = app.vault.readFm(file);
  assert.equal(after.status, 'done');
  assert.equal(after.date_done, today);
  assert.equal(after.last_reviewed, today);
  assert.equal(after.next_review, undefined);
  assert.equal(after.interval, undefined);
  assert.equal(after.review_count, 3);
  assert.equal(after.a_factor, 1.5);
  assert.equal(after.priority, 50);
  assert.equal(after.custom_field, 'keep');
  assert.equal(writesFor(app, file).length, 1);
  assert.equal(app.vault.appendCalls.length, 0);
});

test('markPathsDone retires the card deck tag and keeps other tags', async (t) => {
  const { plugin, app, today } = setup(t);
  const file = makeFile(app, 'Cards/Card.md', {
    type: 'card', status: 'active', ir_spaced_repetition: true,
    ir_spaced_repetition_deck_tag: 'flashcards/incremental-reading',
    tags: ['incremental-reading', 'ir/card', 'flashcards/incremental-reading', 'topic/keep'],
    review_count: 2, next_review: '2026-11-20',
  }, '# Card\n');
  await plugin.markPathsDone([file.path], { confirm: false });
  const after = app.vault.readFm(file);
  assert.equal(after.status, 'done');
  assert.equal(after.date_done, today);
  assert.equal(after.next_review, undefined);
  assert.deepEqual(after.tags, ['incremental-reading', 'ir/card', 'topic/keep']);
  assert.equal(after.ir_completed_deck_tag, 'flashcards/incremental-reading');
  assert.equal(writesFor(app, file).length, 1);
});

test('resetPaths clears source scheduling history but keeps identity fields', async (t) => {
  const { plugin, app } = setup(t);
  const file = makeFile(app, 'Sources/Reset.md', {
    type: 'source', status: 'done', date_done: '2026-11-20', date_dismissed: '2026-11-19',
    priority: 50, interval: 8, review_count: 3, a_factor: 1.5,
    next_review: '2026-11-20', last_reviewed: '2026-11-20', custom_field: 'keep',
  }, '# Reset\n');
  await plugin.resetPaths([file.path], { confirm: false });
  const after = app.vault.readFm(file);
  assert.equal(after.status, 'active');
  assert.equal(after.date_done, undefined);
  assert.equal(after.date_dismissed, undefined);
  assert.equal(after.interval, undefined);
  assert.equal(after.review_count, undefined);
  assert.equal(after.a_factor, undefined);
  assert.equal(after.next_review, undefined);
  assert.equal(after.last_reviewed, undefined);
  assert.equal(after.priority, 50);
  assert.equal(after.custom_field, 'keep');
  assert.equal(writesFor(app, file).length, 1);
});

test('resetPaths restores card tags and removes SR scheduling comments', async (t) => {
  const { plugin, app } = setup(t);
  const file = makeFile(app, 'Cards/ResetCard.md', {
    type: 'card', status: 'done', date_done: '2026-11-20',
    ir_spaced_repetition: true,
    ir_completed_deck_tag: 'flashcards/incremental-reading',
    tags: ['ir/card', 'topic/keep'],
    priority: 40,
  }, '# Card\n\nquestion\n?\nanswer\n<!--SR:!2026-11-25,3,250-->\n');
  await plugin.resetPaths([file.path], { confirm: false });
  const after = app.vault.readFm(file);
  assert.equal(after.status, 'active');
  assert.equal(after.date_done, undefined);
  assert.equal(after.ir_completed_deck_tag, undefined);
  assert.ok(after.tags.includes('flashcards/incremental-reading'));
  assert.ok(after.tags.includes('topic/keep'));
  assert.equal(app.vault.readBody(file).includes('<!--SR:'), false);
  assert.equal(writesFor(app, file).length, 1);
  assert.equal(app.vault.processCalls.length, 1);
});

test('dismissTreeNode sets dismissed without changing scheduling; cards are refused', async (t) => {
  const { plugin, app } = setup(t);
  const file = makeFile(app, 'Sources/Dismiss.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, review_count: 3,
    a_factor: 1.5, next_review: '2026-11-20',
  }, '# Dismiss\n');
  await plugin.dismissTreeNode(file.path);
  assert.equal(app.vault.readFm(file).status, 'dismissed');
  assert.equal(app.vault.readFm(file).interval, 8);
  assert.equal(writesFor(app, file).length, 1);
  const card = makeFile(app, 'Cards/DismissCard.md', { type: 'card', status: 'active' }, '# Card\n');
  await plugin.dismissTreeNode(card.path);
  assert.equal(app.vault.readFm(card).status, 'active');
  assert.equal(writesFor(app, card).length, 0);
});

test('createTimestampExtract writes extract fields and bumps the parent source (0.1 legacy behavior)', async (t) => {
  const { plugin, app, today } = setup(t);
  const source = makeFile(app, 'Sources/Source.md', {
    type: 'source', status: 'active', priority: 50, interval: 8, review_count: 3,
    a_factor: 1.5, read_point: 40, total_pages: 100, next_review: '2026-11-20',
  }, '# Source\n');
  app.activeFile = source;
  const created = await plugin.createTimestampExtract({
    sourceFile: source,
    text: 'A quoted passage.',
    page: 5,
    open: false,
  });
  assert.ok(created);
  assert.equal(app.vault.createCalls.length, 1);
  assert.equal(app.vault.createCalls[0].file.path, created.path);
  assert.match(created.path, /^Extracts\/2026-11-24 12-00-00\.md$/);
  const content = app.vault.readContent(created);
  assert.match(content, /^---\ntype: extract\n/);
  assert.match(content, /status: pending/);
  assert.match(content, /priority: 50/);
  assert.match(content, /interval: 8/);
  assert.match(content, /a_factor: 2\.0/);
  assert.match(content, /review_count: 0/);
  assert.match(content, /page: 5/);
  assert.match(content, new RegExp(`next_review: ${addDays(today, 8)}`));
  assert.match(content, /source: "\[\[Source\]\]"/);
  assert.match(content, /A quoted passage\./);
  assert.match(content, /\[\[Source#page=5\|Source · p\.5\]\]/);
  const parent = app.vault.readFm(source);
  assert.equal(parent.priority, 51);
  assert.equal(parent.a_factor, 1.575);
  assert.equal(writesFor(app, source).length, 2);
  assert.equal(writesFor(app, created).length, 0);
});
