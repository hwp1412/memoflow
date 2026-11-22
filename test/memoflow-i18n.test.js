'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { COMMAND_NAMES, MENU_LABELS } = require('../src/i18n/zh.js');

const BASE_COMMANDS = [
  'build-session-queue',
  'next-element',
  'end-session',
  'extract-selection',
  'flashcard-clipboard',
  'capture-more',
  'current-actions',
  'open-toolkit-view',
  'advanced-tools',
];

const hasChinese = value => /[\u4e00-\u9fff]/.test(String(value || ''));

test('every base command receives a non-empty Chinese name', () => {
  for (const id of BASE_COMMANDS) {
    assert.ok(COMMAND_NAMES[id], `missing command mapping: ${id}`);
    assert.ok(hasChinese(COMMAND_NAMES[id]), `command is not Chinese: ${id}`);
  }
});

test('top-level action menus are fully translated and aligned with callbacks', () => {
  assert.equal(MENU_LABELS.capture.length, 6);
  assert.equal(MENU_LABELS.current.length, 12);
  assert.equal(MENU_LABELS.toolkit.length, 6);
  assert.equal(MENU_LABELS.advanced.length, 10);
  for (const key of ['captureTitle', 'currentTitle', 'toolkitTitle', 'advancedTitle']) {
    assert.ok(hasChinese(MENU_LABELS[key]), `menu title is not Chinese: ${key}`);
  }
  for (const key of ['capture', 'current', 'toolkit', 'advanced']) {
    for (const label of MENU_LABELS[key]) {
      assert.ok(hasChinese(label), `menu label is not Chinese: ${key}/${label}`);
    }
  }
});

test('technical deck names are preserved in menu labels', () => {
  assert.ok(MENU_LABELS.advanced.includes('导出内联卡片到 SR'));
  assert.ok(MENU_LABELS.current.includes('打开 PDF'));
});

const { BASE_STRINGS, localizeBaseSource } = require('../src/i18n/base-zh.js');

test('base UI strings are localized at build time without touching logic values', () => {
  const sample = [
    "new Notice('Topic quality?');",
    "new Notice('No saved queue for today. Run Build today\\'s session queue first.');",
    "const status = 'active';",
    "new Notice('Page you stopped at');",
  ].join('\n');
  const localized = localizeBaseSource(sample);
  assert.ok(localized.includes('这次阅读感觉如何？'));
  assert.ok(localized.includes('今天没有已保存的队列'));
  assert.ok(localized.includes("const status = 'active';"));
  assert.ok(localized.includes('读到的页码'));
  assert.ok(Object.keys(BASE_STRINGS).length >= 150);
});

test('base localization covers core reading prompts and queue notices', () => {
  for (const key of [
    'Topic quality?',
    'Page you stopped at',
    'Built today\'s queue with ${queue.length} element${queue.length === 1 ? \'\' : \'s\'}.',
    'Nothing overdue.',
    'Open an incremental reading source or extract first.',
  ]) {
    assert.ok(BASE_STRINGS[key], `missing base translation: ${key}`);
  }
});
