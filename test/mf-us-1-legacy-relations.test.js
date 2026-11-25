'use strict';

// PR-06 — legacy parent/root relation resolution (SPEC A3.4, A8).

const test = require('node:test');
const assert = require('node:assert/strict');

const { adaptLegacyTopics } = require('../src/scheduling/index.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

function uuid(seq) {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function source(seq, name, overrides = {}) {
  return {
    type: 'source',
    status: 'active',
    priority: 50,
    interval: 10,
    a_factor: 2.0,
    review_count: 1,
    next_review: '24-11-2026',
    mf_id: uuid(seq),
    path: `Sources/${name}.md`,
    basename: name,
    ...overrides,
  };
}

function extract(seq, name, parent, overrides = {}) {
  return {
    type: 'extract',
    status: 'active',
    priority: 40,
    interval: 5,
    a_factor: 2.0,
    review_count: 1,
    next_review: '24-11-2026',
    parent: `[[${parent}]]`,
    source: `[[${parent}]]`,
    mf_id: uuid(seq),
    path: `Extracts/${name}.md`,
    basename: name,
    ...overrides,
  };
}

function byName(report) {
  return Object.fromEntries(report.results.map(result => [result.source.basename, result]));
}

test('Source -> Extract links resolve parent and root', () => {
  const report = adaptLegacyTopics([
    source(1, 'A'),
    extract(2, 'E1', 'A'),
  ], CONTEXT);
  const results = byName(report);
  assert.equal(results.A.relation.status, 'root');
  assert.equal(results.A.relation.rootId, uuid(1));
  assert.equal(results.E1.status, 'ready');
  assert.equal(results.E1.topic.mf_parent_id, uuid(1));
  assert.equal(results.E1.topic.mf_root_id, uuid(1));
  assert.equal(results.E1.relation.depth, 1);
});

test('a five-level chain keeps depth, parent and root correct', () => {
  const report = adaptLegacyTopics([
    source(10, 'Root'),
    extract(11, 'L1', 'Root'),
    extract(12, 'L2', 'L1'),
    extract(13, 'L3', 'L2'),
    extract(14, 'L4', 'L3'),
  ], CONTEXT);
  const results = byName(report);
  const expected = [
    ['Root', 0, null, uuid(10)],
    ['L1', 1, uuid(10), uuid(10)],
    ['L2', 2, uuid(11), uuid(10)],
    ['L3', 3, uuid(12), uuid(10)],
    ['L4', 4, uuid(13), uuid(10)],
  ];
  for (const [name, depth, parentId, rootId] of expected) {
    assert.equal(results[name].relation.depth, depth, name);
    assert.equal(results[name].topic.mf_parent_id, parentId, name);
    assert.equal(results[name].topic.mf_root_id, rootId, name);
    assert.equal(results[name].status, 'ready', name);
  }
});

test('a missing parent is an orphan warning, never a fabricated parent', () => {
  const report = adaptLegacyTopics([extract(20, 'E1', 'Missing')], CONTEXT);
  const result = report.results[0];
  assert.equal(result.relation.status, 'orphan');
  assert.equal(result.topic.mf_parent_id, null);
  assert.ok(result.warnings.some(warning => warning.code === 'E_RELATION_ORPHAN'));
  assert.equal(result.status, 'read-only-limited');
  assert.equal(report.relationIssues.orphans.length, 1);
});

test('two snapshot notes with one basename make the parent ambiguous', () => {
  const report = adaptLegacyTopics([
    source(30, 'A', { path: 'Sources/x/A.md' }),
    source(31, 'A', { path: 'Sources/y/A.md' }),
    extract(32, 'E1', 'A'),
  ], CONTEXT);
  const result = byName(report).E1;
  assert.equal(result.relation.status, 'ambiguous');
  assert.equal(result.topic.mf_parent_id, null);
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.warnings.some(warning => warning.code === 'E_RELATION_AMBIGUOUS'));
  assert.equal(report.relationIssues.ambiguous.length, 1);
  assert.equal(report.relationIssues.ambiguous[0].candidates.length, 2);
});

test('a path link disambiguates same-basename notes', () => {
  const report = adaptLegacyTopics([
    source(40, 'A', { path: 'Sources/x/A.md' }),
    source(41, 'A', { path: 'Sources/y/A.md' }),
    extract(42, 'E1', 'Sources/x/A'),
  ], CONTEXT);
  const result = byName(report).E1;
  assert.equal(result.relation.status, 'ok');
  assert.equal(result.topic.mf_parent_id, uuid(40));
});

test('parent cycles are detected and rejected', () => {
  const report = adaptLegacyTopics([
    extract(50, 'A', 'B'),
    extract(51, 'B', 'A'),
  ], CONTEXT);
  for (const result of report.results) {
    assert.equal(result.status, 'invalid');
    assert.ok(result.errors.some(error => error.code === 'E_RELATION_CYCLE'));
  }
  assert.ok(report.relationIssues.cycles.length >= 2);
});

test('a note cannot be its own parent', () => {
  const report = adaptLegacyTopics([extract(60, 'A', 'A')], CONTEXT);
  assert.equal(report.results[0].status, 'invalid');
  assert.ok(report.results[0].errors.some(error => error.code === 'E_RELATION_SELF'));
  assert.equal(report.relationIssues.selfReferences.length, 1);
});

test('tree_root marks a root even when a legacy source link exists', () => {
  const report = adaptLegacyTopics([
    source(70, 'A'),
    extract(71, 'E1', 'A', { tree_root: true }),
  ], CONTEXT);
  const result = byName(report).E1;
  assert.equal(result.relation.status, 'root');
  assert.equal(result.relation.parentId, null);
  assert.equal(result.topic.mf_parent_id, null);
});

test('a done parent still resolves and is never modified by the child', () => {
  const parent = source(80, 'A', { status: 'done' });
  const snapshot = JSON.parse(JSON.stringify(parent));
  const report = adaptLegacyTopics([parent, extract(81, 'E1', 'A')], CONTEXT);
  const results = byName(report);
  assert.equal(results.E1.relation.status, 'ok');
  assert.equal(results.E1.topic.mf_parent_id, uuid(80));
  assert.equal(results.A.topic.status, 'done');
  assert.deepEqual(JSON.parse(JSON.stringify(parent)), snapshot);
});

test('a temporary parent yields a non-persistent relation and a null mf_parent_id', () => {
  const report = adaptLegacyTopics([
    source(90, 'A', { mf_id: undefined, path: 'Sources/A.md' }),
    extract(91, 'E1', 'A', { mf_id: undefined, path: 'Extracts/E1.md' }),
  ], CONTEXT);
  const result = byName(report).E1;
  assert.equal(result.relation.status, 'ok');
  assert.equal(result.relation.persistent, false);
  assert.equal(result.topic.mf_parent_id, null);
  assert.ok(result.warnings.some(warning => warning.code === 'RELATION_NOT_PERSISTENT'));
  assert.equal(result.status, 'read-only-limited');
});

test('relation resolution is order independent and never mutates the snapshot', () => {
  const topics = [
    source(100, 'A'),
    extract(101, 'E1', 'A'),
    extract(102, 'E2', 'E1'),
  ];
  const snapshot = JSON.parse(JSON.stringify(topics));
  const forward = adaptLegacyTopics(topics, CONTEXT);
  const backward = adaptLegacyTopics(topics.slice().reverse(), CONTEXT);

  const summarise = report => Object.fromEntries(report.results.map(result => [
    result.source.basename,
    [result.relation.status, result.relation.parentId, result.relation.rootId, result.relation.depth],
  ]));
  assert.deepEqual(summarise(forward), summarise(backward));
  assert.deepEqual(JSON.parse(JSON.stringify(topics)), snapshot);
});

// ---- ancestor-chain persistence (review fix 1) ----------------------------

test('a temporary ancestor never becomes a formal mf_root_id candidate', () => {
  const report = adaptLegacyTopics([
    source(200, 'A', { mf_id: undefined }),
    extract(201, 'B', 'A'),
    extract(202, 'C', 'B'),
  ], CONTEXT);
  const results = byName(report);
  assert.equal(results.B.topic.mf_parent_id, null, 'temporary parent cannot be a formal parent');
  assert.equal(results.B.topic.mf_root_id, null);
  assert.equal(results.C.topic.mf_parent_id, uuid(201), 'direct parent is persistent');
  assert.equal(results.C.topic.mf_root_id, null, 'temporary root must not leak into mf_root_id');
  assert.equal(results.C.relation.chainPersistent, false);
  assert.equal(results.C.status, 'read-only-limited');
  for (const result of report.results) {
    assert.equal(result.topic.mf_root_id == null || /^[0-9a-f-]{36}$/i.test(result.topic.mf_root_id), true);
  }
});

test('a five-level mixed chain validates persistence over every ancestor', () => {
  const report = adaptLegacyTopics([
    source(210, 'A', { mf_id: undefined }),
    extract(211, 'B', 'A'),
    extract(212, 'C', 'B'),
    extract(213, 'D', 'C'),
    extract(214, 'E', 'D'),
  ], CONTEXT);
  const results = byName(report);
  assert.equal(results.E.relation.depth, 4);
  assert.equal(results.E.topic.mf_parent_id, uuid(213));
  assert.equal(results.E.topic.mf_root_id, null);
  assert.equal(results.E.relation.chainPersistent, false);
  assert.equal(results.C.topic.mf_parent_id, uuid(211));
  assert.equal(results.C.topic.mf_root_id, null);
  assert.equal(results.B.relation.parentPersistent, false);
});

test('an unresolved ancestor poisons the whole descendant chain', () => {
  const report = adaptLegacyTopics([
    extract(220, 'B', 'Missing'),
    extract(221, 'C', 'B'),
  ], CONTEXT);
  const results = byName(report);
  assert.equal(results.B.relation.status, 'orphan');
  assert.equal(results.C.relation.status, 'orphan');
  assert.equal(results.C.topic.mf_parent_id, null);
  assert.equal(results.C.topic.mf_root_id, null);
});

// ---- duplicate paths / ids never bind arbitrarily (review fix 2) ----------

test('two notes sharing one path make a path link ambiguous', () => {
  const report = adaptLegacyTopics([
    source(230, 'A1', { path: 'Sources/Shared.md' }),
    source(231, 'A2', { path: 'Sources/Shared.md' }),
    extract(232, 'E', 'Sources/Shared.md'),
  ], CONTEXT);
  const result = byName(report).E;
  assert.equal(result.relation.status, 'ambiguous');
  assert.equal(result.topic.mf_parent_id, null);
  assert.equal(report.relationIssues.ambiguous[0].candidates.length, 2);
});

test('the same UUID on different paths is a duplicate, not a merge', () => {
  const report = adaptLegacyTopics([
    source(240, 'A1', { mf_id: uuid(240), path: 'Sources/A1.md' }),
    source(241, 'A2', { mf_id: uuid(240), path: 'Sources/A2.md' }),
    extract(242, 'E', 'A1'),
  ], CONTEXT);
  const results = byName(report);
  assert.equal(results.A1.status, 'conflict');
  assert.equal(results.A2.status, 'conflict');
  assert.equal(results.E.topic.mf_parent_id, null);
  assert.equal(results.E.relation.status, 'duplicate');
  assert.equal(results.E.status, 'conflict');
});

test('two temporary ids from the same path are duplicated and unbound', () => {
  const report = adaptLegacyTopics([
    source(250, 'A1', { mf_id: undefined, path: 'Sources/Same.md' }),
    source(251, 'A2', { mf_id: undefined, path: 'Sources/Same.md' }),
    extract(252, 'E', 'Sources/Same.md'),
  ], CONTEXT);
  assert.equal(report.results[0].identity.id, report.results[1].identity.id);
  assert.equal(report.results[0].status, 'conflict');
  assert.equal(report.results[1].status, 'conflict');
  assert.equal(report.results[2].topic.mf_parent_id, null);
});

test('UUID case differences are still the same identity', () => {
  const upper = uuid(260).toUpperCase();
  const report = adaptLegacyTopics([
    source(260, 'A1', { mf_id: upper }),
    source(261, 'A2', { mf_id: uuid(260) }),
  ], CONTEXT);
  assert.equal(report.results[0].status, 'conflict');
  assert.equal(report.results[1].status, 'conflict');
});

test('conflict classification is independent of input order', () => {
  const build = () => [
    source(270, 'A1', { mf_id: uuid(270), path: 'Sources/A1.md' }),
    source(271, 'A2', { mf_id: uuid(270), path: 'Sources/A2.md' }),
    extract(272, 'E', 'A1'),
  ];
  const forward = adaptLegacyTopics(build(), CONTEXT);
  const backward = adaptLegacyTopics(build().reverse(), CONTEXT);
  const statusOf = report => Object.fromEntries(report.results.map(result => [result.source.basename, result.status]));
  assert.deepEqual(statusOf(forward), statusOf(backward));
});
