'use strict';

// Protected admin-field writer for host batch operations that are not A8 events
// (Mercy updates only `mf_not_before`). It reuses the accepted async storage
// adapter, so every write is a real-byte CAS with id/revision/version/status
// verification plus read-back — no synthetic storage promises are reused.
//
// It deliberately allows a tiny whitelist (administrative fields only) and
// bumping mf_revision; it cannot touch interval, A-Factor, review_count or
// mf_ideal_due.

const { isPersistentUuid } = require('../scheduling/legacy-identity.js');
const { hasSyntheticHostAuthorization } = require('./host-runtime.js');

const ADMIN_FIELDS = Object.freeze(['mf_not_before']);

function normalizeNotBefore(value) {
  if (value == null || value === 'null' || value === '') return null;
  return String(value);
}

function createProtectedAdminWriter({ storage, allowedFields = ADMIN_FIELDS, authorization = null } = {}) {
  if (!storage || typeof storage.readTopic !== 'function' || typeof storage.compareAndSwap !== 'function') {
    throw Object.assign(new Error('a trusted async topic storage is required'), { code: 'E_STORAGE_REQUIRED' });
  }
  const allowed = new Set([...allowedFields, 'mf_revision']);

  for (const field of allowedFields) {
    if (field === 'interval' || field === 'a_factor' || field === 'review_count' || field === 'mf_ideal_due') {
      throw Object.assign(new Error(`field ${field} is never writable through the admin writer`), { code: 'E_FIELD_FORBIDDEN' });
    }
  }

  async function write({ topicId, updates, expectedNotBefore = undefined, expectedRevision = null } = {}) {
    // Production never holds this token: without it the admin writer refuses to
    // write, mirroring the runtime authorization gate.
    if (!hasSyntheticHostAuthorization(authorization)) {
      return { status: 'blocked', reason: 'E_UNIFIED_NOT_AUTHORIZED' };
    }
    if (!isPersistentUuid(topicId)) return { status: 'blocked', reason: 'E_TOPIC_ID_INVALID' };
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { status: 'failed', reason: 'E_UPDATES_REQUIRED' };
    for (const key of Object.keys(updates)) {
      if (!allowed.has(key)) return { status: 'failed', reason: `E_FIELD_NOT_WRITABLE:${key}` };
    }

    const located = await storage.readTopic(topicId);
    if (located.duplicates && located.duplicates.length) {
      return { status: 'conflict', reason: 'E_DUPLICATE_TOPIC_ID' };
    }
    const entry = located.entry;
    if (!entry) return { status: 'conflict', reason: located.code || 'E_TOPIC_NOT_FOUND' };
    if (!isPersistentUuid(entry.mfId) || entry.mfId !== topicId) {
      return { status: 'conflict', reason: 'E_TOPIC_ID_MISMATCH' };
    }
    if (entry.frontmatter.status !== 'active') return { status: 'conflict', reason: 'E_TOPIC_NOT_ACTIVE' };
    if (!Number.isInteger(entry.revision)) return { status: 'conflict', reason: 'E_REVISION_NOT_PERSISTED' };
    if (expectedRevision != null && entry.revision !== expectedRevision) {
      return { status: 'conflict', reason: 'E_REVISION_MISMATCH' };
    }
    if (expectedNotBefore !== undefined) {
      if (normalizeNotBefore(entry.frontmatter.mf_not_before) !== normalizeNotBefore(expectedNotBefore)) {
        return { status: 'conflict', reason: 'E_INPUT_CHANGED' };
      }
    }

    const cas = await storage.compareAndSwap(topicId, {
      expectedHash: entry.hash,
      expectedRevision: entry.revision,
      updates: { ...updates, mf_revision: entry.revision + 1 },
    });
    if (!cas || !cas.ok) {
      const code = (cas && cas.code) || 'E_WRITE_FAILED';
      if (code === 'E_WRITE_UNVERIFIED' || code === 'E_WRITE_UNCERTAIN') {
        return { status: 'uncertain', reason: code };
      }
      return { status: 'conflict', reason: code };
    }
    return {
      status: 'applied',
      reason: null,
      revision: entry.revision + 1,
      beforeHash: cas.beforeHash,
      afterHash: cas.afterHash,
    };
  }

  return { write, allowedFields: [...allowedFields] };
}

module.exports = { ADMIN_FIELDS, createProtectedAdminWriter, normalizeNotBefore };
