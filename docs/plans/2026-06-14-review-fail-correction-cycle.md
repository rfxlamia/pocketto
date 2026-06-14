# REVIEW_FAIL Correction Cycle — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Give Pocket a deterministic correction cycle after `REVIEW_FAIL` by tracking append-only correction commits per phase (never moving `done_sha`), with full per-file cross-task attribution, a new `pocket-correction` skill, and review/closing/development updates.

**Architecture:** Add an additive `phase.corrections[]` array to `log.json` (`{sha, files, for_task?}`). A new CLI mode `log update <dir> <phase> --correction <sha> [--for-task TN]` records a correction commit, computing its files from git and attributing them to owning tasks. Skills (pocket-review, pocket-closing, pocket-development, new pocket-correction) consume this: a corrected task's review range is its original range plus the per-file slices of correction commits it owns; closing freshness anchors to the latest owned correction SHA.

**Tech Stack:** Plain Node `>=18` (`node:*` builtins only, no deps), `node --test` (`test/cli.test.js` is the entire CI surface). Skills are markdown prompts (no runtime tests). Dual-host manifests: Pi (`package.json` `pi.skills`) + Claude Code plugin (`.claude-plugin/marketplace.json`).

**Source of truth:** `docs/plans/2026-06-14-review-fail-correction-cycle-design.md` — read it before starting.

**Invariants to preserve (do NOT break):**
- JSON envelope shape `{ ok, command, cliVersion, contract, data, error }` and `CONTRACT = 2` (additive-only — no `2→3` bump).
- `log.json` writer: 2-space indent + trailing newline (`cli/lib/logjson.js`).
- `done_sha` is NEVER moved by correction code.
- Existing `#28` collision warning must keep working unchanged.

---

## Task 1: git helpers for commit/range file lists

**Files:**
- Modify: `cli/lib/git.js`
- Test: `test/cli.test.js`

**Step 1: Write the failing tests**

Add near the other git-gated tests in `test/cli.test.js` (after the `#28` collision test region):

```js
const gitlib = require('../cli/lib/git');

test('getCommitFiles lists files changed in a single commit (incl. root)', { skip: !hasGit() }, () => {
  const dir = tmp();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@e.com']);
  git(dir, ['config', 'user.name', 'T']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'root']);          // root commit (no parent)
  const rootSha = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(gitlib.getCommitFiles(dir, rootSha), ['a.txt']);

  writeFileSync(path.join(dir, 'b.txt'), 'b');
  git(dir, ['add', 'b.txt']);
  git(dir, ['commit', '-q', '-m', 'second']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(gitlib.getCommitFiles(dir, sha), ['b.txt']);
});

test('getRangeFiles lists files changed across a base..head range', { skip: !hasGit() }, () => {
  const dir = tmp();
  gitInitRepo(dir);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(path.join(dir, 'x.txt'), 'x');
  git(dir, ['add', 'x.txt']);
  git(dir, ['commit', '-q', '-m', 'x']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(gitlib.getRangeFiles(dir, base, head), ['x.txt']);
});

test('getCommitFiles / getRangeFiles return [] on git failure', () => {
  const nodir = path.join(tmp(), 'not-a-repo');
  assert.deepEqual(gitlib.getCommitFiles(nodir, 'deadbeef'), []);
  assert.deepEqual(gitlib.getRangeFiles(nodir, 'a', 'b'), []);
});
```

**Step 2: Run to verify failure**

Run: `node --test --test-name-pattern="getCommitFiles|getRangeFiles" test/cli.test.js`
Expected: FAIL — `gitlib.getCommitFiles is not a function`.

**Step 3: Implement**

Add to `cli/lib/git.js` (before `module.exports`):

```js
// Files changed by a single commit, relative to its parent. `diff-tree -r`
// handles a root commit (no parent) without empty-tree special-casing.
// Mirrors getGitSha(): never throws — returns [] when git is unavailable.
function getCommitFiles(cwd, sha) {
  try {
    const out = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

// Files changed across base..head. Never throws — returns [] on failure.
function getRangeFiles(cwd, base, head) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}..${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}
```

Update exports:

```js
module.exports = { getGitSha, getRemoteUrl, getCommitFiles, getRangeFiles };
```

**Step 4: Run to verify pass**

Run: `node --test --test-name-pattern="getCommitFiles|getRangeFiles" test/cli.test.js`
Expected: PASS (3 tests; the failure-path one runs even without git).

**Step 5: Commit**

```bash
git add cli/lib/git.js test/cli.test.js
git commit -m "feat(cli): add getCommitFiles/getRangeFiles git helpers"
```

---

## Task 2: CLI `log update --correction` — record + attribute

**Files:**
- Modify: `cli/index.js:33-92` (argv), `cli/index.js:200-202` (dispatch)
- Modify: `cli/commands/log.js`
- Test: `test/cli.test.js`

**Step 1: Write the failing tests**

```js
const PLAN_4 = [
  '# Plan',
  '',
  '## Pocket Packets',
  '',
  '### Task 1: alpha',
  '### Task 2: beta',
  '### Task 3: gamma',
  '',
].join('\n');

function setupPhasedDone(dir) {
  // Build a 3-task flat plan, structure it, init log, and mark T1..T3 DONE
  // each on its own commit so they have distinct done_sha boundaries.
  writeFileSync(path.join(dir, 'execution-plan.md'), PLAN_4);
  run(['structure', path.join(dir, 'execution-plan.md')]);
  gitInitRepo(dir);
  run(['log', 'init', dir]);
  const phase = 'execution-plan.md';
  for (const t of ['T1', 'T2', 'T3']) {
    writeFileSync(path.join(dir, `${t.toLowerCase()}.txt`), t);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `${t} work`]);
    run(['log', 'update', dir, phase, 'DONE', '--task', t, '--json']);
  }
  return phase;
}

test('log update --correction appends to phase.corrections with files', { skip: !hasGit() }, () => {
  const dir = tmp();
  const phase = setupPhasedDone(dir);

  // A correction to T1 that only touches t1.txt.
  writeFileSync(path.join(dir, 't1.txt'), 'T1 fixed');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fix T1']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();

  const env = json(['log', 'update', dir, phase, '--correction', sha, '--for-task', 'T1', '--json']);
  assert.equal(env.command, 'log update');
  assert.equal(env.data.level, 'correction');
  assert.equal(env.data.correction.sha, sha);
  assert.deepEqual(env.data.correction.files, ['t1.txt']);
  assert.deepEqual(env.data.correction.affectedTasks, ['T1']);
  assert.deepEqual(env.data.correction.bleed, []);

  // Persisted under the phase, done_sha untouched.
  const log = JSON.parse(readFileSync(path.join(dir, 'log.json'), 'utf8'));
  const ph = log.phases.find((p) => p.file === phase);
  assert.equal(ph.corrections.length, 1);
  assert.equal(ph.corrections[0].sha, sha);
  assert.deepEqual(ph.corrections[0].files, ['t1.txt']);
  assert.equal(ph.corrections[0].for_task, 'T1');
});

test('log update --correction warns on cross-task file bleed', { skip: !hasGit() }, () => {
  const dir = tmp();
  const phase = setupPhasedDone(dir);

  // A "T1" correction that also edits t2.txt (owned by T2) → bleed.
  writeFileSync(path.join(dir, 't1.txt'), 'T1 fixed');
  writeFileSync(path.join(dir, 't2.txt'), 'T2 touched');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fix T1 bleeding into T2']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();

  const env = json(['log', 'update', dir, phase, '--correction', sha, '--for-task', 'T1', '--json']);
  assert.deepEqual(env.data.correction.affectedTasks.sort(), ['T1', 'T2']);
  assert.deepEqual(env.data.correction.bleed, ['T2']);

  const human = run(['log', 'update', dir, phase, '--correction', sha, '--for-task', 'T1']).stdout;
  assert.match(human, /already recorded/); // idempotent re-record warns (see next test)
});

test('log update --correction is idempotent on a duplicate sha (no-op + warn)', { skip: !hasGit() }, () => {
  const dir = tmp();
  const phase = setupPhasedDone(dir);
  writeFileSync(path.join(dir, 't3.txt'), 'T3 fixed');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fix T3']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();

  json(['log', 'update', dir, phase, '--correction', sha, '--for-task', 'T3', '--json']);
  const again = json(['log', 'update', dir, phase, '--correction', sha, '--for-task', 'T3', '--json']);
  assert.equal(again.data.correction.idempotent, true);

  const log = JSON.parse(readFileSync(path.join(dir, 'log.json'), 'utf8'));
  const ph = log.phases.find((p) => p.file === phase);
  assert.equal(ph.corrections.length, 1); // not appended twice
});

test('log update --correction preserves the byte-parity writer + additive schema', { skip: !hasGit() }, () => {
  const dir = tmp();
  const phase = setupPhasedDone(dir);
  writeFileSync(path.join(dir, 't1.txt'), 'fix');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fix']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  json(['log', 'update', dir, phase, '--correction', sha, '--for-task', 'T1', '--json']);

  const raw = readFileSync(path.join(dir, 'log.json'), 'utf8');
  assert.ok(raw.endsWith('\n'));                       // trailing newline
  assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n'); // 2-space indent, round-trips
});
```

**Step 2: Run to verify failure**

Run: `node --test --test-name-pattern="--correction" test/cli.test.js`
Expected: FAIL — `Unknown flag: --correction` (argv) / `level` not `correction`.

**Step 3a: Implement argv parsing** in `cli/index.js`

Add to the `flags` object (after `task: null,`):

```js
    correction: null,
    forTask: null,
```

Add to the parse loop (after the `--task=` branch, before `--contract`):

```js
    else if (a === '--correction') flags.correction = requireValue(argv[++i], '--correction');
    else if (a.startsWith('--correction=')) flags.correction = requireValue(a.slice('--correction='.length), '--correction');
    else if (a === '--for-task') flags.forTask = requireValue(argv[++i], '--for-task');
    else if (a.startsWith('--for-task=')) flags.forTask = requireValue(a.slice('--for-task='.length), '--for-task');
```

Update the `log` dispatch (`cli/index.js:201`) to forward the new flags:

```js
      const result = log.run({
        sub: positionals[1],
        positionals: positionals.slice(2),
        task: flags.task,
        correction: flags.correction,
        forTask: flags.forTask,
      });
```

Add a help line under `--task <id>` in `HELP`:

```
  --correction <sha> (log update) record a correction commit on a phase
  --for-task <id>    (log update) task a correction is primarily for, e.g. --for-task T1
```

**Step 3b: Implement the correction path** in `cli/commands/log.js`

Add to the requires at the top:

```js
const { getGitSha, getCommitFiles, getRangeFiles } = require('../lib/git');
```

Add a helper (after `collectPlanFiles`):

```js
// file → owning task id, by chaining each DONE task's original range
// (prev..done_sha) in plan order. Last writer within original ranges wins.
// Mirrors pocket-review's linear range model. Correction commits are NOT
// part of any task's original range, so they never appear here.
function buildOwnerMap(planDir, phase, baselineSha) {
  const owner = {};
  let prev = baselineSha;
  for (const t of phase.tasks || []) {
    if (!t.done_sha) continue;
    for (const f of getRangeFiles(planDir, prev, t.done_sha)) owner[f] = t.id;
    prev = t.done_sha;
  }
  return owner;
}
```

Add the recorder (after `update`):

```js
function recordCorrection(positionals, sha, forTask) {
  if (positionals.length !== 2) {
    throw new CliError(
      'USAGE',
      'Usage: pocketto-pi log update <plan_dir> <phase_file> --correction <sha> [--for-task <task_id>]',
    );
  }
  const [planDirArg, phaseFile] = positionals;
  const planDir = resolvePlanDir(planDirArg);
  const logPath = path.join(planDir, 'log.json');
  if (!existsSync(logPath)) {
    throw new CliError('NO_LOG', `log.json not found at '${logPath}'. Run 'pocketto-pi log init' first.`);
  }
  const log = readLog(logPath);
  const phase = log.phases.find((p) => p.file === phaseFile);
  if (!phase) {
    const available = log.phases.map((p) => p.file);
    throw new CliError('PHASE_NOT_FOUND', `'${phaseFile}' not found in log. Available: ${JSON.stringify(available)}`);
  }
  if (!phase.corrections) phase.corrections = [];

  const forId = forTask ? forTask.toUpperCase() : null;
  const files = getCommitFiles(planDir, sha);
  const owner = buildOwnerMap(planDir, phase, log.header.baseline_sha);

  // Attribution: every owning task whose files appear in this commit.
  const affected = new Set();
  if (forId) affected.add(forId);
  const bleed = new Set();
  for (const f of files) {
    const o = owner[f];
    if (!o) continue;          // brand-new file, owned by no prior task
    affected.add(o);
    if (forId && o !== forId) bleed.add(o);
  }
  const affectedTasks = [...affected].sort();
  const bleedTasks = [...bleed].sort();

  // Idempotency: a sha already recorded on this phase → no-op + warn.
  const existing = phase.corrections.find((c) => c.sha === sha);
  if (existing) {
    return {
      command: 'log update',
      exit: 0,
      human: [`Correction ${sha} is already recorded on ${phaseFile} — no-op.`],
      data: {
        planDir,
        phaseFile,
        level: 'correction',
        correction: { sha, files: existing.files, affectedTasks, bleed: bleedTasks, idempotent: true },
      },
    };
  }

  const entry = { sha, files };
  if (forId) entry.for_task = forId;
  phase.corrections.push(entry);
  writeLog(logPath, log);

  const human = [`Recorded correction ${sha} on ${phaseFile}${forId ? ` (for ${forId})` : ''}: ${files.length} file(s).`];
  if (bleedTasks.length) {
    human.push(
      `⚠ this correction also touches files owned by ${bleedTasks.join(', ')} (cross-task bleed).`,
      `  Those tasks will be re-reviewed by pocket-review. See design: full attribution.`,
    );
  }
  return {
    command: 'log update',
    exit: 0,
    human,
    data: {
      planDir,
      phaseFile,
      level: 'correction',
      correction: { sha, files, affectedTasks, bleed: bleedTasks, idempotent: false },
    },
  };
}
```

Route it in `run` (replace the `update` branch):

```js
  if (sub === 'update') {
    if (correction) return recordCorrection(positionals, correction, forTask);
    return update(positionals, task);
  }
```

And update the `run` signature + module destructuring:

```js
function run({ sub, positionals, task, correction, forTask }) {
```

**Step 4: Run to verify pass**

Run: `node --test --test-name-pattern="--correction" test/cli.test.js`
Expected: PASS (4 tests).

Then the full suite: `npm test` — Expected: all pass (additive change; existing tests untouched).

**Step 5: Commit**

```bash
git add cli/index.js cli/commands/log.js test/cli.test.js
git commit -m "feat(cli): record phase corrections with cross-task attribution (#34)"
```

---

## Task 3: `pocket-correction` skill

**Files:**
- Create: `skills/pocket-correction/SKILL.md`
- Modify: `package.json` (`pi.skills`), `.claude-plugin/marketplace.json` (and `.claude-plugin/plugin.json` if it enumerates skills)
- Modify: `skills/pocket-help/SKILL.md`, `skills/pocket-help/references/skill-map.md`, `skills/pocket-help/references/end-to-end-flow.md`

> Skills are prompts — no runtime test. "Done" = the SKILL.md exists, frontmatter is valid (`name` + `description` only), and both host manifests list it. Verify with `node cli/index.js doctor` is NOT applicable; instead grep the manifests (Step 4).

**Step 1: Write `skills/pocket-correction/SKILL.md`**

Frontmatter (exactly two keys):

```yaml
---
name: pocket-correction
description: Standalone user-triggered stage between a pocket-review REVIEW_FAIL verdict and re-review. Delegates each failed task's fix to an implementer subagent (main agent stays Delegator + Auditor), records an append-only correction commit per task via the pocketto-pi CLI (done_sha never moves), and hands back for user-triggered re-review. Trigger on "pocket-correction", "apply review fixes", "fix the review failures", or when pocket-review reports REVIEW_FAIL in agent-managed execution.
---
```

Body MUST contain these sections (prose, mirroring pocket-development's tone):

1. **Role** — Delegator + Auditor only; never writes code. Identical non-negotiable to pocket-development:71.
2. **When to use** — after pocket-review wrote verdicts and ≥1 task is `REVIEW_FAIL`. NOT for `REVIEW_BLOCKED` (escalate). NOT mid-phase — the phase already reached `PHASE_COMPLETE`.
3. **Preflight** — read `<plan_dir>/log.json` and `<plan_dir>/reviews/`. Collect `REVIEW_FAIL` tasks that carry `fix_instructions`. If none → report "nothing to correct". If any `REVIEW_BLOCKED` → list them for escalation, do not loop.
4. **Correction loop (SEQUENTIAL, plan order — never parallel; parallel re-triggers the #28 collision):** per `REVIEW_FAIL` task TN:
   - Build a correction packet from `reviews/<TN>-review.json` `fix_instructions` + the task's DELIVERABLE / quality_bar from the plan file.
   - Delegate to one implementer subagent → it makes the fix and creates **exactly one commit**, returns the sha.
   - Quick audit (tests + `git log` + DELIVERABLE) like pocket-development. Fail → re-dispatch with the failure reason. Unresolvable → **BLOCKED mid-correction**: record nothing for TN.
   - Record: `npx -y pocketto-pi log update <plan_dir> <phase_file> --correction <sha> --for-task TN --json --contract 2`. Parse `data.correction`; if `bleed` is non-empty, note the affected tasks (pocket-review will re-review them).
5. **Terminal report:**
   - Success → do NOT auto-run review. Emit: `Corrections recorded for <ids> — run /pocketto:pocket-review <plan_dir>/<phase_file>`.
   - BLOCKED mid-correction → report corrected vs blocked tasks, each blocker's reason + next action. Phase stays un-closeable.
6. **Enterprise note** — corrections are commits on the same branch; they ride the existing PR via create-pr / traveling state. No GitHub calls here.
7. **CLI usage block** — show the exact `--correction` invocation with `--json --contract 2`.

Keep `SKILL.md` lean; no `references/` needed for v1.

**Step 2: Register in the Pi manifest (`package.json`)**

Add `"pocket-correction"` to the `pi.skills` array (match the existing entry format — confirm whether entries are skill dir names or paths by reading the current array first).

**Step 3: Register in the Claude Code plugin manifest**

Add the skill to `.claude-plugin/marketplace.json` (and `.claude-plugin/plugin.json` if it enumerates skills) in the same shape as `pocket-review` / `pocket-closing`. Read those files first and mirror the exact structure.

**Step 4: Verify registration**

Run: `node -e "const p=require('./package.json'); console.log(p.pi.skills.includes('pocket-correction'))"`
Expected: `true`.

Run: `grep -l pocket-correction .claude-plugin/*.json`
Expected: lists the manifest(s) you edited.

Run: `npm test`
Expected: still all pass (manifests aren't CLI-tested, but ensure no JSON syntax error broke anything that is required by tests).

Also sanity-check JSON validity:
Run: `node -e "require('./.claude-plugin/marketplace.json')"` (and plugin.json) — Expected: no error.

**Step 5: Add pocket-correction to pocket-help**

Edit `skills/pocket-help/SKILL.md`, `references/skill-map.md`, `references/end-to-end-flow.md` to describe pocket-correction as the REVIEW_FAIL → re-review stage. Mirror the one-line summary style already used for the other skills.

**Step 6: Commit**

```bash
git add skills/pocket-correction package.json .claude-plugin skills/pocket-help
git commit -m "feat(skills): add pocket-correction skill + register on both hosts (#34)"
```

---

## Task 4: pocket-review — attribution, range-union, re-review trigger

**Files:**
- Modify: `skills/pocket-review/SKILL.md`

> Prose changes only. No runtime test. "Done" = the steps below read coherently and match the CLI data contract.

**Step 1: Extend Step 3 (Build reviewable task list)**

After the existing reviewable-list logic, add:

- Read `phase.corrections` (may be absent → empty).
- Build `owner[file]` exactly as the CLI does (chain `prev..done_sha` in plan order, last-writer-wins). State the algorithm inline so a host without the CLI can reproduce it.
- A task `T` becomes reviewable via **re-review** (in addition to the existing first-cycle rule) when some correction commit touches a file with `owner[file] == T` **and** that commit's sha is newer than the `reviewed_sha` recorded in `reviews/<T>-review.json`. Define "newer" by commit time (`git show -s --format=%cI <sha>`), or treat "sha not equal to recorded reviewed_sha and present in corrections after it" — pick the commit-time rule for determinism and document it.

**Step 2: Define the review range (per-file slicing)**

For a reviewable task `T`, the subagent reviews:
- the original range slice: files in `prev..done_sha` owned by T, AND
- for each correction commit owning ≥1 of T's files: the slice of that commit limited to T's owned files (`git show <sha> -- <those files>`).

State explicitly: a correction commit touching two tasks is presented sliced — each task sees only its own files from that commit.

**Step 3: Cycle + reviewed_sha bookkeeping**

When writing `reviews/<T>-review.json` for a re-review:
- `loop_info.current_cycle` += 1 (and `cycle` mirrors it).
- `reviewed_sha` = the newest correction sha owning a T-file (by commit time), else `done_sha`.
- A passing re-review writes `overall: REVIEW_PASS`, superseding the prior FAIL. A still-failing one writes `REVIEW_FAIL` with fresh `fix_instructions` (cycle-2+, cumulative).

**Step 4: Verify coherence**

Re-read the edited Steps 3–5 end to end; confirm the `reviewed_sha`/`cycle`/`loop_info` field names match the skip-stub JSON already in the file (lines ~106–126). No drift.

**Step 5: Commit**

```bash
git add skills/pocket-review/SKILL.md
git commit -m "feat(pocket-review): attribute corrections per-file + union review range (#34)"
```

---

## Task 5: pocket-closing — freshness anchored to latest owned correction

**Files:**
- Modify: `skills/pocket-closing/SKILL.md`

**Step 1: Update Step 3 freshness check (lines ~96–102)**

Replace the "verdict current iff review timestamp ≥ done_sha commit time" rule with:
- `latest_owned_sha(T)` = the max-by-commit-time of `{ T.done_sha } ∪ { correction commits in phase.corrections whose files include any file owned by T }`.
- The verdict is current iff `reviews/<T>-review.json`.`reviewed_sha` `== latest_owned_sha(T)` (exact match). If a correction touched T's files after its review → `reviewed_sha` is behind → **stale** → `CLOSE_BLOCKED: "T{id} verdict is stale: a correction changed its files after review. Re-run pocket-review."`.
- Keep the timestamp proxy only as a fallback when `reviewed_sha` is absent (older reviews).

**Step 2: Confirm the gate + [CRITICAL] rule are unchanged**

- The verdict gate (line ~112: any `REVIEW_FAIL` → `CLOSE_BLOCKED`) is unchanged — but note explicitly that the **current** per-task verdict decides; an old FAIL superseded by a newer PASS (advanced `reviewed_sha`, `overall == REVIEW_PASS`) passes.
- The `[CRITICAL]` "never pass `--task` on close" (line ~126) is unchanged: closing still only advances phase `REVIEW → DONE`. Corrections are recorded by pocket-correction, never by closing.

**Step 3: Verify coherence**

Re-read the reconciliation table (lines ~86–104) and confirm the new freshness rule slots in without contradicting the reviewable-set definition.

**Step 4: Commit**

```bash
git add skills/pocket-closing/SKILL.md
git commit -m "feat(pocket-closing): anchor freshness to latest owned correction sha (#34)"
```

---

## Task 6: pocket-development row + pocket-review Action Required rewrite

**Files:**
- Modify: `skills/pocket-development/SKILL.md:610-619` (Status Handling)
- Modify: `skills/pocket-review/SKILL.md:170-197` (Action Required block)

**Step 1: Add the REVIEW_FAIL row to pocket-development Status Handling**

After the `BLOCKED` row in the table (line ~617):

```markdown
| **REVIEW_FAIL** (from pocket-review) | The phase already terminated at PHASE_COMPLETE — you are NOT mid-phase. Re-enter via `/pocketto:pocket-correction <plan_dir>/<phase_file>`: it delegates each fix to an implementer subagent (you stay Delegator + Auditor), records an append-only correction, then hands back for user-triggered re-review. Do NOT write the fix yourself; do NOT refresh done_sha. |
```

Add one clarifying sentence under the table noting that REVIEW_FAIL is a post-phase verdict (not a subagent return status), handled by the standalone pocket-correction skill, keeping pocket-development one-shot.

**Step 2: Rewrite the pocket-review Action Required block (lines 170-197)**

Replace the entire SAFE/NOT-SAFE block with a context-aware two-path block. New printed block:

```
ACTION REQUIRED — review did not pass

Do not run pocket-closing yet. Corrections are append-only — done_sha never moves,
so there is no "safe vs unsafe" boundary decision anymore.

▸ MANUAL (a human is applying fixes directly):
  For each REVIEW_FAIL task:
  1. Read reviews/<task_id>-review.json and apply the fix_instructions.
  2. Commit the fix (one commit), then record it as a correction:
       npx -y pocketto-pi log update <plan_dir> <phase_file> \
         --correction <sha> --for-task <task_id> --json --contract 2
  3. Re-run: /pocketto:pocket-review <plan_dir>/<phase_file>

▸ AGENT (you reached here from pocket-development — agent-managed execution):
  The phase already terminated at PHASE_COMPLETE; you are NOT mid-phase.
  Run: /pocketto:pocket-correction <plan_dir>/<phase_file>
  It delegates each fix, records corrections, and hands back for re-review.

For REVIEW_BLOCKED (either path):
- Do not enter a fix cycle. Resolve the blocker or escalate as instructed.
```

Delete the now-obsolete "Why this matters: pocket-review computes task ranges linearly… Refreshing a non-last task…" paragraph (lines ~195-197) and the line-186 NOT-SAFE guidance — superseded by the correction model. Replace with one sentence: "Recording a correction never moves an existing done_sha, so it is always safe regardless of task position."

**Step 3: Verify coherence**

Re-read both edited sections. Confirm no remaining reference to "SAFE/NOT-SAFE done_sha refresh" survives anywhere in `skills/pocket-review/SKILL.md` (grep below).

Run: `grep -n "NOT SAFE\|NOT-SAFE\|refresh.*done_sha" skills/pocket-review/SKILL.md`
Expected: no stale SAFE/NOT-SAFE refresh guidance remains (only the new "always safe" sentence, if it matches).

**Step 4: Commit**

```bash
git add skills/pocket-development/SKILL.md skills/pocket-review/SKILL.md
git commit -m "feat(skills): context-aware REVIEW_FAIL path via pocket-correction (#34)"
```

---

## Task 7: Final verification + issue update

**Step 1: Full test suite**

Run: `npm test`
Expected: all pass, including the new Task 1 + Task 2 tests.

**Step 2: Manifest sanity**

Run: `node -e "require('./.claude-plugin/marketplace.json'); require('./package.json'); console.log('manifests OK')"`
Expected: `manifests OK`.

**Step 3: Cross-reference grep**

Run: `grep -rn "pocket-correction" skills/ package.json .claude-plugin`
Expected: appears in the new skill, both manifests, and pocket-help references.

**Step 4: Update issue #34**

Post a closing-the-loop comment on #34 linking the design doc + this plan + the branch/PR, summarizing that the doc-only suggestions were superseded by the append-only `corrections[]` data model. (Do this via `gh issue comment 34` only after the user approves opening a PR.)

---

## Notes for the executor

- **TDD discipline:** Tasks 1–2 are real TDD (failing test first). Tasks 3–6 are prose/manifest changes with no runtime tests — verify via grep/JSON-parse, not `node --test`.
- **Do not** touch `done_sha` write logic in `update()` — corrections are a separate path.
- **Read first, mirror:** before editing any manifest or pocket-help reference, read the existing entries for `pocket-review`/`pocket-closing` and copy their exact shape.
- **Parity:** `npm test` is the only gate — run it after every CLI task.
