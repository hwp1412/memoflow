'use strict';

const SCHEMA_VERSION = 1;
const VERSION_RESTORE_SCHEMA_VERSION = 2;
const SUPPORTED_OPERATION_SCHEMAS = new Set([SCHEMA_VERSION, VERSION_RESTORE_SCHEMA_VERSION]);
const STATUSES = Object.freeze(['prepared', 'applied', 'verified', 'restored', 'failed', 'conflict']);
const UNRESOLVED_STATUSES = new Set(['prepared', 'applied', 'conflict', 'failed']);
const TRANSITIONS = Object.freeze({
  prepared: new Set(['applied', 'failed', 'conflict']),
  applied: new Set(['verified', 'failed', 'conflict']),
  verified: new Set(['restored']),
  restored: new Set(),
  failed: new Set(),
  conflict: new Set(),
});

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const SOFT_OPERATION_LIMIT = 20;
const NOTE_TYPE = 'extract';

class RefineError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'RefineError';
    this.code = code;
    this.details = details;
  }
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function isValidOperationId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function sha256Text(value) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new RefineError('CRYPTO_UNAVAILABLE', 'Web Crypto SHA-256 is unavailable');
  const bytes = new TextEncoder().encode(String(value));
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Split exact file text into a byte-preserving frontmatter prefix and body.
// Supports BOM, LF, CRLF, empty body and absence of frontmatter. Any
// frontmatter-looking malformed header is rejected rather than guessed.
function splitContent(content) {
  if (typeof content !== 'string') throw new RefineError('INVALID_CONTENT', 'content must be a string');
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const rest = content.slice(bom.length);
  if (!rest.startsWith('---')) {
    return {
      ok: true,
      bom,
      eol: rest.includes('\r\n') ? '\r\n' : '\n',
      hasFrontmatter: false,
      prefix: bom,
      frontmatter: '',
      body: rest,
      bodyStart: bom.length,
    };
  }

  const firstNewline = rest.indexOf('\n');
  if (firstNewline < 0) {
    throw new RefineError('MALFORMED_FRONTMATTER', 'frontmatter opening delimiter has no newline');
  }
  const openingLine = rest.slice(0, firstNewline).replace(/\r$/, '');
  if (openingLine !== '---') {
    throw new RefineError('MALFORMED_FRONTMATTER', 'frontmatter opening delimiter is malformed');
  }
  const eol = rest[firstNewline - 1] === '\r' ? '\r\n' : '\n';

  let position = firstNewline + 1;
  let closingEnd = -1;
  while (position <= rest.length) {
    const newline = rest.indexOf('\n', position);
    const lineEnd = newline < 0 ? rest.length : newline;
    const line = rest.slice(position, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      closingEnd = lineEnd;
      break;
    }
    if (newline < 0) break;
    position = newline + 1;
  }
  if (closingEnd < 0) {
    throw new RefineError('MALFORMED_FRONTMATTER', 'frontmatter closing delimiter is missing');
  }

  const prefixLength = bom.length + closingEnd + (closingEnd < rest.length ? 1 : 0);
  const prefix = content.slice(0, prefixLength);
  const body = content.slice(prefixLength);
  return {
    ok: true,
    bom,
    eol,
    hasFrontmatter: true,
    prefix,
    frontmatter: prefix.slice(bom.length),
    body,
    bodyStart: prefixLength,
  };
}

function parseFrontmatterType(content) {
  const split = splitContent(content);
  if (!split.hasFrontmatter) return { ok: false, code: 'CURRENT_TYPE_UNKNOWN' };
  const lines = split.frontmatter.split(/\r?\n/);
  const values = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const match = lines[i].match(/^type:\s*(.*)$/);
    if (match) values.push(match[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  if (values.length !== 1 || !values[0]) {
    return {
      ok: false,
      code: values.length > 1 ? 'CURRENT_TYPE_AMBIGUOUS' : 'CURRENT_TYPE_UNKNOWN',
    };
  }
  return { ok: true, type: values[0] };
}

function requireCurrentExtractType(content) {
  const parsed = parseFrontmatterType(content);
  if (!parsed.ok) throw new RefineError(parsed.code, 'current note type is not safely identifiable');
  if (parsed.type !== NOTE_TYPE) {
    throw new RefineError('CURRENT_TYPE_UNSUPPORTED', `current note type is ${parsed.type}, expected Extract`);
  }
  return parsed.type;
}

function validateSelection(split, selection) {
  if (!split || !split.ok) throw new RefineError('MALFORMED_FRONTMATTER', 'content cannot be safely split');
  if (!selection || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)) {
    throw new RefineError('INVALID_SELECTION', 'selection start/end must be integers');
  }
  if (selection.start < 0 || selection.end <= selection.start || selection.end > split.body.length) {
    throw new RefineError('INVALID_SELECTION', 'selection must be a non-empty body range');
  }
  const selectedText = split.body.slice(selection.start, selection.end);
  if (selection.selectedText != null && selection.selectedText !== selectedText) {
    throw new RefineError('SELECTION_MISMATCH', 'selection text does not match the current body');
  }
  return { start: selection.start, end: selection.end, selectedText };
}

function validateIdentity({ operationId, notePath, noteType, createdAt, toolVersion }) {
  if (!isValidOperationId(operationId)) throw new RefineError('INVALID_OPERATION_ID', 'operationId must be a UUID');
  if (!notePath || typeof notePath !== 'string') throw new RefineError('INVALID_NOTE_PATH', 'notePath is required');
  if (noteType !== NOTE_TYPE) throw new RefineError('UNSUPPORTED_NOTE_TYPE', 'only Extract is supported');
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new RefineError('INVALID_TIMESTAMP', 'createdAt must be an ISO timestamp');
  }
  if (toolVersion != null && typeof toolVersion !== 'string') {
    throw new RefineError('INVALID_TOOL_VERSION', 'toolVersion must be a string');
  }
}

async function buildSnapshot(fullContent) {
  const split = splitContent(fullContent);
  const prefixHash = await sha256Text(split.prefix);
  const bodyHash = await sha256Text(split.body);
  const fullHash = await sha256Text(fullContent);
  return { split, prefixHash, bodyHash, fullHash };
}

async function createRefineOperation({
  operationId,
  notePath,
  noteType = NOTE_TYPE,
  fullContent,
  selection,
  replacementText = '',
  createdAt = new Date().toISOString(),
  toolVersion = '1.0.0',
}) {
  validateIdentity({ operationId, notePath, noteType, createdAt, toolVersion });
  if (typeof fullContent !== 'string') throw new RefineError('INVALID_CONTENT', 'fullContent is required');
  if (utf8Bytes(fullContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', `note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`);
  }
  requireCurrentExtractType(fullContent);
  const before = await buildSnapshot(fullContent);
  const range = validateSelection(before.split, selection);
  const replacement = String(replacementText == null ? '' : replacementText);
  const afterBody = before.split.body.slice(0, range.start) + replacement + before.split.body.slice(range.end);
  const afterContent = before.split.prefix + afterBody;
  if (utf8Bytes(afterContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', `refined note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`);
  }
  const afterBodyHash = await sha256Text(afterBody);
  const afterFullHash = await sha256Text(afterContent);

  const operation = {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    createdAt,
    toolVersion,
    restoreOf: null,
    note: {
      path: notePath,
      type: NOTE_TYPE,
      bodyStart: before.split.bodyStart,
      bodyBytes: utf8Bytes(before.split.body),
      fullBytes: utf8Bytes(fullContent),
      frontmatterHash: before.prefixHash,
      bodyHash: before.bodyHash,
      fullHash: before.fullHash,
    },
    before: {
      fullContent,
      frontmatter: before.split.prefix,
      body: before.split.body,
    },
    after: {
      body: afterBody,
      bodyBytes: utf8Bytes(afterBody),
      fullBytes: utf8Bytes(afterContent),
      frontmatterHash: before.prefixHash,
      bodyHash: afterBodyHash,
      fullHash: afterFullHash,
    },
    selection: {
      start: range.start,
      end: range.end,
      selectedText: range.selectedText,
      replacementText: replacement,
    },
  };
  const serializedBytes = utf8Bytes(JSON.stringify(operation));
  if (serializedBytes > MAX_HISTORY_BYTES) {
    throw new RefineError('HISTORY_TOO_LARGE', `history record exceeds ${MAX_HISTORY_BYTES} UTF-8 bytes`);
  }
  return operation;
}

function validateRestoreTargetShape(operation, afterBodyHash, afterBodyBytes) {
  if (!operation.restoreOf || !isValidOperationId(operation.restoreOf)) {
    throw new RefineError('INVALID_RESTORE_TARGET', 'v2 restore requires restoreOf');
  }
  const target = operation.restoreTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new RefineError('INVALID_RESTORE_TARGET', 'v2 operation requires restoreTarget');
  }
  if (!isValidOperationId(target.operationId)) {
    throw new RefineError('INVALID_RESTORE_TARGET', 'restoreTarget.operationId must be a UUID');
  }
  if (target.operationId !== operation.restoreOf) {
    throw new RefineError('RESTORE_TARGET_MISMATCH', 'restoreTarget.operationId must equal restoreOf');
  }
  if (target.operationId === operation.operationId) {
    throw new RefineError('RESTORE_CYCLE', 'restoreTarget must not reference itself');
  }
  if (target.side !== 'before' && target.side !== 'after') {
    throw new RefineError('INVALID_RESTORE_TARGET', 'restoreTarget.side must be before or after');
  }
  if (target.bodyHash !== afterBodyHash) {
    throw new RefineError('RESTORE_TARGET_HASH_MISMATCH', 'restoreTarget.bodyHash must match after body');
  }
  if (target.bodyBytes !== afterBodyBytes) {
    throw new RefineError('RESTORE_TARGET_HASH_MISMATCH', 'restoreTarget.bodyBytes must match after body');
  }
}

async function validateOperationIntegrity(operation) {
  if (!operation || typeof operation !== 'object') throw new RefineError('INVALID_HISTORY', 'history record is not an object');
  const schemaVersion = operation.schemaVersion;
  if (!SUPPORTED_OPERATION_SCHEMAS.has(schemaVersion)) {
    throw new RefineError('UNSUPPORTED_SCHEMA', 'unsupported history schema');
  }
  if (schemaVersion === SCHEMA_VERSION && operation.restoreTarget != null) {
    throw new RefineError('INVALID_RESTORE_TARGET', 'v1 operation must not contain restoreTarget');
  }
  validateIdentity({
    operationId: operation.operationId,
    notePath: operation.note && operation.note.path,
    noteType: operation.note && operation.note.type,
    createdAt: operation.createdAt,
    toolVersion: operation.toolVersion,
  });
  if (!operation.before || typeof operation.before.fullContent !== 'string' || typeof operation.before.body !== 'string') {
    throw new RefineError('INVALID_HISTORY', 'missing before snapshot');
  }
  if (!operation.after || typeof operation.after.body !== 'string') {
    throw new RefineError('INVALID_HISTORY', 'missing after body');
  }
  if (utf8Bytes(operation.before.fullContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', 'before snapshot exceeds note limit');
  }
  requireCurrentExtractType(operation.before.fullContent);
  const split = splitContent(operation.before.fullContent);
  if (split.body !== operation.before.body || split.prefix !== operation.before.frontmatter) {
    throw new RefineError('HISTORY_INTEGRITY', 'stored frontmatter/body split does not match full content');
  }
  let range;
  try {
    range = validateSelection(split, operation.selection);
  } catch (error) {
    if (error instanceof RefineError && error.code === 'SELECTION_MISMATCH') {
      throw new RefineError('HISTORY_INTEGRITY', 'stored selected text does not match before body');
    }
    throw error;
  }
  const expectedAfterBody = split.body.slice(0, range.start) + String(operation.selection.replacementText || '') + split.body.slice(range.end);
  if (expectedAfterBody !== operation.after.body) {
    throw new RefineError('HISTORY_INTEGRITY', 'stored after body does not match selection replacement');
  }
  const afterContent = split.prefix + operation.after.body;
  const frontmatterHash = await sha256Text(split.prefix);
  const beforeBodyHash = await sha256Text(split.body);
  const beforeFullHash = await sha256Text(operation.before.fullContent);
  const afterBodyHash = await sha256Text(operation.after.body);
  const afterFullHash = await sha256Text(afterContent);
  const note = operation.note;
  if (note.bodyStart !== split.bodyStart || note.bodyHash !== beforeBodyHash
    || note.frontmatterHash !== frontmatterHash || note.fullHash !== beforeFullHash
    || note.fullBytes !== utf8Bytes(operation.before.fullContent) || note.bodyBytes !== utf8Bytes(split.body)) {
    throw new RefineError('HISTORY_INTEGRITY', 'before snapshot hashes do not match');
  }
  if (operation.after.bodyHash !== afterBodyHash || operation.after.fullHash !== afterFullHash
    || operation.after.frontmatterHash !== frontmatterHash
    || operation.after.bodyBytes !== utf8Bytes(operation.after.body)
    || operation.after.fullBytes !== utf8Bytes(afterContent)) {
    throw new RefineError('HISTORY_INTEGRITY', 'after hashes do not match');
  }
  if (schemaVersion === VERSION_RESTORE_SCHEMA_VERSION) {
    validateRestoreTargetShape(operation, afterBodyHash, utf8Bytes(operation.after.body));
  }
  if (utf8Bytes(operation.after.body) > MAX_NOTE_BYTES || utf8Bytes(JSON.stringify(operation)) > MAX_HISTORY_BYTES) {
    throw new RefineError('HISTORY_TOO_LARGE', 'history exceeds size limit');
  }
  return { operation, split, beforeBodyHash, afterBodyHash, frontmatterHash, afterContent };
}

function makeState(operationId, status = 'prepared', at = new Date().toISOString()) {
  if (!isValidOperationId(operationId)) throw new RefineError('INVALID_OPERATION_ID', 'operationId must be a UUID');
  if (!STATUSES.includes(status)) throw new RefineError('INVALID_STATUS', 'unknown history status');
  return { schemaVersion: SCHEMA_VERSION, operationId, status, updatedAt: at, recovery: [] };
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].has(to));
}

function validateState(state, operationId) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) throw new RefineError('INVALID_STATE', 'invalid state schema');
  if (state.operationId !== operationId) throw new RefineError('STATE_ID_MISMATCH', 'state operationId mismatch');
  if (!STATUSES.includes(state.status)) throw new RefineError('INVALID_STATUS', 'unknown state status');
  if (typeof state.updatedAt !== 'string' || Number.isNaN(Date.parse(state.updatedAt))) {
    throw new RefineError('INVALID_STATE', 'state updatedAt is invalid');
  }
  if (!Array.isArray(state.recovery)) throw new RefineError('INVALID_STATE', 'state recovery must be an array');
  return state;
}

function isUnresolvedStatus(status) {
  return UNRESOLVED_STATUSES.has(status);
}

async function createRestoreOperation({
  operationId,
  latestOperation,
  currentContent,
  currentNotePath,
  currentNoteType = NOTE_TYPE,
  createdAt = new Date().toISOString(),
  toolVersion = '1.0.0',
}) {
  const actualCurrentType = requireCurrentExtractType(currentContent);
  if (currentNoteType && currentNoteType !== actualCurrentType) {
    throw new RefineError('CURRENT_TYPE_MISMATCH', 'caller noteType does not match current Frontmatter');
  }
  validateIdentity({ operationId, notePath: currentNotePath, noteType: actualCurrentType, createdAt, toolVersion });
  if (currentNotePath !== latestOperation?.note?.path) {
    throw new RefineError('NOTE_PATH_MISMATCH', 'history belongs to a different note path');
  }
  await validateOperationIntegrity(latestOperation);
  if (utf8Bytes(currentContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', 'current note exceeds size limit');
  }
  const current = await buildSnapshot(currentContent);
  if (current.bodyHash !== latestOperation.after.bodyHash) {
    throw new RefineError('RESTORE_CONFLICT', 'current body does not match the refined version');
  }
  // Preserve the current frontmatter bytes; restore only the body.
  const afterBody = latestOperation.before.body;
  const afterContent = current.split.prefix + afterBody;
  if (utf8Bytes(afterContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', 'restored note exceeds size limit');
  }
  const afterBodyHash = await sha256Text(afterBody);
  const afterFullHash = await sha256Text(afterContent);
  const operation = {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    createdAt,
    toolVersion,
    restoreOf: latestOperation.operationId,
    note: {
      path: currentNotePath,
      type: NOTE_TYPE,
      bodyStart: current.split.bodyStart,
      bodyBytes: utf8Bytes(current.split.body),
      fullBytes: utf8Bytes(currentContent),
      frontmatterHash: current.prefixHash,
      bodyHash: current.bodyHash,
      fullHash: current.fullHash,
    },
    before: {
      fullContent: currentContent,
      frontmatter: current.split.prefix,
      body: current.split.body,
    },
    after: {
      body: afterBody,
      bodyBytes: utf8Bytes(afterBody),
      fullBytes: utf8Bytes(afterContent),
      frontmatterHash: current.prefixHash,
      bodyHash: afterBodyHash,
      fullHash: afterFullHash,
    },
    selection: {
      start: 0,
      end: current.split.body.length,
      selectedText: current.split.body,
      replacementText: afterBody,
    },
  };
  if (utf8Bytes(JSON.stringify(operation)) > MAX_HISTORY_BYTES) {
    throw new RefineError('HISTORY_TOO_LARGE', 'restore history exceeds size limit');
  }
  return operation;
}

async function createVersionRestoreOperation({
  operationId,
  currentContent,
  currentNotePath,
  targetOperation,
  targetSide = 'after',
  createdAt = new Date().toISOString(),
  toolVersion = '1.0.0',
}) {
  const currentType = requireCurrentExtractType(currentContent);
  validateIdentity({ operationId, notePath: currentNotePath, noteType: currentType, createdAt, toolVersion });
  if (targetSide !== 'before' && targetSide !== 'after') {
    throw new RefineError('INVALID_RESTORE_TARGET', 'targetSide must be before or after');
  }
  await validateOperationIntegrity(targetOperation);
  if (targetOperation.note.path !== currentNotePath) {
    throw new RefineError('RESTORE_CROSS_NOTE', 'restore target belongs to another note');
  }
  const targetBody = targetSide === 'before' ? targetOperation.before.body : targetOperation.after.body;
  const targetBodyHash = await sha256Text(targetBody);
  const targetBodyBytes = utf8Bytes(targetBody);
  if (utf8Bytes(currentContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', 'current note exceeds size limit');
  }
  const current = await buildSnapshot(currentContent);
  const afterContent = current.split.prefix + targetBody;
  if (utf8Bytes(afterContent) > MAX_NOTE_BYTES) {
    throw new RefineError('NOTE_TOO_LARGE', 'restored note exceeds size limit');
  }
  const afterFullHash = await sha256Text(afterContent);
  const operation = {
    schemaVersion: VERSION_RESTORE_SCHEMA_VERSION,
    operationId,
    createdAt,
    toolVersion,
    restoreOf: targetOperation.operationId,
    restoreTarget: {
      operationId: targetOperation.operationId,
      side: targetSide,
      bodyHash: targetBodyHash,
      bodyBytes: targetBodyBytes,
    },
    note: {
      path: currentNotePath,
      type: NOTE_TYPE,
      bodyStart: current.split.bodyStart,
      bodyBytes: utf8Bytes(current.split.body),
      fullBytes: utf8Bytes(currentContent),
      frontmatterHash: current.prefixHash,
      bodyHash: current.bodyHash,
      fullHash: current.fullHash,
    },
    before: {
      fullContent: currentContent,
      frontmatter: current.split.prefix,
      body: current.split.body,
    },
    after: {
      body: targetBody,
      bodyBytes: targetBodyBytes,
      fullBytes: utf8Bytes(afterContent),
      frontmatterHash: current.prefixHash,
      bodyHash: targetBodyHash,
      fullHash: afterFullHash,
    },
    selection: {
      start: 0,
      end: current.split.body.length,
      selectedText: current.split.body,
      replacementText: targetBody,
    },
  };
  if (utf8Bytes(JSON.stringify(operation)) > MAX_HISTORY_BYTES) {
    throw new RefineError('HISTORY_TOO_LARGE', 'version restore history exceeds size limit');
  }
  await validateOperationIntegrity(operation);
  return operation;
}

function assertNoRestoreCycle(operation, operationsById = null) {
  if (!operation || !operation.operationId) return;
  const seen = new Set();
  let current = operation;
  while (current && current.restoreOf) {
    if (current.restoreOf === operation.operationId) {
      throw new RefineError('RESTORE_CYCLE', 'restoreOf cycle detected');
    }
    if (seen.has(current.restoreOf)) {
      throw new RefineError('RESTORE_CYCLE', 'restoreOf cycle detected');
    }
    seen.add(current.restoreOf);
    if (!operationsById || !operationsById.has(current.restoreOf)) break;
    current = operationsById.get(current.restoreOf);
  }
}

function classifyCompletedEntry(entry) {
  const operation = entry && entry.operation;
  const state = entry && entry.state;
  if (!operation || !state || state.missingState) {
    throw new RefineError('UNRESOLVED_HISTORY', 'history entry state is missing');
  }
  if (isUnresolvedStatus(state.status)) {
    throw new RefineError('UNRESOLVED_HISTORY', 'history entry is unresolved', { status: state.status });
  }
  if (!operation.restoreOf && state.status === 'restored') {
    throw new RefineError('INVALID_HISTORY_STATE', 'ordinary refine operation cannot be restored');
  }
  if (operation.restoreOf && state.status === 'verified') {
    throw new RefineError('RESTORE_PENDING', 'restore event is verified but not finalized');
  }
  if (state.status !== 'verified' && state.status !== 'restored') {
    throw new RefineError('INVALID_HISTORY_STATE', `unsupported completed status: ${state.status}`);
  }
  return entry;
}

function latestTrustedState(entries = []) {
  if (!entries.length) throw new RefineError('NO_TRUSTED_STATE', 'no completed history state');
  for (const entry of entries) classifyCompletedEntry(entry);
  const entry = entries[entries.length - 1];
  const operation = entry.operation;
  return {
    entry,
    operation,
    state: entry.state,
    operationId: operation.operationId,
    bodyHash: operation.after.bodyHash,
    bodyBytes: operation.after.bodyBytes,
    index: entries.length - 1,
  };
}

async function assertCurrentTrustedState({ entries, notePath, currentContent, editorContent = null }) {
  const trusted = latestTrustedState(entries);
  if (trusted.operation.note.path !== notePath) {
    throw new RefineError('RESTORE_CROSS_NOTE', 'history belongs to another note');
  }
  if (typeof currentContent !== 'string') {
    throw new RefineError('INVALID_CONTENT', 'currentContent is required');
  }
  if (editorContent != null && editorContent !== currentContent) {
    throw new RefineError('EDITOR_NOT_SAVED', 'editor content is not saved to disk');
  }
  requireCurrentExtractType(currentContent);
  const split = splitContent(currentContent);
  const currentBodyHash = await sha256Text(split.body);
  if (currentBodyHash !== trusted.bodyHash) {
    throw new RefineError('CURRENT_BODY_NOT_TRUSTED', 'current body does not match latest trusted history');
  }
  return { trusted, split, currentBodyHash, currentBodyBytes: utf8Bytes(split.body) };
}

async function validateRestoreRelationship(operation, referencedOperation, { operationsById = null } = {}) {

  if (!operation || !operation.restoreOf) {
    throw new RefineError('NOT_RESTORE_OPERATION', 'operation is not a restore event');
  }
  if (!referencedOperation || referencedOperation.operationId !== operation.restoreOf) {
    throw new RefineError('RESTORE_REFERENCE_MISSING', 'restoreOf does not reference an existing operation');
  }
  await validateOperationIntegrity(operation);
  await validateOperationIntegrity(referencedOperation);
  if (operation.note.path !== referencedOperation.note.path
    || operation.note.type !== referencedOperation.note.type) {
    throw new RefineError('RESTORE_RELATION_MISMATCH', 'restore and referenced note identities differ');
  }
  if (operation.schemaVersion === VERSION_RESTORE_SCHEMA_VERSION) {
    const target = operation.restoreTarget;
    if (!target || target.operationId !== referencedOperation.operationId) {
      throw new RefineError('RESTORE_REFERENCE_MISSING', 'restoreTarget does not reference the target operation');
    }
    if (Date.parse(referencedOperation.createdAt) > Date.parse(operation.createdAt)) {
      throw new RefineError('RESTORE_TARGET_NOT_EARLIER', 'restore target must not be newer than the restore event');
    }
    assertNoRestoreCycle(operation, operationsById);
    const targetBody = target.side === 'before' ? referencedOperation.before.body : referencedOperation.after.body;
    const targetHash = await sha256Text(targetBody);
    if (targetHash !== target.bodyHash || target.bodyHash !== operation.after.bodyHash
      || target.bodyBytes !== utf8Bytes(targetBody)
      || operation.after.body !== targetBody) {
      throw new RefineError('RESTORE_RELATION_MISMATCH', 'version restore body relationship does not match target');
    }
    return true;
  }
  if (operation.note.bodyHash !== referencedOperation.after.bodyHash
    || operation.after.body !== referencedOperation.before.body) {
    throw new RefineError('RESTORE_RELATION_MISMATCH', 'restore body relation does not match referenced operation');
  }
  return true;
}

async function planRestore({ latestOperation, currentContent, currentNotePath, currentNoteType = NOTE_TYPE }) {
  const actualCurrentType = requireCurrentExtractType(currentContent);
  if (latestOperation?.note?.type !== NOTE_TYPE || currentNoteType && currentNoteType !== actualCurrentType) {
    throw new RefineError('UNSUPPORTED_NOTE_TYPE', 'only Extract is supported');
  }
  return createRestoreOperation({
    operationId: globalThis.crypto.randomUUID(),
    latestOperation,
    currentContent,
    currentNotePath,
    currentNoteType: actualCurrentType,
  });
}

module.exports = {
  SCHEMA_VERSION,
  VERSION_RESTORE_SCHEMA_VERSION,
  SUPPORTED_OPERATION_SCHEMAS,
  STATUSES,
  UNRESOLVED_STATUSES,
  TRANSITIONS,
  MAX_NOTE_BYTES,
  MAX_HISTORY_BYTES,
  SOFT_OPERATION_LIMIT,
  NOTE_TYPE,
  RefineError,
  utf8Bytes,
  sha256Text,
  isValidOperationId,
  splitContent,
  parseFrontmatterType,
  requireCurrentExtractType,
  validateSelection,
  createRefineOperation,
  validateOperationIntegrity,
  makeState,
  canTransition,
  validateState,
  isUnresolvedStatus,
  createRestoreOperation,
  createVersionRestoreOperation,
  validateRestoreRelationship,
  assertNoRestoreCycle,
  classifyCompletedEntry,
  latestTrustedState,
  assertCurrentTrustedState,
  planRestore,
};
