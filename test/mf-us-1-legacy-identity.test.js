'use strict';

// PR-06 — legacy stable identity (SPEC A2.2, A10.2).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveIdentity,
  temporaryId,
  isPersistentUuid,
  UUID_RE,
  adaptLegacyTopics,
} = require('../src/scheduling/index.js');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

function raw(overrides = {}) {
  return {
    type: 'extract',
    status: 'active',
    priority: 50,
    interval: 5,
    a_factor: 2.0,
    review_count: 1,
    next_review: '24-11-2026',
    path: 'Extracts/E1.md',
    basename: 'E1',
    ...overrides,
  };
}

test('a valid mf_id is a persistent identity and never changes with a title', () => {
  const identity = resolveIdentity(raw({ mf_id: UUID }));
  assert.equal(identity.kind, 'persistent');
  assert.equal(identity.persistent, true);
  assert.equal(identity.id, UUID);
  assert.equal(identity.renameStable, true);
  assert.equal(isPersistentUuid(UUID), true);

  const renamed = resolveIdentity(raw({ mf_id: UUID, path: 'Elsewhere/Renamed.md', basename: 'Renamed' }));
  assert.equal(renamed.id, UUID, 'title/path never influence a persisted id');
});

test('an invalid mf_id is rejected instead of being replaced', () => {
  for (const value of ['nope', '', '123', 42, '3f2504e0-4f89-41d3-9a0c']) {
    const identity = resolveIdentity(raw({ mf_id: value }));
    assert.equal(identity.kind, 'invalid', String(value));
    assert.equal(identity.error, 'E_ID_FORMAT');
    assert.equal(identity.id, null);
  }
});

test('a note without mf_id gets a deterministic temporary id from its snapshot path', () => {
  const first = resolveIdentity(raw({ path: 'Extracts/E1.md' }));
  const second = resolveIdentity(raw({ path: 'Extracts/E1.md' }));
  assert.equal(first.kind, 'temporary');
  assert.equal(first.persistent, false);
  assert.equal(first.renameStable, false);
  assert.equal(first.id, second.id);
  assert.equal(first.source, 'snapshot_path');
  // A temporary id must never look like a persisted UUID.
  assert.equal(isPersistentUuid(first.id), false);
  assert.equal(UUID_RE.test(first.id), false);
});

test('different paths or titles never share a temporary id', () => {
  const a = resolveIdentity(raw({ path: 'Extracts/A.md' }));
  const b = resolveIdentity(raw({ path: 'Extracts/B.md' }));
  assert.notEqual(a.id, b.id);

  const named = resolveIdentity({ type: 'source', path: undefined, basename: 'A' });
  assert.equal(named.source, 'title');
  assert.equal(named.warning, 'TEMP_ID_FROM_TITLE');
});

test('renaming changes a temporary id and the limitation is explicit', () => {
  const before = resolveIdentity(raw({ path: 'Extracts/A.md' }));
  const after = resolveIdentity(raw({ path: 'Extracts/B.md' }));
  assert.notEqual(before.id, after.id);
  assert.equal(before.renameStable, false);
  assert.equal(after.renameStable, false);
});

test('an unresolvable identity is reported, not invented', () => {
  const identity = resolveIdentity({ type: 'source' });
  assert.equal(identity.kind, 'missing');
  assert.equal(identity.id, null);
  assert.equal(identity.error, 'E_LEGACY_ID_UNAVAILABLE');
});

test('duplicate persistent ids are a conflict for every occurrence', () => {
  const report = adaptLegacyTopics([
    raw({ mf_id: UUID }),
    raw({ mf_id: UUID, path: 'Extracts/E2.md', basename: 'E2' }),
    raw({ mf_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', path: 'Extracts/E3.md', basename: 'E3' }),
  ], CONTEXT);
  assert.equal(report.results[0].status, 'conflict');
  assert.equal(report.results[1].status, 'conflict');
  assert.equal(report.results[2].status, 'ready');
  assert.equal(report.results[0].errors.filter(error => error.code === 'E_DUPLICATE_ID').length, 1);
});

test('two notes sharing a snapshot path collide as a temporary id', () => {
  const report = adaptLegacyTopics([
    raw({ path: 'Extracts/Same.md' }),
    raw({ path: 'Extracts/Same.md' }),
  ], CONTEXT);
  assert.equal(report.results[0].identity.id, report.results[1].identity.id);
  assert.equal(report.results[0].status, 'conflict');
  assert.equal(report.results[1].status, 'conflict');
});

test('temporary ids are derived only from the snapshot, not from order', () => {
  const first = resolveIdentity(raw({ path: 'Extracts/A.md' }));
  const second = resolveIdentity(raw({ path: 'Extracts/A.md' }));
  const synthetic = temporaryId('path:extracts/a.md');
  assert.equal(first.id, synthetic);
  assert.equal(second.id, synthetic);
});

test('adaptation never writes a generated id back to the raw snapshot', () => {
  const source = raw({ path: 'Extracts/A.md' });
  assert.equal('mf_id' in source, false);
  const report = adaptLegacyTopics([source], CONTEXT);
  assert.equal('mf_id' in source, false);
  assert.equal(report.results[0].identity.kind, 'temporary');
  assert.equal(report.results[0].writesPerformed, false);
});
