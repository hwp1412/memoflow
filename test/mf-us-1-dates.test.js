'use strict';

// PR-01 — pure calendar arithmetic (SPEC A2.3, A13 T15, owner ruling Q3).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulingError,
  addCalendarDays,
  calendarDayDifference,
  compareDate,
  maxDate,
  minDate,
  isValidDateString,
  assertDateString,
  toDayNumber,
  fromDayNumber,
  isLeapYear,
  daysInMonth,
  MIN_YEAR,
  MAX_YEAR,
} = require('../src/scheduling/index.js');

function expectCode(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof SchedulingError, `expected SchedulingError, got ${error && error.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('strict ISO dates only', () => {
  for (const value of ['0001-01-01', '1970-01-01', '2026-11-24', '2028-02-29', '9999-12-31']) {
    assert.equal(isValidDateString(value), true, value);
  }
  for (const value of [
    '2026-1-1', '2026-01-1', '26-01-01', '2026/01/01', '2026-01-01 ', ' 2026-01-01',
    '', null, undefined, 20260101, 'YYYY-MM-DD',
  ]) {
    assert.equal(isValidDateString(value), false, String(value));
  }
});

test('impossible calendar dates are rejected, not rolled over', () => {
  for (const value of ['2026-02-30', '2027-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '0000-01-01']) {
    assert.equal(isValidDateString(value), false, value);
    expectCode(() => assertDateString(value), 'E_DATE_INVALID');
  }
  expectCode(() => assertDateString('2026-1-1'), 'E_DATE_FORMAT');
  expectCode(() => assertDateString(20260101), 'E_DATE_FORMAT');
});

test('Gregorian leap rules, including century exceptions', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(2100), false);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2027, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
});

test('month-end and year-end rollovers', () => {
  assert.equal(addCalendarDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addCalendarDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addCalendarDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addCalendarDays('1900-02-28', 1), '1900-03-01');
  assert.equal(addCalendarDays('2000-02-28', 1), '2000-02-29');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addCalendarDays('2026-01-31', 31), '2026-03-03');
  assert.equal(addCalendarDays('2026-11-24', 21), '2026-12-15');
  assert.equal(addCalendarDays('2026-11-24', 0), '2026-11-24');
  assert.equal(addCalendarDays('2026-11-24', -1), '2026-11-23');
  assert.equal(addCalendarDays('2026-01-01', -1), '2025-12-31');
});

test('DST transition days still advance exactly one calendar day (T15)', () => {
  // US spring forward 2026-03-08, EU spring forward 2026-03-29, US fall back 2026-11-01.
  assert.equal(addCalendarDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addCalendarDays('2026-03-08', -1), '2026-03-07');
  assert.equal(addCalendarDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addCalendarDays('2026-11-01', 1), '2026-11-02');
  assert.equal(addCalendarDays('2026-11-01', -1), '2026-10-31');
  // A 400-day span must not lose or gain a day across two DST changes.
  assert.equal(calendarDayDifference(addCalendarDays('2026-01-01', 400), '2026-01-01'), 400);
});

test('calendar day difference is integer and symmetric', () => {
  assert.equal(calendarDayDifference('2026-11-24', '2026-11-24'), 0);
  assert.equal(calendarDayDifference('2026-11-27', '2026-11-24'), 3);
  assert.equal(calendarDayDifference('2026-11-24', '2026-11-27'), -3);
  assert.equal(calendarDayDifference('2027-01-01', '2026-12-31'), 1);
  assert.equal(calendarDayDifference('2028-03-01', '2028-02-28'), 2);
  assert.equal(calendarDayDifference('2100-01-01', '2000-01-01'), 36525);
  assert.equal(calendarDayDifference('2000-01-01', '2100-01-01'), -36525);
});

test('add and difference are inverse operations', () => {
  const offsets = [-400, -31, -1, 0, 1, 7, 30, 365, 3650];
  for (const offset of offsets) {
    const moved = addCalendarDays('2026-11-24', offset);
    assert.equal(calendarDayDifference(moved, '2026-11-24'), offset);
    assert.equal(addCalendarDays(moved, -offset), '2026-11-24');
  }
});

test('day numbers round-trip for every supported boundary', () => {
  assert.equal(fromDayNumber(toDayNumber('0001-01-01')), '0001-01-01');
  assert.equal(fromDayNumber(toDayNumber('9999-12-31')), '9999-12-31');
  assert.equal(fromDayNumber(toDayNumber('1970-01-01')), '1970-01-01');
  assert.equal(toDayNumber('1970-01-01'), 0);
});

test('overflow past the supported range is an explicit error', () => {
  expectCode(() => addCalendarDays('0001-01-01', -1), 'E_DATE_OUT_OF_RANGE');
  expectCode(() => addCalendarDays('9999-12-31', 1), 'E_DATE_OUT_OF_RANGE');
  expectCode(() => addCalendarDays('9999-12-31', 3650000), 'E_DATE_OUT_OF_RANGE');
  expectCode(() => fromDayNumber(10 ** 9), 'E_DATE_OUT_OF_RANGE');
  assert.equal(MIN_YEAR, 1);
  assert.equal(MAX_YEAR, 9999);
});

test('non-integer day offsets are rejected', () => {
  expectCode(() => addCalendarDays('2026-11-24', 1.5), 'E_DAY_ADD_TYPE');
  expectCode(() => addCalendarDays('2026-11-24', '1'), 'E_DAY_ADD_TYPE');
  expectCode(() => addCalendarDays('2026-11-24', NaN), 'E_DAY_ADD_TYPE');
});

test('comparison helpers', () => {
  assert.equal(compareDate('2026-11-24', '2026-11-24'), 0);
  assert.equal(compareDate('2026-11-25', '2026-11-24'), 1);
  assert.equal(compareDate('2026-11-23', '2026-11-24'), -1);
  assert.equal(maxDate('2026-11-24', '2026-12-01'), '2026-12-01');
  assert.equal(minDate('2026-11-24', '2026-12-01'), '2026-11-24');
});

test('date functions are deterministic across repeated evaluation', () => {
  const first = addCalendarDays('2026-11-24', 37);
  for (let i = 0; i < 1000; i++) {
    assert.equal(addCalendarDays('2026-11-24', 37), first);
  }
});
