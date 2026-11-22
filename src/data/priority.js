'use strict';

const DEFAULT_PRIORITY = 50;

function isValidPriority(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100;
}

function normalizePriority(value, fallback = DEFAULT_PRIORITY) {
  return isValidPriority(value) ? Number(value) : fallback;
}

function boostPriority(current, delta) {
  const amount = Math.abs(Math.trunc(Number(delta) || 0));
  return Math.max(1, normalizePriority(current) - amount);
}

module.exports = { DEFAULT_PRIORITY, isValidPriority, normalizePriority, boostPriority };
