'use strict';

// Durable batch records for host-level batch operations (Mercy/Boost).
//
// A batch record is business state owned by the feature (preview digest,
// absolute targets, per-item before/after values, results). It lives in its
// own reserved data.json key, written through the PluginDataCoordinator so it
// can never be clobbered by settings or the event ledger.
//
// It is NOT a second event WAL: per-Topic writes still use the accepted
// protected write path, and the record exists to make retry/undo/recovery
// deterministic.

const BATCH_KEY = 'mfUs1Batches';
const UNFINISHED = new Set(['prepared', 'uncertain', 'partial', 'requires-manual-recovery']);

function createBatchStore({ coordinator, key = BATCH_KEY } = {}) {
  if (!coordinator || typeof coordinator.reservedStore !== 'function') {
    throw Object.assign(new Error('a PluginDataCoordinator is required'), { code: 'E_BATCH_STORE_REQUIRED' });
  }
  const store = coordinator.reservedStore(key);

  async function loadAll() {
    const value = await store.load();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function saveBatch(record) {
    if (!record || typeof record.batchId !== 'string' || !record.batchId) {
      return { ok: false, code: 'E_BATCH_RECORD_INVALID' };
    }
    const all = await loadAll();
    const next = { ...all, [record.batchId]: { ...record, updatedAt: new Date().toISOString() } };
    const result = await store.save(next);
    return result && result.ok ? { ok: true, verified: result.verified === true } : { ok: false, code: (result && result.code) || 'E_BATCH_SAVE_FAILED' };
  }

  async function getBatch(batchId) {
    const all = await loadAll();
    return all[batchId] || null;
  }

  async function listBatches({ kind = null, unfinishedOnly = false } = {}) {
    const all = await loadAll();
    return Object.values(all)
      .filter(record => (kind ? record.kind === kind : true))
      .filter(record => (unfinishedOnly ? UNFINISHED.has(record.status) : true))
      .sort((left, right) => String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')));
  }

  async function latestBatch(kind) {
    const list = await listBatches({ kind });
    return list.length ? list[list.length - 1] : null;
  }

  return { key, loadAll, saveBatch, getBatch, listBatches, latestBatch };
}

module.exports = { BATCH_KEY, UNFINISHED, createBatchStore };
