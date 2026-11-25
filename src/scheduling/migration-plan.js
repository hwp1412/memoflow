'use strict';

// Read-only migration planning for legacy MemoFlow notes (PR-08, SPEC A10.2).
//
// previewMigration() never writes. It reuses the accepted PR-06 adapter for
// field/identity/relation parsing, then decides what a future authorized write
// would add. A plan can be re-executed safely because every assigned UUID is
// fixed inside the plan hash.
//
// Classification:
//   migratable        fields/identity/relations are safe to add
//   already-migrated  no modern field is missing
//   manual-review     ambiguity or an unverified decision is required
//   blocked           invalid/unsupported data
//   conflict          legacy and modern values disagree

const { fail } = require('./errors.js');
const { ALGORITHM_VERSION } = require('./constants.js');
const { adaptLegacyTopics } = require('./legacy-adapter.js');
const { resolveRelations } = require('./legacy-relations.js');
const { isPersistentUuid } = require('./legacy-identity.js');
const { effectiveDueFromDates } = require('./due.js');
const { sha256Hex, hashObject } = require('./migration-hash.js');
const { mergeFrontmatter, assertAddOnly } = require('./migration-frontmatter.js');

const PLAN_KIND = 'mf-us-1-migration-plan';

function hashEntry(entry) {
  return {
    index: entry.index,
    path: entry.path,
    status: entry.status,
    identityId: entry.identity ? entry.identity.id : null,
    assignedUuid: entry.assignedUuid,
    fieldsToAdd: entry.fieldsToAdd,
    before: entry.before,
    after: entry.after,
    relation: entry.relation ? { parentId: entry.relation.parentId, rootId: entry.relation.rootId, verified: entry.relation.verified } : null,
    revision: entry.revision,
    contentHash: entry.contentHash,
  };
}

function planHashOf(plan) {
  return hashObject({
    kind: PLAN_KIND,
    algorithmVersion: plan.algorithmVersion,
    snapshotId: plan.snapshotId ?? null,
    dateFormat: plan.dateFormat ?? null,
    entries: plan.entries.map(hashEntry),
  });
}
const LOSS_NOTES = Object.freeze([
  'NOT_BEFORE_NOT_RECOVERABLE',
  'LEGACY_INTERVAL_MAY_INCLUDE_ADMINISTRATIVE_VALUE',
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function reason(code, message) {
  return { code, message };
}

function baseEntry(result, raw, index) {
  const topic = result.topic;
  const entry = {
    index,
    path: typeof raw.path === 'string' ? raw.path : null,
    basename: typeof raw.basename === 'string' ? raw.basename : null,
    status: 'blocked',
    reasons: [],
    identity: result.identity ? {
      kind: result.identity.kind,
      id: result.identity.id,
      persistent: Boolean(result.identity.persistent),
    } : { kind: 'missing', id: null, persistent: false },
    adapterStatus: result.status,
    requiresUuid: false,
    assignedUuid: null,
    uuidStatus: 'not-needed',
    fieldsToAdd: {},
    before: null,
    after: null,
    effectiveDuePreserved: false,
    relation: null,
    lossNotes: [...LOSS_NOTES],
    revision: Number.isInteger(raw.mf_revision) && raw.mf_revision >= 0 ? raw.mf_revision : null,
    contentHash: typeof raw.content === 'string' ? sha256Hex(raw.content) : null,
  };

  if (!topic) {
    entry.reasons = [
      ...result.errors.map(error => reason(error.code, error.message)),
      ...result.ambiguities.map(item => reason(item.code, item.message || 'ambiguous')),
    ];
    if (!entry.reasons.length) entry.reasons = [reason('ADAPTER_NO_CANDIDATE', 'no candidate was produced')];
    entry.status = result.status === 'conflict' ? 'conflict' : 'blocked';
    return entry;
  }

  entry.status = 'pending';
  entry.requiresUuid = !entry.identity.persistent;
  const existingNotBefore = typeof raw.mf_not_before === 'string' ? raw.mf_not_before : null;
  if (existingNotBefore) entry.lossNotes = entry.lossNotes.filter(note => note !== 'NOT_BEFORE_NOT_RECOVERABLE');
  entry.before = {
    idealDue: topic.mf_ideal_due,
    notBefore: existingNotBefore,
    effectiveDue: effectiveDueFromDates(topic.mf_ideal_due, existingNotBefore),
    intervalDays: topic.mf_interval_days,
    aFactor: topic.a_factor,
    priority: topic.priority,
    reviewCount: topic.review_count,
    status: topic.status,
  };
  entry.current = topic;
  return entry;
}

function mapRelationId(id, idToUuid) {
  if (!id) return null;
  if (isPersistentUuid(id)) return id;
  return idToUuid.get(id.toLowerCase()) || null;
}

function finalizeEntry(entry, raw, reportEntry, rawRelation, idToUuid, context) {
  if (!entry.current) return entry;
  const topic = entry.current;
  const relation = reportEntry.relation;
  const reasons = [];

  // --- identity ---------------------------------------------------------
  if (entry.requiresUuid && entry.uuidStatus === 'unassigned') {
    reasons.push(reason('UUID_ALLOCATION_REQUIRED', 'a temporary identity needs an assigned UUID before migration'));
  } else if (entry.uuidStatus === 'conflict') {
    reasons.push(reason('UUID_CONFLICT', 'the allocated UUID already exists in the snapshot or batch'));
  } else if (entry.uuidStatus === 'invalid') {
    reasons.push(reason('UUID_INVALID', 'the allocator did not return a valid UUID'));
    entry.status = 'blocked';
  } else if (entry.uuidStatus === 'allocator-failed') {
    reasons.push(reason('UUID_ALLOCATOR_FAILED', 'the UUID allocator threw'));
    entry.status = 'blocked';
  }

  // --- relations --------------------------------------------------------
  // Use the accepted relation resolver directly so a temporary parent id can be
  // mapped to the UUID allocated in this same plan.
  let parentId = null;
  let rootId = null;
  if (rawRelation) {
    parentId = mapRelationId(rawRelation.parentId, idToUuid);
    rootId = mapRelationId(rawRelation.rootId, idToUuid);
    if (rawRelation.parentId && !parentId) reasons.push(reason('RELATION_PARENT_UNRESOLVED', 'the parent identity cannot be mapped to a persisted UUID'));
    if (rawRelation.rootId && !rootId) reasons.push(reason('RELATION_ROOT_UNRESOLVED', 'the root identity cannot be mapped to a persisted UUID'));
    for (const status of ['orphan', 'ambiguous', 'cycle', 'self', 'duplicate']) {
      if (rawRelation.status === status) reasons.push(reason(`RELATION_${status.toUpperCase()}`, `relation resolution reported ${status}`));
    }
    const modernOnlyParent = raw.mf_parent_id != null && !raw.parent && !raw.source;
    if (modernOnlyParent) reasons.push(reason('RELATION_UNVERIFIED', 'the modern parent has no legacy link to confirm it'));
  } else {
    reasons.push(reason('RELATION_UNRESOLVED', 'no relation record was resolved for this identity'));
  }
  entry.relation = rawRelation ? {
    status: rawRelation.status,
    parentId,
    rootId,
    depth: rawRelation.depth,
    verified: rawRelation.status === 'ok' || rawRelation.status === 'root',
  } : null;

  // --- effective due invariant -----------------------------------------
  const afterIdealDue = topic.mf_ideal_due;
  const afterNotBefore = hasOwn(raw, 'mf_not_before') ? (raw.mf_not_before ?? null) : null;
  entry.after = {
    idealDue: afterIdealDue,
    notBefore: afterNotBefore,
    effectiveDue: effectiveDueFromDates(afterIdealDue, afterNotBefore),
    intervalDays: topic.mf_interval_days,
    aFactor: topic.a_factor,
    priority: topic.priority,
    reviewCount: topic.review_count,
    status: topic.status,
  };
  entry.effectiveDuePreserved = entry.before.effectiveDue === entry.after.effectiveDue;
  if (!entry.effectiveDuePreserved) reasons.push(reason('EFFECTIVE_DUE_CHANGED', 'migration would move the effective due date'));

  // --- fields to add ----------------------------------------------------
  const fields = {};
  if (!isPersistentUuid(raw.mf_id) && entry.assignedUuid) fields.mf_id = entry.assignedUuid;
  if (raw.mf_ideal_due == null) fields.mf_ideal_due = topic.mf_ideal_due;
  if (!hasOwn(raw, 'mf_not_before')) fields.mf_not_before = afterNotBefore;
  if (raw.mf_interval_days == null) fields.mf_interval_days = topic.mf_interval_days;
  if (raw.mf_scheduler_version == null) fields.mf_scheduler_version = ALGORITHM_VERSION;
  if (raw.mf_revision == null) fields.mf_revision = 0;
  if (!hasOwn(raw, 'mf_last_event_id')) fields.mf_last_event_id = null;
  if (raw.mf_parent_id == null && parentId) fields.mf_parent_id = parentId;
  if (raw.mf_root_id == null && rootId) fields.mf_root_id = rootId;
  entry.fieldsToAdd = fields;

  // --- snapshot evidence ------------------------------------------------
  if (Object.keys(fields).length > 0) {
    if (typeof raw.content !== 'string') {
      reasons.push(reason('SNAPSHOT_CONTENT_MISSING', 'the preview has no exact content/hash, so migration cannot verify the file later'));
    } else {
      try {
        mergeFrontmatter(raw.content, fields);
        assertAddOnly(raw.content, fields);
      } catch (error) {
        reasons.push(reason(error.code || 'E_FRONTMATTER_INVALID', error.message || 'the frontmatter cannot be merged safely'));
      }
    }
  }

  // --- status -----------------------------------------------------------
  const adapterStatus = reportEntry.status;
  const fieldAlreadyPresent = reasons.some(item => item.code === 'E_FIELD_ALREADY_PRESENT');
  const blockedByDecision = reasons.some(item => [
    'EFFECTIVE_DUE_CHANGED',
    'UUID_INVALID',
    'UUID_ALLOCATOR_FAILED',
    'E_FRONTMATTER_DUPLICATE_KEY',
    'E_FRONTMATTER_UNSUPPORTED_STRUCTURE',
    'E_ENCODING_UNSUPPORTED',
  ].includes(item.code))
    || entry.uuidStatus === 'invalid'
    || entry.uuidStatus === 'allocator-failed';
  if (blockedByDecision) entry.status = 'blocked';
  else if (adapterStatus === 'conflict' || fieldAlreadyPresent) entry.status = 'conflict';
  else if (adapterStatus === 'unsupported' || adapterStatus === 'invalid') entry.status = 'blocked';
  else if (adapterStatus === 'ambiguous') entry.status = 'manual-review';
  else if (reasons.length > 0) entry.status = 'manual-review';
  else if (Object.keys(fields).length === 0) entry.status = 'already-migrated';
  else entry.status = 'migratable';

  if (adapterStatus === 'read-only-limited' && entry.status === 'migratable') {
    entry.reasons.push(reason('LEGACY_READ_ONLY_LIMITED', 'the legacy record is only partially normalised; review the loss notes'));
  }
  entry.reasons = [...entry.reasons, ...reasons];
  delete entry.current;
  return entry;
}

function previewMigration(snapshots, context = {}, options = {}) {
  if (!Array.isArray(snapshots)) {
    fail('E_OBJECT_REQUIRED', 'previewMigration expects an array of legacy snapshots', { field: 'snapshots' });
  }
  const report = adaptLegacyTopics(snapshots, context);
  const relationEntries = report.results
    .filter(result => result.identity && result.identity.id)
    .map(result => {
      const raw = snapshots[result.index] || {};
      return {
        id: result.identity.id,
        identity: result.identity,
        path: raw.path,
        basename: raw.basename || raw.title,
        raw,
      };
    });
  const rawRelations = relationEntries.length ? resolveRelations(relationEntries) : { byId: new Map() };
  const allocate = typeof options.uuidAllocator === 'function' ? options.uuidAllocator : null;
  const existingIds = new Set();
  for (const result of report.results) {
    if (result.identity && result.identity.persistent) existingIds.add(result.identity.id.toLowerCase());
  }

  const entries = report.results.map((result, index) => baseEntry(result, snapshots[index] || {}, index));

  // Fixed UUID allocation: every assigned id is part of the plan hash so a
  // retry can never allocate a second identity for the same topic.
  const idToUuid = new Map();
  const assigned = [];
  for (const entry of entries) {
    if (!entry.requiresUuid) continue;
    if (!allocate) {
      entry.uuidStatus = 'unassigned';
      continue;
    }
    let uuid;
    try {
      uuid = allocate({ index: entry.index, path: entry.path, basename: entry.basename, temporaryId: entry.identity.id });
    } catch (error) {
      entry.uuidStatus = 'allocator-failed';
      entry.uuidError = error && error.message ? error.message : 'allocator failed';
      continue;
    }
    if (!isPersistentUuid(uuid)) {
      entry.uuidStatus = 'invalid';
      continue;
    }
    const key = uuid.toLowerCase();
    if (existingIds.has(key) || assigned.some(value => value.toLowerCase() === key)) {
      entry.uuidStatus = 'conflict';
      entry.assignedUuid = null;
      continue;
    }
    entry.uuidStatus = 'assigned';
    entry.assignedUuid = uuid;
    idToUuid.set(entry.identity.id.toLowerCase(), uuid);
    assigned.push(uuid);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const identityId = report.results[index].identity && report.results[index].identity.id;
    const rawRelation = identityId ? rawRelations.byId.get(identityId.toLowerCase()) : null;
    finalizeEntry(entries[index], snapshots[index] || {}, report.results[index], rawRelation, idToUuid, context);
  }

  const summary = {
    total: entries.length,
    migratable: entries.filter(entry => entry.status === 'migratable').length,
    alreadyMigrated: entries.filter(entry => entry.status === 'already-migrated').length,
    manualReview: entries.filter(entry => entry.status === 'manual-review').length,
    blocked: entries.filter(entry => entry.status === 'blocked').length,
    conflict: entries.filter(entry => entry.status === 'conflict').length,
    requiresUuid: entries.filter(entry => entry.requiresUuid).length,
    withoutPersistentId: entries.filter(entry => !entry.identity.persistent).length,
  };

  const plan = {
    kind: PLAN_KIND,
    algorithmVersion: ALGORITHM_VERSION,
    snapshotId: options.snapshotId ?? null,
    dateFormat: context ? (context.dateFormat ?? null) : null,
    entries,
    summary,
    executable: entries.filter(entry => entry.status === 'migratable' && Object.keys(entry.fieldsToAdd).length > 0).length,
    writesPerformed: false,
  };
  plan.planId = planHashOf(plan);
  return plan;
}

function executableEntries(plan) {
  return plan.entries.filter(entry => entry.status === 'migratable' && Object.keys(entry.fieldsToAdd).length > 0);
}

module.exports = { PLAN_KIND, LOSS_NOTES, previewMigration, executableEntries, planHashOf };
