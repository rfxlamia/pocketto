'use strict';

const path = require('node:path');
const { CORE_CLI } = require('./constants');
const { runProcess, startProcess } = require('./process');

function parseCliResult(result) {
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* Preserve raw output for the assertion. */ }
  return { ...result, json };
}

function runCore(fixture, args, env = fixture.env) {
  return parseCliResult(runProcess(process.execPath, [CORE_CLI, ...args], { cwd: fixture.root, env }));
}

async function runCoreAsync(fixture, args, env = fixture.env) {
  const result = await startProcess(process.execPath, [CORE_CLI, ...args], { cwd: fixture.root, env }).done;
  return parseCliResult(result);
}

function assertCliOk(result, label) {
  assertResult(result, label);
  return result.json.data;
}

function assertResult(result, label) {
  const assert = require('node:assert/strict');
  assert.equal(result.exit, 0, `${label} must succeed: ${result.stdout}${result.stderr}`);
  assert.ok(result.json && result.json.ok, `${label} must return a successful JSON envelope: ${result.stdout}`);
}

module.exports = { runCore, runCoreAsync, assertCliOk };
