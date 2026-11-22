'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isValidPriority, normalizePriority, boostPriority } = require('../src/data/priority.js');

test('priority must be an integer from 1 to 100', () => {
  assert.equal(isValidPriority(1), true);
  assert.equal(isValidPriority(100), true);
  assert.equal(isValidPriority(0), false);
  assert.equal(isValidPriority(101), false);
  assert.equal(isValidPriority(5.5), false);
  assert.equal(isValidPriority('8'), true);
});

test('normalizePriority falls back for invalid values', () => {
  assert.equal(normalizePriority('8'), 8);
  assert.equal(normalizePriority('nope'), 50);
  assert.equal(normalizePriority(0, 30), 30);
});

test('boostPriority lowers the number and never goes below one', () => {
  assert.equal(boostPriority(8, 5), 3);
  assert.equal(boostPriority(8, 30), 1);
  assert.equal(boostPriority(100, 15), 85);
});
