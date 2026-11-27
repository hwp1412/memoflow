'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
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



test('withFrozenDate restores Date and removes window when none existed', () => {
  const originalDate = global.Date;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const originalWindow = global.window;
  delete global.window;
  const callbacks = [];
  const fakeT = { after: callback => callbacks.push(callback) };
  try {
    withFrozenDate(fakeT);
    assert.notEqual(global.Date, originalDate);
    assert.equal(typeof global.window, 'object');
    assert.equal(global.window.setTimeout, global.setTimeout);
    callbacks.forEach(callback => callback());
    assert.equal(global.Date, originalDate);
    assert.equal(Object.prototype.hasOwnProperty.call(global, 'window'), false);
  } finally {
    global.Date = originalDate;
    if (hadWindow) global.window = originalWindow;
    else delete global.window;
  }
});

test('withFrozenDate restores an existing window.setTimeout', () => {
  const originalDate = global.Date;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const originalWindow = global.window;
  const sentinel = () => {};
  global.window = { marker: 'keep', setTimeout: sentinel };
  const callbacks = [];
  const fakeT = { after: callback => callbacks.push(callback) };
  try {
    withFrozenDate(fakeT);
    assert.equal(global.window.marker, 'keep');
    assert.equal(global.window.setTimeout, global.setTimeout);
    callbacks.forEach(callback => callback());
    assert.equal(global.window.marker, 'keep');
    assert.equal(global.window.setTimeout, sentinel);
    assert.equal(global.Date, originalDate);
  } finally {
    global.Date = originalDate;
    if (hadWindow) global.window = originalWindow;
    else delete global.window;
  }
});

test('withFrozenDate removes setTimeout added to an existing window', () => {
  const originalDate = global.Date;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const originalWindow = global.window;
  global.window = { marker: 'keep' };
  const callbacks = [];
  const fakeT = { after: callback => callbacks.push(callback) };
  try {
    withFrozenDate(fakeT);
    assert.equal(global.window.marker, 'keep');
    assert.equal(typeof global.window.setTimeout, 'function');
    callbacks.forEach(callback => callback());
    assert.equal(global.window.marker, 'keep');
    assert.equal(Object.prototype.hasOwnProperty.call(global.window, 'setTimeout'), false);
    assert.equal(global.Date, originalDate);
  } finally {
    global.Date = originalDate;
    if (hadWindow) global.window = originalWindow;
    else delete global.window;
  }
});

test('plugin loader restores Module._load after loading', () => {
  const before = Module._load;
  createPlugin({ settings: makeSettings() });
  assert.equal(Module._load, before);
});
