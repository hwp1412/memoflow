'use strict';

// PR-10B — Obsidian Vault.process adapter contract (mock only).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createObsidianProcessAdapter,
  assertTrustedProcessAdapter,
} = require('../src/integration/obsidian-process-storage.js');
const { sha256Hex } = require('../src/scheduling/index.js');
const { uuid } = require('./helpers/unified-fixtures.js');

class MockVault {
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.beforeProcess = null;
    this.afterProcess = null;
  }

  async process(path, mutator) {
    if (typeof this.beforeProcess === 'function') await this.beforeProcess(path, this);
    const latest = this.files.get(path);
    const next = mutator(latest); // latest bytes, inside the atomic callback
    this.files.set(path, next);
    if (typeof this.afterProcess === 'function') await this.afterProcess(path, this);
    return next;
  }

  async read(path) {
    return this.files.get(path) ?? null;
  }
}

function content(fields = {}, body = 'Body text\nline2') {
  const merged = {
    type: 'source', status: 'active', priority: 50, interval: 8, a_factor: 2.0,
    review_count: 3, next_review: '20-11-2026', mf_id: uuid(1), mf_revision: 1,
    mf_scheduler_version: 1, custom: 'keep', ...fields,
  };
  const lines = Object.entries(merged).map(([key, value]) => `${key}: ${value}`);
  return ['---', ...lines, '---', body].join('\n');
}

function setup(initial = content()) {
  const vault = new MockVault({ 'Sources/A.md': initial });
  const adapter = createObsidianProcessAdapter({
    vault,
    dateFormat: 'DD-MM-YYYY',
    pathForTopicId: topicId => (topicId === uuid(1) ? 'Sources/A.md' : null),
  });
  return { vault, adapter };
}

test('CAS validates and updates inside Vault.process, preserving body and unknown fields', async () => {
  const { vault, adapter } = setup();
  const before = await vault.read('Sources/A.md');
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(before),
    expectedRevision: 1,
    mutate: frontmatter => { frontmatter.mf_not_before = '2026-11-27'; },
  });
  assert.equal(result.ok, true);
  const after = await vault.read('Sources/A.md');
  assert.equal(sha256Hex(after), result.afterHash);
  assert.match(after, /mf_not_before: 2026-11-27/);
  assert.match(after, /mf_revision: 2/);
  assert.match(after, /custom: keep/);
  assert.match(after, /Body text\nline2/);
});

test('a concurrent edit inside the process window is a snapshot conflict', async () => {
  const { vault, adapter } = setup();
  const before = await vault.read('Sources/A.md');
  vault.beforeProcess = path => { vault.files.set(path, `${before}\nexternal edit`); };
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(before),
    expectedRevision: 1,
    mutate: fm => { fm.mf_not_before = '2026-11-27'; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SNAPSHOT_MISMATCH');
  assert.match(await vault.read('Sources/A.md'), /external edit/);
});

test('revision and identity mismatches are refused', async () => {
  const { vault, adapter } = setup();
  const before = await vault.read('Sources/A.md');
  const revision = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(before), expectedRevision: 9, mutate: fm => { fm.mf_not_before = 'x'; },
  });
  assert.equal(revision.code, 'E_REVISION_MISMATCH');

  const wrongId = await adapter.compareAndSwap(uuid(2), {
    expectedHash: sha256Hex(before), expectedRevision: 1, mutate: () => {},
  });
  assert.equal(wrongId.code, 'E_TOPIC_NOT_FOUND');

  vault.files.set('Sources/A.md', content({ mf_id: 'not-a-uuid' }));
  const invalid = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(await vault.read('Sources/A.md')), expectedRevision: 1, mutate: () => {},
  });
  assert.equal(invalid.code, 'E_ID_NOT_PERSISTED');
});

test('unsupported YAML structures are refused instead of guessed', async () => {
  const { vault, adapter } = setup(content({}, 'Body').replace('custom: keep', '# comment line'));
  const before = await vault.read('Sources/A.md');
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(before), expectedRevision: 1, mutate: fm => { fm.mf_not_before = '2026-11-27'; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_FRONTMATTER_UNSUPPORTED_STRUCTURE');
});

test('a post-write read-back mismatch is reported as uncertain', async () => {
  const { vault, adapter } = setup();
  const before = await vault.read('Sources/A.md');
  vault.afterProcess = path => { vault.files.set(path, `${before}\ncli edit`); };
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(before), expectedRevision: 1, mutate: fm => { fm.mf_not_before = '2026-11-27'; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_WRITE_UNVERIFIED');
});

test('only a factory-created adapter is trusted; forged markers fail', () => {
  const { adapter } = setup();
  assert.equal(assertTrustedProcessAdapter(adapter), adapter);
  assert.throws(() => assertTrustedProcessAdapter({
    kind: 'obsidian-process-adapter', supportsAtomicCas: true, compareAndSwap: async () => ({ ok: true }),
  }), error => error.code === 'E_STORAGE_UNTRUSTED');
});

test('an unknown date format is refused up front', () => {
  assert.throws(() => createObsidianProcessAdapter({
    vault: new MockVault({}), dateFormat: 'DD.MM.YYYY', pathForTopicId: () => null,
  }), error => error.code === 'E_DATE_FORMAT_UNSUPPORTED');
});
