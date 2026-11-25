'use strict';

// Minimal, format-preserving frontmatter merge for migration (PR-08).
//
// Only approved keys are updated; existing order, unknown fields, comments and
// the body are preserved. LF and CRLF are handled separately, a UTF-8 BOM is
// kept, and files without a closed YAML block are refused instead of guessing.

const { fail } = require('./errors.js');

function serializeValue(value) {
  if (value === null) return 'null';
  return String(value);
}

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function mergeFrontmatter(content, fields) {
  if (typeof content !== 'string') {
    fail('E_CONTENT_INVALID', 'file content must be a string', { field: 'content' });
  }
  let bom = '';
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) {
    bom = '\uFEFF';
    text = text.slice(1);
  }
  if (text.includes('\uFFFD')) {
    fail('E_ENCODING_UNSUPPORTED', 'the content contains replacement characters; exact byte recovery cannot be guaranteed');
  }

  const newline = detectNewline(text);
  const lines = text.split(newline);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    fail('E_FRONTMATTER_MISSING', 'migration requires a YAML frontmatter block; no header was inserted');
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) {
    fail('E_FRONTMATTER_UNCLOSED', 'the YAML frontmatter block is not closed');
  }

  const frontmatter = lines.slice(1, end);
  const rendered = new Map(Object.entries(fields).map(([key, value]) => [key, `${key}: ${serializeValue(value)}`]));
  const applied = new Set();
  const next = frontmatter.map(line => {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!match || !rendered.has(match[1])) return line;
    applied.add(match[1]);
    return rendered.get(match[1]);
  });
  for (const [key, line] of rendered) {
    if (!applied.has(key)) next.push(line);
  }

  return bom + ['---', ...next, ...lines.slice(end)].join(newline);
}

// Strict, read-only frontmatter inspection used for add-only migration checks.
function parseFrontmatter(content) {
  if (typeof content !== 'string') {
    fail('E_CONTENT_INVALID', 'file content must be a string', { field: 'content' });
  }
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\uFFFD')) {
    fail('E_ENCODING_UNSUPPORTED', 'replacement characters prevent a safe frontmatter check');
  }
  const newline = detectNewline(text);
  const lines = text.split(newline);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    fail('E_FRONTMATTER_MISSING', 'migration requires a YAML frontmatter block');
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) fail('E_FRONTMATTER_UNCLOSED', 'the YAML frontmatter block is not closed');

  const keys = new Map();
  const duplicates = new Set();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (/^\s+/.test(line)) {
      fail('E_FRONTMATTER_UNSUPPORTED_STRUCTURE', 'nested or indented frontmatter is not safe to migrate');
    }
    // Quoted and plain keys are the same semantic key for add-only checks.
    const quoted = line.match(/^(['"])([A-Za-z0-9_-]+)\1\s*:/);
    const plain = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    let key = null;
    if (quoted) key = quoted[2];
    else if (plain) key = plain[1];
    if (!key) {
      fail('E_FRONTMATTER_UNSUPPORTED_STRUCTURE', `unsupported frontmatter line: ${trimmed.slice(0, 40)}`);
    }
    if (keys.has(key)) duplicates.add(key);
    keys.set(key, (keys.get(key) || 0) + 1);
  }
  if (duplicates.size > 0) {
    fail('E_FRONTMATTER_DUPLICATE_KEY', `duplicate frontmatter keys: ${[...duplicates].join(', ')}`);
  }
  return { keys, newline, hasFrontmatter: true };
}

// Migration is add-only: a field the plan wants to add must not already exist.
function assertAddOnly(content, fields) {
  const parsed = parseFrontmatter(content);
  const present = Object.keys(fields).filter(key => parsed.keys.has(key));
  if (present.length > 0) {
    fail('E_FIELD_ALREADY_PRESENT', `frontmatter already contains: ${present.join(', ')}; migration refuses to overwrite`, {
      fields: present,
    });
  }
  return parsed;
}

function hasClosedFrontmatter(content) {
  try {
    mergeFrontmatter(content, {});
    return true;
  } catch (error) {
    return !(error && (error.code === 'E_FRONTMATTER_MISSING' || error.code === 'E_FRONTMATTER_UNCLOSED' || error.code === 'E_ENCODING_UNSUPPORTED'));
  }
}

module.exports = { mergeFrontmatter, parseFrontmatter, assertAddOnly, hasClosedFrontmatter };
