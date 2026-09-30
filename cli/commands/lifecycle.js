'use strict';

// `pocketto-pi lifecycle transition <spec_dir> <event-type> --artifact ...`
// Thin command wrapper: parses CLI args, delegates to the transition
// coordinator, and reports through the shared envelope.

const { CliError } = require('../lib/envelope');
const { runTransition } = require('../lib/lifecycle-transition');
const { runDrain } = require('../lib/lifecycle-dispatch');

function run({ positionals, artifacts } = {}) {
  const list = Array.isArray(positionals) ? positionals : [];
  const [sub, specDir, type] = list;
  if (sub === 'transition') {
    return runTransition({ specDir, type, artifactFlags: artifacts });
  }
  if (sub === 'drain') {
    return runDrain({ specDir });
  }
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown 'lifecycle' subcommand: ${sub || '(none)'}. Use transition | drain.`);
}

module.exports = { run };
