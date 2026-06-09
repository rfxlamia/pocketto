'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { CliError } = require('../lib/envelope');
const { issueBody, prBody } = require('../lib/bodies');

function readInput(inputPath) {
  if (!inputPath) {
    throw new CliError('USAGE', 'Usage: pocketto-pi format <issue|pr> --input <json-file>');
  }
  let raw;
  try {
    raw = readFileSync(inputPath, 'utf8');
  } catch {
    throw new CliError('NOT_FOUND', `Input file not found: ${inputPath}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError('BAD_INPUT', `Invalid JSON in input file: ${inputPath}`);
  }
}

function writeBodyFile(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pocketto-body-'));
  const bodyFile = path.join(dir, 'body.md');
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  writeFileSync(bodyFile, normalized, 'utf8');
  return bodyFile;
}

function runIssue(input) {
  const body = issueBody(input);
  const bodyFile = writeBodyFile(body);
  return {
    command: 'format issue',
    exit: 0,
    human: [`Wrote issue body: ${bodyFile}`],
    data: { kind: 'issue', bodyFile },
  };
}

function runPr(input) {
  const { body, linkKeyword, fileWarning } = prBody(input);
  const bodyFile = writeBodyFile(body);
  return {
    command: 'format pr',
    exit: 0,
    human: [`Wrote PR body: ${bodyFile}`],
    data: { kind: 'pr', bodyFile, linkKeyword, fileWarning },
  };
}

function run({ kind, inputPath }) {
  if (!kind || (kind !== 'issue' && kind !== 'pr')) {
    throw new CliError('USAGE', 'Usage: pocketto-pi format <issue|pr> --input <json-file>');
  }
  const input = readInput(inputPath);
  if (kind === 'issue') return runIssue(input);
  return runPr(input);
}

module.exports = { run };
