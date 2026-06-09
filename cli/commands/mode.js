'use strict';

const { CliError } = require('../lib/envelope');
const { detectMode } = require('../lib/mode');

function run({ positionals = [] } = {}) {
  if (positionals[0] === 'init') {
    throw new CliError('MODE_INIT_RESERVED', 'mode init is reserved for a future Pocket Enterprise bootstrap command.');
  }
  if (positionals.length > 1) {
    throw new CliError('BAD_USAGE', 'Usage: pocketto-pi mode [<dir>]');
  }

  const data = detectMode(positionals[0] || process.cwd());
  const human = [
    data.enterprise
      ? `Pocket Enterprise enabled (${data.branch_strategy}, create_pr=${data.create_pr})`
      : 'Pocket Enterprise disabled',
  ];
  if (data.source) human.push(`Source: ${data.source}`);

  return {
    command: 'mode',
    exit: 0,
    human,
    data,
  };
}

module.exports = { run };
