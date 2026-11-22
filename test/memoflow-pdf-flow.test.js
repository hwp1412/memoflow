const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('clipboard extract keeps its current-page helper wired', () => {
  assert.match(main, /_activePdfPageNumber\(sourceFile = null\)/);
  assert.match(main, /async clipboardExtract\(sourceFile = null\)/);
  assert.match(main, /pageFallback = this\._activePdfPageNumber\(sourceFile\)/);
  assert.match(main, /pageFallback/);
});

test('extract open confirmation does not shadow Modal.onOpen', () => {
  const modal = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'extract-open-modal.js'), 'utf8');
  assert.match(modal, /onOpenFile/);
  assert.doesNotMatch(modal, /this\.onOpen\s*=\s*onOpenFile/);
});

test('card review has an explicit SR failure fallback', () => {
  const review = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'review-view.js'), 'utf8');
  assert.match(review, /Spaced Repetition 未能启动/);
  assert.match(review, /reviewCardsInNote\(file\)/);
  assert.match(review, /attempt < 40/);
});

test('destructive reading actions ask for confirmation', () => {
  assert.match(main, /_confirmDestructive\(/);
  assert.match(main, /移出队列？/);
  assert.match(main, /仅标记完成？/);
});
