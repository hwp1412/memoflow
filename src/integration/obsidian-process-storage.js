'use strict';

// Production-shaped Obsidian storage adapter using Vault.process(), the API
// documented as an atomic read-modify-write on a single file. All checks run
// INSIDE the process callback against the latest bytes; a pre-read outside the
// callback is never treated as CAS. This file is source-only: no test touches a
// real vault, and the host service never authorizes Unified writes.

const { fail } = require('../scheduling/errors.js');
const { sha256Hex } = require('../scheduling/migration-hash.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');

const TRUSTED_PROCESS_ADAPTERS = new WeakSet();
const DATE_FORMATS = Object.freeze(['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);

function parseFrontmatter(data) {
  const match = data.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) fail('E_FRONTMATTER_MISSING', 'missing frontmatter');
  const frontmatter = {};
  const seen = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) fail('E_FRONTMATTER_UNSUPPORTED_STRUCTURE', 'unsupported frontmatter structure; refusing to rewrite');
    if (seen.has(m[1])) fail('E_FRONTMATTER_DUPLICATE_KEY', 'duplicate frontmatter key');
    seen.add(m[1]);
    const raw = m[2].trim();
    if (raw === 'null') frontmatter[m[1]] = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) frontmatter[m[1]] = Number(raw);
    else frontmatter[m[1]] = raw.replace(/^['"]|['"]$/g, '');
  }
  return { frontmatter, body: data.slice(match[0].length), prefix: match[0] };
}

function render(frontmatter, body) {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value === null ? 'null' : value}`);
  return ['---', ...lines, '---', body].join('\n');
}

function createObsidianProcessAdapter({ vault, pathForTopicId, dateFormat, verifyAfter = true }) {
  if (!vault || typeof vault.process !== 'function') fail('E_STORAGE_INVALID', 'Vault.process is required');
  if (!DATE_FORMATS.includes(dateFormat)) fail('E_DATE_FORMAT_UNSUPPORTED', 'unsupported date format', { dateFormat });
  if (typeof pathForTopicId !== 'function') fail('E_STORAGE_INVALID', 'a stable-id path resolver is required');

  const adapter = {
    kind: 'obsidian-process-adapter',
    supportsAtomicCas: true,
    dateFormat,

    async compareAndSwap(topicId, { expectedHash, expectedRevision, mutate }) {
      const path = pathForTopicId(topicId);
      if (!path) return { ok: false, code: 'E_TOPIC_NOT_FOUND' };
      let outcome;
      try {
        await vault.process(path, data => {
          // Everything below runs inside the atomic callback, on latest bytes.
          const hash = sha256Hex(data);
          if (expectedHash && hash !== expectedHash) throw Object.assign(new Error('snapshot mismatch'), { code: 'E_SNAPSHOT_MISMATCH' });
          const parsed = parseFrontmatter(data);
          if (!isPersistentUuid(parsed.frontmatter.mf_id)) throw Object.assign(new Error('missing id'), { code: 'E_ID_NOT_PERSISTED' });
          if (parsed.frontmatter.mf_id !== topicId) throw Object.assign(new Error('wrong id'), { code: 'E_TOPIC_ID_MISMATCH' });
          if (expectedRevision != null && parsed.frontmatter.mf_revision !== expectedRevision) {
            throw Object.assign(new Error('revision mismatch'), { code: 'E_REVISION_MISMATCH' });
          }
          const nextFrontmatter = { ...parsed.frontmatter };
          mutate(nextFrontmatter);
          nextFrontmatter.mf_revision = expectedRevision + 1;
          const next = render(nextFrontmatter, parsed.body);
          outcome = { beforeHash: hash, afterHash: sha256Hex(next), nextFrontmatter };
          return next;
        });
      } catch (error) {
        return { ok: false, code: error.code || 'E_WRITE_FAILED' };
      }
      if (verifyAfter && outcome) {
        try {
          if (typeof vault.read === 'function') {
            const data = await vault.read(path);
            if (typeof data === 'string' && sha256Hex(data) !== outcome.afterHash) {
              return { ok: false, code: 'E_WRITE_UNVERIFIED', afterHash: outcome.afterHash };
            }
          }
        } catch (error) {
          return { ok: false, code: 'E_WRITE_UNVERIFIED', afterHash: outcome.afterHash };
        }
      }
      return { ok: true, ...outcome };
    },
  };
  TRUSTED_PROCESS_ADAPTERS.add(adapter);
  return adapter;
}

function assertTrustedProcessAdapter(adapter) {
  if (!adapter || !TRUSTED_PROCESS_ADAPTERS.has(adapter)) {
    fail('E_STORAGE_UNTRUSTED', 'only a factory-created Obsidian process adapter is trusted');
  }
  return adapter;
}

module.exports = {
  DATE_FORMATS,
  createObsidianProcessAdapter,
  assertTrustedProcessAdapter,
  parseFrontmatter,
};
