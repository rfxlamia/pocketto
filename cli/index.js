#!/usr/bin/env node
'use strict';

// pocketto-pi — cross-platform CLI for the pocket-* development skills.
//
//   pocketto-pi structure <execution-plan.md> [--dry-run] [--json]
//   pocketto-pi log init   <plan_dir>                      [--json]
//   pocketto-pi log update <plan_dir> <phase_file> <status> [--task TN] [--json]
//   pocketto-pi log close  <plan_dir>                      [--json]
//
// Skills always pass --json (stable envelope) and --contract <N> (version
// handshake). Humans get readable text by default.

const { ok, fail, CliError } = require('./lib/envelope');
const { CLI_VERSION, CONTRACT } = require('./lib/version');
const structure = require('./commands/structure');
const log = require('./commands/log');

function parseArgs(argv) {
  const positionals = [];
  const flags = { json: false, dryRun: false, task: null, contract: null, version: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--task') flags.task = argv[++i];
    else if (a.startsWith('--task=')) flags.task = a.slice('--task='.length);
    else if (a === '--contract') flags.contract = argv[++i];
    else if (a.startsWith('--contract=')) flags.contract = a.slice('--contract='.length);
    else if (a.startsWith('--')) throw new CliError('UNKNOWN_FLAG', `Unknown flag: ${a}`);
    else positionals.push(a);
  }
  return { positionals, flags };
}

// Version handshake: skills declare the contract they were written against.
// A mismatch fails loudly with guidance instead of silently emitting output
// the skill can't parse.
function checkContract(requested) {
  if (requested == null) return;
  const r = Number(requested);
  if (!Number.isInteger(r)) {
    throw new CliError('BAD_CONTRACT', `--contract must be an integer, got '${requested}'.`);
  }
  if (r === CONTRACT) return;
  if (r < CONTRACT) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `This skill expects pocketto-pi contract ${r}, but the installed CLI is contract ${CONTRACT} ` +
        `(v${CLI_VERSION}) — a newer, breaking major. Update your pocketto skills/plugin, or pin the ` +
        `CLI: npx -y pocketto-pi@${r}`,
    );
  }
  throw new CliError(
    'CONTRACT_MISMATCH',
    `This skill expects pocketto-pi contract ${r}, but the installed CLI is only contract ${CONTRACT} ` +
      `(v${CLI_VERSION}). Update the CLI: npx -y pocketto-pi@latest`,
  );
}

const HELP = `pocketto-pi — CLI for the pocket-* development skills

Usage:
  pocketto-pi structure <execution-plan.md> [--dry-run] [--json]
  pocketto-pi log init   <plan_dir>                       [--json]
  pocketto-pi log update <plan_dir> <phase_file> <status> [--task TN] [--json]
  pocketto-pi log close  <plan_dir>                       [--json]

Status values: WAITING | REVIEW | DONE | BLOCKED

Flags:
  --json            Emit the stable JSON envelope to stdout
  --contract <N>    Assert the expected output contract (version handshake)
  --dry-run         (structure) compute + summarize without writing files
  --task <id>       (log update) update a task within a phase, e.g. --task T1
  --version, -v     Print version + contract
  --help, -h        Show this help`;

function emitSuccess(command, result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(ok(command, result.data)) + '\n');
  } else {
    process.stdout.write(result.human.join('\n') + '\n');
  }
  process.exit(result.exit ?? 0);
}

function emitError(command, err, json) {
  const code = err instanceof CliError ? err.code : 'INTERNAL_ERROR';
  const message = err.message || String(err);
  const exitCode = err instanceof CliError ? err.exitCode : 1;
  if (json) {
    process.stdout.write(JSON.stringify(fail(command, code, message)) + '\n');
  } else {
    process.stderr.write((err.human || `Error: ${message}`) + '\n');
  }
  process.exit(exitCode);
}

function main() {
  const argv = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    emitError('cli', err, false);
    return;
  }
  const { positionals, flags } = parsed;

  if (flags.version) {
    process.stdout.write(`pocketto-pi ${CLI_VERSION} (contract ${CONTRACT})\n`);
    process.exit(0);
  }
  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP + '\n');
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  const command = positionals[0];
  try {
    checkContract(flags.contract);
    if (command === 'structure') {
      const result = structure.run({ planArg: positionals[1], dryRun: flags.dryRun });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'log') {
      const result = log.run({ sub: positionals[1], positionals: positionals.slice(2), task: flags.task });
      emitSuccess(result.command, result, flags.json);
    } else {
      throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}. Use structure | log.`);
    }
  } catch (err) {
    emitError(command, err, flags.json);
  }
}

main();
