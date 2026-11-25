'use strict';

// P2-US1-CREATION-WIRING — authorized, idempotent and honest-about-partial
// Source/Extract creation. Synthetic storage only; no real Vault is touched.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  issueSyntheticCreationAuthorization,
  hasSyntheticCreationAuthorization,
  planTopicCreation,
  creationFieldLines,
  composeCreationContent,
  executeTopicCreation,
} = require('../src/integration/topic-creation-host.js');
const { uuid } = require('./helpers/unified-fixtures.js');

const TODAY = '2026-11-24';

class FakeVault {
  constructor() {
    this.files = new Map();
    this.createCalls = [];
    this.readCalls = 0;
    this.failNextCreate = null;
    this.createWritesAnyway = false;
    this.stripMfOnRead = false;
    this.unreadable = new Set();
  }

  getAbstractFileByPath(filePath) {
    const content = this.files.get(filePath);
    return content === undefined ? null : { path: filePath };
  }

  async read(file) {
    this.readCalls += 1;
    if (this.unreadable.has(file.path)) throw new Error(`unreadable file: ${file.path}`);
    const content = this.files.get(file.path);
    if (content === undefined) throw new Error(`missing file: ${file.path}`);
    return this.stripMfOnRead ? content.replace(/^mf_id:.*$/m, '') : content;
  }

  async create(filePath, content) {
    this.createCalls.push({ path: filePath, content });
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      if (this.createWritesAnyway) this.files.set(filePath, content);
      throw error;
    }
    if (this.files.has(filePath)) throw new Error(`file exists: ${filePath}`);
    this.files.set(filePath, content);
    return { path: filePath };
  }
}

const SOURCE_CONTENT = [
  '---',
  'type: source',
  'source_type: article',
  'status: active',
  'priority: 50',
  'next_review: 2026-11-27',
  'interval: 3',
  'a_factor: 2.0',
  'review_count: 0',
  'last_reviewed:',
  'date_added: 2026-11-24',
  'tags:',
  '  - incremental-reading',
  '  - ir/source',
  '---',
  '',
  'Body keeps its exact bytes.',
  '',
].join('\n');

function plannedSource(requestId = 'source-1') {
  return planTopicCreation({ requestId, kind: 'source', priority: 50, today: TODAY });
}

function authorized() {
  return issueSyntheticCreationAuthorization();
}

test('creation without a synthetic token fails closed before any storage access', async () => {
  const vault = new FakeVault();
  const plan = plannedSource();
  const content = composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due });
  await assert.rejects(
    () => executeTopicCreation({ plan, vault, path: 'Sources/A.md', content, authorization: null }),
    error => error.code === 'E_CREATION_NOT_AUTHORIZED',
  );
  await assert.rejects(
    () => executeTopicCreation({ plan, vault, path: 'Sources/A.md', content, authorization: { kind: 'fake' } }),
    error => error.code === 'E_CREATION_NOT_AUTHORIZED',
  );
  assert.equal(vault.createCalls.length, 0);
  assert.equal(vault.readCalls, 0);
  assert.equal(hasSyntheticCreationAuthorization({}), false);
});

test('planning derives a deterministic valid uuid and initializes A3.3 fields', () => {
  const first = plannedSource('stable-request');
  const again = plannedSource('stable-request');
  assert.equal(first.mfId, again.mfId);
  assert.notEqual(plannedSource('other-request').mfId, first.mfId);
  assert.match(first.mfId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.topic.mf_revision, 0);
  assert.equal(first.topic.mf_not_before, null);
  assert.equal(first.topic.mf_last_event_id, null);
  assert.equal(first.topic.mf_scheduler_version, 1);
  assert.equal(first.topic.review_count, 0);
  assert.match(first.topic.mf_ideal_due, /^\d{4}-\d{2}-\d{2}$/);
});

test('planning refuses a missing requestId, a missing today and an unstable parent', () => {
  assert.throws(() => planTopicCreation({ kind: 'source', priority: 50, today: TODAY }), error => error.code === 'E_REQUEST_ID_REQUIRED');
  assert.throws(() => planTopicCreation({ requestId: 'r', kind: 'source', priority: 50 }), error => error.code === 'E_TODAY_REQUIRED');
  assert.throws(
    () => planTopicCreation({ requestId: 'r', kind: 'extract', priority: 50, today: TODAY, parentId: 'not-a-uuid' }),
    error => error.code === 'E_PARENT_REQUIRED',
  );
  assert.throws(
    () => planTopicCreation({ requestId: 'r', kind: 'card', priority: 50, today: TODAY }),
    error => error.code === 'E_TOPIC_TYPE',
  );
});

test('compose replaces only canonical scheduling keys and preserves other bytes', () => {
  const plan = plannedSource();
  const composed = composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due });
  assert.ok(composed.endsWith('\n\nBody keeps its exact bytes.\n'));
  assert.match(composed, /^---\ntype: source\nsource_type: article\nstatus: active\ndate_added: 2026-11-24\n/);
  const ids = composed.match(/^mf_id:/gm) || [];
  assert.equal(ids.length, 1, 'mf_id must appear exactly once');
  assert.equal((composed.match(/^next_review:/gm) || []).length, 1);
  assert.equal((composed.match(/^interval:/gm) || []).length, 1);
  assert.match(composed, new RegExp(`^mf_id: ${plan.topic.mf_id}$`, 'm'));
  assert.match(composed, /^review_count: 0$/m);
  assert.match(composed, /^last_reviewed:$/m);
});

test('compose derives next_review from the effective due and refuses an empty one', () => {
  const plan = plannedSource();
  const seen = [];
  const composed = composeCreationContent({
    content: SOURCE_CONTENT,
    topic: plan.topic,
    nextReview: isoDate => { seen.push(isoDate); return '2026/11/27'; },
  });
  assert.deepEqual(seen, [plan.topic.mf_ideal_due]);
  assert.match(composed, /^next_review: 2026\/11\/27$/m);
  assert.throws(
    () => composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic }),
    error => error.code === 'E_NEXT_REVIEW_REQUIRED',
  );
  assert.throws(
    () => composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: () => '' }),
    error => error.code === 'E_NEXT_REVIEW_REQUIRED',
  );
});

test('compose refuses duplicate canonical keys instead of silently picking one', () => {
  const plan = plannedSource();
  const duplicated = SOURCE_CONTENT.replace('a_factor: 2.0', 'a_factor: 2.0\na_factor: 1.2');
  assert.throws(
    () => composeCreationContent({ content: duplicated, topic: plan.topic, nextReview: plan.topic.mf_ideal_due }),
    error => error.code === 'E_FRONTMATTER_DUPLICATE_KEY',
  );
});

test('authorized source creation writes mf fields and verifies the read-back', async () => {
  const vault = new FakeVault();
  const plan = plannedSource();
  const content = composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due });
  const outcome = await executeTopicCreation({
    plan, vault, path: 'Sources/A.md', content, authorization: authorized(),
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.route, 'unified');
  assert.equal(outcome.fileCreated, true);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.writesPerformed, true);
  assert.equal(outcome.ledgerRecorded, false);
  assert.equal(outcome.requiresManualRecovery, false);
  assert.equal(vault.createCalls.length, 1);
  const written = vault.files.get('Sources/A.md');
  for (const line of creationFieldLines(plan.topic)) assert.ok(written.includes(line), line);
  assert.match(written, /^mf_revision: 0$/m);
});

test('a retried request is a duplicate, not a second Topic', async () => {
  const vault = new FakeVault();
  const token = authorized();
  const firstPlan = planTopicCreation({ requestId: 'dup-request', kind: 'source', priority: 50, today: TODAY });
  const firstContent = composeCreationContent({ content: SOURCE_CONTENT, topic: firstPlan.topic, nextReview: firstPlan.topic.mf_ideal_due });
  const first = await executeTopicCreation({ plan: firstPlan, vault, path: 'Sources/Dup.md', content: firstContent, authorization: token });
  assert.equal(first.status, 'applied');
  const before = vault.files.get('Sources/Dup.md');

  const retryPlan = planTopicCreation({ requestId: 'dup-request', kind: 'source', priority: 50, today: TODAY });
  const retryContent = composeCreationContent({ content: SOURCE_CONTENT, topic: retryPlan.topic, nextReview: retryPlan.topic.mf_ideal_due });
  const retry = await executeTopicCreation({ plan: retryPlan, vault, path: 'Sources/Dup.md', content: retryContent, authorization: token });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.mfId, first.mfId);
  assert.equal(retry.fileCreated, false);
  assert.equal(vault.createCalls.length, 1);
  assert.equal(vault.files.get('Sources/Dup.md'), before);
});

test('a different request targeting the same path is a conflict with no overwrite', async () => {
  const vault = new FakeVault();
  const token = authorized();
  const first = planTopicCreation({ requestId: 'owner-1', kind: 'source', priority: 50, today: TODAY });
  await executeTopicCreation({
    plan: first,
    vault,
    path: 'Sources/Same.md',
    content: composeCreationContent({ content: SOURCE_CONTENT, topic: first.topic, nextReview: first.topic.mf_ideal_due }),
    authorization: token,
  });
  const before = vault.files.get('Sources/Same.md');
  const conflict = planTopicCreation({ requestId: 'owner-2', kind: 'source', priority: 50, today: TODAY });
  const outcome = await executeTopicCreation({
    plan: conflict,
    vault,
    path: 'Sources/Same.md',
    content: composeCreationContent({ content: SOURCE_CONTENT, topic: conflict.topic, nextReview: conflict.topic.mf_ideal_due }),
    authorization: token,
  });
  assert.equal(outcome.status, 'conflict');
  assert.equal(outcome.writesPerformed, false);
  assert.equal(outcome.requiresManualRecovery, true);
  assert.equal(vault.files.get('Sources/Same.md'), before);
  assert.equal(vault.createCalls.length, 1);
});

test('a create that throws but leaves a file is uncertain, not failed', async () => {
  const vault = new FakeVault();
  const plan = plannedSource();
  vault.failNextCreate = new Error('disk flushed then aborted');
  vault.createWritesAnyway = true;
  const outcome = await executeTopicCreation({
    plan,
    vault,
    path: 'Sources/Uncertain.md',
    content: composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due }),
    authorization: authorized(),
  });
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.writesPerformed, null);
  assert.equal(outcome.requiresManualRecovery, true);
  assert.equal(outcome.diagnostics[0].code, 'E_CREATE_THREW_BUT_EXISTS');
});

test('a create that throws with no file is a definite failure', async () => {
  const vault = new FakeVault();
  const plan = plannedSource();
  vault.failNextCreate = new Error('permission denied');
  const outcome = await executeTopicCreation({
    plan,
    vault,
    path: 'Sources/Failed.md',
    content: composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due }),
    authorization: authorized(),
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.writesPerformed, false);
  assert.equal(outcome.requiresManualRecovery, false);
  assert.equal(outcome.diagnostics[0].code, 'E_CREATE_FAILED');
});

test('a read-back that cannot confirm mf_id is reported as partial', async () => {
  const vault = new FakeVault();
  const plan = plannedSource();
  vault.stripMfOnRead = true;
  const outcome = await executeTopicCreation({
    plan,
    vault,
    path: 'Sources/Partial.md',
    content: composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due }),
    authorization: authorized(),
  });
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.fileCreated, true);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.requiresManualRecovery, true);
  assert.equal(outcome.diagnostics[0].code, 'E_READBACK_MISMATCH');
});

test('an existing unreadable file blocks creation as uncertain', async () => {
  const vault = new FakeVault();
  const plan = plannedSource();
  vault.files.set('Sources/Locked.md', '---\nmf_id: 00000000-0000-4000-8000-000000000000\n---\n');
  vault.unreadable.add('Sources/Locked.md');
  const outcome = await executeTopicCreation({
    plan,
    vault,
    path: 'Sources/Locked.md',
    content: composeCreationContent({ content: SOURCE_CONTENT, topic: plan.topic, nextReview: plan.topic.mf_ideal_due }),
    authorization: authorized(),
  });
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.writesPerformed, null);
  assert.equal(vault.createCalls.length, 0);
});

test('extract creation keeps its parent/root links and an independent schedule', async () => {
  const vault = new FakeVault();
  const parentId = uuid(1);
  const parent = planTopicCreation({ requestId: 'parent', kind: 'source', priority: 50, today: TODAY });
  const plan = planTopicCreation({
    requestId: 'child', kind: 'extract', priority: 50, parentId, rootId: parentId, today: TODAY,
  });
  const extractContent = SOURCE_CONTENT
    .replace('type: source', 'type: extract')
    .replace('source_type: article', 'source: "[[Source A]]"');
  const outcome = await executeTopicCreation({
    plan,
    vault,
    path: 'Extracts/E1.md',
    content: composeCreationContent({ content: extractContent, topic: plan.topic, nextReview: plan.topic.mf_ideal_due }),
    authorization: authorized(),
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(plan.topic.mf_parent_id, parentId);
  assert.equal(plan.topic.mf_root_id, parentId);
  assert.notEqual(plan.topic.mf_id, parent.topic.mf_id);
  assert.equal(plan.topic.review_count, 0);
  assert.equal(plan.topic.mf_revision, 0);
  const written = vault.files.get('Extracts/E1.md');
  assert.match(written, new RegExp(`^mf_parent_id: ${parentId}$`, 'm'));
  assert.match(written, new RegExp(`^mf_root_id: ${parentId}$`, 'm'));
});

// ---- host wiring (real plugin class + mocked Obsidian API) -----------------

const { createPlugin, makeFile, getNotices } = require('./helpers/obsidian-mock.js');

function hostSetup() {
  const { plugin, app } = createPlugin();
  return { plugin, app };
}

function addHostSource(app, overrides = {}) {
  return makeFile(app, 'Sources/Hosted.md', {
    type: 'source',
    status: 'active',
    priority: 50,
    a_factor: 1.5,
    review_count: 0,
    next_review: '2026-11-27',
    interval: 3,
    ...overrides,
  }, '# Hosted\n');
}

test('the creation gateway is a strict no-op without a synthetic authorization', async () => {
  const { plugin, app } = hostSetup();
  const source = addHostSource(app, { mf_id: uuid(1), mf_root_id: uuid(1) });
  const before = app.vault.createCalls.length;
  const result = await plugin._mfUs1CreateTopicFromHost({
    requestId: 'no-token',
    kind: 'extract',
    priority: 50,
    parentFile: source,
    path: 'Extracts/Hosted - Extract.md',
    content: '---\ntype: extract\n---\n\nbody\n',
  });
  assert.equal(result.handled, false);
  assert.equal(app.vault.createCalls.length, before);
});

test('a synthetic creation writes MF-US-1 fields and leaves the parent schedule untouched', async () => {
  const { plugin, app } = hostSetup();
  const parentId = uuid(1);
  const source = addHostSource(app, { mf_id: parentId, mf_root_id: parentId });
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();

  const created = await plugin.createTimestampExtract({ sourceFile: source, text: 'hosted body', page: 5, open: false });
  assert.ok(created, 'expected a created extract');
  const text = app.vault.readContent(created);
  assert.match(text, new RegExp(`^mf_id: [0-9a-f-]{36}$`, 'm'));
  assert.match(text, new RegExp(`^mf_parent_id: ${parentId}$`, 'm'));
  assert.match(text, new RegExp(`^mf_root_id: ${parentId}$`, 'm'));
  assert.match(text, /^mf_revision: 0$/m);
  assert.match(text, /^mf_scheduler_version: 1$/m);
  assert.match(text, /^mf_not_before: null$/m);

  const parentFm = app.vault.readFm(source);
  assert.equal(Number(parentFm.priority), 50, 'Unified creation must not bump the parent priority');
  assert.equal(Number(parentFm.a_factor), 1.5, 'Unified creation must not bump the parent A-Factor');
});

test('legacy creation (no authorization) still writes the 0.1 bytes without mf fields', async () => {
  const { plugin, app } = hostSetup();
  const source = addHostSource(app, { mf_id: uuid(2), mf_root_id: uuid(2) });
  const created = await plugin.createTimestampExtract({ sourceFile: source, text: 'legacy body', page: 3, open: false });
  assert.ok(created);
  const text = app.vault.readContent(created);
  assert.equal(/\bmf_id:/.test(text), false);
  assert.equal(/\bmf_revision:/.test(text), false);
  assert.match(text, /^---\ntype: extract\n/);
});

test('a host retry with the same request is a duplicate and writes no second file', async () => {
  const { plugin, app } = hostSetup();
  const parentId = uuid(3);
  const source = addHostSource(app, { mf_id: parentId, mf_root_id: parentId });
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  const request = {
    requestId: `extract:Extracts/Hosted - Extract.md`,
    kind: 'extract',
    priority: 50,
    parentFile: source,
    path: 'Extracts/Hosted - Extract.md',
    content: '---\ntype: extract\nstatus: pending\npriority: 50\nnext_review: 2026-11-27\n---\n\nbody\n',
  };
  const first = await plugin._mfUs1CreateTopicFromHost(request);
  assert.equal(first.handled, true);
  assert.equal(first.outcome.status, 'applied');
  const createdCount = app.vault.createCalls.length;
  const before = app.vault.readContent(app.vault.getAbstractFileByPath(request.path));

  const retry = await plugin._mfUs1CreateTopicFromHost(request);
  assert.equal(retry.outcome.status, 'duplicate');
  assert.equal(app.vault.createCalls.length, createdCount);
  assert.equal(app.vault.readContent(app.vault.getAbstractFileByPath(request.path)), before);
});

test('an extract whose parent has no persistent mf_id is blocked, not downgraded to Legacy', async () => {
  const { plugin, app } = hostSetup();
  const source = addHostSource(app); // no mf_id
  plugin.__mfUs1CreationAuthorization = issueSyntheticCreationAuthorization();
  const created = await plugin.createTimestampExtract({ sourceFile: source, text: 'blocked body', page: 1, open: false });
  assert.equal(created, null);
  assert.equal(app.vault.createCalls.length, 0);
  const notices = getNotices(app).join('\n');
  assert.match(notices, /父级缺少持久 mf_id/);
});
