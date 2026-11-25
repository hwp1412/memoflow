'use strict';

// Obsidian storage adapter using Vault.process(TFile, fn) with byte-preserving
// frontmatter edits. Source-only: no test touches a real vault, and the host
// facade never authorizes Unified writes.
//
// Guarantees:
//   * all checks run inside the process callback against the latest bytes;
//   * only whitelisted scheduling keys are edited, existing lines only;
//   * every other byte (unknown fields, quotes, comments, body, newlines, BOM)
//     is preserved verbatim;
//   * unsupported YAML structures are refused with zero writes.

const { fail } = require('../scheduling/errors.js');
const { sha256Hex } = require('../scheduling/migration-hash.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');

const TRUSTED_PROCESS_ADAPTERS = new WeakSet();
const DATE_FORMATS = Object.freeze(['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);
const HASH_RE = /^[0-9a-f]{64}$/i;
const KEY_RE = /^((?:['"])([A-Za-z0-9_-]+)(?:['"])\s*:|([A-Za-z0-9_-]+)\s*:)/;

const WRITABLE_FIELDS = new Set([
  'mf_revision', 'mf_last_event_id', 'mf_scheduler_version', 'mf_interval_days',
  'mf_ideal_due', 'mf_not_before', 'priority', 'a_factor', 'review_count',
  'last_reviewed', 'status', 'next_review',
]);
const FORBIDDEN_FIELDS = new Set(['mf_id', 'mf_parent_id', 'mf_root_id', 'type']);

function parseBlock(text) {
  let bom = '';
  let data = text;
  if (data.charCodeAt(0) === 0xfeff) {
    bom = '\uFEFF';
    data = data.slice(1);
  }
  const newline = data.includes('\r\n') ? '\r\n' : '\n';
  const lines = data.split(newline);
  if (lines[0] !== '---') fail('E_FRONTMATTER_MISSING', 'missing frontmatter opener');
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') { end = index; break; }
  }
  if (end < 0) fail('E_FRONTMATTER_UNCLOSED', 'frontmatter is not closed');

  const keys = new Map();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) fail('E_FRONTMATTER_UNSUPPORTED_STRUCTURE', 'indented/nested YAML is not editable');
    const match = line.match(KEY_RE);
    if (!match) fail('E_FRONTMATTER_UNSUPPORTED_STRUCTURE', `unsupported frontmatter line: ${line.slice(0, 40)}`);
    const key = match[2] || match[3];
    if (keys.has(key)) fail('E_FRONTMATTER_DUPLICATE_KEY', `duplicate frontmatter key: ${key}`);
    const prefix = match[0];
    const rawValue = line.slice(prefix.length);
    keys.set(key, { index, prefix, rawValue, line });
  }
  return { bom, newline, lines, end, keys };
}

function readScalar(parsed, key) {
  const info = parsed.keys.get(key);
  if (!info) return undefined;
  const value = info.rawValue.trim();
  if (value === 'null') return null;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  return value;
}

function serialize(value) {
  if (value === null) return 'null';
  return String(value);
}

function applyEdits(text, updates) {
  const parsed = parseBlock(text);
  const touched = new Map();
  for (const [key, value] of Object.entries(updates)) {
    if (FORBIDDEN_FIELDS.has(key)) fail('E_FIELD_FORBIDDEN', `field ${key} is not editable`);
    if (!WRITABLE_FIELDS.has(key)) fail('E_FIELD_NOT_WRITABLE', `field ${key} is not a scheduling field`);
    const info = parsed.keys.get(key);
    if (!info) fail('E_FIELD_MISSING', `field ${key} is not present; this adapter updates only existing fields`);
    if (/\s#/.test(info.rawValue)) fail('E_FRONTMATTER_UNSUPPORTED_STRUCTURE', 'inline comments on edited fields are refused');
    touched.set(info.index, `${info.prefix} ${serialize(value)}`);
  }
  const lines = parsed.lines.map((line, index) => (touched.has(index) ? touched.get(index) : line));
  return parsed.bom + lines.join(parsed.newline);
}

function createObsidianProcessAdapter({ vault, resolveFile, dateFormat, verifyAfter = true }) {
  if (!vault || typeof vault.process !== 'function' || typeof vault.read !== 'function') {
    fail('E_STORAGE_INVALID', 'Vault.process/read are required');
  }
  if (!DATE_FORMATS.includes(dateFormat)) fail('E_DATE_FORMAT_UNSUPPORTED', 'unsupported date format', { dateFormat });
  if (typeof resolveFile !== 'function') fail('E_STORAGE_INVALID', 'a trusted TFile resolver is required');

  const adapter = {
    kind: 'obsidian-process-adapter',
    supportsAtomicCas: true,
    dateFormat,

    async compareAndSwap(topicId, { expectedHash, expectedRevision, updates } = {}) {
      if (!isPersistentUuid(topicId)) return { ok: false, code: 'E_TOPIC_ID_INVALID' };
      if (typeof expectedHash !== 'string' || !HASH_RE.test(expectedHash)) return { ok: false, code: 'E_HASH_REQUIRED' };
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return { ok: false, code: 'E_REVISION_REQUIRED' };
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { ok: false, code: 'E_UPDATES_REQUIRED' };
      for (const key of Object.keys(updates)) {
        if (FORBIDDEN_FIELDS.has(key)) return { ok: false, code: 'E_FIELD_FORBIDDEN' };
        if (!WRITABLE_FIELDS.has(key)) return { ok: false, code: 'E_FIELD_NOT_WRITABLE' };
      }

      let file;
      try {
        file = resolveFile(topicId);
      } catch (error) {
        return { ok: false, code: error && error.code ? error.code : 'E_TOPIC_NOT_FOUND' };
      }
      if (!file || typeof file.path !== 'string') return { ok: false, code: 'E_TOPIC_NOT_FOUND' };

      let outcome;
      try {
        await vault.process(file, data => {
          // Everything below runs inside the atomic callback on latest bytes.
          if (sha256Hex(data) !== expectedHash) throw Object.assign(new Error('snapshot mismatch'), { code: 'E_SNAPSHOT_MISMATCH' });
          const parsed = parseBlock(data);
          const mfId = readScalar(parsed, 'mf_id');
          if (!isPersistentUuid(mfId)) throw Object.assign(new Error('missing id'), { code: 'E_ID_NOT_PERSISTED' });
          if (String(mfId).toLowerCase() !== topicId.toLowerCase()) throw Object.assign(new Error('wrong id'), { code: 'E_TOPIC_ID_MISMATCH' });
          const revision = readScalar(parsed, 'mf_revision');
          if (!/^\d+$/.test(String(revision))) throw Object.assign(new Error('missing revision'), { code: 'E_REVISION_NOT_PERSISTED' });
          if (Number(revision) !== expectedRevision) throw Object.assign(new Error('revision mismatch'), { code: 'E_REVISION_MISMATCH' });
          if (readScalar(parsed, 'mf_scheduler_version') !== '1') throw Object.assign(new Error('version'), { code: 'E_VERSION_NOT_PERSISTED' });
          const type = readScalar(parsed, 'type');
          if (type !== 'source' && type !== 'extract') throw Object.assign(new Error('type'), { code: 'E_TOPIC_TYPE' });
          if (readScalar(parsed, 'status') !== 'active') throw Object.assign(new Error('status'), { code: 'E_TOPIC_NOT_ACTIVE' });

          const next = applyEdits(data, { ...updates, mf_revision: expectedRevision + 1 });
          outcome = { beforeHash: sha256Hex(data), afterHash: sha256Hex(next) };
          return next;
        });
      } catch (error) {
        const code = error && error.code ? error.code : 'E_WRITE_UNCERTAIN';
        if (code === 'E_WRITE_UNCERTAIN') return { ok: false, code: 'E_WRITE_UNCERTAIN' };
        return { ok: false, code };
      }

      if (verifyAfter) {
        try {
          const data = await vault.read(file);
          if (typeof data !== 'string' || sha256Hex(data) !== outcome.afterHash) {
            return { ok: false, code: 'E_WRITE_UNVERIFIED', afterHash: outcome.afterHash };
          }
        } catch (error) {
          return { ok: false, code: 'E_WRITE_UNCERTAIN', afterHash: outcome.afterHash };
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
  WRITABLE_FIELDS,
  FORBIDDEN_FIELDS,
  createObsidianProcessAdapter,
  assertTrustedProcessAdapter,
  parseBlock,
  applyEdits,
};
