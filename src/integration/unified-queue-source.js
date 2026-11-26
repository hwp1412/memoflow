'use strict';

// Unified queue / dashboard / reading-session data source (P2-US1 QUEUE-SOURCE).
//
// One read-side adapter between vault metadata rows and the pure MF-US-1 core:
//
//   rows --projectTopic--> canonical projections (P0 contract)
//        --toQueueTopic--> queue topics
//        --selectDailyQueue--> the only accepted queue algorithm
//        --buildDashboardModel--> dashboard model
//
// Authority rules (P0 topic-projection contract, SPEC A6/A12):
//   * unified mode: only projections with a persisted topic id and a fully
//     writable mf_* field set are handed to the queue. Legacy-only /
//     unmigrated / card / unsupported-status rows are excluded up front and
//     reported in `diagnostics`; there is NO fallback to next_review/interval,
//     so a stale legacy field can never change the unified schedule.
//   * legacy mode: the P0 projection maps the legacy fields read-only and those
//     projections are queued for parity/diagnostics. Nothing is written back
//     and the result is never used as unified authority.
//
// The module is pure: no I/O, no clock, no path access, no vault, no writes. It
// never mutates the caller's rows and it never mints scheduling identities; the
// deterministic legacy temporary id is namespaced by `legacyTempId` and is
// read-only (SPEC A6.2).

const { projectTopic, toQueueTopic } = require('./topic-projection.js');
const { selectDailyQueue } = require('../scheduling/queue.js');
const { fail } = require('../scheduling/errors.js');
const { buildDashboardModel } = require('../ui/scheduler-dashboard-model.js');

const MODES = Object.freeze(['unified', 'legacy']);
const DEFAULT_MODE = 'unified';
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
const DEFAULT_LEGACY_TEMP_ID = 'legacy';

// Accept either the bare mode string or a `{ mode }` config object (the shape
// consumed by evaluateRuntimeMode / buildDashboardModel), so the host can pass
// its existing mode config through without a second mapping table.
function normalizeMode(mode) {
  if (mode == null) return DEFAULT_MODE;
  const value = typeof mode === 'object' && !Array.isArray(mode) ? mode.mode : mode;
  if (typeof value !== 'string' || !MODES.includes(value)) {
    fail('E_QUEUE_SOURCE_MODE', `unsupported queue source mode "${String(value)}"; expected unified or legacy`, {
      value,
    });
  }
  return value;
}

function basenameFromPath(path) {
  if (typeof path !== 'string' || !path) return null;
  const name = path.split('/').pop();
  if (!name) return null;
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function rowFile(row) {
  return row && (row.tfile || row.file);
}

// Deterministic read-only identifier for legacy projections (SPEC A6.2).
// `legacyTempId` is an optional namespace prefix; the default keeps legacy
// parity output stable across runs.
function legacyTempIdFor(row, index, legacyTempId) {
  const namespace = legacyTempId == null ? DEFAULT_LEGACY_TEMP_ID : String(legacyTempId);
  const file = rowFile(row);
  const path = file && typeof file.path === 'string' && file.path ? file.path : null;
  return path ? `${namespace}:${path}` : `${namespace}:row-${index}`;
}

function projectRows(rows, mode, legacyTempId) {
  return rows.map((row, index) => {
    const tempId = mode === 'legacy' ? legacyTempIdFor(row, index, legacyTempId) : null;
    return projectTopic(row, { mode, tempId });
  });
}

// A queue row is authoritative only when the projection was produced from
// persisted mf_* fields. In unified mode `writable` is the P0 signal that every
// scheduling field exists and is legal; an id is additionally required because
// the queue never mints identities. Cards short-circuit to authority legacy in
// P0 and are therefore rejected here as well.
function isQueueEligibleProjection(projection, mode) {
  if (!projection) return false;
  if (mode === 'unified') {
    return projection.authority === 'unified'
      && Boolean(projection.topicId)
      && projection.writable === true;
  }
  return projection.queueEligible === true;
}

// One primary diagnostic code per excluded row; `blockers` keeps the full P0
// reason list so the dashboard can explain every missing field.
function diagnosticCode(projection, mode) {
  const blockers = Array.isArray(projection.blockers) ? projection.blockers : [];
  if (blockers.includes('E_TOPIC_MISSING')) return 'E_TOPIC_MISSING';
  if (blockers.includes('CARD')) return 'CARD';
  if (mode === 'unified' && !projection.topicId) return 'LEGACY_NOT_MIGRATED';
  if (blockers.length > 0) return blockers[0];
  return mode === 'unified' ? 'NOT_WRITABLE' : 'NOT_QUEUE_ELIGIBLE';
}

function diagnosticFor(projection, mode) {
  const blockers = Array.isArray(projection.blockers) ? projection.blockers.slice() : [];
  return {
    path: projection.path ?? null,
    basename: projection.basename ?? basenameFromPath(projection.path),
    code: diagnosticCode(projection, mode),
    blockers,
  };
}

function sourceIndex(projections) {
  const index = new Map();
  for (const projection of projections) {
    const id = projection.topicId || projection.tempId;
    if (id) index.set(id, projection);
  }
  return index;
}

// The pure queue result carries stable ids only. Reading-session callers need
// the vault path of each selected Topic, so the source path (and authority) is
// attached to `selected` entries here. Ranking, budget and explain stay exactly
// what selectDailyQueue returned.
function withSelectedSources(queue, queuedProjections) {
  const index = sourceIndex(queuedProjections);
  const selected = queue.selected.map(entry => {
    const projection = index.get(entry.stableId);
    if (!projection) return { ...entry };
    return {
      ...entry,
      path: projection.path ?? null,
      basename: projection.basename ?? basenameFromPath(projection.path),
      authority: projection.authority,
    };
  });
  return { ...queue, selected };
}

function queueTopicFromProjection(projection) {
  const topic = toQueueTopic(projection);
  if (!topic) return null;
  // P0 `toQueueTopic` publishes the deterministic read-only id as `stableId`;
  // the frozen queue contract reads `stable_id` for id-less legacy topics. The
  // bridge stays here (both frozen modules are untouched) and is only needed in
  // legacy parity mode: unified topics carry a persistent `mf_id`.
  if (topic.mf_id == null && topic.stable_id == null && topic.stableId != null) {
    topic.stable_id = topic.stableId;
  }
  return topic;
}

function prepareQueueSource({ rows, mode, today, config, legacyTempId }) {
  if (!Array.isArray(rows)) {
    fail('E_OBJECT_REQUIRED', 'buildUnifiedQueue expects rows to be an array', { field: 'rows' });
  }
  const projections = projectRows(rows, mode, legacyTempId);
  const queuedProjections = [];
  const diagnostics = [];
  for (const projection of projections) {
    if (isQueueEligibleProjection(projection, mode)) queuedProjections.push(projection);
    else diagnostics.push(diagnosticFor(projection, mode));
  }
  const topics = queuedProjections.map(queueTopicFromProjection).filter(Boolean);
  const queue = withSelectedSources(selectDailyQueue(topics, config, today), queuedProjections);
  return {
    queue,
    projections,
    topics,
    queuedProjections,
    diagnostics,
    source: Object.freeze({
      mode,
      queued: queuedProjections.length,
      excluded: diagnostics.length,
    }),
  };
}

// SPEC A6 / A12 — the read-side queue source used by the dashboard, the reading
// session and (later) the host views. See the module header for authority rules.
//
// `dateFormat` is accepted for call-site symmetry with the dashboard source; the
// pure queue itself never formats dates. `legacyTempId` is only used in legacy
// mode: null keeps the deterministic `legacy:<path>` read-only id.
function buildUnifiedQueue({
  rows, mode = DEFAULT_MODE, today, config, dateFormat = DEFAULT_DATE_FORMAT, legacyTempId = null,
} = {}) {
  // Accepted for API symmetry; kept so callers cannot silently drop a format.
  void dateFormat;
  const normalizedMode = normalizeMode(mode);
  const prepared = prepareQueueSource({ rows, mode: normalizedMode, today, config, legacyTempId });
  return {
    queue: prepared.queue,
    projections: prepared.projections,
    diagnostics: prepared.diagnostics,
    source: prepared.source,
  };
}

// Enrich the frozen dashboard model (new object, original untouched) with the
// projection authority of each visible Topic plus the queue-source summary.
// `buildDashboardModel` already carries mode/blockers/budget and reads
// mf_interval_days (never the legacy `interval`); this only makes the authority
// explicit and keeps excluded rows observable.
function enrichDashboardModel(model, prepared, mode) {
  const index = sourceIndex(prepared.queuedProjections);
  const topics = Array.isArray(model.topics) ? model.topics.map(view => {
    const projection = view && view.stableId != null ? index.get(view.stableId) : null;
    return {
      ...view,
      authority: projection ? projection.authority : mode,
      writable: projection ? projection.writable === true : false,
      blockers: projection && Array.isArray(projection.blockers) ? projection.blockers.slice() : [],
    };
  }) : [];
  const cardsExcluded = prepared.diagnostics.filter(item => item.code === 'CARD').length;
  return {
    ...model,
    // Read-side data authority of this model. This is deliberately separate
    // from buildDashboardModel's `authoritativeScheduler`/`allowed` (write
    // runtime gates): a unified dashboard may read mf_* while unified writes
    // are still blocked.
    projectionAuthority: mode,
    source: prepared.source,
    diagnostics: prepared.diagnostics,
    topics,
    cardsExcluded,
  };
}

// Dashboard data source: the same queue-source result feeds buildDashboardModel,
// so the model and the queue can never disagree about candidates, ordering or
// budget.
function buildUnifiedDashboardModel({ rows, mode = DEFAULT_MODE, today, config, dateFormat = DEFAULT_DATE_FORMAT, mercy = null } = {}) {
  const normalizedMode = normalizeMode(mode);
  const prepared = prepareQueueSource({
    rows,
    mode: normalizedMode,
    today,
    config,
    // Legacy-mode dashboard parity: deterministic temporary ids keep the queue
    // readable; they are never written back.
    legacyTempId: DEFAULT_LEGACY_TEMP_ID,
  });
  const model = buildDashboardModel({
    topics: prepared.topics,
    today,
    queueConfig: config,
    mode: { mode: normalizedMode },
    dateFormat,
    mercy,
  });
  return {
    model: enrichDashboardModel(model, prepared, normalizedMode),
    queue: prepared.queue,
    diagnostics: prepared.diagnostics,
  };
}

// Reading-session projection. Ordering follows queue.selected (the queue has
// already applied the SPEC A6.2 five-key order and the A6.3 budget); cards are
// never part of a reading session even if a caller fabricates such an entry.
function sessionItemsFromQueue(queue) {
  const selected = queue && Array.isArray(queue.selected) ? queue.selected : [];
  const items = [];
  for (const entry of selected) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'card') continue;
    const path = entry.path ?? null;
    items.push({
      path,
      basename: entry.basename ?? basenameFromPath(path),
      type: entry.type ?? null,
      priority: entry.priority ?? null,
      effectiveDue: entry.effectiveDue ?? entry.idealDue ?? null,
      rank: entry.rank ?? null,
    });
  }
  return items;
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  DEFAULT_DATE_FORMAT,
  normalizeMode,
  buildUnifiedQueue,
  buildUnifiedDashboardModel,
  sessionItemsFromQueue,
};
