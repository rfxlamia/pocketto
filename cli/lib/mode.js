'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('./envelope');

const DEFAULT_MODE = {
  enterprise: false,
  branch_strategy: null,
  create_pr: null,
  source: null,
};

const FILES = ['AGENTS.md', 'CLAUDE.md'];
const BOOLS = new Set(['true', 'false']);
const BRANCH_STRATEGIES = new Set(['branch', 'main-local']);

function invalid(message) {
  throw new CliError('MODE_CONFIG_INVALID', message, { human: `Invalid Pocket Enterprise config: ${message}` });
}

function boolValue(key, value, source) {
  if (!BOOLS.has(value)) {
    invalid(`${source}: ${key} must be one of: true, false.`);
  }
  return value === 'true';
}

function enumValue(key, value, allowed, source) {
  if (!allowed.has(value)) {
    invalid(`${source}: ${key} must be one of: ${Array.from(allowed).join(', ')}.`);
  }
  return value;
}

function findHeadingBlock(text, source) {
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === '## Pocket Enterprise');
  if (heading === -1) return null;

  let open = -1;
  for (let i = heading + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      open = i;
      break;
    }
  }
  if (open === -1) {
    invalid(`${source}: ## Pocket Enterprise must contain a fenced block.`);
  }

  const block = [];
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) return block.join('\n');
    block.push(lines[i]);
  }
  invalid(`${source}: ## Pocket Enterprise fenced block is not closed.`);
}

function parseBlock(block, source) {
  const fields = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      invalid(`${source}: cannot parse line "${line}". Use key: value.`);
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === '' || value === '') {
      invalid(`${source}: cannot parse line "${line}". Use key: value.`);
    }
    fields[key] = value;
  }
  return fields;
}

function normalize(fields, source) {
  if (!Object.prototype.hasOwnProperty.call(fields, 'enterprise')) {
    return { ...DEFAULT_MODE };
  }

  const enterprise = boolValue('enterprise', fields.enterprise, source);
  if (!enterprise) {
    return {
      enterprise: false,
      branch_strategy: Object.prototype.hasOwnProperty.call(fields, 'branch_strategy')
        ? enumValue('branch_strategy', fields.branch_strategy, BRANCH_STRATEGIES, source)
        : null,
      create_pr: Object.prototype.hasOwnProperty.call(fields, 'create_pr')
        ? boolValue('create_pr', fields.create_pr, source)
        : null,
      source,
    };
  }

  const missing = ['branch_strategy', 'create_pr'].filter((key) => !Object.prototype.hasOwnProperty.call(fields, key));
  if (missing.length) {
    invalid(`${source}: enterprise true requires ${missing.join(', ')}.`);
  }

  return {
    enterprise: true,
    branch_strategy: enumValue('branch_strategy', fields.branch_strategy, BRANCH_STRATEGIES, source),
    create_pr: boolValue('create_pr', fields.create_pr, source),
    source,
  };
}

function parseConfig(text, source) {
  const block = findHeadingBlock(text, source);
  if (block === null) return null;
  return normalize(parseBlock(block, source), source);
}

function readConfigFile(dir, file) {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  return parseConfig(text, file);
}

function detectMode(targetDir = process.cwd()) {
  const dir = path.resolve(targetDir || process.cwd());
  let active = null;
  for (const file of FILES) {
    const parsed = readConfigFile(dir, file);
    if (parsed) active = parsed;
  }
  return active || { ...DEFAULT_MODE };
}

function validateInitFields({ enterprise, branchStrategy, createPr }) {
  if (enterprise === null || enterprise === undefined || !BOOLS.has(enterprise)) {
    invalid('enterprise is required and must be one of: true, false.');
  }

  const ent = enterprise === 'true';
  if (ent) {
    if (branchStrategy === null || branchStrategy === undefined) {
      invalid('enterprise true requires branch_strategy.');
    }
    enumValue('branch_strategy', branchStrategy, BRANCH_STRATEGIES, 'init');
    if (createPr === null || createPr === undefined) {
      invalid('enterprise true requires create_pr.');
    }
    boolValue('create_pr', createPr, 'init');
  } else {
    if (branchStrategy !== null && branchStrategy !== undefined) {
      enumValue('branch_strategy', branchStrategy, BRANCH_STRATEGIES, 'init');
    }
    if (createPr !== null && createPr !== undefined) {
      boolValue('create_pr', createPr, 'init');
    }
  }

  return {
    enterprise: ent,
    branch_strategy: ent ? branchStrategy : (branchStrategy ?? null),
    create_pr: ent ? createPr === 'true' : (createPr === null || createPr === undefined ? null : createPr === 'true'),
  };
}

module.exports = {
  DEFAULT_MODE,
  detectMode,
  parseConfig,
  validateInitFields,
};
