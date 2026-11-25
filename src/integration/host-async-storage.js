'use strict';

// Async production topic storage for the Unified host chain (HOST-RUNTIME-01).
//
// The accepted PR-09 writer is synchronous and only accepts the synthetic
// in-memory store, because a sync CAS cannot honestly represent an async Vault.
// This adapter is the async counterpart:
//
//   * reads go through Vault.read (a real Promise is awaited, never a cached
//     snapshot pretending the write finished);
//   * writes go through Vault.process (byte-preserving, whitelisted fields plus
//     hash + revision re-checks *inside* the callback) — the same adapter that
//     PR-10B reviewed, not a second YAML serializer;
//   * the post-write hash is the hash of real Markdown bytes, never the hash of
//     a synthetic frontmatter rendering.
//
// Obsidian offers no cross-file transaction and no cross-process CAS; that
// limit is documented rather than simulated.

const { fail } = require('../scheduling/errors.js');
const { sha256Hex } = require('../scheduling/migration-hash.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');
const {
  parseBlock,
  readScalar,
  createObsidianProcessAdapter,
  assertTrustedProcessAdapter,
} = require('./obsidian-process-storage.js');

const TRUSTED_ASYNC_STORAGES = new WeakSet();

const NUMERIC_KEYS = new Set([
  'priority',
  'a_factor',
  'review_count',
  'mf_revision',
  'mf_scheduler_version',
  'mf_interval_days',
  'read_point',
  'total_pages',
  'total_seconds',
  'read_point_seconds',
]);
const NULLABLE_KEYS = new Set(['mf_not_before', 'last_reviewed', 'mf_last_event_id', 'mf_parent_id', 'mf_root_id', 'next_review']);

function coerceValue(key, raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (NULLABLE_KEYS.has(key) && String(raw).trim() === '') return null;
  if (NUMERIC_KEYS.has(key)) {
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  return raw;
}

function frontmatterFromContent(content, { allowNestedBlocks = true } = {}) {
  const parsed = parseBlock(content, { allowNestedBlocks });
  const frontmatter = {};
  for (const [key] of parsed.keys) {
    frontmatter[key] = coerceValue(key, readScalar(parsed, key));
  }
  return { parsed, frontmatter };
}

function bodyFromContent(content, { allowNestedBlocks = true } = {}) {
  const parsed = parseBlock(content, { allowNestedBlocks });
  return parsed.lines.slice(parsed.end + 1).join(parsed.newline);
}

// Locates the single TFile whose persisted mf_id matches. Duplicate identities
// are refused: picking one silently could schedule the wrong note.
//
// MetadataCache is only an index. A freshly created note may not be in it yet,
// and cached data can be stale, so the resolver keeps an explicitly remembered
// mapping for paths discovered by a direct read. Correctness never depends on
// that hint: the write adapter re-checks mf_id inside Vault.process on the
// latest bytes, so a stale hint fails closed instead of writing the wrong note.
function createVaultTopicResolver({ app } = {}) {
  if (!app || !app.vault || typeof app.vault.getMarkdownFiles !== 'function') {
    fail('E_STORAGE_INVALID', 'an app with vault.getMarkdownFiles() is required');
  }
  const remembered = new Map();

  function resolveTopicFile(topicId) {
    if (!isPersistentUuid(topicId)) fail('E_TOPIC_ID_INVALID', 'topicId must be a persistent UUID');
    const wanted = String(topicId).toLowerCase();
    if (remembered.has(wanted)) return remembered.get(wanted);
    const matches = [];
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache && typeof app.metadataCache.getFileCache === 'function'
        ? app.metadataCache.getFileCache(file)
        : null;
      const frontmatter = cache && cache.frontmatter;
      if (frontmatter && typeof frontmatter.mf_id === 'string' && frontmatter.mf_id.toLowerCase() === wanted) {
        matches.push(file);
      }
    }
    if (matches.length === 0) fail('E_TOPIC_NOT_FOUND', 'no note carries this mf_id', { topicId });
    if (matches.length > 1) {
      fail('E_DUPLICATE_TOPIC_ID', 'more than one note carries this mf_id', {
        topicId,
        paths: matches.map(file => file.path),
      });
    }
    return matches[0];
  }

  resolveTopicFile.remember = (topicId, file) => {
    if (file && typeof file.path === 'string') remembered.set(String(topicId).toLowerCase(), file);
  };
  resolveTopicFile.forget = (topicId) => { remembered.delete(String(topicId).toLowerCase()); };
  return resolveTopicFile;
}

const MAX_SCAN_FILES = 500;
const MF_ID_LINE = /^mf_id:\s*([0-9a-fA-F-]{36})\s*$/m;

// Direct-read fallback for a stale/missing MetadataCache entry. Bounded so a
// large vault cannot turn one event into an unbounded scan; on give-up the
// caller fails closed with E_TOPIC_NOT_FOUND.
async function scanVaultForTopic(app, topicId) {
  const wanted = String(topicId).toLowerCase();
  const files = app.vault.getMarkdownFiles().slice(0, MAX_SCAN_FILES);
  const matches = [];
  for (const file of files) {
    let content;
    try {
      content = await app.vault.read(file);
    } catch (error) {
      continue;
    }
    const match = MF_ID_LINE.exec(String(content));
    if (match && match[1].toLowerCase() === wanted) matches.push(file);
  }
  return matches;
}

function createObsidianAsyncTopicStorage({ app, resolveFile, dateFormat, verifyAfter = true } = {}) {
  if (!app || !app.vault || typeof app.vault.read !== 'function' || typeof app.vault.process !== 'function') {
    fail('E_STORAGE_INVALID', 'Vault.read/process are required');
  }
  const adapter = createObsidianProcessAdapter({
    vault: app.vault, resolveFile, dateFormat, verifyAfter, allowNestedBlocks: true,
  });
  assertTrustedProcessAdapter(adapter);

  const storage = {
    kind: 'obsidian-async-topic-storage',
    supportsAtomicCas: true,
    // Nested blocks are preserved but never edited; the executor must predict
    // bytes with the same tolerant parser the commit uses.
    allowNestedBlocks: true,
    dateFormat,

    async readTopic(topicId) {
      if (!isPersistentUuid(topicId)) return { entry: null, duplicates: [], code: 'E_TOPIC_ID_INVALID' };
      let file;
      try {
        file = resolveFile(topicId);
      } catch (error) {
        const code = error && error.code ? error.code : 'E_TOPIC_NOT_FOUND';
        if (code !== 'E_TOPIC_NOT_FOUND') {
          return { entry: null, duplicates: error && error.details && error.details.paths ? error.details.paths : [], code };
        }
        // Cache miss: a note may exist but not be indexed yet (fresh creation).
        const scanned = await scanVaultForTopic(app, topicId);
        if (scanned.length > 1) {
          return { entry: null, duplicates: scanned.map(item => item.path), code: 'E_DUPLICATE_TOPIC_ID' };
        }
        if (scanned.length === 0) return { entry: null, duplicates: [], code: 'E_TOPIC_NOT_FOUND' };
        file = scanned[0];
        if (typeof resolveFile.remember === 'function') resolveFile.remember(topicId, file);
      }
      let content;
      try {
        content = await app.vault.read(file);
      } catch (error) {
        // The hint may point at a moved/deleted file: drop it and fail closed.
        if (typeof resolveFile.forget === 'function') resolveFile.forget(topicId);
        return { entry: null, duplicates: [], code: 'E_TOPIC_NOT_FOUND' };
      }
      if (typeof content !== 'string') fail('E_STORAGE_READ_INVALID', 'Vault.read must return text');
      const { frontmatter } = frontmatterFromContent(content);
      const revision = Number.isInteger(frontmatter.mf_revision) ? frontmatter.mf_revision : null;
      return {
        entry: {
          path: file.path,
          file,
          content,
          hash: sha256Hex(content),
          frontmatter,
          body: bodyFromContent(content),
          revision,
          mfId: frontmatter.mf_id || null,
        },
        duplicates: [],
      };
    },

    async compareAndSwap(topicId, options) {
      return adapter.compareAndSwap(topicId, options);
    },
  };
  TRUSTED_ASYNC_STORAGES.add(storage);
  return storage;
}

function assertTrustedAsyncTopicStorage(storage) {
  if (!storage || !TRUSTED_ASYNC_STORAGES.has(storage)) {
    fail('E_STORAGE_UNTRUSTED', 'only a factory-created async Obsidian topic storage is trusted');
  }
  return storage;
}

module.exports = {
  createVaultTopicResolver,
  createObsidianAsyncTopicStorage,
  assertTrustedAsyncTopicStorage,
  frontmatterFromContent,
  bodyFromContent,
};
