'use strict';

const {
  MAX_HISTORY_BYTES,
  SOFT_OPERATION_LIMIT,
  RefineError,
  utf8Bytes,
  isValidOperationId,
  createRefineOperation,
  validateOperationIntegrity,
  makeState,
  canTransition,
  validateState,
  isUnresolvedStatus,
  createRestoreOperation,
  requireCurrentExtractType,
  splitContent,
  sha256Text,
} = require('./refine-history.js');

const DEFAULT_HISTORY_ROOT = 'MemoFlow History/refine';

function normalizePath(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = path.split('/');
  if (!path || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new RefineError('INVALID_PATH', `unsafe path: ${value}`);
  }
  return path;
}

function joinPath(root, name) {
  return `${root}/${name}`;
}

class RefineHistoryStore {
  constructor({ adapter, historyRoot = DEFAULT_HISTORY_ROOT, now = () => new Date().toISOString() } = {}) {
    if (!adapter) throw new RefineError('ADAPTER_REQUIRED', 'history store requires an adapter');
    this.adapter = adapter;
    this.root = normalizePath(historyRoot);
    this.now = now;
  }

  operationPath(operationId) {
    if (!isValidOperationId(operationId)) throw new RefineError('INVALID_OPERATION_ID', 'operationId must be a UUID');
    return joinPath(this.root, `${operationId}.json`);
  }

  statePath(operationId) {
    if (!isValidOperationId(operationId)) throw new RefineError('INVALID_OPERATION_ID', 'operationId must be a UUID');
    return joinPath(this.root, `${operationId}.state.json`);
  }

  async ensureRoot() {
    let current = '';
    for (const part of this.root.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (!await this.adapter.exists(current)) {
        await this.adapter.mkdir(current);
      }
    }
  }

  async writeAtomic(path, text, { mustNotExist = false, tempSuffix = 'tmp' } = {}) {
    await this.ensureRoot();
    if (mustNotExist && await this.adapter.exists(path)) {
      throw new RefineError('DUPLICATE_OPERATION', `history already exists: ${path}`);
    }
    const temp = `${path}.${tempSuffix}-${Math.random().toString(36).slice(2)}`;
    try {
      await this.adapter.write(temp, text);
      const tempReadback = await this.adapter.read(temp);
      if (tempReadback !== text) {
        throw new RefineError('HISTORY_READBACK_MISMATCH', `history temp readback mismatch: ${temp}`, { tempPath: temp });
      }
      if (mustNotExist && await this.adapter.exists(path)) {
        throw new RefineError('DUPLICATE_OPERATION', `history already exists: ${path}`, { tempPath: temp });
      }
      await this.adapter.rename(temp, path);
      const finalReadback = await this.adapter.read(path);
      if (finalReadback !== text) {
        throw new RefineError('HISTORY_READBACK_MISMATCH', `history final readback mismatch: ${path}`, { path, tempPath: temp });
      }
    } catch (error) {
      if (error instanceof RefineError) throw error;
      throw new RefineError('HISTORY_WRITE_FAILED', error.message || 'history write failed', { path, tempPath: temp });
    }
  }

  async readText(path, code = 'HISTORY_MISSING') {
    if (!await this.adapter.exists(path)) throw new RefineError(code, `missing history file: ${path}`);
    try {
      return await this.adapter.read(path);
    } catch (error) {
      throw new RefineError('HISTORY_READ_FAILED', error.message || 'history read failed', { path });
    }
  }

  async assertNoUnresolved(notePath) {
    const entries = await this.listEntries(notePath);
    const unresolved = entries.filter(entry => isUnresolvedStatus(entry.state.status) || entry.state.missingState);
    if (unresolved.length) {
      throw new RefineError('UNRESOLVED_HISTORY', 'note has unresolved refine history', {
        count: unresolved.length,
        operationIds: unresolved.map(entry => entry.operation.operationId),
      });
    }
    return entries;
  }

  async writeOperation(operation) {
    await validateOperationIntegrity(operation);
    const state = makeState(operation.operationId, 'prepared', this.now());
    const bytes = utf8Bytes(JSON.stringify(operation));
    if (bytes > MAX_HISTORY_BYTES) throw new RefineError('HISTORY_TOO_LARGE', 'history record too large');
    const opPath = this.operationPath(operation.operationId);
    if (await this.adapter.exists(opPath)) {
      throw new RefineError('DUPLICATE_OPERATION', `history already exists: ${operation.operationId}`);
    }
    const existingEntries = await this.assertNoUnresolved(operation.note.path);
    const previousCount = existingEntries.length;
    await this.writeAtomic(opPath, JSON.stringify(operation, null, 2), { mustNotExist: true, tempSuffix: 'op-tmp' });
    // The immutable snapshot must be independently readable and valid.
    const readback = JSON.parse(await this.readText(opPath));
    await validateOperationIntegrity(readback);
    const statePath = this.statePath(operation.operationId);
    try {
      await this.writeAtomic(statePath, JSON.stringify(state, null, 2), { mustNotExist: true, tempSuffix: 'state-tmp' });
      const stateReadback = JSON.parse(await this.readText(statePath));
      validateState(stateReadback, operation.operationId);
    } catch (error) {
      if (error instanceof RefineError) {
        error.details = { ...(error.details || {}), operationPersisted: true, operationPath: opPath };
        throw error;
      }
      throw new RefineError('STATE_WRITE_FAILED', error.message || 'state write failed', {
        operationPersisted: true,
        operationPath: opPath,
      });
    }
    return { operation: readback, state, softLimitExceeded: previousCount >= SOFT_OPERATION_LIMIT };
  }

  async prepareRefine(args) {
    const operation = await createRefineOperation(args);
    return this.writeOperation(operation);
  }

  async readOperation(operationId) {
    const text = await this.readText(this.operationPath(operationId));
    let operation;
    try {
      operation = JSON.parse(text);
    } catch (error) {
      throw new RefineError('HISTORY_CORRUPT', 'history JSON is corrupt', { operationId });
    }
    await validateOperationIntegrity(operation);
    return operation;
  }

  async readState(operationId) {
    const text = await this.readText(this.statePath(operationId), 'STATE_MISSING');
    let state;
    try {
      state = JSON.parse(text);
    } catch (error) {
      throw new RefineError('STATE_CORRUPT', 'history state JSON is corrupt', { operationId });
    }
    return validateState(state, operationId);
  }

  async readEntry(operationId) {
    const operation = await this.readOperation(operationId);
    const state = await this.readState(operationId);
    return { operation, state };
  }

  async _writeStatus(operationId, status, { recovery = [], at = this.now() } = {}) {
    const { operation, state } = await this.readEntry(operationId);
    if (!canTransition(state.status, status)) {
      throw new RefineError('INVALID_STATUS_TRANSITION', `cannot transition ${state.status} -> ${status}`, {
        operationId,
        from: state.status,
        to: status,
      });
    }
    const next = {
      ...state,
      status,
      updatedAt: at,
      recovery: [...(state.recovery || []), ...recovery],
    };
    validateState(next, operation.operationId);
    const statePath = this.statePath(operationId);
    await this.writeAtomic(statePath, JSON.stringify(next, null, 2), { tempSuffix: 'state-tmp' });
    const readback = JSON.parse(await this.readText(statePath));
    validateState(readback, operationId);
    return readback;
  }

  async setStatus(operationId, status, options = {}) {
    if (status === 'verified' || status === 'restored') {
      throw new RefineError('VERIFICATION_REQUIRED', `${status} requires content verification`);
    }
    return this._writeStatus(operationId, status, options);
  }

  async markVerified(operationId, currentContent) {
    const { operation, state } = await this.readEntry(operationId);
    if (state.status !== 'applied') {
      throw new RefineError('VERIFICATION_REQUIRED', 'only an applied operation can be verified');
    }
    requireCurrentExtractType(currentContent);
    const currentBody = splitContent(currentContent).body;
    const currentHash = await sha256Text(currentBody);
    if (currentHash !== operation.after.bodyHash) {
      throw new RefineError('VERIFICATION_MISMATCH', 'current body does not match expected after hash');
    }
    return this._writeStatus(operationId, 'verified', { recovery: [{ at: this.now(), reason: 'body hash verified' }] });
  }

  async markRestored(operationId, currentContent) {
    const { operation, state } = await this.readEntry(operationId);
    if (state.status !== 'verified') {
      throw new RefineError('VERIFICATION_REQUIRED', 'only a verified operation can be marked restored');
    }
    requireCurrentExtractType(currentContent);
    const currentBody = splitContent(currentContent).body;
    const currentHash = await sha256Text(currentBody);
    if (currentHash !== operation.after.bodyHash) {
      throw new RefineError('VERIFICATION_MISMATCH', 'current body does not match expected after hash');
    }
    return this._writeStatus(operationId, 'restored', { recovery: [{ at: this.now(), reason: 'restored body verified' }] });
  }

  async listFiles() {
    if (!await this.adapter.exists(this.root)) return [];
    const listing = await this.adapter.list(this.root);
    const files = Array.isArray(listing) ? listing : (listing.files || []);
    return files
      .map(file => String(file).split('/').pop())
      .filter(name => name.endsWith('.json') && !name.endsWith('.state.json') && !name.includes('.op-tmp-') && !name.includes('.state-tmp-'))
      .sort();
  }

  async listEntries(notePath) {
    const files = await this.listFiles();
    const entries = [];
    for (const file of files) {
      const operationId = file.slice(0, -5);
      let operation;
      let state;
      try {
        operation = await this.readOperation(operationId);
        state = await this.readState(operationId);
      } catch (error) {
        if (error.code === 'STATE_MISSING') {
          // The immutable history exists but its state is missing. Keep it
          // visible as unresolved instead of silently ignoring it.
          operation = await this.readOperation(operationId);
          state = { operationId, status: 'conflict', updatedAt: this.now(), recovery: [], missingState: true };
        } else {
          throw error;
        }
      }
      if (operation.note.path === notePath) entries.push({ operation, state });
    }
    entries.sort((a, b) => {
      const byCreated = String(a.operation.createdAt).localeCompare(String(b.operation.createdAt));
      if (byCreated !== 0) return byCreated;
      const byState = String(a.state.updatedAt).localeCompare(String(b.state.updatedAt));
      if (byState !== 0) return byState;
      return String(a.operation.operationId).localeCompare(String(b.operation.operationId));
    });
    return entries;
  }

  async historyCount(notePath) {
    return (await this.listEntries(notePath)).length;
  }

  async latestVerified(notePath) {
    const entries = await this.listEntries(notePath);
    const unresolved = entries.filter(entry => isUnresolvedStatus(entry.state.status) || entry.state.missingState);
    if (unresolved.length) {
      throw new RefineError('UNRESOLVED_HISTORY', 'note has unresolved refine history', {
        count: unresolved.length,
        operationIds: unresolved.map(entry => entry.operation.operationId),
      });
    }
    const verified = entries.filter(entry => entry.state.status === 'verified');
    if (!verified.length) throw new RefineError('NO_VERIFIED_HISTORY', 'no verified refine history for note');
    return verified[verified.length - 1];
  }

  // A verified restore is itself a valid current-state history event. Keep
  // latestVerified for the original operation and expose the resolved view
  // used by restore planning.
  async latestRestorable(notePath) {
    const entries = await this.listEntries(notePath);
    const unresolved = entries.filter(entry => isUnresolvedStatus(entry.state.status) || entry.state.missingState);
    if (unresolved.length) {
      throw new RefineError('UNRESOLVED_HISTORY', 'note has unresolved refine history', {
        count: unresolved.length,
        operationIds: unresolved.map(entry => entry.operation.operationId),
      });
    }
    const resolved = entries.filter(entry => entry.state.status === 'verified' || entry.state.status === 'restored');
    if (!resolved.length) throw new RefineError('NO_VERIFIED_HISTORY', 'no verified or restored history for note');
    return resolved[resolved.length - 1];
  }

  async planRestore(notePath, currentContent) {
    const currentType = requireCurrentExtractType(currentContent);
    const latest = await this.latestRestorable(notePath);
    const operation = await createRestoreOperation({
      operationId: globalThis.crypto.randomUUID(),
      latestOperation: latest.operation,
      currentContent,
      currentNotePath: notePath,
      currentNoteType: currentType,
    });
    return { latest, operation };
  }

  // 1A only prepares the restore history/plan. 1B must revalidate the real
  // editor/disk state before writing the note body.
  async writeRestorePlan(plan) {
    return this.writeOperation(plan.operation);
  }
}

module.exports = {
  DEFAULT_HISTORY_ROOT,
  RefineHistoryStore,
  normalizePath,
};
