'use strict';

// Step 1 of `log handoff` (stacked plans): preconditions, plus the closeout
// section extraction the snapshot step reuses. Every refusal throws before
// anything is written.
//
// Boundary: local only. No push, no `gh`, no enterprise/** imports.

const path = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { CliError } = require('./envelope');
const { readLogChecked } = require('./logjson');
const { currentBranch } = require('./git-worktree');
// The dirty-set guard is shared with `log init`; only the rerun hint differs.
const { assertCleanOutsidePlan } = require('./phase-branches');

const HEADING = /^#{1,6}\s/;
const MARKER_PREFIX = '<!-- pocket-closeout:';

function closeoutMarker(order) {
  return `${MARKER_PREFIX}phase-${order} -->`;
}

// Indexes of lines that are exactly <marker> (surrounding whitespace aside).
// Never a substring or heading match: phase-1 must not match phase-10.
function markerLines(lines, marker) {
  const hits = [];
  lines.forEach((line, i) => {
    if (line.trim() === marker) hits.push(i);
  });
  return hits;
}

// closeout.md split into lines, or HANDOFF_CLOSEOUT_MISSING when the file is
// absent or the phase's exact marker is not there exactly once.
function readCloseoutLines(planDir, order) {
  const file = path.join(planDir, 'closeout.md');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : null;
  const hits = lines ? markerLines(lines, closeoutMarker(order)) : [];
  if (hits.length !== 1) {
    const reason = hits.length === 0 ? 'has no' : `has ${hits.length} copies of the`;
    throw new CliError(
      'HANDOFF_CLOSEOUT_MISSING',
      `${file} ${reason} ${closeoutMarker(order)} section. It needs exactly one; append or repair the phase's closeout section (pocket-closing), then rerun log handoff.`,
    );
  }
  return { lines, start: hits[0] };
}

// The phase's closeout section: from its marker line up to the next
// `<!-- pocket-closeout:` marker line or EOF. Each marker sits directly under
// its own heading, so the heading line that belongs to the next marker is
// left out, and trailing whitespace is normalized to one newline. The result
// is therefore unchanged when later sections are appended.
function extractSection({ lines, start }) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith(MARKER_PREFIX)) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);
  if (end < lines.length) {
    while (section.length > 1 && section[section.length - 1].trim() === '') section.pop();
    if (section.length > 1 && HEADING.test(section[section.length - 1])) section.pop();
  }
  return `${section.join('\n').replace(/\s+$/, '')}\n`;
}

// HEAD must be exactly this phase's recorded branch; detached HEAD is a
// mismatch too.
function assertOnPhaseBranch(planDir, phase) {
  const head = currentBranch(planDir);
  if (head === phase.branch) return;
  throw new CliError(
    'PHASE_BRANCH_MISMATCH',
    `${phase.file} belongs on ${phase.branch}, but HEAD is ${head === null ? 'detached' : head}. ` +
      `Run: git switch ${phase.branch}`,
  );
}

// Worktree paths from `git worktree list --porcelain`. The first entry is the
// main worktree. Null when git cannot list them (fail closed by the caller).
function worktreeList(cwd) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0 || r.error) return null;
  return r.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

// Pocket parallel groups register task worktrees (conventionally under
// .worktree/). Any registered worktree besides the main one means a group may
// still hold unmerged work, so handoff refuses. Entries are counted, never
// compared as path strings.
function assertNoExtraWorktrees(planDir) {
  const list = worktreeList(planDir);
  if (list === null) {
    throw new CliError('HANDOFF_WORKTREES_ACTIVE', 'Could not list git worktrees (git worktree list --porcelain failed), so handoff cannot confirm no parallel group is active.');
  }
  const extra = list.slice(1);
  if (extra.length === 0) return;
  const err = new CliError(
    'HANDOFF_WORKTREES_ACTIVE',
    `Other git worktrees are still registered: ${extra.join(', ')}. Merge or finish the parallel group, remove them with git worktree remove <path> (and git worktree prune), then rerun log handoff.`,
  );
  err.details = { worktrees: extra };
  throw err;
}

// Step 1: preconditions, in spec order. Every refusal throws before anything
// is written. Returns the plan context the later steps need.
function checkPreconditions(planDir, phaseFileArg, findPhaseInLog) {
  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }
  const log = readLogChecked(logPath);
  const mode = log.header && log.header.phase_branches ? log.header.phase_branches.mode : 'none';
  if (mode !== 'stacked') {
    throw new CliError(
      'HANDOFF_NOT_STACKED',
      `${logPath} records phase_branches '${mode || 'none'}'; log handoff applies only to stacked plans. Nothing was changed.`,
    );
  }
  const phase = findPhaseInLog(log, phaseFileArg);
  if (!phase) {
    const available = log.phases.map((p) => p.file);
    throw new CliError('PHASE_NOT_FOUND', `'${phaseFileArg}' not found in log. Available: ${JSON.stringify(available)}`);
  }
  if (phase.status !== 'DONE') {
    throw new CliError(
      'HANDOFF_PHASE_NOT_DONE',
      `${phase.file} is ${phase.status}; handoff runs only after the phase is DONE. Close the phase first (pocket-closing), then rerun log handoff.`,
    );
  }
  const closeout = readCloseoutLines(planDir, phase.order);
  assertOnPhaseBranch(planDir, phase);
  assertNoExtraWorktrees(planDir);
  assertCleanOutsidePlan(planDir, 'log handoff');
  return { logPath, log, phase, closeout };
}

module.exports = { checkPreconditions, extractSection, closeoutMarker };
