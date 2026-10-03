'use strict';

// `pocketto-pi lifecycle transition <spec_dir> <event-type> --artifact ...`
// Thin command wrapper: parses CLI args, delegates to the transition
// coordinator, and reports through the shared envelope.

const { CliError } = require('../lib/envelope');
const { runTransition } = require('../lib/lifecycle-transition');
const { runDrain, runRepair } = require('../lib/lifecycle-dispatch');
const { runMigration } = require('../lib/lifecycle-migration');

function run({ positionals, artifacts, from } = {}) {
  const list = Array.isArray(positionals) ? positionals : [];
  const [sub, specDir, type] = list;
  if (sub === 'transition') {
    return runTransition({ specDir, type, artifactFlags: artifacts });
  }
  if (sub === 'drain') {
    return runDrain({ specDir });
  }
  if (sub === 'repair') {
    return runRepair({ specDir });
  }
  if (sub === 'migrate') {
    return runMigration({ specDir, from });
  }
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown 'lifecycle' subcommand: ${sub || '(none)'}. Use transition | drain | repair | migrate.`);
}

module.exports = { run };
