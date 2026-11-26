'use strict';

// Unified persistence coordinator for the plugin's `data.json` (HOST-DATA-01).
//
// Problem it solves: Obsidian's `Plugin.saveData(obj)` REPLACES the whole file.
// Before this module, settings/session saves wrote `this.settings` directly
// while the Unified ledger was written by a separate key-scoped adapter, and
// `onload` had merged the startup ledger snapshot into `this.settings`. The
// combination could delete or *roll back* the ledger (losing applied-event
// records and duplicate protection).
//
// Contract:
//   * one process-wide FIFO queue for every `data.json` write;
//   * every write merges onto the LATEST persisted snapshot (never a memory copy);
//   * field ownership: `settings` may not write reserved keys, `ledger` may only
//     write its own key; keys owned by nobody else are never dropped;
//   * success means "written AND read back identical"; a save call that merely
//     returned is not success;
//   * failures are classified (pre-write / unknown / unverified) and reported;
//     they are never silently swallowed.
//
// It gives no cross-file transaction and no power-loss durability guarantee:
// read-back proves "observed on disk", not "flushed to stable storage".

const { fail } = require('../scheduling/errors.js');
const { stableStringify } = require('../scheduling/migration-hash.js');

const LEDGER_KEY = 'mfUs1Ledger';
const DEFAULT_RESERVED_KEYS = Object.freeze([LEDGER_KEY]);

const OWNER_SETTINGS = 'settings';
const OWNER_LEDGER = 'ledger';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripReservedKeys(data, reservedKeys = DEFAULT_RESERVED_KEYS) {
  if (!isPlainObject(data)) return {};
  const next = { ...data };
  for (const key of reservedKeys) delete next[key];
  return next;
}

function sectionOf(snapshot, owner, reservedKeys) {
  if (owner === OWNER_LEDGER) return snapshot[LEDGER_KEY] ?? null;
  if (owner === OWNER_SETTINGS) return stripReservedKeys(snapshot, reservedKeys);
  if (reservedKeys.includes(owner)) return snapshot[owner] ?? null;
  return null;
}

function sameSection(left, right) {
  try {
    return stableStringify(left ?? null) === stableStringify(right ?? null);
  } catch (error) {
    return false;
  }
}

function createPluginDataCoordinator({
  plugin,
  reservedKeys = DEFAULT_RESERVED_KEYS,
  ledgerKey = LEDGER_KEY,
  verifyAfter = true,
  notice = null,
  onDiagnostic = null,
} = {}) {
  if (!plugin || typeof plugin.loadData !== 'function' || typeof plugin.saveData !== 'function') {
    fail('E_DATA_COORDINATOR_PLUGIN_REQUIRED', 'a plugin with loadData()/saveData(data) is required');
  }
  if (!Array.isArray(reservedKeys) || !reservedKeys.includes(ledgerKey)) {
    fail('E_DATA_COORDINATOR_RESERVED', 'reservedKeys must include the ledger key');
  }

  let chain = Promise.resolve();
  let pending = 0;
  let lastResult = null;
  const lastByOwner = new Map();
  // Unresolved failure is tracked PER OWNER. A successful settings save must
  // never clear a ledger failure (and vice versa): they are independent
  // durability claims about the same file.
  const failures = new Map();
  const notified = new Map();
  const recoveredSinceNotify = new Map();

  function ownerLabel(owner) {
    return owner === OWNER_LEDGER ? 'Unified 账本' : '插件设置';
  }

  function notifyFailure(result) {
    const diagnostic = {
      code: result.code,
      owner: result.owner,
      phase: result.phase,
      pendingRetry: result.pendingRetry === true,
      at: new Date().toISOString(),
    };
    failures.set(result.owner, diagnostic);
    if (typeof onDiagnostic === 'function') {
      try { onDiagnostic(diagnostic); } catch (error) { /* diagnostics must never throw */ }
    }
    // Rate limit per owner: a persistent failure notifies once; it notifies
    // again only after the owner has recovered and failed again.
    const previousCode = notified.get(result.owner) || null;
    const recovered = recoveredSinceNotify.get(result.owner) === true;
    if (previousCode === result.code && !recovered) return;
    notified.set(result.owner, result.code);
    recoveredSinceNotify.set(result.owner, false);
    if (typeof notice === 'function') {
      try {
        notice(`MemoFlow ${ownerLabel(result.owner)} 保存未完成（${result.code}）：${result.message || '请稍后重试'}`, 8000);
      } catch (error) { /* notice is best effort */ }
    }
  }

  function notifyRecovered(owner) {
    if (!notified.has(owner)) return;
    notified.delete(owner);
    recoveredSinceNotify.set(owner, true);
    if (typeof notice === 'function') {
      try { notice(`MemoFlow ${ownerLabel(owner)} 保存已恢复。`, 4000); } catch (error) { /* best effort */ }
    }
  }

  async function buildNext(owner, mutate, reserved) {
    const isReservedKey = reserved.includes(owner) && owner !== OWNER_SETTINGS && owner !== OWNER_LEDGER;
    if (owner !== OWNER_SETTINGS && owner !== OWNER_LEDGER && !isReservedKey) {
      fail('E_DATA_OWNER_INVALID', `unknown data owner: ${owner}`);
    }
    let snapshot;
    try {
      snapshot = await plugin.loadData();
    } catch (error) {
      return { error: { code: 'E_PERSIST_PREWRITE', phase: 'load', message: error && error.message } };
    }
    if (snapshot == null) snapshot = {};
    if (!isPlainObject(snapshot)) {
      return { error: { code: 'E_DATA_CORRUPT', phase: 'load', message: 'data.json is not an object; refusing to overwrite' } };
    }
    const current = sectionOf(snapshot, owner, reserved);
    let value;
    try {
      value = await mutate(clone(current));
    } catch (error) {
      return { error: { code: 'E_PERSIST_PREWRITE', phase: 'mutate', message: error && error.message } };
    }
    const next = { ...snapshot };
    if (isReservedKey) {
      // A dedicated reserved key has its own owner: it can never overwrite
      // settings or the ledger, and settings can never overwrite it.
      next[owner] = value;
    } else if (owner === OWNER_SETTINGS) {
      if (!isPlainObject(value)) {
        return { error: { code: 'E_DATA_OWNER_INVALID', phase: 'mutate', message: 'settings mutation must return an object' } };
      }
      // Reserved keys are owned by the ledger owner. The stripped settings
      // value cannot overwrite them, while a reserved key already present in
      // the persisted snapshot is kept untouched.
      Object.assign(next, stripReservedKeys(value, reserved));
    } else {
      next[ledgerKey] = value;
    }
    return { snapshot, next, value };
  }

  async function writeOnce(owner, mutate) {
    const built = await buildNext(owner, mutate, reservedKeys);
    if (built.error) {
      return finish(owner, built.error, { writesAttempted: false, verified: false });
    }
    try {
      await plugin.saveData(built.next);
    } catch (error) {
      // The save call threw: the file may or may not have changed.
      return finish(owner, {
        code: 'E_PERSIST_WRITE_UNKNOWN', phase: 'write', message: error && error.message,
      }, { writesAttempted: true, verified: false, uncertain: true });
    }
    if (!verifyAfter) {
      const result = { ok: true, verified: false, owner, code: null, pendingRetry: false, writesAttempted: true };
      lastResult = result;
      lastByOwner.set(owner, result);
      failures.delete(owner);
      notifyRecovered(owner);
      return result;
    }
    let back;
    try {
      back = await plugin.loadData();
    } catch (error) {
      return finish(owner, {
        code: 'E_PERSIST_UNVERIFIED', phase: 'verify', message: error && error.message,
      }, { writesAttempted: true, verified: false, uncertain: true });
    }
    if (!isPlainObject(back)) {
      return finish(owner, { code: 'E_PERSIST_UNVERIFIED', phase: 'verify', message: 'read-back is not an object' },
        { writesAttempted: true, verified: false, uncertain: true });
    }
    const expected = sectionOf(built.next, owner, reservedKeys);
    const actual = sectionOf(back, owner, reservedKeys);
    if (!sameSection(expected, actual)) {
      return finish(owner, { code: 'E_PERSIST_UNVERIFIED', phase: 'verify', message: 'read-back differs from the intended value' },
        { writesAttempted: true, verified: false, uncertain: true });
    }
    const result = { ok: true, verified: true, owner, code: null, pendingRetry: false, writesAttempted: true };
    lastResult = result;
    lastByOwner.set(owner, result);
    // Only this owner's failure is cleared, and only because this owner's write
    // was just written and read back successfully.
    failures.delete(owner);
    notifyRecovered(owner);
    return result;
  }

  function finish(owner, error, flags) {
    const result = {
      ok: false,
      verified: false,
      owner,
      code: error.code,
      phase: error.phase,
      message: error.message,
      writesAttempted: flags.writesAttempted,
      uncertain: flags.uncertain === true,
      pendingRetry: true,
    };
    lastResult = result;
    lastByOwner.set(owner, result);
    notifyFailure(result);
    return result;
  }

  function update(owner, mutate) {
    if (typeof mutate !== 'function') {
      return Promise.resolve({
        ok: false, verified: false, owner, code: 'E_DATA_OWNER_INVALID', phase: 'mutate',
        message: 'mutate must be a function', pendingRetry: false,
      });
    }
    pending += 1;
    const run = chain.then(() => writeOnce(owner, mutate));
    chain = run.then(() => undefined, () => undefined);
    return run.finally(() => { pending -= 1; });
  }

  function unresolvedList() {
    return [...failures.entries()].map(([owner, diagnostic]) => ({ owner, ...diagnostic }));
  }

  async function flush({ owner = null } = {}) {
    // Drain everything queued so far. Re-checks because callers may enqueue
    // another write while we wait.
    let guard = 0;
    do {
      await chain.catch(() => undefined);
      guard += 1;
    } while (pending > 0 && guard < 100);
    const unresolved = unresolvedList();
    if (owner) {
      // Owner-scoped flush answers "is THIS owner durable?"; it still reports
      // other owners' unresolved failures instead of hiding them.
      const failure = failures.get(owner);
      if (failure) {
        return {
          ok: false, verified: false, owner, code: failure.code, phase: failure.phase,
          pendingRetry: true, unresolved,
        };
      }
      const last = lastByOwner.get(owner) || null;
      return {
        ok: !last || last.ok !== false,
        verified: last ? last.verified === true : false,
        owner, code: null, idle: !last, unresolved,
      };
    }
    if (unresolved.length > 0) {
      // A global flush may not claim everything is persisted while any owner
      // still has an unresolved failure.
      return {
        ok: false, verified: false, owner: null, code: 'E_PERSIST_UNRESOLVED',
        pendingRetry: true, unresolved,
      };
    }
    if (lastResult) return { ...lastResult, unresolved };
    return { ok: true, verified: false, owner: null, code: null, pendingRetry: false, idle: true, unresolved };
  }

  function read(owner) {
    return (async () => {
      const snapshot = await plugin.loadData();
      if (snapshot == null) return owner === OWNER_LEDGER ? null : {};
      if (!isPlainObject(snapshot)) fail('E_DATA_CORRUPT', 'data.json is not an object');
      return sectionOf(snapshot, owner, reservedKeys);
    })();
  }

  function ledgerStore() {
    return {
      async loadData() {
        return read(OWNER_LEDGER);
      },
      async saveData(key, value) {
        // The ledger is the only owner of this key; reject a foreign key instead
        // of silently writing it into the ledger slot.
        if (key != null && key !== ledgerKey) {
          return { ok: false, verified: false, owner: OWNER_LEDGER, code: 'E_DATA_OWNER_INVALID', pendingRetry: false };
        }
        return update(OWNER_LEDGER, () => value);
      },
      async flush() {
        return flush({ owner: OWNER_LEDGER });
      },
    };
  }

  function state() {
    const unresolved = {};
    for (const owner of [OWNER_SETTINGS, OWNER_LEDGER, ...reservedKeys.filter(key => key !== ledgerKey)]) {
      unresolved[owner] = failures.get(owner) || null;
    }
    return {
      pending,
      reservedKeys: [...reservedKeys],
      ledgerKey,
      lastResult,
      lastByOwner: Object.fromEntries([...lastByOwner.entries()]),
      unresolved,
      diagnostics: unresolvedList(),
    };
  }

  function reservedStore(key) {
    if (!reservedKeys.includes(key) || key === ledgerKey) {
      fail('E_DATA_OWNER_INVALID', `reserved store key is not registered: ${key}`);
    }
    return {
      key,
      async load() {
        return read(key);
      },
      async save(value) {
        return update(key, () => value);
      },
    };
  }

  return {
    reservedKeys: [...reservedKeys],
    ledgerKey,
    reservedStore,
    update,
    flush,
    read,
    ledgerStore,
    state,
    stripReservedKeys: data => stripReservedKeys(data, reservedKeys),
  };
}

module.exports = {
  LEDGER_KEY,
  DEFAULT_RESERVED_KEYS,
  OWNER_SETTINGS,
  OWNER_LEDGER,
  stripReservedKeys,
  createPluginDataCoordinator,
};
