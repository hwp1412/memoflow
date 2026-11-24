'use strict';

// Pure calendar arithmetic for MF-US-1 (SPEC A2.3, owner ruling Q3).
//
// Contract:
//   * input and output are strict four-digit ISO local calendar dates,
//     'YYYY-MM-DD' in 0001-01-01 .. 9999-12-31;
//   * adding days is a calendar operation on the proleptic Gregorian calendar,
//     NEVER `N * 86400000` milliseconds;
//   * there is no Date object, no timezone, no DST and no clock read anywhere in
//     this module, so results are identical on every host and at every instant.
//
// Implementation: civil date <-> integer day number (Howard Hinnant's
// days_from_civil / civil_from_days), entirely in integers.

const { fail } = require('./errors.js');
const { SPEC_CONFIG } = require('./constants.js');

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MIN_YEAR = SPEC_CONFIG.yearRange.min;
const MAX_YEAR = SPEC_CONFIG.yearRange.max;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1];
}

// Integer day number, 0 = 1970-01-01. Negative for earlier dates.
function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(dayNumber) {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const yearBase = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yearBase + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

const MIN_DAY_NUMBER = daysFromCivil(MIN_YEAR, 1, 1);
const MAX_DAY_NUMBER = daysFromCivil(MAX_YEAR, 12, 31);

function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function assertDateString(value, field = 'date') {
  if (typeof value !== 'string') {
    fail('E_DATE_FORMAT', `${field} must be a 'YYYY-MM-DD' string`, { field, value });
  }
  const match = ISO_RE.exec(value);
  if (!match) {
    fail('E_DATE_FORMAT', `${field} must be a strict 'YYYY-MM-DD' string`, { field, value });
  }
  if (!isValidDateString(value)) {
    fail('E_DATE_INVALID', `${field} is not a real Gregorian calendar date`, { field, value });
  }
  return value;
}

function toParts(value, field) {
  assertDateString(value, field);
  const match = ISO_RE.exec(value);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatParts({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toDayNumber(value, field = 'date') {
  const { year, month, day } = toParts(value, field);
  return daysFromCivil(year, month, day);
}

function fromDayNumber(dayNumber, field = 'date') {
  if (!Number.isInteger(dayNumber)) {
    fail('E_DATE_FORMAT', `${field} day number must be an integer`, { field, value: dayNumber });
  }
  if (dayNumber < MIN_DAY_NUMBER || dayNumber > MAX_DAY_NUMBER) {
    fail(
      'E_DATE_OUT_OF_RANGE',
      `${field} falls outside the supported range ${formatParts(civilFromDays(MIN_DAY_NUMBER))}..${formatParts(civilFromDays(MAX_DAY_NUMBER))}`,
      { field, dayNumber }
    );
  }
  return formatParts(civilFromDays(dayNumber));
}

// Calendar addition. `days` must be an integer; overflow past the supported
// range is an explicit error, never a silently clamped date.
function addCalendarDays(value, days, field = 'date') {
  if (typeof days !== 'number' || !Number.isInteger(days) || !Number.isFinite(days)) {
    fail('E_DAY_ADD_TYPE', 'days to add must be an integer', { field, value: days });
  }
  const start = toDayNumber(value, field);
  return fromDayNumber(start + days, field);
}

// Whole calendar days from `right` to `left` (left - right). DST-immune.
function calendarDayDifference(left, right, field = 'date') {
  return toDayNumber(left, field) - toDayNumber(right, field);
}

function compareDate(left, right, field = 'date') {
  const diff = toDayNumber(left, field) - toDayNumber(right, field);
  return diff === 0 ? 0 : (diff < 0 ? -1 : 1);
}

function maxDate(left, right, field = 'date') {
  return compareDate(left, right, field) >= 0 ? left : right;
}

function minDate(left, right, field = 'date') {
  return compareDate(left, right, field) <= 0 ? left : right;
}

module.exports = {
  MIN_YEAR,
  MAX_YEAR,
  MIN_DAY_NUMBER,
  MAX_DAY_NUMBER,
  isLeapYear,
  daysInMonth,
  daysFromCivil,
  civilFromDays,
  isValidDateString,
  assertDateString,
  toDayNumber,
  fromDayNumber,
  addCalendarDays,
  calendarDayDifference,
  compareDate,
  maxDate,
  minDate,
};
