'use strict';

const { CLI_VERSION, CONTRACT } = require('./version');

// Stable --json envelope shared by every command.
//   { ok, command, cliVersion, contract, data, error }

function ok(command, data) {
  return { ok: true, command, cliVersion: CLI_VERSION, contract: CONTRACT, data, error: null };
}

function fail(command, code, message) {
  return { ok: false, command, cliVersion: CLI_VERSION, contract: CONTRACT, data: null, error: { code, message } };
}

// Error carrying a stable machine code, an exit code, and an optional
// multi-line human rendering (used for the non-JSON path).
class CliError extends Error {
  constructor(code, message, { exitCode = 1, human = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.human = human;
  }
}

module.exports = { ok, fail, CliError };
