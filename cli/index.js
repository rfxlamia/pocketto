#!/usr/bin/env node
'use strict';

// pocketto-pi — cross-platform CLI for the pocket-* development skills.
//
//   pocketto-pi structure <execution-plan.md> [--dry-run] [--json]
//   pocketto-pi log init   <plan_dir>                      [--json]
//   pocketto-pi log update <plan_dir> <phase_file> <status> [--task TN] [--sha <commit>] [--allow-duplicate-sha] [--json]
//   pocketto-pi log close  <plan_dir>                      [--json]
//   pocketto-pi meta get   <dir> <field>                   [--json]
//   pocketto-pi meta set   <dir> <field> <value>           [--json]
//   pocketto-pi doctor                                     [--strict] [--json]
//   pocketto-pi mode [<dir>]                               [--json]
//   pocketto-pi mode init [<dir>]                          [--enterprise <bool>] [--branch-strategy <strategy>] [--create-pr <bool>] [--require-approval <bool>] [--file <AGENTS.md|CLAUDE.md>] [--json]
//   pocketto-pi format <issue|pr|comment|closeout>         [--input <json-file>] [--json]
//   pocketto-pi format tasklist <plan_dir>                 [--json]
//   pocketto-pi scaffold github [<dir>]                    [--dry-run] [--json]
//   pocketto-pi reconcile                                  [--prior <json>] [--new <json>] [--json]
//   pocketto-pi setup-extensions                           [--all] [--json]
//
// Skills always pass --json (stable envelope) and --contract <N> (version
// handshake). Humans get readable text by default.

const { ok, fail, CliError } = require('./lib/envelope');
const { CLI_VERSION, CONTRACT } = require('./lib/version');
const structure = require('./commands/structure');
const log = require('./commands/log');
const meta = require('./commands/meta');
const doctor = require('./commands/doctor');
const mode = require('./commands/mode');
const setupExtensions = require('./commands/setup-extensions');
const format = require('./commands/format');
const reconcile = require('./commands/reconcile');
const scaffold = require('./commands/scaffold');

function parseArgs(argv) {
  const positionals = [];
  const flags = {
    json: false,
    dryRun: false,
    task: null,
    contract: null,
    version: false,
    help: false,
    strict: false,
    all: false,
    recommended: false,
    enterprise: null,
    branchStrategy: null,
    createPr: null,
    requireApproval: null,
    file: null,
    input: null,
    prior: null,
    newInput: null,
    correction: null,
    forTask: null,
    sha: null,
    allowDuplicateSha: false,
  };

  // A flag that takes a value must actually have one — guard against it being
  // the last token (`argv[++i]` === undefined) or another flag, which would
  // otherwise be silently dropped.
  const requireValue = (value, name) => {
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new CliError('MISSING_VALUE', `${name} requires a value.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--task') flags.task = requireValue(argv[++i], '--task');
    else if (a.startsWith('--task=')) flags.task = requireValue(a.slice('--task='.length), '--task');
    else if (a === '--contract') flags.contract = requireValue(argv[++i], '--contract');
    else if (a.startsWith('--contract=')) flags.contract = requireValue(a.slice('--contract='.length), '--contract');
    else if (a === '--strict') flags.strict = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--recommended') flags.recommended = true;
    else if (a === '--enterprise') flags.enterprise = requireValue(argv[++i], '--enterprise');
    else if (a.startsWith('--enterprise=')) flags.enterprise = requireValue(a.slice('--enterprise='.length), '--enterprise');
    else if (a === '--branch-strategy') flags.branchStrategy = requireValue(argv[++i], '--branch-strategy');
    else if (a.startsWith('--branch-strategy=')) flags.branchStrategy = requireValue(a.slice('--branch-strategy='.length), '--branch-strategy');
    else if (a === '--create-pr') flags.createPr = requireValue(argv[++i], '--create-pr');
    else if (a.startsWith('--create-pr=')) flags.createPr = requireValue(a.slice('--create-pr='.length), '--create-pr');
    else if (a === '--require-approval') flags.requireApproval = requireValue(argv[++i], '--require-approval');
    else if (a.startsWith('--require-approval=')) flags.requireApproval = requireValue(a.slice('--require-approval='.length), '--require-approval');
    else if (a === '--file') flags.file = requireValue(argv[++i], '--file');
    else if (a.startsWith('--file=')) flags.file = requireValue(a.slice('--file='.length), '--file');
    else if (a === '--input') flags.input = requireValue(argv[++i], '--input');
    else if (a.startsWith('--input=')) flags.input = requireValue(a.slice('--input='.length), '--input');
    else if (a === '--prior') flags.prior = requireValue(argv[++i], '--prior');
    else if (a.startsWith('--prior=')) flags.prior = requireValue(a.slice('--prior='.length), '--prior');
    else if (a === '--new') flags.newInput = requireValue(argv[++i], '--new');
    else if (a.startsWith('--new=')) flags.newInput = requireValue(a.slice('--new='.length), '--new');
    else if (a === '--correction') flags.correction = requireValue(argv[++i], '--correction');
    else if (a.startsWith('--correction=')) flags.correction = requireValue(a.slice('--correction='.length), '--correction');
    else if (a === '--for-task') flags.forTask = requireValue(argv[++i], '--for-task');
    else if (a.startsWith('--for-task=')) flags.forTask = requireValue(a.slice('--for-task='.length), '--for-task');
    else if (a === '--sha') flags.sha = requireValue(argv[++i], '--sha');
    else if (a.startsWith('--sha=')) flags.sha = requireValue(a.slice('--sha='.length), '--sha');
    else if (a === '--allow-duplicate-sha') flags.allowDuplicateSha = true;
    else if (a.startsWith('--')) throw new CliError('UNKNOWN_FLAG', `Unknown flag: ${a}`);
    else positionals.push(a);
  }
  return { positionals, flags };
}

// Version handshake: skills declare the contract they were written against.
// A mismatch fails loudly with guidance instead of silently emitting output
// the skill can't parse.
function checkContract(requested) {
  if (requested === null) return; // flag not supplied (a missing value is caught at parse time)
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
  pocketto-pi log update <plan_dir> <phase_file> <status> [--task TN] [--sha <commit>] [--allow-duplicate-sha] [--json]
  pocketto-pi log update <plan_dir> <phase_file> --correction <sha> [--for-task TN] [--json]
  pocketto-pi log close  <plan_dir>                       [--json]
  pocketto-pi meta get   <dir> <field>                    [--json]
  pocketto-pi meta set   <dir> <field> <value>            [--json]
  pocketto-pi doctor                                      [--strict] [--json]
  pocketto-pi mode [<dir>]                                [--json]
  pocketto-pi mode init [<dir>]                           [--enterprise <bool>] [--branch-strategy <strategy>] [--create-pr <bool>] [--require-approval <bool>] [--file <AGENTS.md|CLAUDE.md>] [--json]
  pocketto-pi format <issue|pr|comment|closeout>          [--input <json-file>] [--json]
  pocketto-pi format tasklist <plan_dir>                  [--json]
  pocketto-pi scaffold github [<dir>]                     [--dry-run] [--json]
  pocketto-pi reconcile                                   [--prior <json>] [--new <json>] [--json]
  pocketto-pi setup-extensions                            [--all] [--json]

Status values: WAITING | REVIEW | DONE | BLOCKED

Flags:
  --json            Emit the stable JSON envelope to stdout
  --contract <N>    Assert the expected output contract (version handshake)
  --dry-run         (structure) compute + summarize without writing files
  --task <id>       (log update) update a task within a phase, e.g. --task T1
  --correction <sha> (log update) record a correction commit on a phase
  --for-task <id>   (log update) task a correction is primarily for, e.g. --for-task T1
  --sha <commit>    (log update) record this commit as the task's done_sha instead of HEAD
                    (repairs a collapsed parallel-group merge; requires --task and status DONE)
  --allow-duplicate-sha (log update) permit a done_sha already recorded by a sibling task
                    (only for tasks that legitimately produced no new commit)
  --strict          (doctor) exit nonzero when a required extension is missing
  --all             (setup-extensions) also install the recommended extensions
  --version, -v     Print version + contract
  --help, -h        Show this help`;

// Set process.exitCode and let the process exit naturally rather than calling
// process.exit(), which can abandon a pending async stdout write (and truncate
// the --json envelope) when output is piped.
function emitSuccess(command, result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(ok(command, result.data)) + '\n');
  } else {
    process.stdout.write(result.human.join('\n') + '\n');
  }
  process.exitCode = result.exit ?? 0;
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
  process.exitCode = exitCode;
}

function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    emitError('cli', err, wantsJson);
    return;
  }
  const { positionals, flags } = parsed;

  if (flags.version) {
    process.stdout.write(`pocketto-pi ${CLI_VERSION} (contract ${CONTRACT})\n`);
    return;
  }
  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP + '\n');
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const command = positionals[0];
  try {
    checkContract(flags.contract);
    if (command === 'structure') {
      const result = structure.run({ planArg: positionals[1], dryRun: flags.dryRun });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'log') {
      const result = log.run({
        sub: positionals[1],
        positionals: positionals.slice(2),
        task: flags.task,
        correction: flags.correction,
        forTask: flags.forTask,
        sha: flags.sha,
        allowDuplicateSha: flags.allowDuplicateSha,
      });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'meta') {
      const result = meta.run({ sub: positionals[1], positionals: positionals.slice(2) });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'doctor') {
      const result = doctor.run({ strict: flags.strict });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'mode') {
      const result = mode.run({
        positionals: positionals.slice(1),
        enterprise: flags.enterprise,
        branchStrategy: flags.branchStrategy,
        createPr: flags.createPr,
        requireApproval: flags.requireApproval,
        file: flags.file,
      });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'format') {
      const result = format.run({ kind: positionals[1], inputPath: flags.input, positionals: positionals.slice(2) });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'scaffold') {
      const result = scaffold.run({ target: positionals[1], targetDir: positionals[2], dryRun: flags.dryRun });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'reconcile') {
      const result = reconcile.run({ priorPath: flags.prior, newPath: flags.newInput });
      emitSuccess(result.command, result, flags.json);
    } else if (command === 'setup-extensions') {
      const result = setupExtensions.run({ all: flags.all, recommended: flags.recommended });
      emitSuccess(result.command, result, flags.json);
    } else {
      throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}. Use structure | log | meta | doctor | mode | format | scaffold | reconcile | setup-extensions.`);
    }
  } catch (err) {
    emitError(command, err, flags.json);
  }
}

main();
