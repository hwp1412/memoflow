'use strict';

// Production-shaped onload lifecycle: load and validate the durable ledger,
// hydrate the trusted memory ledger, recover pending events, and expose the
// runtime view. No production Unified authorization is issued here.

const {
  PersistentEventLedger,
  MemoryLedgerStore,
} = require('../scheduling/index.js');
const { createObsidianPluginDataStore, openPluginDataLedger } = require('./plugin-data-ledger-store.js');
const { createHostRuntime } = require('./host-runtime.js');

async function initializeHostLifecycle({
  plugin,
  key = 'mfUs1Ledger',
  mode = 'legacy',
  conditions = {},
  storage = null,
  capability = null,
  // When the host owns a PluginDataCoordinator, pass its ledger store here so
  // settings/session/ledger share one serialised write queue.
  dataStore = null,
} = {}) {
  if (!plugin) {
    const error = new Error('a plugin with loadData/saveData is required');
    error.code = 'E_PLUGIN_REQUIRED';
    throw error;
  }
  const store = dataStore || createObsidianPluginDataStore(plugin);
  const opened = await openPluginDataLedger({ dataStore: store, key });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const runtime = createHostRuntime({
    mode,
    conditions,
    authorization: null,
    storage,
    ledger,
    capability,
    persist: async records => {
      opened.store.replace(records);
      return opened.flush();
    },
  });
  const recovery = storage ? await runtime.recover() : { recovered: [], blockedTopicIds: opened.blockedTopicIds };
  return {
    ledger,
    runtime,
    opened,
    healthy: opened.healthy,
    diagnostics: opened.diagnostics,
    blockedTopicIds: recovery.blockedTopicIds || opened.blockedTopicIds,
    recovery,
    view: runtime.view(),
  };
}

// Async transport lifecycle: same ledger open/validate/recover contract, but
// the runtime commits through the Obsidian adapter. Production still has no
// authorization: the caller must hand in an explicitly issued token, and the
// runtime gate re-checks it on every event.
async function initializeAsyncHostLifecycle({
  plugin,
  key = 'mfUs1Ledger',
  mode = 'legacy',
  conditions = {},
  storage = null,
  capability = null,
  config = null,
  dateFormat = 'DD-MM-YYYY',
  authorization = null,
  dataStore = null,
} = {}) {
  const { createAsyncHostRuntime } = require('./host-async-runtime.js');
  if (!plugin) {
    const error = new Error('a plugin with loadData/saveData is required');
    error.code = 'E_PLUGIN_REQUIRED';
    throw error;
  }
  const store = dataStore || createObsidianPluginDataStore(plugin);
  const opened = await openPluginDataLedger({ dataStore: store, key });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore(opened.store.dump()));
  const runtime = createAsyncHostRuntime({
    mode,
    conditions,
    authorization,
    storage,
    ledger,
    capability,
    config,
    dateFormat,
    persist: async records => {
      opened.store.replace(records);
      return opened.flush();
    },
  });
  const recovery = storage ? await runtime.recover() : { recovered: [], blockedTopicIds: opened.blockedTopicIds };
  return {
    ledger,
    runtime,
    opened,
    healthy: opened.healthy,
    diagnostics: opened.diagnostics,
    blockedTopicIds: recovery.blockedTopicIds || opened.blockedTopicIds,
    recovery,
    view: runtime.view(),
  };
}

module.exports = { initializeHostLifecycle, initializeAsyncHostLifecycle };
