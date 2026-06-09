'use strict';

const { readFileSync } = require('node:fs');
const { CliError } = require('../lib/envelope');
const { setDiff } = require('../lib/reconcile');

function readJsonArray(inputPath, label) {
  if (!inputPath) {
    throw new CliError('USAGE', 'Usage: pocketto-pi reconcile --prior <json> --new <json>');
  }
  let raw;
  try {
    raw = readFileSync(inputPath, 'utf8');
  } catch {
    throw new CliError('NOT_FOUND', `Input file not found: ${inputPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('BAD_INPUT', `Invalid JSON in ${label} file: ${inputPath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new CliError('BAD_INPUT', `${label} input must be a JSON array: ${inputPath}`);
  }
  return parsed;
}

function run({ priorPath, newPath }) {
  if (!priorPath || !newPath) {
    throw new CliError('USAGE', 'Usage: pocketto-pi reconcile --prior <json> --new <json>');
  }
  const prior = readJsonArray(priorPath, '--prior');
  const next = readJsonArray(newPath, '--new');
  const { resolve, post, keep } = setDiff(prior, next);
  return {
    command: 'reconcile',
    exit: 0,
    human: [`resolve: ${resolve.length}, post: ${post.length}, keep: ${keep.length}`],
    data: { resolve, post, keep },
  };
}

module.exports = { run };
