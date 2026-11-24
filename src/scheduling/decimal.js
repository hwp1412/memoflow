'use strict';

// Exact decimal arithmetic for MF-US-1 interval maths.
//
// SPEC A3.3 defines roundHalfUp on the MATHEMATICAL value, but IEEE-754 does
// not represent decimal fractions exactly:
//
//   25 * 2.3 === 57.49999999999999   (mathematically 57.5  -> must round to 58)
//   1 * 1.4999999996 === 1.4999999996 (genuinely below 1.5 -> must stay 1)
//
// A tolerance window ("snap values within 5e-10 of a half to the half") fixes
// the first case but breaks the second. This module therefore never rounds a
// float product. It converts each input to the exact decimal it denotes (the
// shortest round-trip decimal of the double, i.e. the number the user wrote),
// multiplies in BigInt, and rounds the exact rational with floor(x + 1/2).
//
// The public roundHalfUp() in interval.js stays a strict floor(x + 0.5) on the
// value it is given; only the I x A multiplication uses this exact path.

const { fail } = require('./errors.js');

const TEN = 10n;

function toRational(value, field = 'value') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('E_DECIMAL_TYPE', `${field} must be a finite number`, { field, value });
  }
  if (value < 0) {
    fail('E_NEGATIVE_INPUT', `${field} must be non-negative`, { field, value });
  }
  // String() yields the shortest decimal that round-trips to the same double,
  // which is exactly the decimal the caller wrote (YAML/JSON/frontmatter).
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) {
    fail('E_DECIMAL_FORMAT', `${field} is not a plain decimal number`, { field, value, text });
  }
  const integerPart = match[1];
  const fractionPart = match[2] || '';
  const exponent = match[3] ? Number(match[3]) : 0;
  const digits = `${integerPart}${fractionPart}`;
  const scale = fractionPart.length - exponent;
  let numerator = BigInt(digits);
  let denominator = 1n;
  if (scale >= 0) denominator = TEN ** BigInt(scale);
  else numerator *= TEN ** BigInt(-scale);
  return { n: numerator, d: denominator };
}

function multiplyRationals(left, right) {
  return { n: left.n * right.n, d: left.d * right.d };
}

// floor(n/d + 1/2) in integer arithmetic, i.e. floor((2n + d) / 2d).
function roundHalfUpRational({ n, d }) {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') {
    fail('E_DECIMAL_TYPE', 'rational parts must be BigInt', { n: String(n), d: String(d) });
  }
  if (d <= 0n) {
    fail('E_DECIMAL_FORMAT', 'rational denominator must be positive', { d: String(d) });
  }
  if (n < 0n) {
    fail('E_NEGATIVE_INPUT', 'roundHalfUpRational is defined for non-negative values only', { n: String(n) });
  }
  return (2n * n + d) / (2n * d);
}

// Exact decimal text for rationals whose denominator is a power of ten.
function rationalToDecimalString({ n, d }) {
  if (typeof n !== 'bigint' || typeof d !== 'bigint' || d <= 0n) {
    fail('E_DECIMAL_FORMAT', 'rationalToDecimalString needs positive BigInt parts', { n: String(n), d: String(d) });
  }
  let scale = 0;
  let power = 1n;
  while (power < d) {
    power *= TEN;
    scale += 1;
  }
  if (power !== d) {
    fail('E_DECIMAL_FORMAT', 'denominator is not a power of ten', { d: String(d) });
  }
  const digits = n.toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  const integerPart = digits.slice(0, cut);
  const fractionPart = digits.slice(cut).replace(/0+$/, '');
  return fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
}

function toSafeNumber(value, field = 'value') {
  if (typeof value !== 'bigint') {
    fail('E_DECIMAL_TYPE', 'toSafeNumber expects a BigInt', { field });
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('E_DECIMAL_FORMAT', `${field} exceeds the safe integer range`, { field, value: value.toString() });
  }
  return Number(value);
}

module.exports = { toRational, multiplyRationals, roundHalfUpRational, rationalToDecimalString, toSafeNumber };
