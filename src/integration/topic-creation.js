'use strict';

// Idempotent Source/Extract creation helper for the Unified path.
// Pure: allocates identity, initializes scheduling fields and validates the
// parent relation. File creation remains a separate, non-transactional step.

const { initializeTopic, validateTopic } = require('../scheduling/index.js');
const { sha256Hex } = require('../scheduling/migration-hash.js');
const { isPersistentUuid } = require('../scheduling/legacy-identity.js');

function allocateStableUuid(requestId) {
  if (typeof requestId !== 'string' || !requestId) {
    const error = new Error('a request id is required for stable uuid allocation');
    error.code = 'E_REQUEST_ID_REQUIRED';
    throw error;
  }
  const hex = sha256Hex(`mf-us1-create:${requestId}`).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function createTopic({ kind, priority = 50, mfId, parentId = null, rootId = null, today, config = undefined }) {
  if (kind !== 'source' && kind !== 'extract') {
    const error = new Error('only Source and Extract can be created');
    error.code = 'E_TOPIC_TYPE';
    throw error;
  }
  if (!isPersistentUuid(mfId)) {
    const error = new Error('a persistent mfId is required');
    error.code = 'E_ID_REQUIRED';
    throw error;
  }
  if (kind === 'source' && (parentId || rootId)) {
    const error = new Error('a source must not have a parent');
    error.code = 'E_PARENT_INVALID';
    throw error;
  }
  if (kind === 'extract' && !isPersistentUuid(parentId)) {
    const error = new Error('an extract requires a persistent parent id');
    error.code = 'E_PARENT_REQUIRED';
    throw error;
  }
  const result = initializeTopic({
    type: kind,
    priority,
    mfId,
    mfParentId: kind === 'extract' ? parentId : null,
    mfRootId: kind === 'extract' ? (rootId || parentId) : null,
  }, config, today);
  validateTopic(result.topic);
  return result;
}

function createTopicOnce({ requestId, registry, kind, priority, parentId = null, rootId = null, today, config = undefined }) {
  if (registry.has(requestId)) return { topic: registry.get(requestId), duplicate: true };
  const mfId = allocateStableUuid(requestId);
  const result = createTopic({ kind, priority, mfId, parentId, rootId, today, config });
  registry.set(requestId, result.topic);
  return { topic: result.topic, duplicate: false };
}

module.exports = { allocateStableUuid, createTopic, createTopicOnce };
