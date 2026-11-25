'use strict';

// Host orchestration for Source/Extract creation (MF-US-1 INIT-05 host wiring).
//
// Creation is NOT an MF-US-1 event (SPEC A8 EVENT_TYPES has no CREATE); it is
// field initialization per A3.3/A3.4. Therefore it has no ledger intent and no
// cross-file transaction. This module keeps the three separable outcomes
// explicit instead of pretending they are atomic:
//
//   1. file creation
//   2. written-field verification (read-back)
//   3. (absent by design) ledger registration — reports `ledgerRecorded:false`
//
// Idempotency is derived, not stored: the stable UUID is a pure function of the
// caller's requestId, and a retry is recognised by reading the existing file's
// `mf_id`. A retry can therefore never produce a second Topic, but a crash
// between file creation and read-back can only be discovered by inspection.
//
// Authorization: the production runtime never holds a creation token. Only a
// WeakSet-issued synthetic token unlocks the write path, mirroring the
// synthetic host-runtime authorization used by the closed Unified executor.

const { createTopic } = require('./topic-creation.js');
const { fail } = require('../scheduling/errors.js');

const SYNTHETIC_CREATION_AUTHORIZATIONS = new WeakSet();

const CANONICAL_KEYS = Object.freeze([
  'priority',
  'next_review',
  'interval',
  'a_factor',
  'review_count',
  'last_reviewed',
  'mf_id',
  'mf_parent_id',
  'mf_root_id',
  'mf_ideal_due',
  'mf_not_before',
  'mf_interval_days',
  'mf_last_event_id',
  'mf_revision',
  'mf_scheduler_version',
]);

function issueSyntheticCreationAuthorization() {
  const token = Object.freeze({ kind: 'synthetic-topic-creation-authorization' });
  SYNTHETIC_CREATION_AUTHORIZATIONS.add(token);
  return token;
}

function hasSyntheticCreationAuthorization(token) {
  return Boolean(token && typeof token === 'object' && SYNTHETIC_CREATION_AUTHORIZATIONS.has(token));
}

function assertPlainRequest(request, field) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('E_CREATION_REQUEST', `${field} must be a plain object`);
  }
}

// `createTopic` requires a caller-supplied mfId; creation-host derives it from
// the requestId so a retry is deterministic. Kept separate so the pure module
// stays free of identity allocation.
function planTopicCreation({ requestId, kind, priority, parentId = null, rootId = null, today, config = undefined } = {}) {
  if (typeof requestId !== 'string' || !requestId) {
    fail('E_REQUEST_ID_REQUIRED', 'a stable creation requestId is required for idempotent retries');
  }
  if (typeof today !== 'string' || !today) {
    fail('E_TODAY_REQUIRED', 'today must be provided explicitly; the creation path never reads the system clock');
  }
  const { allocateStableUuid } = require('./topic-creation.js');
  const mfId = allocateStableUuid(requestId);
  const created = createTopic({
    kind,
    priority,
    mfId,
    parentId,
    rootId,
    today,
    config,
  });
  return { requestId, kind, mfId, topic: created.topic, diff: created.diff };
}

function creationFieldLines(topic) {
  if (!topic || typeof topic !== 'object') fail('E_TOPIC_REQUIRED', 'a planned topic is required');
  const parentId = topic.mf_parent_id == null ? null : topic.mf_parent_id;
  const rootId = topic.mf_root_id == null ? null : topic.mf_root_id;
  return [
    `mf_id: ${topic.mf_id}`,
    `mf_parent_id: ${parentId === null ? 'null' : parentId}`,
    `mf_root_id: ${rootId === null ? 'null' : rootId}`,
    `mf_ideal_due: ${topic.mf_ideal_due}`,
    `mf_not_before: ${topic.mf_not_before == null ? 'null' : topic.mf_not_before}`,
    `mf_interval_days: ${topic.mf_interval_days}`,
    `mf_last_event_id: ${topic.mf_last_event_id == null ? 'null' : topic.mf_last_event_id}`,
    `mf_revision: ${topic.mf_revision}`,
    `mf_scheduler_version: ${topic.mf_scheduler_version}`,
  ];
}

function splitFrontmatter(content) {
  if (typeof content !== 'string') fail('E_CONTENT_REQUIRED', 'creation content must be a string');
  if (!content.startsWith('---\n')) {
    fail('E_CONTENT_FRONTMATTER', 'creation content must start with a LF frontmatter block');
  }
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) fail('E_CONTENT_FRONTMATTER', 'creation content must close the frontmatter block');
  const block = content.slice(4, end);
  const body = content.slice(end + '\n---\n'.length);
  if (block.includes('\r')) fail('E_CONTENT_FRONTMATTER', 'CRLF frontmatter is not produced by the creation builders');
  return { lines: block.split('\n'), body };
}

function isCanonicalLine(line) {
  const match = /^([A-Za-z0-9_]+):/.exec(line);
  return Boolean(match) && CANONICAL_KEYS.includes(match[1]);
}

function assertNoDuplicateCanonicalKeys(lines) {
  const seen = new Set();
  for (const line of lines) {
    const match = /^([A-Za-z0-9_]+):/.exec(line);
    if (!match) continue;
    if (!CANONICAL_KEYS.includes(match[1])) continue;
    if (seen.has(match[1])) {
      fail('E_FRONTMATTER_DUPLICATE_KEY', `creation content repeats the canonical key ${match[1]}`, { key: match[1] });
    }
    seen.add(match[1]);
  }
}

// Composes the exact file content for a Unified creation. Legacy lines keep
// their order and bytes; only the canonical scheduling keys are replaced by
// the topic's initialized values, appended in a fixed order so a read-back can
// verify them deterministically.
function resolveNextReview(nextReview, topic) {
  // A2.2: next_review = formatForVault(effective_due); for a fresh topic
  // effective_due === mf_ideal_due. The host owns the vault date format, so it
  // may pass a formatter; the value is always derived from the topic's date.
  const value = typeof nextReview === 'function' ? nextReview(topic.mf_ideal_due) : nextReview;
  if (typeof value !== 'string' || !value.trim() || value === 'undefined' || value === 'null') {
    fail('E_NEXT_REVIEW_REQUIRED', 'next_review must be supplied in vault date format derived from the effective due');
  }
  return value.trim();
}

function composeCreationContent({ content, topic, nextReview } = {}) {
  if (!topic || typeof topic !== 'object') fail('E_TOPIC_REQUIRED', 'a planned topic is required');
  const nextReviewValue = resolveNextReview(nextReview, topic);
  const { lines, body } = splitFrontmatter(content);
  assertNoDuplicateCanonicalKeys(lines);
  const preserved = lines.filter(line => line.length > 0 && !isCanonicalLine(line));
  const canonical = [
    `priority: ${topic.priority}`,
    `next_review: ${nextReviewValue}`,
    `interval: ${topic.mf_interval_days}`,
    `a_factor: ${topic.a_factor}`,
    `review_count: ${topic.review_count}`,
    'last_reviewed:',
    ...creationFieldLines(topic),
  ];
  return `---\n${preserved.concat(canonical).join('\n')}\n---\n${body}`;
}

function readFrontmatterKey(content, key) {
  if (typeof content !== 'string') return null;
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(content);
  if (!match) return null;
  const value = match[1].trim();
  return value === '' ? null : value;
}

async function executeTopicCreation({ plan, vault, path, content, authorization = null } = {}) {
  // Fail closed before any storage access: no token, no read, no write.
  if (!hasSyntheticCreationAuthorization(authorization)) {
    fail('E_CREATION_NOT_AUTHORIZED', 'real Unified topic creation is not authorized for the host runtime');
  }
  assertPlainRequest(plan, 'plan');
  if (!plan.topic || typeof plan.topic.mf_id !== 'string') fail('E_TOPIC_REQUIRED', 'plan.topic.mf_id is required');
  if (typeof path !== 'string' || !path) fail('E_PATH_REQUIRED', 'a target path is required');
  if (!vault || typeof vault.getAbstractFileByPath !== 'function' || typeof vault.create !== 'function') {
    fail('E_VAULT_REQUIRED', 'a vault with getAbstractFileByPath/create is required');
  }

  const outcome = {
    status: 'applied',
    route: 'unified',
    requestId: plan.requestId,
    mfId: plan.topic.mf_id,
    path,
    topic: plan.topic,
    fileCreated: false,
    verified: false,
    ledgerRecorded: false,
    writesPerformed: false,
    requiresManualRecovery: false,
    diagnostics: [],
  };

  const existing = vault.getAbstractFileByPath(path);
  if (existing) {
    let current = null;
    try {
      current = await vault.read(existing);
    } catch (error) {
      outcome.status = 'uncertain';
      outcome.writesPerformed = null;
      outcome.requiresManualRecovery = true;
      outcome.diagnostics.push({ code: 'E_EXISTING_UNREADABLE', message: error && error.message });
      return outcome;
    }
    const existingId = readFrontmatterKey(current, 'mf_id');
    if (existingId === plan.topic.mf_id) {
      outcome.status = 'duplicate';
      outcome.verified = true;
      outcome.diagnostics.push({ code: 'DUPLICATE_REQUEST', existingId });
      return outcome;
    }
    outcome.status = 'conflict';
    outcome.requiresManualRecovery = true;
    outcome.diagnostics.push({ code: existingId ? 'PATH_CONFLICT' : 'PATH_CONFLICT_UNMIGRATED', existingId });
    return outcome;
  }

  try {
    await vault.create(path, content);
    outcome.fileCreated = true;
    outcome.writesPerformed = true;
  } catch (error) {
    // The create call threw. Only report a definite no-write when the path is
    // provably still absent; otherwise the write may have landed.
    const after = vault.getAbstractFileByPath(path);
    if (after) {
      outcome.status = 'uncertain';
      outcome.fileCreated = true;
      outcome.writesPerformed = null;
      outcome.requiresManualRecovery = true;
      outcome.diagnostics.push({ code: 'E_CREATE_THREW_BUT_EXISTS', message: error && error.message });
    } else {
      outcome.status = 'failed';
      outcome.writesPerformed = false;
      outcome.diagnostics.push({ code: 'E_CREATE_FAILED', message: error && error.message });
    }
    return outcome;
  }

  // Read-back verification. A created file whose persisted identity cannot be
  // confirmed is reported as partial, never as a clean success.
  try {
    const written = await vault.read(vault.getAbstractFileByPath(path));
    const persistedId = readFrontmatterKey(written, 'mf_id');
    const persistedRevision = readFrontmatterKey(written, 'mf_revision');
    if (persistedId === plan.topic.mf_id && Number(persistedRevision) === plan.topic.mf_revision) {
      outcome.verified = true;
    } else {
      outcome.status = 'partial';
      outcome.requiresManualRecovery = true;
      outcome.diagnostics.push({
        code: 'E_READBACK_MISMATCH',
        persistedId,
        persistedRevision,
        expectedId: plan.topic.mf_id,
        expectedRevision: plan.topic.mf_revision,
      });
    }
  } catch (error) {
    outcome.status = 'partial';
    outcome.requiresManualRecovery = true;
    outcome.diagnostics.push({ code: 'E_READBACK_FAILED', message: error && error.message });
  }
  return outcome;
}

module.exports = {
  CANONICAL_KEYS,
  issueSyntheticCreationAuthorization,
  hasSyntheticCreationAuthorization,
  planTopicCreation,
  creationFieldLines,
  composeCreationContent,
  executeTopicCreation,
};
