'use strict';

const { statSync } = require('node:fs');
const { CliError } = require('../lib/envelope');
const { metaPathFor, readMeta, writeMeta, getDotted, setDotted } = require('../lib/meta');

function resolveDir(arg) {
  let st;
  try {
    st = statSync(arg);
  } catch {
    throw new CliError('NOT_FOUND', `'${arg}' is not a directory.`);
  }
  if (!st.isDirectory()) throw new CliError('NOT_FOUND', `'${arg}' is not a directory.`);
  return arg;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function get(positionals) {
  if (positionals.length !== 2) {
    throw new CliError('USAGE', 'Usage: pocketto-pi meta get <dir> <field>');
  }
  const [dirArg, field] = positionals;
  const dir = resolveDir(dirArg);
  const metaPath = metaPathFor(dir);
  const meta = readMeta(metaPath);
  const value = getDotted(meta, field);

  return {
    command: 'meta get',
    exit: 0,
    human: [value === null ? '' : JSON.stringify(value)],
    data: { dir, metaPath, field, value },
  };
}

function set(positionals) {
  if (positionals.length !== 3) {
    throw new CliError('USAGE', 'Usage: pocketto-pi meta set <dir> <field> <value>');
  }
  const [dirArg, field, rawValue] = positionals;
  const dir = resolveDir(dirArg);
  const metaPath = metaPathFor(dir);
  const meta = readMeta(metaPath);
  const value = parseValue(rawValue);
  setDotted(meta, field, value);
  writeMeta(metaPath, meta);

  return {
    command: 'meta set',
    exit: 0,
    human: [`Set ${field} in ${metaPath}`],
    data: { dir, metaPath, field, value },
  };
}

function run({ sub, positionals }) {
  if (sub === 'get') return get(positionals);
  if (sub === 'set') return set(positionals);
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown 'meta' subcommand: ${sub || '(none)'}. Use get | set.`);
}

module.exports = { run };
