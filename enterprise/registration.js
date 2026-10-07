'use strict';

// Public Enterprise registration boundary. The record, compatibility, and
// preflight internals stay separate while consumers keep this stable API.
const record = require('./registration-record');
const { preflight } = require('./registration-preflight');

module.exports = {
  REGISTRATION_SCHEMA: record.REGISTRATION_SCHEMA,
  ADAPTER_CONTRACT: record.ADAPTER_CONTRACT,
  REGISTRATION_DIR: record.REGISTRATION_DIR,
  REGISTRATION_FILE: record.REGISTRATION_FILE,
  DEFAULT_TIMEOUT_MS: record.DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS: record.MAX_TIMEOUT_MS,
  REGISTRATION_FIELDS: record.REGISTRATION_FIELDS,
  registrationPathFor: record.registrationPathFor,
  buildRegistration: record.buildRegistration,
  validateRegistration: record.validateRegistration,
  loadRegistration: record.loadRegistration,
  installRegistration: record.installRegistration,
  preflight,
};
