'use strict';

// Public lifecycle dispatch entry point; implementation lives in focused Core modules.

const { runDrain } = require('./lifecycle-drain');
const { runRepair } = require('./lifecycle-projection');

module.exports = { runDrain, runRepair };
