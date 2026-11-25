'use strict';

// PR-10B — static evidence that the host entries delegate to the scheduler
// service, plus the dashboard model hookup. No real Obsidian is loaded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const srcSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const baseSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

test('every audited root entry delegates through the host scheduler service', () => {
  for (const [method, action] of [
    ['_gradeTopic', 'ADVANCED'],
    ['markDone', 'COMPLETE'],
    ['resetCurrent', 'RESET_CURRENT'],
    ['dismiss', 'DISMISS'],
    ['postpone', 'POSTPONE'],
    ['schedule', 'MANUAL_SCHEDULE'],
    ['setPriority', 'SET_PRIORITY'],
    ['postponeSubtree', 'POSTPONE_SUBTREE'],
    ['_createExtract', 'CREATE_EXTRACT'],
    ['newSource', 'CREATE_SOURCE'],
  ]) {
    const start = mainSource.indexOf(`  async ${method}(`);
    assert.ok(start >= 0, method);
    const end = mainSource.indexOf('\n  async ', start + 10);
    const body = mainSource.slice(start, end < 0 ? undefined : end);
    assert.match(body, /_mfUs1RunLegacy\(/, method);
    if (['_gradeTopic', 'markDone', 'dismiss'].includes(method)) {
      assert.match(body, /_mfUs1(Event|Active)Descriptor\(/, `${method} must build an explicit event descriptor`);
    } else {
      assert.ok(body.includes(`'${action}'`), `${method} must name its event action`);
    }
  }
  assert.match(mainSource, /createHostSchedulerService/);
  assert.match(mainSource, /schedulerDashboardModel\(/);
});

test('reading-page extraction and mercy routing delegate in src/main.js', () => {
  assert.match(srcSource, /async createTimestampExtract\(options = \{\}\) \{[\s\S]{0,200}?_mfUs1RunLegacy\(\{ action: 'CREATE_EXTRACT' \}/);
  assert.match(srcSource, /async spreadOverdue\(overdueRows, days\) \{[\s\S]{0,200}?_mfUs1RunLegacy\(\{ action: 'MERCY_APPLY' \}/);
});

test('postpone, schedule and setPriority confirm UI parameters before routing', () => {
  for (const [method, picker] of [['postpone', 'pickFromList'], ['schedule', 'askText'], ['setPriority', 'askText']]) {
    const start = mainSource.indexOf(`  async ${method}(`);
    const end = mainSource.indexOf('\n  async ', start + 10);
    const body = mainSource.slice(start, end < 0 ? undefined : end);
    const pickerIndex = body.indexOf(picker);
    const routeIndex = body.indexOf('_mfUs1RunLegacy');
    assert.ok(pickerIndex >= 0, `${method} must confirm parameters first`);
    assert.ok(pickerIndex < routeIndex, `${method} must not route before confirmation`);
    assert.match(body, /return; \/\/ cancel: no event, no write|if \(!choice\) return;/);
  }
});

test('the default host mode remains legacy and unified has no authorization path', () => {
  assert.match(mainSource, /getMode: \(\) => \(this\.settings && this\.settings\.mf_us1_mode \? this\.settings\.mf_us1_mode : 'legacy'\)/);
  assert.equal(/issueSyntheticRuntimeAuthorization/.test(mainSource), false);
  assert.equal(/mode: 'unified'/.test(mainSource), false);
});

test('the legacy bodies are preserved behind distinct methods', () => {
  for (const name of ['_gradeTopicLegacy', '_markDoneLegacy', '_dismissLegacy', '_postponeLegacyWrite', '_scheduleLegacyWrite', '_setPriorityLegacyWrite', '_newSourceLegacy', '_createExtractLegacy']) {
    assert.ok(mainSource.includes(`async ${name}(`), name);
  }
  assert.ok(srcSource.includes('async _createTimestampExtractLegacy('));
  assert.ok(srcSource.includes('async _spreadOverdueLegacy('));
  assert.equal(baseSource.length > 0, true);
});
