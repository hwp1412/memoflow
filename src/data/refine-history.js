'use strict';

const SCHEMA_VERSION = 1;
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

async function validateOperationIntegrity(operation) {
  if (!operation || typeof operation !== 'object') throw new RefineError('INVALID_HISTORY', 'history record is not an object');
  if (operation.schemaVersion !== SCHEMA_VERSION) throw new RefineError('UNSUPPORTED_SCHEMA', 'unsupported history schema');
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

async function validateRestoreRelationship(operation, referencedOperation) {
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
  validateRestoreRelationship,
  planRestore,
};
