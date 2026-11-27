'use strict';

// Phase UI: merged rhythm/workload panel + knowledge-tree constellation board.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'src', 'ui', 'dashboard.js'), 'utf8');
const treeSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('the dashboard merges study rhythm and future workload into one board', () => {
  assert.equal(/renderForecast\(model\)/.test(dashboard), false, 'separate forecast panel is gone');
  assert.match(dashboard, /mf-rhythm-panel is-combined/);
  assert.match(dashboard, /mf-rhythm-load/);
  assert.match(dashboard, /copy\.rhythmLoad/);
});

test('the knowledge tree keeps the tree and adds a constellation board', () => {
  assert.match(treeSource, /this\.boardMode = 'tree'/);
  assert.match(treeSource, /_renderConstellation\(\) \{/);
  assert.match(treeSource, /mf-constellation-svg/);
  assert.match(treeSource, /boardMode === 'constellation' \? 'tree' : 'constellation'/);
  assert.match(treeSource, /点击节点打开笔记/);
});

test('constellation board styles exist', () => {
  assert.match(css, /\.mf-constellation-svg/);
  assert.match(css, /\.mf-const-node:hover/);
  assert.match(css, /mf-twinkle/);
});
