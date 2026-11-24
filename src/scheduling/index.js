'use strict';

// Public surface of the MF-US-1 pure core.
//
// SPEC A9: no Obsidian, no Vault, no filesystem, no clock, no randomness, no SR.
// Every function is deterministic and leaves its arguments untouched.

const errors = require('./errors.js');
const constants = require('./constants.js');
const schema = require('./schema.js');
const dates = require('./dates.js');
const initial = require('./initial.js');
const interval = require('./interval.js');

module.exports = {
  ...errors,
  ...constants,
  ...schema,
  ...dates,
  ...initial,
  ...interval,
  // Namespaced access for callers that prefer explicit module grouping.
  schema,
  dates,
  initial,
  interval,
};
