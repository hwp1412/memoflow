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

test('creation entries bypass the scheduler host and use the creation writers', () => {
  for (const [method, delegated] of [['newSource', '_newSourceLegacy'], ['_createExtract', '_createExtractLegacy']]) {
    const start = mainSource.indexOf(`  async ${method}(`);
    assert.ok(start >= 0, method);
    const end = mainSource.indexOf('\n  async ', start + 10);
    const body = mainSource.slice(start, end < 0 ? undefined : end);
    assert.ok(body.includes(delegated), `${method} must call ${delegated} directly`);
    assert.equal(/_mfUs1RunLegacy/.test(body), false, `${method} must not go through the scheduling host`);
  }
});

test('every audited root entry delegates through the host scheduler service', () => {
  // HOST-ACTIONS-01: postpone/schedule/setPriority now share one authoritative
  // descriptor site (`*File`) so every UI surface goes through the same event.
  const fileEntries = [
    ['postpone', 'postponeFile('],
    ['schedule', 'scheduleFile('],
    ['setPriority', 'setPriorityFile('],
  ];
  for (const [method, delegated] of fileEntries) {
    const start = mainSource.indexOf(`  async ${method}(`);
    assert.ok(start >= 0, method);
    const end = mainSource.indexOf('\n  async ', start + 10);
    const body = mainSource.slice(start, end < 0 ? undefined : end);
    assert.ok(body.includes(delegated), `${method} must delegate to ${delegated}`);
  }
  for (const [method, action] of [
    ['_gradeTopic', 'ADVANCED'],
    ['markDone', 'COMPLETE'],
    ['resetCurrent', 'RESET_CURRENT'],
    ['dismiss', 'DISMISS'],
    ['postponeSubtree', 'POSTPONE_SUBTREE'],
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
  // The shared entries name the action they build; the event type itself comes
  // from the accepted reading-action map, not from a second literal table.
  for (const kind of ['postpone', 'schedule', 'priority']) {
    const occurrences = mainSource.split(`buildEventPayload('${kind}'`).length - 1;
    assert.equal(occurrences, 1, `${kind} must be built in exactly one host entry`);
  }
  assert.match(mainSource, /_mfUs1RunLegacy\(/);
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
    const routeIndex = body.indexOf(`${method}File(`);
    assert.ok(pickerIndex >= 0, `${method} must confirm parameters first`);
    assert.ok(routeIndex > pickerIndex, `${method} must not route before confirmation`);
    assert.match(body, /return; \/\/ cancel: no event, no write|if \(!choice\) return;/);
  }
});

test('the default host mode is Unified and authorization has no synthetic forge path', () => {
  assert.match(mainSource, /getMode: \(\) => this\._mfUs1EffectiveMode\(\)/);
  assert.match(mainSource, /_mfUs1NormalizeMode\(/);
  assert.equal(/issueSyntheticRuntimeAuthorization/.test(mainSource), false);
  // UX: fresh installs default to Unified and auto-connect on startup; the
  // low-level activation coordinator is still the only place capabilities are
  // minted, and no capability can be forged from settings.
  assert.match(mainSource, /mfUs1ActivateUnified\(/);
  assert.match(mainSource, /approvalProvider/);
  assert.match(mainSource, /_mfUs1AutoStartRuntime\(/);
  assert.match(mainSource, /mf_us1_mode: 'unified'/);
});

test('the legacy bodies are preserved behind distinct methods', () => {
  for (const name of ['_gradeTopicLegacy', '_markDoneLegacy', '_dismissLegacy', '_postponeLegacyWrite', '_scheduleLegacyWrite', '_setPriorityLegacyWrite', '_newSourceLegacy', '_createExtractLegacy']) {
    assert.ok(mainSource.includes(`async ${name}(`), name);
  }
  assert.ok(srcSource.includes('async _createTimestampExtractLegacy('));
  assert.ok(srcSource.includes('async _spreadOverdueLegacy('));
  assert.equal(baseSource.length > 0, true);
});
