'use strict';

// Public surface of the MF-US-1 pure core.
//
// SPEC A9: no Obsidian, no Vault, no filesystem, no clock, no randomness, no SR.
// Every function is deterministic and leaves its arguments untouched.

const errors = require('./errors.js');
const constants = require('./constants.js');
const schema = require('./schema.js');
const dates = require('./dates.js');
const initial = require('./initial.js');
const interval = require('./interval.js');
const events = require('./events.js');
const due = require('./due.js');
const eventLedger = require('./event-ledger.js');
const queueConfig = require('./queue-config.js');
const queue = require('./queue.js');
const workload = require('./workload.js');
const mercy = require('./mercy.js');
const mercyBatch = require('./mercy-batch.js');
const legacyIdentity = require('./legacy-identity.js');
const legacyAdapter = require('./legacy-adapter.js');
const legacyRelations = require('./legacy-relations.js');
const mode = require('./mode.js');
const shadow = require('./shadow.js');
const migrationHash = require('./migration-hash.js');
const migrationPlan = require('./migration-plan.js');
const migrationStorage = require('./migration-storage.js');
const migrationFrontmatter = require('./migration-frontmatter.js');
const migrationBackup = require('./migration-backup.js');
const migrationExecute = require('./migration-execute.js');

module.exports = {
  ...errors,
  ...constants,
  ...schema,
  ...dates,
  ...initial,
  ...interval,
  ...events,
  ...due,
  ...eventLedger,
  ...queueConfig,
  ...queue,
  ...workload,
  ...mercy,
  ...mercyBatch,
  ...legacyIdentity,
  ...legacyAdapter,
  ...legacyRelations,
  ...mode,
  ...shadow,
  ...migrationHash,
  ...migrationPlan,
  ...migrationStorage,
  ...migrationFrontmatter,
  ...migrationBackup,
  ...migrationExecute,
  // Namespaced access for callers that prefer explicit module grouping.
  schema,
  dates,
  initial,
  interval,
  events,
  due,
  eventLedger,
  queueConfig,
  queue,
  workload,
  mercy,
  mercyBatch,
  legacyIdentity,
  legacyAdapter,
  legacyRelations,
  mode,
  shadow,
  migrationHash,
  migrationPlan,
  migrationStorage,
  migrationFrontmatter,
  migrationBackup,
  migrationExecute,
};
