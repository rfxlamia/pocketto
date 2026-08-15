'use strict';

// Single source of truth for CLI version + output contract.
//
//   CLI_VERSION  full semver, read from package.json (informational)
//   CONTRACT     integer JSON-output contract. Bumped ONLY on a breaking
//                change to the --json envelope/schema (== a new major, e.g.
//                v3 -> contract 3). Within one contract, output is additive-
//                only, so older skills keep working against a newer CLI.
//   PIPELINE     integer execution-pipeline generation. Bumped independently
//                of CONTRACT when the in-repo skill pipeline changes.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  version = pkg.version || version;
} catch {
  // package.json missing/unreadable — fall back to placeholder.
}

module.exports = {
  CLI_VERSION: version,
  CONTRACT: 2,
  PIPELINE: 3,
};
