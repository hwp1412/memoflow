'use strict';

// PR-10B — Obsidian Vault.process adapter: TFile contract, byte fidelity, CAS.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createObsidianProcessAdapter,
  assertTrustedProcessAdapter,
  parseBlock,
} = require('../src/integration/obsidian-process-storage.js');
const { sha256Hex } = require('../src/scheduling/index.js');
const { uuid } = require('./helpers/unified-fixtures.js');

class FakeTFile {
  constructor(vault, path) {
    this.vault = vault;
    this.path = path;
    this.stale = false;
  }
}

class FakeVault {
  constructor() {
    this.entries = new Map();
    this.beforeProcess = null;
    this.afterProcess = null;
    this.readShouldThrow = false;
  }

  add(path, content) {
    this.entries.set(path, { content, file: new FakeTFile(this, path) });
  }

  assertFile(file) {
    if (!(file instanceof FakeTFile) || file.vault !== this || file.stale || !this.entries.has(file.path)) {
      throw Object.assign(new Error('stale or foreign TFile'), { code: 'E_FILE_STALE' });
    }
    return this.entries.get(file.path);
  }

  resolveByTopicId(topicId) {
    const matches = [];
    for (const [path, entry] of this.entries) {
      let mfId = null;
      try {
        const parsed = parseBlock(entry.content);
        const raw = parsed.keys.get('mf_id');
        mfId = raw ? raw.rawValue.trim().replace(/^['"]|['"]$/g, '') : null;
      } catch (error) {
        const fallback = entry.content.match(/^['"]?mf_id['"]?\s*:\s*(\S+)$/m);
        mfId = fallback ? fallback[1].replace(/^['"]|['"]$/g, '') : null;
      }
      if (typeof mfId === 'string' && mfId.toLowerCase() === topicId.toLowerCase()) matches.push(path);
    }
    if (matches.length > 1) throw Object.assign(new Error('duplicate ids'), { code: 'E_DUPLICATE_TOPIC_ID' });
    if (matches.length === 0) return null;
    return this.entries.get(matches[0]).file;
  }

  async read(file) {
    const entry = this.assertFile(file);
    if (this.readShouldThrow) throw Object.assign(new Error('read failed'), { code: 'E_STORAGE_READ_FAILED' });
    return entry.content;
  }

  async process(file, fn) {
    const entry = this.assertFile(file);
    if (typeof this.beforeProcess === 'function') await this.beforeProcess(file, this);
    const latest = this.entries.get(file.path).content;
    const next = fn(latest);
    this.entries.set(file.path, { ...this.entries.get(file.path), content: next });
    if (typeof this.afterProcess === 'function') await this.afterProcess(file, this);
    return next;
  }

  rename(oldPath, newPath) {
    const entry = this.entries.get(oldPath);
    entry.file.stale = true;
    this.entries.delete(oldPath);
    this.entries.set(newPath, { content: entry.content, file: new FakeTFile(this, newPath) });
  }
}

function bodyWith(overrides = {}, { bom = false, crlf = false, extra = [] } = {}) {
  const newline = crlf ? '\r\n' : '\n';
  const fields = {
    type: 'source',
    status: 'active',
    priority: 50,
    interval: 8,
    a_factor: 2.0,
    review_count: 3,
    next_review: '20-11-2026',
    mf_id: uuid(1),
    mf_revision: 1,
    mf_scheduler_version: 1,
    mf_not_before: null,
    custom: '"00123"',
    note: "'a: b # c'",
    ...overrides,
  };
  const lines = ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '# keep this comment', ...extra, '---', 'Body line', 'second'];
  return `${bom ? '\uFEFF' : ''}${lines.join(newline)}${newline}`;
}

function setup(content, options = {}) {
  const vault = new FakeVault();
  vault.add('Sources/A.md', content);
  const adapter = createObsidianProcessAdapter({
    vault,
    dateFormat: 'DD-MM-YYYY',
    resolveFile: topicId => vault.resolveByTopicId(topicId),
    ...options,
  });
  return { vault, adapter };
}

function replaceLines(content, replacements) {
  let next = content;
  for (const [key, value] of Object.entries(replacements)) {
    next = next.replace(new RegExp(`^(${key}:\\s*).*$`, 'm'), `$1${value}`);
  }
  return next;
}

test('a CAS edits only the requested lines and preserves every other byte', async () => {
  const original = bodyWith();
  const { vault, adapter } = setup(original);
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original),
    expectedRevision: 1,
    updates: { mf_not_before: '2026-11-27', next_review: '27-11-2026' },
  });
  assert.equal(result.ok, true);
  const after = await vault.read(vault.resolveByTopicId(uuid(1)));
  assert.equal(after, replaceLines(original, {
    mf_not_before: '2026-11-27',
    next_review: '27-11-2026',
    mf_revision: '2',
  }));
  assert.match(after, /custom: "00123"/);
  assert.match(after, /note: 'a: b # c'/);
  assert.match(after, /# keep this comment/);
  assert.match(after, /Body line\nsecond/);
});

test('CRLF, BOM, quotes and comments survive an edit', async () => {
  const original = bodyWith({}, { bom: true, crlf: true });
  const { vault, adapter } = setup(original);
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original),
    expectedRevision: 1,
    updates: { mf_not_before: '2026-11-27' },
  });
  assert.equal(result.ok, true);
  const after = await vault.read(vault.resolveByTopicId(uuid(1)));
  assert.equal(after.startsWith('\uFEFF---\r\n'), true);
  assert.equal(after.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(after, replaceLines(original, { mf_not_before: '2026-11-27', mf_revision: '2' }));
});

test('a quoted key keeps its original spelling', async () => {
  const original = bodyWith({}, { extra: ["'priority': 50"] }).replace('priority: 50\n', '');
  const { vault, adapter } = setup(original);
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original),
    expectedRevision: 1,
    updates: { priority: 10 },
  });
  assert.equal(result.ok, true);
  const after = await vault.read(vault.resolveByTopicId(uuid(1)));
  assert.match(after, /'priority': 10/);
  assert.match(after, /custom: "00123"/);
});

test('duplicate semantic keys and unsupported YAML are refused with zero writes', async () => {
  const cases = [
    bodyWith({}, { extra: ["'mf_not_before': null"] }),
    bodyWith({}, { extra: ['nested:', '  child: x'] }),
    bodyWith({}, { extra: ['{a: 1}'] }),
    bodyWith({ mf_not_before: 'null # inline' }),
  ];
  for (const original of cases) {
    const { vault, adapter } = setup(original);
    const result = await adapter.compareAndSwap(uuid(1), {
      expectedHash: sha256Hex(original),
      expectedRevision: 1,
      updates: { mf_not_before: '2026-11-27' },
    });
    assert.equal(result.ok, false);
    assert.ok(['E_FRONTMATTER_DUPLICATE_KEY', 'E_FRONTMATTER_UNSUPPORTED_STRUCTURE'].includes(result.code), result.code);
    assert.equal(await vault.read(vault.resolveByTopicId(uuid(1))), original);
  }
});

test('only whitelisted existing fields can be updated', async () => {
  const original = bodyWith();
  const { vault, adapter } = setup(original);
  for (const [updates, code] of [
    [{ mf_id: uuid(2) }, 'E_FIELD_FORBIDDEN'],
    [{ mf_parent_id: uuid(2) }, 'E_FIELD_FORBIDDEN'],
    [{ unknown_key: 'x' }, 'E_FIELD_NOT_WRITABLE'],
    [{ mf_interval_days: 9 }, 'E_FIELD_MISSING'],
  ]) {
    const result = await adapter.compareAndSwap(uuid(1), {
      expectedHash: sha256Hex(original), expectedRevision: 1, updates,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
  assert.equal(await vault.read(vault.resolveByTopicId(uuid(1))), original);
});

test('hash, revision, identity and version preconditions are mandatory', async () => {
  const original = bodyWith();
  const hash = sha256Hex(original);
  const cases = [
    [{ expectedRevision: 1, updates: { priority: 10 } }, 'E_HASH_REQUIRED'],
    [{ expectedHash: 'xyz', expectedRevision: 1, updates: { priority: 10 } }, 'E_HASH_REQUIRED'],
    [{ expectedHash: hash, updates: { priority: 10 } }, 'E_REVISION_REQUIRED'],
    [{ expectedHash: '0'.repeat(64), expectedRevision: 1, updates: { priority: 10 } }, 'E_SNAPSHOT_MISMATCH'],
    [{ expectedHash: hash, expectedRevision: 9, updates: { priority: 10 } }, 'E_REVISION_MISMATCH'],
  ];
  for (const [args, code] of cases) {
    const { adapter } = setup(original);
    const result = await adapter.compareAndSwap(uuid(1), args);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }

  for (const [overrides, code] of [
    [{ mf_id: 'nope' }, 'E_ID_NOT_PERSISTED'],
    [{ mf_scheduler_version: 2 }, 'E_VERSION_NOT_PERSISTED'],
    [{ type: 'card' }, 'E_TOPIC_TYPE'],
    [{ status: 'done' }, 'E_TOPIC_NOT_ACTIVE'],
  ]) {
    const invalid = bodyWith(overrides);
    const vault = new FakeVault();
    vault.add('Sources/A.md', invalid);
    // A trusted metadata index may still resolve the file even when the stored
    // id is invalid; the callback validation must catch it.
    const adapter = createObsidianProcessAdapter({
      vault,
      dateFormat: 'DD-MM-YYYY',
      resolveFile: () => vault.entries.get('Sources/A.md').file,
    });
    const result = await adapter.compareAndSwap(uuid(1), {
      expectedHash: sha256Hex(invalid), expectedRevision: 1, updates: { priority: 10 },
    });
    assert.equal(result.code, code, code);
  }
});

test('wrong or duplicate identities are refused', async () => {
  const wrong = bodyWith({ mf_id: uuid(2) });
  const { adapter: wrongAdapter } = setup(wrong);
  const wrongResult = await wrongAdapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(wrong), expectedRevision: 1, updates: { priority: 10 },
  });
  assert.equal(wrongResult.code, 'E_TOPIC_NOT_FOUND');

  const vault = new FakeVault();
  const first = bodyWith();
  const second = bodyWith({}, { extra: [] }).replace(uuid(1), uuid(1).toUpperCase());
  vault.add('Sources/A.md', first);
  vault.add('Sources/B.md', second);
  const adapter = createObsidianProcessAdapter({
    vault, dateFormat: 'DD-MM-YYYY', resolveFile: id => vault.resolveByTopicId(id),
  });
  const duplicate = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(first), expectedRevision: 1, updates: { priority: 10 },
  });
  assert.equal(duplicate.code, 'E_DUPLICATE_TOPIC_ID');
});

test('a rename keeps identity and stale TFile objects are rejected', async () => {
  const original = bodyWith();
  const { vault, adapter } = setup(original);
  const oldFile = vault.resolveByTopicId(uuid(1));
  vault.rename('Sources/A.md', 'Sources/Renamed.md');
  await assert.rejects(() => vault.read(oldFile), error => error.code === 'E_FILE_STALE');
  const renamed = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original), expectedRevision: 1, updates: { priority: 10 },
  });
  assert.equal(renamed.ok, true);
  assert.equal(vault.resolveByTopicId(uuid(1)).path, 'Sources/Renamed.md');
});

test('an external edit inside the process window is a snapshot conflict', async () => {
  const original = bodyWith();
  const { vault, adapter } = setup(original);
  vault.beforeProcess = (file, v) => { v.entries.get(file.path).content = `${original}\nexternal`; };
  const result = await adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original), expectedRevision: 1, updates: { priority: 10 },
  });
  assert.equal(result.code, 'E_SNAPSHOT_MISMATCH');
  assert.match(await vault.read(vault.resolveByTopicId(uuid(1))), /external/);
});

test('read-back mismatch or failure is uncertain, never success', async () => {
  const original = bodyWith();
  const mismatch = setup(original);
  const expectedAfter = replaceLines(original, { mf_revision: '2' });
  mismatch.vault.afterProcess = (file, v) => { v.entries.get(file.path).content = `${expectedAfter}\ncli edit`; };
  const first = await mismatch.adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original), expectedRevision: 1, updates: {},
  });
  assert.equal(first.code, 'E_WRITE_UNVERIFIED');

  const failure = setup(original);
  failure.vault.readShouldThrow = true;
  const second = await failure.adapter.compareAndSwap(uuid(1), {
    expectedHash: sha256Hex(original), expectedRevision: 1, updates: {},
  });
  assert.equal(second.code, 'E_WRITE_UNCERTAIN');
});

test('only factory-created adapters are trusted; unsupported formats are refused', () => {
  const { adapter } = setup(bodyWith());
  assert.equal(assertTrustedProcessAdapter(adapter), adapter);
  assert.throws(() => assertTrustedProcessAdapter({
    kind: 'obsidian-process-adapter', supportsAtomicCas: true, compareAndSwap: async () => ({ ok: true }),
  }), error => error.code === 'E_STORAGE_UNTRUSTED');
  assert.throws(() => createObsidianProcessAdapter({
    vault: new FakeVault(), resolveFile: () => null, dateFormat: 'DD.MM.YYYY',
  }), error => error.code === 'E_DATE_FORMAT_UNSUPPORTED');
});
