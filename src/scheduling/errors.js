'use strict';

// Stable error contract for the MF-US-1 pure core.
//
// SPEC A1.4: illegal values must be reported explicitly — never silently
// repaired, defaulted or truncated. Callers branch on `code`; `message` is for
// humans. Every rejection path in src/scheduling throws a SchedulingError so an
// adapter can turn it into a per-topic anomaly report instead of guessing.

class SchedulingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SchedulingError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    if (Error.captureStackTrace) Error.captureStackTrace(this, SchedulingError);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

function fail(code, message, details) {
  throw new SchedulingError(code, message, details);
}

function isSchedulingError(value) {
  return value instanceof SchedulingError;
}

module.exports = { SchedulingError, fail, isSchedulingError };
