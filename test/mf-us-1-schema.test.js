'use strict';

// PR-01 — schema, invariants and purity contract (SPEC A1.4, A3.1, A3.2, A15).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scheduling = require('../src/scheduling/index.js');
const {
  SchedulingError,
  SPEC_CONFIG,
  ALGORITHM_VERSION,
  TOPIC_TYPES,
  assertConfig,
  validatePriority,
  isPriority,
  validateIntervalDays,
  validateAFactor,
  validateTopicType,
  validateUuid,
  validateOptionalUuid,
  isPlainObject,
  assertPlainObject,
} = scheduling;

const MODULE_DIR = path.join(__dirname, '..', 'src', 'scheduling');

// Scan code, not prose: documentation comments legitimately mention the words
// these tests forbid (e.g. "no Obsidian, no Vault").
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  });
}

test('priority accepts only integers 1..100', () => {
  for (const value of [1, 2, 50, 80, 99, 100]) {
    assert.equal(validatePriority(value), value);
    assert.equal(isPriority(value), true);
  }
  for (const value of [0, 101, -1, 1.5, '50', '', null, undefined, NaN, Infinity]) {
    assert.equal(isPriority(value), false);
  }
});

test('a quoted number is a type error, never a silent default', () => {
  expectCode(() => validatePriority('50'), 'E_PRIORITY_TYPE');
  expectCode(() => validatePriority(1.5), 'E_PRIORITY_TYPE');
  expectCode(() => validatePriority(null), 'E_PRIORITY_TYPE');
});

test('out-of-range priority is a range error (SPEC A3.2: no silent P50)', () => {
  expectCode(() => validatePriority(0), 'E_PRIORITY_RANGE');
  expectCode(() => validatePriority(101), 'E_PRIORITY_RANGE');
});

test('interval days must be an integer within 1..3650', () => {
  assert.equal(validateIntervalDays(1), 1);
  assert.equal(validateIntervalDays(3650), 3650);
  expectCode(() => validateIntervalDays(0), 'E_INTERVAL_RANGE');
  expectCode(() => validateIntervalDays(3651), 'E_INTERVAL_RANGE');
  expectCode(() => validateIntervalDays(1.5), 'E_INTERVAL_TYPE');
  expectCode(() => validateIntervalDays('8'), 'E_INTERVAL_TYPE');
});

test('A-Factor is strict 1.10..3.00 and legacy bounds are rejected (Q2)', () => {
  for (const value of [1.1, 1.5, 1.8, 2, 2.5, 3]) {
    assert.equal(validateAFactor(value), value);
  }
  // 1.05 and 5.0 are the legacy clamp bounds; they are outside the spec range.
  expectCode(() => validateAFactor(1.05), 'E_AFACTOR_RANGE');
  expectCode(() => validateAFactor(1.09), 'E_AFACTOR_RANGE');
  expectCode(() => validateAFactor(3.01), 'E_AFACTOR_RANGE');
  expectCode(() => validateAFactor(5), 'E_AFACTOR_RANGE');
  expectCode(() => validateAFactor('1.5'), 'E_AFACTOR_TYPE');
  expectCode(() => validateAFactor(NaN), 'E_AFACTOR_TYPE');
});

test('only source and extract are MF-US-1 topic types (cards stay in SR)', () => {
  assert.deepEqual(TOPIC_TYPES, ['source', 'extract']);
  assert.equal(validateTopicType('source'), 'source');
  assert.equal(validateTopicType('extract'), 'extract');
  expectCode(() => validateTopicType('card'), 'E_TOPIC_TYPE');
  expectCode(() => validateTopicType(''), 'E_TOPIC_TYPE');
  expectCode(() => validateTopicType(undefined), 'E_TOPIC_TYPE');
});

test('stable ids are UUID strings supplied by the caller', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  assert.equal(validateUuid(uuid), uuid);
  expectCode(() => validateUuid('not-a-uuid'), 'E_ID_FORMAT');
  expectCode(() => validateUuid(''), 'E_ID_FORMAT');
  expectCode(() => validateUuid(123), 'E_ID_FORMAT');
  assert.equal(validateOptionalUuid(null), null);
  assert.equal(validateOptionalUuid(undefined), null);
});

test('plain-object guard rejects arrays and primitives', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
  expectCode(() => assertPlainObject([], 'input'), 'E_OBJECT_REQUIRED');
});

test('spec config is frozen and identical to the specification values', () => {
  assert.equal(Object.isFrozen(SPEC_CONFIG), true);
  assert.equal(Object.isFrozen(SPEC_CONFIG.kFactor), true);
  assert.equal(ALGORITHM_VERSION, 1);
  assert.equal(SPEC_CONFIG.defaultPriority, 50);
  assert.deepEqual(SPEC_CONFIG.kFactor, { source: 1, extract: 0.75 });
  assert.deepEqual(SPEC_CONFIG.initialAFactor, { source: 1.5, extract: 1.8 });
  assert.deepEqual(SPEC_CONFIG.initialIntervalRange, { min: 1, max: 30 });
  assert.deepEqual(SPEC_CONFIG.aFactorRange, { min: 1.1, max: 3 });
  assert.deepEqual(SPEC_CONFIG.intervalRange, { min: 1, max: 3650 });
  assert.deepEqual(SPEC_CONFIG.initialAnchors, [
    { priority: 1, days: 1 },
    { priority: 50, days: 3 },
    { priority: 80, days: 7 },
    { priority: 100, days: 21 },
  ]);
  assert.equal(assertConfig(undefined), SPEC_CONFIG);
  assert.equal(assertConfig(SPEC_CONFIG), SPEC_CONFIG);
});

test('config overrides cannot displace the specification (SPEC A15)', () => {
  const clipped = { ...SPEC_CONFIG, kFactor: { source: 1, extract: 0.8 } };
  expectCode(() => assertConfig(clipped), 'E_CONFIG_SPEC_VIOLATION');
  const tuned = { ...SPEC_CONFIG, initialAFactor: { source: 1.4, extract: 1.8 } };
  expectCode(() => assertConfig(tuned), 'E_CONFIG_SPEC_VIOLATION');
  const missing = { ...SPEC_CONFIG };
  delete missing.defaultPriority;
  expectCode(() => assertConfig(missing), 'E_CONFIG_SPEC_VIOLATION');
  const extra = { ...SPEC_CONFIG, budgetMinutes: 60 };
  expectCode(() => assertConfig(extra), 'E_CONFIG_UNKNOWN_KEY');
});

test('errors carry a stable code and immutable details', () => {
  try {
    validatePriority(0);
    assert.fail('expected a throw');
  } catch (error) {
    assert.equal(error.name, 'SchedulingError');
    assert.equal(error.code, 'E_PRIORITY_RANGE');
    assert.equal(Object.isFrozen(error.details), true);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      name: 'SchedulingError',
      code: 'E_PRIORITY_RANGE',
      message: error.message,
      details: { field: 'priority', value: 0, min: 1, max: 100 },
    });
  }
});

test('pure scheduling modules require only sibling modules', () => {
  const files = fs.readdirSync(MODULE_DIR).filter(name => name.endsWith('.js'));
  assert.ok(files.includes('schema.js') && files.includes('dates.js'));
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(MODULE_DIR, file), 'utf8'));
    const specs = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
    for (const spec of specs) {
      assert.ok(spec.startsWith('./'), `${file} must not require "${spec}"`);
    }
  }
});

test('pure scheduling modules never touch clock, randomness, io or Obsidian', () => {
  const files = fs.readdirSync(MODULE_DIR).filter(name => name.endsWith('.js'));
  const forbidden = [
    [/\bnew\s+Date\b/, 'new Date()'],
    [/\bDate\.now\b/, 'Date.now()'],
    [/Math\.random/, 'Math.random()'],
    [/\bprocess\./, 'process.*'],
    [/obsidian/i, 'obsidian'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\brequire\(\s*['"](?:node:)?fs/, 'fs'],
    [/\brequire\(\s*['"](?:node:)?path/, 'path'],
  ];
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(MODULE_DIR, file), 'utf8'));
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not use ${label}`);
    }
  }
});
