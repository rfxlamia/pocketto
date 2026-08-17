# EXECUTION PLAN — In-Loop Build Cycle

**Date:** 2026-08-15
**Spec:** docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
**GitHub issue:** #41
**Status:** approved
**Total tasks:** 14

---

## Execution Overview

### Recommended Order

```
T1 → T2 ─┐
T3 → T4, T5 (parallel) ─┴→ T6 → T7, T8 (parallel) → T9 → T10
                                                     T9 → T11 → T12 → T13 → T14
```

T6 joins both chains: it depends on T2 (CLI), T4 and T5 (skills).

T7 and T8 depend on **T6**, not T4: if the Phase A comprehension review finds a blocking
contradiction, Phase B must not already be built on top of it. Both are documentation
files, so the serialization costs little.

> Dependency order above is **recommended** — pocket-development enforces actual
> parallelism and sequencing based on its routing logic.

### Parallelizable Groups

| Group | Tasks | Unblocked After |
|-------|-------|-----------------|
| Group A | T4, T5 | T3 completes |
| Group B | T7, T8 | T6 completes |
| Group C | T1/T2 vs T3/T4/T5 | independent — CLI and skill files never overlap |

### Constraints Reminder

**Architecture:**
- Main agent is Delegator + Auditor — never writes implementation code, never judges code itself.
- The auditor is always a separate read-only subagent.
- State lives on disk; `log.json` is written only through the CLI.
- Contract 2 is **additive-only**. `CONTRACT` stays `2` in this plan. The package major goes to `3.0.0` for behavior, not schema.
- Enterprise paths stay fail-closed: any error or non-`true` `enterprise` means zero `gh` calls.
- Pi manifest (`package.json` `pi.skills`, `bin`) and Claude Code plugin manifest stay in sync.
- `npm test` stays green after every CLI task.

**Out-of-scope (no task may touch):**
- The *meaning* of `done_sha` — it remains the boundary of a task's owned range.
- Parallel-group worktree setup, sequential-merge, cleanup mechanics.
- `create-pr` behavior — it stays a recorder.
- `pocket-closing` gate logic — same artifact path and schema, no algorithm change.
- The E5b fingerprint field mismatch (`ruleId`/`occurrence` derived, not stored) — pre-existing.

**Assumptions at risk:**
- The legacy fixture at `test/cli.test.js:982-999` must be **split** (one test for "marker-less legacy log is refused", one for migration against a marker-carrying task-less log), not patched with a marker. Patching it would assert the laundering behavior Rule C1.2 forbids. The `format tasklist` fixtures at `:2079`/`:2131` are on the read-only path and must stay marker-less.
- The phase-level pass runs as a subagent (T7).
- The "no cross-task findings" record must not be readable by `pocket-closing` as a task verdict (T7).
- `create-pr` needs no change (T8, T12).

**Sequencing:** Dependency order shown is recommended only — pocket-development enforces actual blocking rules.

### File Structure Map

```
Rule: Migration (pipeline marker + refusal)
  Modify: cli/lib/version.js                    (T1)
  Modify: cli/commands/log.js                   (T1, T2)
  Modify: cli/lib/logjson.js                    (T2)
  Test:   test/cli.test.js                      (T1, T2)

Rule: In-loop deep audit / Round budget / SHA pinning / Verified refactor
  Rewrite: skills/pocket-development/references/two-stage-review.md   (T3)
  Modify:  skills/pocket-development/SKILL.md                          (T4)
  Modify:  skills/pocket-planning/SKILL.md                             (T5)

Rule: Phase-level pass / Corrections
  Create: skills/pocket-development/references/phase-level-pass.md     (T7)
  Modify: skills/pocket-development/SKILL.md                           (T9)

Rule: Enterprise reporting
  Create: skills/pocket-development/references/enterprise-reporting.md (T8)
  Modify: skills/pocket-development/SKILL.md                           (T9)

Rule: Closing compatibility / Comprehension
  Modify: skills/pocket-review/SKILL.md                                (T11)
  Modify: skills/pocket-correction/SKILL.md                            (T11)
  Modify: skills/pocket-review/references/review-report-template.md    (T11, prose only)
  Modify: skills/pocket-review/references/subagent-dispatch-template.md (T11, superseded note)
  Modify: llms.txt, README.md                                          (T12)
  Modify: skills/create-pr/SKILL.md                                    (T12)
  Modify: skills/pocket-closing/references/verdict-reconciliation.md   (T12)
  Modify: skills/pocket-closing/SKILL.md                               (T12, prose only)
  Modify: skills/pocket-help/SKILL.md                                  (T12)
  Modify: skills/pocket-help/references/skill-map.md                   (T12)
  Modify: skills/pocket-help/references/end-to-end-flow.md             (T12)
  Modify: skills/pocket-help/references/pocket-vs-superpowers.md       (T12)
  Modify: package.json, .claude-plugin/plugin.json,
          .claude-plugin/marketplace.json, README.md                   (T13)

Rule: Comprehension — verification records
  Create: docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-a.md  (T6)
  Create: docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md  (T10)
  Create: docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md    (T14)
```

Verification tasks (T6, T10, T14) edit no product file — they only create the review
records listed immediately above.

---

## Pocket Packets

---

### Task 1: CLI — PIPELINE marker constant and stamping at log init [prereq]

## OBJECTIVE

Introduce an integer pipeline-version marker as a first-class CLI constant and record it in the `log.json` header whenever a log is created from scratch. `CONTRACT` is untouched.

Files:
- Modify: `cli/lib/version.js`
- Modify: `cli/commands/log.js`
- Test: `test/cli.test.js`

Steps:

1. Write failing test for: rule "Migration" — GWT scenario "A new plan is stamped at init"
   File: `test/cli.test.js`
   Test verifies: Given `log init` runs on a plan directory with no `log.json`, When the log is created from scratch, Then `header.pipeline` is the current integer marker and the JSON envelope shape is otherwise unchanged.

   Add beside the existing in-process requires at the top of `test/cli.test.js`
   (next to `const gitlib = require("../cli/lib/git");`):

   ```js
   const version = require("../cli/lib/version");
   ```

   Append this test after `"log init creates a phased log.json with tasks + SHA tracking field"`
   (`test/cli.test.js:974`). It reuses the file's existing `tmp()`, `writePlan()`,
   `run()`, `json()` helpers and the `NINE_TASK_PLAN` fixture — do not invent new ones.
   Indent with tabs, like the rest of the file.

   ```js
   test("log init stamps the pipeline marker into a fresh log.json header", () => {
   	const dir = tmp();
   	writePlan(dir, NINE_TASK_PLAN);
   	run(["structure", path.join(dir, "execution-plan.md")]);

   	const env = json(["log", "init", dir, "--json"]);
   	assert.equal(env.ok, true);
   	assert.equal(env.command, "log init");
   	assert.equal(env.contract, 2); // CONTRACT is NOT bumped by the pipeline marker
   	assert.equal(env.data.migrated, false);
   	// `init`'s data never echoed the header — the envelope shape stays unchanged.
   	assert.equal("header" in env.data, false);

   	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
   	assert.equal(Number.isInteger(version.PIPELINE), true);
   	assert.equal(Number.isInteger(log.header.pipeline), true);
   	assert.equal(log.header.pipeline, version.PIPELINE);

   	// Every other header field is untouched.
   	assert.equal(log.header.plan_type, "phased");
   	assert.equal(log.header.status, "IN_PROGRESS");
   	assert.equal(log.header.date_completed, null);
   	assert.ok("baseline_sha" in log.header);
   });
   ```

   Note on the RED state: `Number.isInteger(...)` is asserted on both sides *before*
   the equality check on purpose. At RED both `log.header.pipeline` and
   `version.PIPELINE` are `undefined`, so `assert.equal(log.header.pipeline,
   version.PIPELINE)` alone would vacuously PASS. Do not reorder these three lines.

2. Run test — verify FAIL:
   `node --test --test-name-pattern="pipeline" test/cli.test.js`
   Expected failure: assertion that `header.pipeline` is a number fails because the key is `undefined`.

3. Implement minimal code to satisfy the test:
   File: `cli/lib/version.js`
   Implement: export a new `PIPELINE` integer constant (value `3`) beside `CONTRACT`, with a comment stating it tracks the execution-pipeline generation and is bumped independently of `CONTRACT`.
   File: `cli/commands/log.js`
   Implement: in the init path that constructs a fresh log object before `writeLog(logPath, log)` (around `cli/commands/log.js:120`), set `header.pipeline = PIPELINE`. Do not alter any other header field, key order aside from appending, or the 2-space-indent + trailing-newline write.

4. Run test — verify PASS:
   `node --test --test-name-pattern="pipeline" test/cli.test.js`
   Expected: PASS

5. Refactor while green (bounded):
   - Rule of three: if the marker value is read in 3+ places, import it from `lib/version.js` rather than re-declaring — never inline the literal.
   - `cli/commands/log.js` is already large; do not add a new helper file for a single constant read.
   - Refactor only within `cli/lib/version.js` and `cli/commands/log.js`.
   - Re-run: `node --test test/cli.test.js` — the full suite must stay PASS.

6. Commit:
   `git add cli/lib/version.js cli/commands/log.js test/cli.test.js`
   `git commit -m "feat(cli): stamp pipeline marker in log.json header at init"`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Migration, GWT "A new plan is stamped at init" used as verification
cli/lib/version.js — `CONTRACT` is a hand-maintained integer constant; `CLI_VERSION` is read from package.json with a try/catch fallback
cli/commands/log.js — the init path constructs the log object then calls `writeLog`; `migrateExisting` (`:171-211`) is the separate path for a log that already exists
cli/lib/logjson.js — `writeLog` writes 2-space indent + trailing newline, byte-for-byte parity with the original Python writer

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: 2 source files plus tests, no branching logic — a constant and a single assignment at a known call site.
Complexity: lightweight

## SANDWICH CONTEXT

[CRITICAL: Do NOT change `CONTRACT`. It stays `2`. The pipeline marker is a separate integer.]
You are implementing the pipeline-version marker for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — artifact-only; `log.json` gains exactly one additive header field.
Files in scope: `cli/lib/version.js`, `cli/commands/log.js`, `test/cli.test.js` — no other files.
Test framework: node:test, CommonJS, CLI spawned via `execFileSync` into `mkdtempSync` fixtures.
Available after: none (prereq)
Architecture rule: contract 2 is additive-only — a new header key is additive; changing or removing an existing key is not.
[RESTATE: `CONTRACT` stays `2`. Touching it requires a major-version decision this task does not own.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given `log init` runs on a plan directory with no `log.json`, When the log is created from scratch, Then `header.pipeline` equals the current integer marker.
Given the same init run, When the JSON envelope is inspected, Then its shape is unchanged from before this task (`init`'s `data` never echoed `header`).
[must-not] Given this task's diff, When `cli/lib/version.js` is read, Then `CONTRACT` must NOT have changed value.
[must-not] Given an existing `log.json`, When init runs against it, Then this task must NOT stamp a marker onto it — that path belongs to T2.

All tests PASS (`node --test test/cli.test.js`). Commit exists matching `feat(cli): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `PIPELINE` exported from `cli/lib/version.js` as an integer, documented as independent of `CONTRACT`
  - `header.pipeline` written only on from-scratch creation
  - Tests written BEFORE implementation (TDD — not after)
  - Commit message follows conventional commits format

Must-not-have:
  - Any change to `CONTRACT`
  - Any change to `writeLog` formatting (2-space indent + trailing newline is parity-locked)
  - Stamping the marker in `migrateExisting`
  - Modifications to files outside the listed scope

Open question risks:
  - This task only stamps on from-scratch creation, so no existing fixture should break here — the fixture that breaks is `test/cli.test.js:982-999`, and it breaks in T2, where it is handled

Rollback note:
  - The marker is additive and ignored by older readers; reverting this commit leaves no residue in existing logs

Red flags:
  - Work outside listed files → DONE_WITH_CONCERNS
  - `CONTRACT` modified → STOP

## STOP CONDITIONS

Done when: all DELIVERABLE scenarios pass, `npm test` green, commit created
Uncertain when: an existing fixture requires a marker-less header for a reason not covered by the spec
Escalate when: satisfying the test appears to require a non-additive header change

---

### Task 2: CLI — pipeline-marker refusal gate at the readLog choke point [depends: T1]

## OBJECTIVE

Refuse, fail-closed and without writing a byte, any `log.json` whose pipeline marker is absent or lower than the current one. Read-only consumers stay ungated.

Files:
- Modify: `cli/lib/logjson.js`
- Modify: `cli/commands/log.js`
- Test: `test/cli.test.js`

Steps:

1. Write failing test for: rule "Migration" — GWT scenarios "An older plan is refused without a single byte written" and "init does not launder an older plan past the gate"
   File: `test/cli.test.js`
   Test verifies:
   - Given a `log.json` whose `header.pipeline` is absent, When `log update <dir> <phase_file> DONE --task T1` runs, Then the process exits non-zero, the message names the detected version and the recovery step `npx -y pocketto-pi@2.4.4`, and the file's bytes are identical before and after.
   - Given the same log, When `log init` runs against it, Then it refuses identically and stamps nothing.
   - Given a `log.json` carrying the current marker, When `log update` runs, Then it succeeds as before.
   - Given `format tasklist`, When it reads a marker-less log, Then it is NOT refused.

   Add these two fixture helpers next to the existing `git`/`hasGit` helpers in
   `test/cli.test.js` (function declarations, so hoisting keeps them usable above
   their definition), then append the tests below to the `log` block. Tabs, as
   elsewhere in the file.

   ```js
   // Strip the pipeline marker from a freshly-initialised log.json, rewriting it
   // in the exact shape writeLog produces (2-space indent + trailing newline).
   function stripPipelineMarker(dir) {
   	const logPath = path.join(dir, "log.json");
   	const log = JSON.parse(readFileSync(logPath, "utf8"));
   	delete log.header.pipeline;
   	writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
   	return logPath;
   }

   function initMarkerlessPlan(dir) {
   	writePlan(dir, NINE_TASK_PLAN);
   	run(["structure", path.join(dir, "execution-plan.md")]);
   	run(["log", "init", dir]);
   	return stripPipelineMarker(dir);
   }
   ```

   ```js
   test("log update refuses a marker-less log.json without writing a byte", () => {
   	const dir = tmp();
   	const logPath = initMarkerlessPlan(dir);
   	const before = readFileSync(logPath);

   	const res = run(
   		[
   			"log",
   			"update",
   			dir,
   			"execution-plan-phase-1.md",
   			"DONE",
   			"--task",
   			"T1",
   			"--json",
   		],
   		{ expectFail: true },
   	);
   	assert.notEqual(res.code, 0);

   	const env = JSON.parse(res.stdout.trim());
   	assert.equal(env.ok, false);
   	assert.equal(env.error.code, "PIPELINE_TOO_OLD");
   	assert.match(env.error.message, /absent/i); // names the detected version
   	assert.match(env.error.message, /pocketto-pi@2\.4\.4/); // names the recovery step

   	// Zero bytes written on the refusal path.
   	assert.deepEqual(readFileSync(logPath), before);
   });

   test("log init refuses an existing marker-less log.json and stamps nothing", () => {
   	const dir = tmp();
   	const logPath = initMarkerlessPlan(dir);
   	const before = readFileSync(logPath);

   	const res = run(["log", "init", dir, "--json"], { expectFail: true });
   	assert.notEqual(res.code, 0);
   	const env = JSON.parse(res.stdout.trim());
   	assert.equal(env.ok, false);
   	assert.equal(env.error.code, "PIPELINE_TOO_OLD");

   	assert.deepEqual(readFileSync(logPath), before);
   	const log = JSON.parse(readFileSync(logPath, "utf8"));
   	assert.equal("pipeline" in log.header, false); // init laundered nothing
   });

   test("log close is refused on a marker-less log even when every phase is DONE", () => {
   	const dir = tmp();
   	writePlan(dir, NINE_TASK_PLAN);
   	run(["structure", path.join(dir, "execution-plan.md")]);
   	run(["log", "init", dir]);
   	for (const f of [
   		"execution-plan-phase-1.md",
   		"execution-plan-phase-2.md",
   		"execution-plan-phase-3.md",
   	]) {
   		run(["log", "update", dir, f, "DONE"]);
   	}
   	const logPath = stripPipelineMarker(dir);
   	const before = readFileSync(logPath);

   	const res = run(["log", "close", dir, "--json"], { expectFail: true });
   	assert.equal(JSON.parse(res.stdout.trim()).error.code, "PIPELINE_TOO_OLD");
   	assert.deepEqual(readFileSync(logPath), before);
   });

   test("a log carrying the current pipeline marker is not refused", () => {
   	const dir = tmp();
   	writePlan(dir, NINE_TASK_PLAN);
   	run(["structure", path.join(dir, "execution-plan.md")]);
   	run(["log", "init", dir]);

   	const env = json([
   		"log",
   		"update",
   		dir,
   		"execution-plan-phase-1.md",
   		"DONE",
   		"--task",
   		"T1",
   		"--json",
   	]);
   	assert.equal(env.ok, true);
   	assert.equal(env.data.newStatus, "DONE");

   	// The marker survives the writeLog round-trip — otherwise the gate would
   	// refuse the very next state-changing command on a log it just wrote.
   	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
   	assert.equal(log.header.pipeline, version.PIPELINE);
   });

   test("format tasklist is never refused by the pipeline gate (read-only path)", () => {
   	const dir = tmp();
   	initMarkerlessPlan(dir);

   	// Rendering is covered by the existing tasklist tests; this asserts only that
   	// the read-only consumer survives the gate.
   	assert.equal(json(["format", "tasklist", dir, "--json"]).ok, true);
   });
   ```

   Append this last one to the corrections block at the end of the file, where
   `setupPhasedDone()` is defined — it covers the fourth gated call site:

   ```js
   test("log update --correction is refused on a marker-less log", {
   	skip: !hasGit(),
   }, () => {
   	const dir = tmp();
   	const phase = setupPhasedDone(dir);
   	writeFileSync(path.join(dir, "fix.txt"), "fix");
   	git(dir, ["add", "-A"]);
   	git(dir, ["commit", "-q", "-m", "fix T1"]);
   	const sha = git(dir, ["rev-parse", "HEAD"]).trim();

   	const logPath = stripPipelineMarker(dir);
   	const before = readFileSync(logPath);

   	const res = run(
   		["log", "update", dir, phase, "--correction", sha, "--for-task", "T1", "--json"],
   		{ expectFail: true },
   	);
   	assert.equal(JSON.parse(res.stdout.trim()).error.code, "PIPELINE_TOO_OLD");
   	assert.deepEqual(readFileSync(logPath), before);
   });
   ```

   Every test name above contains `refus`, so Step 2's and Step 4's
   `--test-name-pattern="refus"` selects all of them. If you rename one, the RED
   step silently runs zero tests and exits 0.

   **Existing fixture this gate will break — read before implementing.** The
   marker-less fixture that actually collides with this task is NOT the one named
   in "Open question risks". It is the hand-crafted `legacy` log at
   `test/cli.test.js:982-999`, inside `"log init migrates tasks into an existing
   task-less log.json, preserving status"`: it has no `header.pipeline`, and
   `:1001` calls `run(["log", "init", dir])` **without** `expectFail`, routing
   straight into `migrateExisting` — the exact site Step 3 gates. That test goes
   red. The fixtures cited at `:2079`/`:2131` are `format tasklist` inputs on the
   read-only path and must stay marker-less — they are covered by the "format
   tasklist is never refused" test above and must NOT be modified.
   Before updating `:982-999`, decide whether gating `migrateExisting` makes the
   task-less-log migration path unreachable for precisely the old logs it was
   written to rescue. If it does, that is a NEEDS_CONTEXT, not a fixture edit.

2. Run test — verify FAIL:
   `node --test --test-name-pattern="refus" test/cli.test.js`
   Expected failure: the command exits 0 and mutates the file instead of refusing.

3. Implement minimal code to satisfy the test:
   File: `cli/lib/logjson.js`
   Implement: an exported `assertPipeline(log, logPath)` that throws `CliError('PIPELINE_TOO_OLD', …)` when `header.pipeline` is missing or `< PIPELINE`. The message must name the detected value (or "absent") and the recovery step: pin the CLI with `npx -y pocketto-pi@2.4.4` and close the plan under the old pipeline before updating. Do not gate inside `readLog` itself — `readLog` is also used by the read-only `format` command (`cli/commands/format.js:94`), which must keep working.
   File: `cli/commands/log.js`
   Implement: call `assertPipeline` immediately after every `readLog` on a state-changing path — `migrateExisting` (`:172`), the update path (`:240`), `recordCorrection` (`:391`), and close (`:532`) — before any mutation or `writeLog`.

4. Run test — verify PASS:
   `node --test --test-name-pattern="refus" test/cli.test.js`
   Expected: PASS

5. Refactor while green (bounded):
   - Four call sites repeating `const log = readLog(p); assertPipeline(log, p);` is the rule of three — extract a named `readLogChecked(logPath)` in `cli/lib/logjson.js` and use it at all four sites. Never a generic `utils`.
   - Re-run: `node --test test/cli.test.js` — must stay PASS.

6. Commit:
   `git add cli/lib/logjson.js cli/commands/log.js test/cli.test.js`
   `git commit -m "feat(cli): refuse log.json from an older pipeline, fail-closed"`
   If Step 5 extracted `readLogChecked`, commit it separately as `refactor(cli): extract readLogChecked for the pipeline gate`.

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Migration, both GWT scenarios used as verification
cli/lib/logjson.js — `readLog` is the single read choke point; `writeLog` is parity-locked
cli/commands/log.js — state-changing `readLog` sites at `:172`, `:240`, `:391`, `:532`; `writeLog` at `:120`, `:198`, `:334`, `:357`, `:498`, `:546`
cli/commands/format.js — `:94` reads the log read-only and must remain ungated
cli/lib/envelope.js — `CliError(code, message)` carries a machine code, exit code, and optional multi-line human rendering

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: 2 source files plus tests, but the correctness hinges on choosing exactly which call sites are gated — read-only paths must survive. That is interpretation, not mechanics.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: A refusal must write ZERO bytes. Assert before any mutation and before any `writeLog`.]
You are implementing the pipeline-marker refusal gate for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — refusal lives in the CLI, the only choke point every caller passes through, because all 48 skill call sites invoke `npx -y pocketto-pi` unpinned.
Files in scope: `cli/lib/logjson.js`, `cli/commands/log.js`, `test/cli.test.js` — no other files.
Test framework: node:test; assert byte-identity of the file before and after a refused command.
Available after: T1 (the `PIPELINE` constant and the stamping path)
Architecture rule: commands never print and never call `process.exit` — throw `CliError` and let `cli/index.js` own I/O.
[RESTATE: Zero bytes written on refusal. The read-only `format` path must stay ungated.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given a `log.json` with an absent or lower pipeline marker, When a state-changing log command runs, Then it exits non-zero with a message naming the detected version and the CLI-pinning recovery step.
Given that refusal, When the file is compared byte-for-byte with its pre-command contents, Then they are identical.
Given a `log.json` that already exists without a marker, When `log init` runs against it, Then it refuses and does not stamp a marker.
Given a `log.json` carrying the current marker, When any log command runs, Then behavior is unchanged from before this task.
[must-not] Given `format tasklist`, When it reads a log, Then it must NOT be refused by this gate.
[must-not] Given a refused command, When the envelope is inspected, Then `ok` must NOT be `true`.

All tests PASS (`node --test test/cli.test.js`). Commit exists matching `feat(cli): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - Gate applied at all four state-changing `readLog` sites, before any mutation
  - `format` left ungated
  - Error carries a machine code and an actionable recovery step naming a pinned CLI invocation
  - Existing marker-less fixtures updated to carry the marker
  - Tests written BEFORE implementation (TDD — not after)

Must-not-have:
  - Gating inside `readLog` itself (breaks the read-only consumer)
  - Any partial write on the refusal path
  - `process.exit` or printing from a command module
  - Modifications to files outside the listed scope

Open question risks:
  - The legacy fixture at `test/cli.test.js:982-999` goes red under this gate. Resolution is decided, not open: **split** it — one test asserting the marker-less legacy log is refused, one re-testing migration against a marker-carrying task-less log. Do NOT patch a marker onto the legacy fixture; that would assert the laundering Rule C1.2 forbids. `migrateExisting` remains reachable for its forward case (a marked log whose plan gained tasks after `init`). If splitting appears to delete coverage rather than modernize it, report NEEDS_CONTEXT

Rollback note:
  - Reverting restores the previous permissive behavior; no data written by this task needs undoing

Red flags:
  - "I made the gate a warning instead of a refusal" → REVERT
  - Work outside listed files → DONE_WITH_CONCERNS

## STOP CONDITIONS

Done when: all DELIVERABLE scenarios pass, `npm test` green, commit created
Uncertain when: a fixture's purpose is genuinely a marker-less log
Escalate when: gating a site would break a read-only consumer that the spec did not anticipate

---

### Task 3: Rewrite two-stage-review.md as the audit-loop contract [prereq]

## OBJECTIVE

Replace `skills/pocket-development/references/two-stage-review.md` with the single normative contract for the in-loop audit that T4, T5, T7, T8 and T9 all cite. This file is the shared interface — without it, each downstream task would invent its own severity ladder.

Files:
- Modify (full rewrite): `skills/pocket-development/references/two-stage-review.md`

This is a **non-testable structural task** — no behavioral GWT, no test framework applies.

Steps:

1. Write the contract covering, each as its own section:
   - **Auditor identity:** always a separate read-only subagent; never the main agent, never the implementer.
   - **Mechanical gate (runs first, by the main agent):** commit exists; the plan's test command green; for a `[no-tdd]` structural task the packet's validation command; if the plan specifies no command at all, proceed straight to the auditor. Mechanical failures re-dispatch the implementer and consume no round.
   - **Audit input:** diff `prev_sha..HEAD` for a sequential task; the worktree tip for a parallel-group task.
   - **Criteria:** QUALITY BAR (must-have / must-not-have / red flags), spec compliance, code quality — reusing `skills/pocket-review/references/spec-compliance-review.md` and `code-quality-review.md` verbatim, cited by absolute path in the dispatch.
   - **Refactor heuristics judged from the diff:** identical logic 3+ times across in-scope files; a modified file crossing ~300 lines; a function exceeding ~50 lines. No implementer self-report is required or accepted.
   - **Severity ladder:** `Critical | Important | Minor`, emitted by the auditor itself. Critical/Important force a round; Minor is persisted as a non-blocking observation carried forward to closing. The main agent reads the label and never re-interprets it.
   - **Round budget:** 2 per task. Consumed by an audit FAIL at Critical/Important, a refactor round, and a new finding introduced by a fix. NOT consumed by auditor infrastructure failure, which gets exactly one separate retry.
   - **BLOCKED categories:** `audit-failed` after the budget is spent with findings remaining; `auditor-unavailable` after two consecutive infrastructure failures. Both persisted in the verdict artifact, not only reported in chat.
   - **Minor carry-forward on re-audit:** the previous verdict is supplied to the re-auditor, which re-emits every still-unfixed Minor. The main agent does not merge findings itself.
   - **SHA pinning:** sequential tasks are marked DONE with `--sha <audited_head>` so `reviewed_sha == done_sha`; parallel-group tasks keep `done_sha` as their own merge commit, with `reviewed_sha` advanced there on a clean merge and a re-audit required when conflicts were resolved manually; empty-diff tasks are marked DONE with `--allow-duplicate-sha` plus a REVIEW_PASS stub and no auditor dispatch.
   - **Artifact contract:** written to exactly `<plan_dir>/reviews/<task_id>-review.json`, conforming to `skills/pocket-review/references/review-report-template.md`, carrying `task_id`, `overall`, `reviewed_sha`, `fix_instructions`, `loop_info` (the durable round counter: `current_cycle`, `max_cycles: 2`, `cycles_remaining`), `stage_2.issues[].severity` and `stage_2.strengths[]`.
   - **Resume:** a task already DONE whose artifact's `reviewed_sha` equals its `done_sha` is skipped; `log update … DONE` is never re-issued for it; the round count is read from `loop_info`, not reset.

2. Verify:
   `grep -c "^## " skills/pocket-development/references/two-stage-review.md` returns at least 11, and
   `grep -F "Nothing to refactor" skills/pocket-development/references/two-stage-review.md` returns nothing (exit 1).

3. Commit:
   `git add skills/pocket-development/references/two-stage-review.md`
   `git commit -m "docs(pocket-development): rewrite two-stage-review as the audit-loop contract"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rules: In-loop deep audit, Mechanical gate, Round budget, SHA pinning, Verified refactor, Closing compatibility
skills/pocket-development/references/two-stage-review.md — the current file already describes a two-stage read-only loop with the same Critical/Important/Minor ladder, but contradicts `SKILL.md:568` ("a quick audit inline — no subagent")
skills/pocket-review/references/review-report-template.md — `loop_info` at `:141-147` is the durable round counter this contract reuses
skills/pocket-review/SKILL.md — `:153-175` is the REVIEW_PASS skip stub shape reused verbatim for empty-diff tasks

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: one file, but it is the normative contract four downstream tasks cite. Getting the severity ladder or the round accounting wrong here propagates everywhere.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: This file is the single source of truth for the audit loop. Downstream tasks cite it — they must not restate its rules in their own words.]
You are rewriting the audit-loop contract for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — all audit state lives in the verdict artifact; `CONTRACT` stays 2.
Files in scope: `skills/pocket-development/references/two-stage-review.md` — no other files.
Test framework: none — this is a prompt document, verified by the grep checks in Step 2.
Available after: none (prereq)
Architecture rule: the main agent never judges code; every criterion here is executed by a read-only subagent.
[RESTATE: Single source of truth. Downstream tasks cite this file rather than paraphrasing it.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the rewritten file, When it is read, Then all eleven contract sections listed in Step 1 are present.
Given the file, When searched for `Nothing to refactor`, Then the escape-hatch phrasing is absent.
Given the file, When the artifact contract section is read, Then it names the literal path `<plan_dir>/reviews/<task_id>-review.json` and every required field.
Given the file, When the round-budget section is read, Then it states that auditor infrastructure failure does not consume a round and yields `auditor-unavailable`.
[must-not] Given the file, When read, Then it must NOT describe the main agent judging code itself.

Commit exists matching `docs(pocket-development): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - All eleven sections from Step 1, each normative rather than descriptive
  - Absolute-path citations for the reused pocket-review criteria references
  - Commit message follows conventional commits format

Must-not-have:
  - Changing `pocket-development/SKILL.md` (that is T4)
  - Changing `pocket-planning/SKILL.md` (that is T5)
  - Describing the phase-level pass or enterprise reporting (those are T7 and T8)
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - The previous file content is recoverable from git history; no other file depends on it until T4 lands

Red flags:
  - Restating rules that belong to T7/T8 → scope creep, DONE_WITH_CONCERNS
  - Leaving the old two-stage text intact alongside the new contract → contradictory instructions, STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a rule in the spec cannot be stated without also specifying phase-level behavior
Escalate when: the contract would require the main agent to read implementation files

---

### Task 4: pocket-development SKILL.md — the per-task in-loop build cycle [depends: T3]

## OBJECTIVE

Rewrite the per-task execution path in `skills/pocket-development/SKILL.md` so the loop is implement → mechanical gate → deep audit → fix/refactor round → re-audit → DONE, citing T3's contract rather than restating it. Remove the contradiction at `SKILL.md:568`.

Files:
- Modify: `skills/pocket-development/SKILL.md`

This is a **non-testable structural task**.

Steps:

1. Replace the `## Review` section's "Per-Task Quick Audit" (`SKILL.md:566-583`) with the in-loop cycle: mechanical gate by the main agent, then dispatch of a read-only auditor subagent, then the fix/refactor round, then re-audit, then `log update --task TN DONE --sha <audited_head>`. Cite `references/two-stage-review.md` for every rule; do not restate the severity ladder or the round budget inline.
2. Update the process digraph (`SKILL.md:316-352`) so `DONE` flows through the mechanical gate and the auditor, with edges for `audit-failed` and `auditor-unavailable`.
3. Update `## Status Handling` (`SKILL.md:642-654`) so the DONE row describes the deep audit and the BLOCKED row carries the two categories. Leave the `REVIEW_FAIL` row at `:650` alone — **T9 owns it**, because its replacement text comes from the phase-level pass contract that does not exist yet at this point.
4. Update the `Main Agent Role (HARDENED)` table so "Run quick audit after each implementer DONE" becomes "Run the mechanical gate, then dispatch the read-only auditor", and the MUST NOT column gains "judge code quality or spec compliance itself". **This table and its surrounding prose carry bare-name claims that pocket-review is a live user-triggered stage — at least `:76`, `:78`, `:80`, plus `:296` (the Task Type Selection table routing review work to the `pocket-review` skill) and `:771` (a Red Flag forbidding its invocation). Rewrite all of them to describe the in-loop auditor.** These line numbers are illustrative, not exhaustive: run `grep -n "pocket-review\|pocket-correction" skills/pocket-development/SKILL.md` and resolve every hit this task owns.
5. Update `## Red Flags` to drop "Mark task DONE in the log without running the quick audit first" in favour of the auditor wording, and add "Mark a task DONE without passing `--sha <audited_head>`".
6. Add `references/two-stage-review.md` to the Mandatory Reference Preloading table and the Reference Triggers table.
7. Verify:
   `grep -F "quick audit inline — no subagent" skills/pocket-development/SKILL.md` returns nothing (exit 1), and
   `grep -c "two-stage-review.md" skills/pocket-development/SKILL.md` returns at least 3.
8. Commit:
   `git add skills/pocket-development/SKILL.md`
   `git commit -m "feat(pocket-development): audit every task before pinning its SHA"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rules: In-loop deep audit, Mechanical gate, Round budget, SHA pinning
skills/pocket-development/references/two-stage-review.md (as rewritten by T3) — the normative contract this task wires in
skills/pocket-development/SKILL.md — `:566-583` quick audit, `:316-352` process digraph, `:642-654` status handling, `:69-80` main agent role, `:706-713` log-command timing table

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: one file, but five interlocking sections that currently describe the old shallow gate. Leaving any of them stale produces an agent that follows whichever half it read last.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: The main agent must never judge code. Every criterion is executed by a read-only subagent it dispatches.]
You are wiring the in-loop build cycle into pocket-development's SKILL.md.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — audit state lives in the verdict artifact; `CONTRACT` stays 2.
Files in scope: `skills/pocket-development/SKILL.md` — no other files.
Test framework: none — verified by the grep checks in Step 7 and by T6's comprehension review.
Available after: T3 (the audit-loop contract this file cites)
Architecture rule: cite `references/two-stage-review.md`; do not paraphrase its rules into SKILL.md.
[RESTATE: Main agent = Delegator + Auditor. It runs the mechanical gate and reads verdict labels — it does not assess code.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the rewritten SKILL.md, When the per-task path is read, Then it describes mechanical gate → auditor subagent → fix/refactor round → re-audit → DONE with `--sha <audited_head>`.
Given the file, When searched for "quick audit inline — no subagent", Then the phrase is absent.
Given the file, When the BLOCKED handling is read, Then both `audit-failed` and `auditor-unavailable` appear.
Given the file, When the severity ladder is sought, Then it is cited from `references/two-stage-review.md` rather than restated.
[must-not] Given the file, When read, Then it must NOT instruct the main agent to invoke `pocket-review`.
[must-not] Given the file, When read, Then it must NOT describe the phase-level pass or enterprise reporting changes (T7–T9 own those).

Commit exists matching `feat(pocket-development): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - All five sections from Steps 1–5 updated consistently with each other
  - `references/two-stage-review.md` present in both reference tables
  - Commit message follows conventional commits format

Must-not-have:
  - Restating the severity ladder, round budget or artifact schema inline
  - Touching the parallel-group worktree setup, merge or cleanup mechanics — including the comparative "same pattern pocket-review uses" prose at `:401`, `:451`, `:457`, `:460`, `:480`, which is analogy, not a liveness claim, and stays byte-identical
  - Editing `skills/pocket-review/SKILL.md` or `skills/pocket-correction/SKILL.md` themselves (T11 owns those two files) — this does **not** exempt you from rewriting mentions of them inside `pocket-development/SKILL.md`, which is this task's job
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Revert restores the shallow gate; T3's contract file becomes orphaned but harmless

Red flags:
  - Two sections describing different gates → contradictory instructions, STOP
  - Work outside listed files → DONE_WITH_CONCERNS

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a section cannot be updated without also specifying phase-level behavior
Escalate when: the wiring would require the main agent to read implementation files

---

### Task 5: pocket-planning — refactor becomes auditor-judged, not self-reported [depends: T3] [parallel: T4]

## OBJECTIVE

Remove the refactor escape hatch from the planning packet template and restate refactor as a step whose completion the auditor judges from the diff.

Files:
- Modify: `skills/pocket-planning/SKILL.md`

This is a **non-testable structural task**.

Steps:

1. In the packet template's Step 5 (`skills/pocket-planning/SKILL.md:314-320`), delete the line `- Nothing to refactor → say so and move to commit` and replace it with a statement that the auditor judges the refactor heuristics from the diff, that no self-report is required or accepted, and that a diff violating none of the thresholds simply proceeds to commit. Keep the three heuristics themselves (rule of three, ~300-line file, ~50-line function) exactly as worded — they are the same thresholds T3's contract cites.
2. In the QUALITY BAR block of the template (`:370-380`), leave "Rule of three enforced" in place but note that enforcement is verified by the auditor, not asserted by the implementer.
3. Verify:
   `grep -F "Nothing to refactor" skills/pocket-planning/SKILL.md` returns nothing (exit 1), and
   `grep -c "Rule of three" skills/pocket-planning/SKILL.md` still returns at least 2.
4. Commit:
   `git add skills/pocket-planning/SKILL.md`
   `git commit -m "feat(pocket-planning): refactor step is auditor-judged, not self-reported"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Verified refactor, GWT "A clean diff triggers no refactor round"
skills/pocket-planning/SKILL.md — `:314-320` refactor step with the escape hatch at `:320`; `:370-380` QUALITY BAR block
skills/pocket-development/references/two-stage-review.md (as rewritten by T3) — the auditor's refactor heuristics, which must stay word-identical to the template's

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: a single file and a narrow edit — one line removed, two restated. The blast radius is deliberately kept to the packet template.
Complexity: lightweight

## SANDWICH CONTEXT

[CRITICAL: Do NOT restructure the refactor heuristics themselves. They must stay word-identical to the auditor's contract, or the two will drift.]
You are removing the refactor escape hatch from the planning packet template.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — the auditor judges refactor from the diff.
Files in scope: `skills/pocket-planning/SKILL.md` — no other files.
Test framework: none — verified by the grep checks in Step 3.
Available after: T3 (whose contract fixes the heuristic wording)
Architecture rule: the planning template and the audit contract must state the same thresholds in the same words.
[RESTATE: Heuristic wording is shared with T3's contract — change the escape hatch, not the thresholds.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the edited template, When searched for "Nothing to refactor", Then the phrase is absent.
Given the template's Step 5, When read, Then it states that the auditor judges refactor from the diff and that no implementer self-report is accepted.
Given the template, When the three heuristics are read, Then they are word-identical to those in `references/two-stage-review.md`.
[must-not] Given the file, When read, Then the three refactor thresholds must NOT have been reworded or renumbered.
[must-not] Given the file, When read, Then no section outside the packet template and its QUALITY BAR block may be modified.

Commit exists matching `feat(pocket-planning): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Escape hatch removed; auditor-judged wording in its place
  - Heuristic thresholds unchanged and word-identical to T3's contract
  - Commit message follows conventional commits format

Must-not-have:
  - Restructuring the non-testable `[no-tdd]` path (T3's mechanical gate depends on it as written)
  - Touching pocket-planning's phases, gates, or reviewer/test-architect dispatch
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Revert restores the escape hatch; no other file depends on this edit

Red flags:
  - Heuristics reworded → drift against the audit contract, STOP
  - Work outside listed files → DONE_WITH_CONCERNS

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: T3's wording of the heuristics differs from the template's existing wording
Escalate when: removing the hatch would leave Step 5 without a completion condition

---

### Task 6: Comprehension review — Phase A [depends: T2, T4, T5]

## OBJECTIVE

Verify that the Phase A instruction set is understandable and internally consistent to a reader with no session context, which is the acceptance signal the spec names for prompt-layer work.

Files:
- Create: `docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-a.md`

This is a **non-testable verification task** — it changes no product file.

Steps:

1. Dispatch one general-purpose subagent, read-only, with this prompt and no additional context:
   > Read `skills/pocket-development/SKILL.md`, `skills/pocket-development/references/two-stage-review.md`, and `skills/pocket-planning/SKILL.md`. What do you understand from these skills — describe the per-task execution loop, what happens when an audit fails, and how the refactor step is verified. Are there any inconsistencies that would confuse you about what to do?
2. Record the subagent's answer verbatim into `docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-a.md`, followed by a short verdict section.
3. Classify each reported inconsistency as blocking (an instruction contradicts another, or the loop cannot be followed) or non-blocking (wording preference).
4. If any blocking inconsistency exists → report BLOCKED with the specific contradiction and the file:line pair involved. Do not fix it in this task; the owning task must.
5. Verify:
   `test -f docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-a.md`
6. Commit:
   `git add docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-a.md`
   `git commit -m "chore(pocket): record Phase A comprehension review"`

Mark in QUALITY BAR: `[no-tdd — verification task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Comprehension, GWT "The changed skill passes comprehension review"
skills/pocket-development/SKILL.md, references/two-stage-review.md, skills/pocket-planning/SKILL.md — the artifacts under review

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: read-only verification with a single dispatched reader; the judgement is the subagent's, recorded verbatim.
Complexity: standard review

## SANDWICH CONTEXT

[CRITICAL: The reviewing subagent must receive NO context from this session. A reader who already knows the design cannot detect an unclear instruction.]
You are running the Phase A comprehension review for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the new review record only — no product file may be edited.
Test framework: none — the deliverable is a recorded review.
Available after: T2, T4, T5
Architecture rule: this task reports; it never fixes.
[RESTATE: Zero session context to the reviewer. Report blocking contradictions; do not repair them here.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the dispatched subagent, When it reports, Then it describes the per-task loop, the audit-failure path and the refactor verification correctly.
Given its report, When inconsistencies are classified, Then none are blocking.
Given the review record, When it is read, Then it contains the answer verbatim plus a verdict.
[must-not] Given a blocking inconsistency, When it is found, Then this task must NOT fix it — it reports BLOCKED naming the owning task.

Commit exists matching `chore(pocket): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — verification task]`
  - Reviewer dispatched with no session context
  - Answer recorded verbatim, not summarized
  - Commit message follows conventional commits format

Must-not-have:
  - Editing any skill file
  - Coaching the reviewer toward the expected answer
  - Modifications to files outside the listed scope

Open question risks:
  - The reviewer may flag pre-existing wording unrelated to this change → classify as non-blocking and note it

Rollback note:
  - The record is documentation only; reverting loses evidence, not behavior

Red flags:
  - Reviewer given the spec or this plan → the test is void, STOP and re-dispatch

## STOP CONDITIONS

Done when: review recorded, no blocking inconsistency, commit created
Uncertain when: an inconsistency's severity is genuinely ambiguous
Escalate when: the reviewer cannot describe the loop at all — that is a Phase A failure, not a review failure

---

### Task 7: references/phase-level-pass.md — the phase pass and its corrections [depends: T6]

## OBJECTIVE

Create the normative contract for the phase-level pass: what it looks for, how its fixes are recorded as append-only corrections, how verdicts are refreshed afterwards, and its own round cap.

Files:
- Create: `skills/pocket-development/references/phase-level-pass.md`

This is a **non-testable structural task**.

Steps:

1. Write the contract covering:
   - **Trigger and scope:** runs after every task in the phase is DONE; looks only for what a per-task audit cannot see — cross-task duplication, integration mismatch, cross-file regression, spec-level gaps. It is dispatched as a subagent; the main agent does not perform it.
   - **Empty result:** a "no cross-task findings" record is written to disk so a completed pass is distinguishable from a skipped one. It must live outside `<plan_dir>/reviews/` (or carry a name `pocket-closing` will never read as `<task_id>-review.json`) so closing cannot mistake it for a task verdict.
   - **Ordering:** phase status is set to `REVIEW` only *after* the pass records its result, so a pass that died mid-flight is detectable on resume.
   - **Fix rounds:** the same budget as a task — 2 rounds. Findings remaining after the second round → `PHASE_BLOCKED` with findings attached and no advance to `REVIEW`.
   - **Correction recording:** each fix is one commit containing only the source files being fixed — never `log.json` — recorded via `npx -y pocketto-pi log update <plan_dir> <phase_file> --correction <sha> --for-task <task_id> --json --contract 2`. `done_sha` never moves. A commit that includes `log.json` is rejected and re-dispatched with explicit staging instructions.
   - **In-loop fixes are not corrections:** `--correction` is phase-level-pass-only. A fix made before a task has a `done_sha` is a plain commit.
   - **Verdict refresh (fan-out):** exactly one auditor reads the correction commit in full. Its verdict is written into the artifact of every task in `data.correction.affectedTasks` (`for_task` plus bleed owners). Each artifact's `reviewed_sha` is set to that task's newest owned commit by commit time — `max-by-commit-time` over `{done_sha} ∪ {corrections attributed to it}` — which is exactly what `pocket-closing` computes as `latest_owned_sha`. Tasks outside `affectedTasks` are left untouched. A correction the CLI reports as `skipped: true` (empty diff) is never used as a `reviewed_sha`.
2. Verify:
   `grep -F "max-by-commit-time" skills/pocket-development/references/phase-level-pass.md` returns at least one match, and
   `grep -F "affectedTasks" skills/pocket-development/references/phase-level-pass.md` returns at least one match.
3. Commit:
   `git add skills/pocket-development/references/phase-level-pass.md`
   `git commit -m "docs(pocket-development): add phase-level pass contract"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rules: Phase-level pass, Corrections
skills/pocket-closing/SKILL.md — `:96-111` the exact-SHA freshness gate this contract must satisfy; `:86` the hard-coded artifact path
skills/pocket-correction/SKILL.md — the sequential correction loop, commit-hygiene requirement, and `data.correction` envelope shape being absorbed
cli/commands/log.js — `:391-515` `recordCorrection`, including the `skipped` empty-diff path at `:420-434` and bleed attribution

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: one new file, but it encodes the attribution arithmetic that `pocket-closing` gates on. An off-by-one in the `reviewed_sha` rule permanently blocks closing.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: `done_sha` NEVER moves. Corrections are strictly append-only.]
You are writing the phase-level pass contract for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — one auditor reads the correction; its verdict fans out to every attributed task.
Files in scope: `skills/pocket-development/references/phase-level-pass.md` — no other files.
Test framework: none — verified by the grep checks in Step 2 and by T10's comprehension review.
Available after: T6 (Phase B must not be built on a Phase A contradiction the comprehension review has not yet cleared)
Architecture rule: `reviewed_sha` must equal what `pocket-closing` computes as `latest_owned_sha`, or the phase can never close.
[RESTATE: `done_sha` never moves. `--correction` is phase-level only — in-loop fixes are plain commits.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the contract, When the fan-out rule is read, Then `reviewed_sha` is defined as max-by-commit-time over the task's owned set, not as a single literal correction sha.
Given the contract, When the empty-result rule is read, Then the "no findings" record is placed where `pocket-closing` cannot read it as a task verdict.
Given the contract, When the ordering rule is read, Then phase `REVIEW` is set only after the pass records its result.
Given the contract, When the round cap is read, Then two rounds then `PHASE_BLOCKED` without advancing to `REVIEW`.
[must-not] Given the contract, When read, Then it must NOT permit `--correction` for an in-loop fix.
[must-not] Given the contract, When read, Then it must NOT allow a correction commit containing `log.json` to be recorded.

Commit exists matching `docs(pocket-development): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - All seven rules from Step 1, each normative
  - The fan-out rule stated so it provably equals `pocket-closing`'s `latest_owned_sha`
  - Commit message follows conventional commits format

Must-not-have:
  - Changing `pocket-closing`'s algorithm or its reference docs
  - Changing the CLI's correction behavior
  - Describing enterprise reporting (T8 owns it)
  - Modifications to files outside the listed scope

Open question risks:
  - The "no findings" record location is an assumption → if any placement risks `pocket-closing` reading it as a verdict, report NEEDS_CONTEXT
  - The pass being a subagent is an assumption → if the Iron Laws make it ambiguous, report NEEDS_CONTEXT

Rollback note:
  - The file is new; deleting it removes the contract with no residue

Red flags:
  - `reviewed_sha` defined as "the correction sha" → permanently blocks closing when a phase produces two corrections, STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: the "no findings" record has no safe home outside `reviews/`
Escalate when: the fan-out rule cannot be reconciled with `pocket-closing`'s computation

---

### Task 8: references/enterprise-reporting.md — E1–E6 relocated [depends: T6] [parallel: T7]

## OBJECTIVE

Move pocket-review's enterprise reporting steps into a pocket-development reference, adding the create-pr offer ordering, with the fail-closed contract preserved exactly.

Files:
- Create: `skills/pocket-development/references/enterprise-reporting.md`

This is a **non-testable structural task**.

Steps:

1. Port E1–E6 from `skills/pocket-review/SKILL.md:247-488` substantively unchanged: mode preflight, PR discovery via `meta get phases.<phase_key>.github_pr.number` with branch fallback, owner/repo resolution, `format comment` body, marker-tagged summary upsert with the >1 race collapse rule, fingerprint reconcile via `reconcile` with resolve/post/keep handling, and fingerprint persistence with its pre-2.5 migration fallback.
2. Add the ordering rule this relocation creates: at phase-completion, if enterprise mode is active and no PR exists for the branch, `create-pr` is **offered** and one confirmation is awaited before posting. On confirmation, the PR is created and verdicts are posted. On decline, verdicts stay on disk, `create-pr` is not modified to post them, and re-running phase-completion later posts them — the marker upsert makes that idempotent.
3. State the fail-closed contract at the top: `ok` false, a missing command, or `data.enterprise` not strictly `true` means skip the entire file's behavior — zero `gh` calls, output byte-identical to the non-enterprise path.
4. Verify:
   `grep -c "^### E" skills/pocket-development/references/enterprise-reporting.md` returns at least 6, and
   `grep -F "fail-closed" skills/pocket-development/references/enterprise-reporting.md` returns at least one match.
5. Commit:
   `git add skills/pocket-development/references/enterprise-reporting.md`
   `git commit -m "docs(pocket-development): relocate enterprise reporting from pocket-review"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Enterprise reporting, both GWT scenarios
skills/pocket-review/SKILL.md — `:247-488` the E1–E6 steps being relocated verbatim in substance
skills/pocket-development/SKILL.md — `:600-613` the existing create-pr offer at phase-completion, and `:615-640` the task-checklist sync
skills/create-pr/SKILL.md — confirms create-pr is a recorder with no verdict logic, so nothing may be delegated to it

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: one new file, but it is a faithful relocation of ~240 lines of GitHub interaction where a dropped guard becomes an orphan comment or a leaked `gh` call in non-enterprise mode.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Non-enterprise must execute ZERO `gh` commands. Any error or non-`true` enterprise value skips everything here.]
You are relocating enterprise reporting into pocket-development.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — reporting moves to phase-completion; `create-pr` stays a recorder.
Files in scope: `skills/pocket-development/references/enterprise-reporting.md` — no other files.
Test framework: none — verified by the grep checks in Step 4 and by T10's comprehension review.
Available after: T6 (Phase B must not be built on a Phase A contradiction the comprehension review has not yet cleared)
Architecture rule: exactly one marker-tagged summary comment per phase; on a race, keep the earliest and delete the rest.
[RESTATE: Fail-closed. No PR found means create nothing — no orphan comments, ever.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given enterprise mode active and a confirmed create-pr offer, When phase-completion runs, Then the PR is created and verdicts posted to it.
Given a declined offer, When the phase ends, Then verdicts stay on disk and `create-pr` is unmodified.
Given `enterprise=false`, `ok=false`, or a missing `mode` command, When phase-completion runs, Then zero `gh` commands execute.
Given a re-run after a decline, When reporting posts, Then the marker upsert produces no duplicate comment.
[must-not] Given no PR for the branch, When reporting runs, Then it must NOT create any comment or thread.
[must-not] Given this file, When read, Then it must NOT assign verdict-posting work to `create-pr`.

Commit exists matching `docs(pocket-development): ...`.

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - E1–E6 present with their guards intact, including the >1 marker race collapse and the pre-2.5 fingerprint fallback
  - The create-pr offer/confirm ordering stated explicitly
  - Commit message follows conventional commits format

Must-not-have:
  - Any change to `skills/create-pr/SKILL.md`
  - Weakening or dropping a fail-closed guard during the port
  - Fixing the E5b fingerprint field mismatch (explicitly out-of-scope, pre-existing)
  - Modifications to files outside the listed scope

Open question risks:
  - `create-pr` needing no change is an assumption → if posting cannot work without it, report NEEDS_CONTEXT rather than editing create-pr

Rollback note:
  - The file is new; `pocket-review` still carries E1–E6 until T11, so reverting loses nothing

Red flags:
  - A `gh` call reachable without the enterprise guard → STOP
  - Orphan comment path introduced → STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a guard in the original cannot be preserved verbatim in the new location
Escalate when: posting verdicts appears to require modifying `create-pr`

---

### Task 9: pocket-development SKILL.md — phase-completion wiring [depends: T7, T8]

## OBJECTIVE

Wire the phase-level pass and the relocated enterprise reporting into pocket-development's phase-completion path, in the correct order, citing T7 and T8 rather than restating them.

Files:
- Modify: `skills/pocket-development/SKILL.md`

This is a **non-testable structural task**.

Steps:

1. Rewrite `## End-of-Execution Handoff` (`SKILL.md:585-640`) so that after all tasks are DONE the order is: dispatch the phase-level pass (cite `references/phase-level-pass.md`) → record its result → set phase status `REVIEW` → run enterprise reporting (cite `references/enterprise-reporting.md`).
2. Update `## Phase Completion Protocol` (`SKILL.md:719-752`) so `PHASE_COMPLETE` requires the phase-level pass to have recorded a result, and add `PHASE_BLOCKED` for the pass exceeding its round cap.
3. Update the log-command timing table (`SKILL.md:700-713`) so the phase `REVIEW` row states "after the phase-level pass records its result", and rewrite `:709` — the row that credits `pocket-review` with advancing the phase — to name the phase-level pass instead.
4. Remove the instruction to hand off to `/pocketto:pocket-review`; replace it with the phase-level pass being internal, and keep `pocket-closing` as the user-triggered next step. **Also rewrite the `REVIEW_FAIL` row in Status Handling (`SKILL.md:650`)** — it currently instructs re-entry via `/pocketto:pocket-correction`, a skill T11 deprecates. Replace it with the phase-level-pass correction path from `references/phase-level-pass.md`. This row is T9's, not T4's. **Also rewrite the sentence directly beneath it at `:652`** — "`REVIEW_FAIL` … is handled by the standalone `pocket-correction` skill" — which carries no `/pocketto:` form and would therefore survive the Step 6 grep untouched.
5. Add both new references to the Mandatory Reference Preloading and Reference Triggers tables.
6. Verify — the bare-name check is the important one, since an invocation-form grep alone lets prose survive:
   `grep -n "pocket-review\|pocket-correction" skills/pocket-development/SKILL.md` returns only the comparative parallel-merge lines (`:401`, `:451`, `:457`, `:460`, `:480`), and nothing describing either as a live stage; and
   `grep -c "phase-level-pass.md\|enterprise-reporting.md" skills/pocket-development/SKILL.md` returns at least 4.
7. Commit:
   `git add skills/pocket-development/SKILL.md`
   `git commit -m "feat(pocket-development): run the phase pass and reporting at phase-completion"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rules: Phase-level pass, Enterprise reporting
skills/pocket-development/references/phase-level-pass.md (T7) and references/enterprise-reporting.md (T8) — the contracts being wired
skills/pocket-development/SKILL.md — `:585-640` handoff, `:700-713` timing table, `:719-752` completion protocol

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: one file, three interlocking sections, and an ordering constraint (pass → record → REVIEW → report) that is wrong if any step is transposed.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Phase status `REVIEW` is written only AFTER the phase-level pass records its result. Transposing this makes a crashed pass undetectable on resume.]
You are wiring phase-completion for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: `skills/pocket-development/SKILL.md` — no other files.
Test framework: none — verified by the grep checks in Step 6 and by T10's comprehension review.
Available after: T7, T8
Architecture rule: `pocket-closing` still owns `REVIEW → DONE` and `log close` — this task must not advance a phase past `REVIEW`.
[RESTATE: Order is pass → record → REVIEW → report. `pocket-closing` keeps ownership of `REVIEW → DONE`.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given all tasks DONE, When phase-completion runs, Then the phase-level pass is dispatched before the phase status changes.
Given the pass recorded a result, When the phase advances, Then status `REVIEW` is set and only then does enterprise reporting run.
Given the file, When searched for `/pocketto:pocket-review` and `/pocketto:pocket-correction`, Then neither invocation remains — including the `REVIEW_FAIL` row that previously routed to pocket-correction.
Given the completion protocol, When the pass exceeded its round cap, Then `PHASE_BLOCKED` is emitted and the phase does not reach `REVIEW`.
[must-not] Given the file, When read, Then it must NOT advance a phase to `DONE` or call `log close` — those remain `pocket-closing`'s.
[must-not] Given the file, When read, Then it must NOT restate the fan-out or fail-closed rules inline instead of citing T7/T8.

Commit exists matching `feat(pocket-development): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Ordering stated explicitly in all three updated sections
  - Both new references in both reference tables
  - Commit message follows conventional commits format

Must-not-have:
  - Advancing phase status beyond `REVIEW`
  - Restating T7/T8 rules inline
  - Deprecating `pocket-review` here (T11 owns that)
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Revert restores the pocket-review handoff; T7/T8 references become orphaned but harmless

Red flags:
  - `REVIEW` set before the pass records → STOP
  - Work outside listed files → DONE_WITH_CONCERNS

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a section cannot be updated without contradicting T7 or T8
Escalate when: wiring appears to require changing `pocket-closing`

---

### Task 10: Comprehension review — Phase B [depends: T9]

## OBJECTIVE

Verify the Phase B instruction set — the phase-level pass, corrections, and enterprise reporting — is understandable and internally consistent to a reader with no session context.

Files:
- Create: `docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md`

This is a **non-testable verification task**.

Steps:

1. Dispatch one general-purpose subagent, read-only, with this prompt and no additional context:
   > Read `skills/pocket-development/SKILL.md`, `references/phase-level-pass.md`, and `references/enterprise-reporting.md`. What do you understand from these skills — describe what happens after every task in a phase is done, how a phase-level fix is recorded, and what happens in enterprise mode when no PR exists yet. Are there any inconsistencies that would confuse you about what to do?
2. Record the answer verbatim into the review file, followed by a verdict section.
3. Classify each reported inconsistency as blocking or non-blocking.
4. If any blocking inconsistency exists → report BLOCKED naming the contradiction and the owning task. Do not fix it here.
5. Verify:
   `test -f docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md`
6. Commit:
   `git add docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md`
   `git commit -m "chore(pocket): record Phase B comprehension review"`

Mark in QUALITY BAR: `[no-tdd — verification task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Comprehension
skills/pocket-development/SKILL.md, references/phase-level-pass.md, references/enterprise-reporting.md — the artifacts under review

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: read-only verification with a single dispatched reader.
Complexity: standard review

## SANDWICH CONTEXT

[CRITICAL: The reviewing subagent must receive NO context from this session.]
You are running the Phase B comprehension review for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the new review record only.
Test framework: none.
Available after: T9
Architecture rule: this task reports; it never fixes.
[RESTATE: Zero session context to the reviewer. Report blocking contradictions; do not repair them here.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the dispatched subagent, When it reports, Then it correctly describes the post-task phase pass, correction recording, and the no-PR enterprise path.
Given its report, When inconsistencies are classified, Then none are blocking.
Given the review record, When read, Then it contains the answer verbatim plus a verdict.
[must-not] Given a blocking inconsistency, When found, Then this task must NOT fix it.

Commit exists matching `chore(pocket): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — verification task]`
  - Reviewer dispatched with no session context
  - Answer recorded verbatim

Must-not-have:
  - Editing any skill file
  - Coaching the reviewer
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Documentation only

Red flags:
  - Reviewer given the spec or this plan → the test is void, STOP and re-dispatch

## STOP CONDITIONS

Done when: review recorded, no blocking inconsistency, commit created
Uncertain when: an inconsistency's severity is ambiguous
Escalate when: the reviewer cannot describe the phase pass at all

---

### Task 11: Deprecate the pocket-review and pocket-correction skills [depends: T9]

## OBJECTIVE

Mark both skills deprecated so hosts stop routing to them, while leaving the CLI correction machinery fully intact.

Files:
- Modify: `skills/pocket-review/SKILL.md`
- Modify: `skills/pocket-correction/SKILL.md`
- Modify: `skills/pocket-review/references/review-report-template.md`
- Modify: `skills/pocket-review/references/subagent-dispatch-template.md`

This is a **non-testable structural task**.

Steps:

1. In each SKILL.md, rewrite the frontmatter `description` so it states the skill is deprecated as of 3.0.0 and names its replacement — pocket-development's in-loop audit and phase-level pass. The `description` is the routing signal a host uses, so this is what actually stops the skill being selected.
2. Replace each body with a short deprecation notice: what replaced it, where the behavior now lives (`references/two-stage-review.md`, `references/phase-level-pass.md`, `references/enterprise-reporting.md`), and an explicit statement that the CLI correction machinery (`log update --correction --for-task`, `phase.corrections`, `for_task`/`bleed` attribution) is retained and now invoked from pocket-development.
3. Keep `skills/pocket-review/references/*` in place — **do not delete any of them.** `spec-compliance-review.md`, `code-quality-review.md` and `review-report-template.md` are cited by the new contracts (T3, T7).
4. Reconcile the two reference files whose own prose still describes pocket-review as the live writer:
   - `review-report-template.md` — it remains the normative artifact schema. Update prose naming pocket-review as the producer to name pocket-development's in-loop auditor. **Do not change any field name, type or nesting** — `pocket-closing` and T3's contract both depend on the exact shape.
   - `subagent-dispatch-template.md` — superseded by the auditor dispatch defined in `pocket-development/references/two-stage-review.md`. Add a one-line note at the top saying so and pointing there. Do not delete it; nothing cites it after this release, but removing a file is not this task's business.
5. Verify:
   `grep -il "deprecated" skills/pocket-review/SKILL.md skills/pocket-correction/SKILL.md` lists both files, and
   `ls skills/pocket-review/references/` still lists `spec-compliance-review.md`, `code-quality-review.md`, `review-report-template.md` and `subagent-dispatch-template.md`, and
   `node -e "const t=require('fs').readFileSync('skills/pocket-review/references/review-report-template.md','utf8'); for (const f of ['task_id','overall','reviewed_sha','fix_instructions','loop_info','severity','strengths']) if(!t.includes(f)) { console.error('missing field: '+f); process.exit(1) }"` exits 0.
6. Commit:
   `git add skills/pocket-review/SKILL.md skills/pocket-correction/SKILL.md skills/pocket-review/references/review-report-template.md skills/pocket-review/references/subagent-dispatch-template.md`
   `git commit -m "feat(skills)!: deprecate pocket-review and pocket-correction"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — Phase C scope; the CLI machinery is explicitly retained
skills/pocket-review/SKILL.md, skills/pocket-correction/SKILL.md — the skills being retired
skills/pocket-review/references/ — three files that MUST survive because the new contracts cite them
CLAUDE.md — the frontmatter `description` is the routing signal a host uses to decide when to load a skill

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: four files. Two are narrow deprecation notices; the other two are reference files whose prose must change while their schema must not — deleting or reshaping either breaks the contracts written in T3 and T7 and, downstream, `pocket-closing`.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Do NOT delete anything under `skills/pocket-review/references/`, and do NOT change a single field name in `review-report-template.md` — the new audit contracts and `pocket-closing` both depend on that exact shape.]
You are deprecating the pocket-review and pocket-correction skills.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — the skills retire; the CLI correction machinery stays.
Files in scope: the four files listed in this packet's Files section — no others.
Test framework: none — verified by the checks in Step 5.
Available after: T9
Architecture rule: no CLI behavior changes in this task whatsoever.
[RESTATE: Nothing under `references/` is deleted, and `review-report-template.md`'s schema fields are untouched — prose only.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given each deprecated SKILL.md, When its frontmatter is read, Then the description states deprecation and names the replacement.
Given each body, When read, Then it names where the behavior now lives and states that the CLI correction machinery is retained.
Given `skills/pocket-review/references/`, When listed, Then all four reference files are still present.
Given `review-report-template.md`, When read, Then its prose names pocket-development's auditor as the producer and every schema field name is unchanged.
Given `subagent-dispatch-template.md`, When read, Then it carries a superseded-by note pointing at `pocket-development/references/two-stage-review.md`.
[must-not] Given this task's diff, When inspected, Then no file under `cli/` may appear.
[must-not] Given this task's diff, When inspected, Then no reference file may be deleted.
[must-not] Given `review-report-template.md`, When diffed, Then no field name, type or nesting may have changed.

Commit exists matching `feat(skills)!: ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Frontmatter `description` updated in both files (the actual routing signal)
  - Explicit statement that the CLI machinery is retained
  - Conventional-commit `!` marker for the breaking change

Must-not-have:
  - Deleting any file
  - Changing any field name, type or nesting in `review-report-template.md`
  - Touching `cli/`
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Reverting restores both skills verbatim from git history

Red flags:
  - A reference file deleted → the audit contracts break, STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a host requires more than a description change to stop routing
Escalate when: deprecating would orphan a reference another skill cites

---

### Task 12: Documentation sync for the deprecated skills [depends: T11]

## OBJECTIVE

Update every document that names `pocket-review` or `pocket-correction` as live stages so the described pipeline matches reality. Documentation only — no behavior changes.

Files:
- Modify: `llms.txt`
- Modify: `README.md`
- Modify: `skills/create-pr/SKILL.md`
- Modify: `skills/pocket-closing/references/verdict-reconciliation.md`
- Modify: `skills/pocket-closing/SKILL.md` *(prose, frontmatter description and remediation strings only — gate logic untouched)*
- Modify: `skills/pocket-help/SKILL.md`
- Modify: `skills/pocket-help/references/skill-map.md`
- Modify: `skills/pocket-help/references/end-to-end-flow.md`
- Modify: `skills/pocket-help/references/pocket-vs-superpowers.md`

This is a **non-testable structural task**.

Steps:

1. Locate every mention: `grep -rn "pocket-review\|pocket-correction" llms.txt README.md skills/create-pr/ skills/pocket-closing/ skills/pocket-help/`
2. In each, replace pipeline descriptions that route users to those skills with the new flow: grinding → planning → structuring → development (in-loop audit + phase pass) → closing.
3. In `skills/create-pr/SKILL.md`, update only prose that refers to pocket-review as the next stage. Its behavior — committing `log.json` so SHA scope can be computed — is unchanged.
4. In `skills/pocket-closing/references/verdict-reconciliation.md`, update prose naming pocket-review as the verdict writer to name pocket-development's auditor instead. The reconciliation algorithm itself is unchanged.
5. In `skills/pocket-closing/SKILL.md`, update every mention of a retired stage. **Step 1's grep is authoritative; the line numbers here are illustrative, not a closed list** — known instances include the frontmatter `description` (the routing signal), the opening paragraph and "Core principle" at `:8` and `:10` (the first thing T14's fresh reader hits), the pipeline diagram at `:15-22`, the "Re-run pocket-review" remediation strings at `:91-94`, `:107`, `:109`, `:121`, `:185`, and `:166` naming pocket-correction as the correction recorder, plus `:315` and `:330`. Every one of these is prose or an instruction string pointing at a retired stage — the verdict gate, the freshness gate, the Advance State logic and `log close` are **untouched**.
6. In `skills/pocket-help/`, update `SKILL.md` (routing table `:80-81`, pipeline diagram `:118-122`, the "pocket-development does NOT call pocket-review" notes `:133-135`), `references/skill-map.md`, `references/end-to-end-flow.md` (invocation forms at `:58`, `:69`, `:84`) and `references/pocket-vs-superpowers.md:56`.
7. Verify — **quote the glob**; unquoted, zsh (this repo's shell) aborts with `no matches found: --include=*.md`, exit 1 and no stdout, which is indistinguishable from a clean pass:
   `grep -rn "pocket-review\|pocket-correction" llms.txt README.md skills/ --include='*.md'` returns only these expected hits:
   - `skills/pocket-review/SKILL.md`, `skills/pocket-correction/SKILL.md` — the deprecation notices themselves (T11)
   - `skills/pocket-review/references/review-report-template.md`, `subagent-dispatch-template.md` — reconciled by T11
   - the comparative parallel-merge lines in `skills/pocket-development/SKILL.md` (`:401`, `:451`, `:457`, `:460`, `:480`)

   Any other hit that describes either skill as a live stage is unfinished work — bare-name mentions count, not just `/pocketto:` invocation forms.
8. Commit:
   `git add llms.txt README.md skills/create-pr/SKILL.md skills/pocket-closing/references/verdict-reconciliation.md skills/pocket-closing/SKILL.md skills/pocket-help/SKILL.md skills/pocket-help/references/skill-map.md skills/pocket-help/references/end-to-end-flow.md skills/pocket-help/references/pocket-vs-superpowers.md`
   `git commit -m "docs: retire pocket-review and pocket-correction from the documented flow"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — Phase C documentation scope. The spec's Implementation Notes enumerate `llms.txt`, `README.md`, `create-pr/SKILL.md`, `verdict-reconciliation.md` and three pocket-help references; `pocket-closing/SKILL.md` and `pocket-help/SKILL.md` are added here under the spec's scope *clauses* rather than its enumeration — only pocket-closing's **gate logic** is fenced (Out-of-Scope), and pocket-help is documentation-only
skills/create-pr/SKILL.md — `:123-130` commits `log.json` so review can compute SHA scope; behavior stays
skills/pocket-closing/references/verdict-reconciliation.md — the algorithm is unchanged; only the writer's name changes

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: nine files, mechanical replacements, no judgement beyond keeping algorithm prose intact and staying on the prose side of `pocket-closing`'s gate logic.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Documentation only. No behavioral instruction in any of these files may change.]
You are syncing documentation after the deprecation.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the nine files listed in this packet's Files section — no others.
Test framework: none — verified by the grep check in Step 7.
Available after: T11
Architecture rule: `pocket-help` and `create-pr` behavior must not change — only prose naming the retired stages.
[RESTATE: Prose only. `verdict-reconciliation.md`'s algorithm and `create-pr`'s steps stay byte-equivalent in meaning.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the repo, When searched for invocations of the retired skills, Then none remain outside their own deprecated SKILL.md files.
Given `README.md` and `llms.txt`, When the pipeline is described, Then it matches the new flow.
Given `verdict-reconciliation.md`, When read, Then the reconciliation algorithm is unchanged and only the verdict writer's name differs.
[must-not] Given `skills/create-pr/SKILL.md`, When diffed, Then no step, command, or gate may have changed.
[must-not] Given `skills/pocket-help/`, When diffed, Then no routing behavior beyond the retired stage names may have changed.
[must-not] Given `skills/pocket-closing/SKILL.md`, When diffed, Then the verdict gate, freshness gate, Advance State logic and `log close` invocation must NOT have changed — only prose, the frontmatter description, and remediation strings naming retired stages.

Commit exists matching `docs: ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Every mention located by grep before editing, so none is missed
  - Algorithm prose preserved

Must-not-have:
  - Behavioral changes to `create-pr` or `pocket-help`
  - Any change to `pocket-closing`'s gate logic, freshness comparison, Advance State, or `log close` call
  - Editing the deprecated SKILL.md files again (T11 owns them)
  - Modifications to files outside the listed scope

Open question risks:
  - `create-pr` needing no change is an assumption → if a doc edit implies a behavior change, report NEEDS_CONTEXT

Rollback note:
  - Documentation only; reverting restores the old prose

Red flags:
  - A step or command changed in `create-pr` → scope violation, STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a mention is load-bearing rather than descriptive
Escalate when: syncing a doc would require a behavior change

---

### Task 13: Version 3.0.0, manifest sync, and migration release notes [depends: T12]

## OBJECTIVE

Cut the major version, keep both host manifests consistent, and publish the migration instruction that is the primary path for users with in-flight plans.

Files:
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md`

This is a **non-testable structural task**.

Steps:

1. Set `package.json` `version` to `3.0.0`. Do not touch `CONTRACT` in `cli/lib/version.js` — it stays `2`.
2. Review `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` for any field that must track the release; keep the Pi manifest (`pi.skills`, `bin`) and the plugin manifest describing the same skill set. Note in the commit body that `marketplace.json` uses `source: url` with no version field, so plugin rollback is "do not update / reinstall an older ref".
3. Add a migration section to `README.md` stating: **close in-flight plans before updating**; a plan started under an older pipeline is refused by the new CLI; recovery is to pin the CLI (`npx -y pocketto-pi@2.4.4`) and keep the plugin at its previous commit until the plan closes.
4. Verify:
   `node -e "const p=require('./package.json'); if(p.version!=='3.0.0') process.exit(1)"` exits 0, and
   `node -e "const v=require('./cli/lib/version'); if(v.CONTRACT!==2) process.exit(1)"` exits 0, and
   `npm test` is green.
5. Commit:
   `git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json README.md`
   `git commit -m "chore(release)!: 3.0.0 — in-loop build cycle, older plans refused"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — Rollback Plan and the Migration rule; the release note is the primary migration path
package.json — currently `2.4.4`; `pi.skills` and `bin` are the Pi manifest surface
.claude-plugin/marketplace.json — `source: url` to the git repo with no version field, so installs pin to a commit
cli/lib/version.js — `CONTRACT` must remain `2`; only the package major moves

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: four files, mechanical, but the version/contract distinction is exactly what this release is about and is easy to get wrong.
Complexity: lightweight

## SANDWICH CONTEXT

[CRITICAL: `CONTRACT` stays `2`. Only the package major moves to 3.0.0.]
You are cutting the 3.0.0 release for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — breaking behavior, additive schema.
Files in scope: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md` — no others.
Test framework: node:test — `npm test` must be green before commit.
Available after: T12
Architecture rule: Pi manifest and Claude Code plugin manifest stay in sync.
[RESTATE: `CONTRACT` = 2. Version = 3.0.0. These are independent numbers.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given `package.json`, When read, Then `version` is `3.0.0`.
Given `cli/lib/version.js`, When read, Then `CONTRACT` is still `2`.
Given `README.md`, When the migration section is read, Then it instructs closing in-flight plans before updating and names the CLI pin as recovery.
Given the repo, When `npm test` runs, Then it is green.
[must-not] Given this task's diff, When inspected, Then `CONTRACT` must NOT appear as changed.
[must-not] Given the manifests, When compared, Then they must NOT describe different skill sets.

Commit exists matching `chore(release)!: ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - `version` 3.0.0, `CONTRACT` 2
  - Migration instruction present in README
  - `npm test` green before commit

Must-not-have:
  - Any change to `CONTRACT`
  - Publishing to npm (release is the user's call, not this task's)
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Reverting the version commit restores 2.4.4 metadata; no on-disk plan data is affected

Red flags:
  - `npm publish` executed → STOP, this task never publishes
  - `CONTRACT` bumped → STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, `npm test` green, commit created
Uncertain when: a manifest field appears to require a version that does not exist
Escalate when: keeping the manifests in sync would require a schema change

---

### Task 14: Final comprehension review and end-to-end verification [depends: T13]

## OBJECTIVE

Verify the whole bundle reads as one coherent pipeline to a fresh reader, and that the repo's own checks are green.

Files:
- Create: `docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md`

This is a **non-testable verification task**.

Steps:

1. Run `npm test` — must be green. Record the summary line.

2. **Closing-arithmetic cross-check.** T7's fan-out rule and `pocket-closing`'s freshness gate must compute the same value; a mismatch permanently blocks closing and no automated test covers it. Build a throwaway fixture and compare by hand.

   Two properties the fixture must have, both of which are easy to get wrong:
   - **Bleed is computed from FILES, not commit messages** (`verdict-reconciliation.md:47-48`: `tasks(c) = {c.for_task} ∪ {owner[f] : f ∈ c.files}`). A commit whose message claims it bleeds into T1 but which touches no T1-owned file does **not** bleed. So C2 must actually modify `a.txt`.
   - **`%cI` is second-resolution.** Four back-to-back commits share a timestamp, leaving `max_by_commit_time` indeterminate. Pin the dates explicitly.

   Run the whole thing in a subshell so the working directory is never left inside the fixture:
   ```bash
   (
     TMP=$(mktemp -d) && cd "$TMP" && git init -q
     git config user.email t@t && git config user.name t
     c() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qm "$2"; }
     printf 'a\n' > a.txt && git add a.txt && c "2026-01-01T00:00:00Z" "T1"  && T1=$(git rev-parse HEAD)
     printf 'b\n' > b.txt && git add b.txt && c "2026-01-01T00:01:00Z" "T2"  && T2=$(git rev-parse HEAD)
     printf 'a2\n' > a.txt && git add a.txt && c "2026-01-01T00:02:00Z" "C1 fixes T1" && C1=$(git rev-parse HEAD)
     printf 'a3\n' > a.txt && printf 'b2\n' > b.txt && git add a.txt b.txt
     c "2026-01-01T00:03:00Z" "C2 fixes T2, bleeds T1" && C2=$(git rev-parse HEAD)
     for s in $T1 $T2 $C1 $C2; do git show -s --format='%h %cI %s' "$s"; done
     echo "C2 files:" && git show --name-only --format= "$C2"
     rm -rf "$TMP"
   )
   ```
   `owner[a.txt] = T1`, and C2 touches `a.txt`, so `tasks(C2) ∋ T1` and T1's owned set is `{T1, C1, C2}`. Confirm the max-by-commit-time value the T7 rule yields for T1 is `C2` — and that `verdict-reconciliation.md`'s `latest_owned_sha(T1)` yields the same commit. Record both values side by side in the review file. If they differ → BLOCKED naming T7.

   Note in the record (do **not** fix — `verdict-reconciliation.md`'s algorithm is out of scope per the spec): `max_by_commit_time` documents no tiebreak for two commits sharing a `%cI` second.

3. Dispatch one general-purpose subagent, read-only, with this prompt and no additional context:
   > Read `skills/pocket-help/references/skill-map.md`, `README.md`, `skills/pocket-development/SKILL.md` and its `references/`, and `skills/pocket-closing/SKILL.md`. What do you understand the Pocket pipeline to be — list the stages in order and say which are triggered by the user. Are there any inconsistencies that would confuse you about which stage to run, or any stage that appears both live and deprecated?
4. Record the answer verbatim into the review file, followed by the `npm test` result, the Step 2 cross-check values, and a verdict.
5. Classify each reported inconsistency as blocking or non-blocking. A stage described as both live and deprecated is always blocking — **except** a comparative mention inside the parallel-merge rationale (`skills/pocket-development/SKILL.md` :401, :451, :457, :460, :480 — "same pattern pocket-review uses", "pocket-review's per-task diff range"). Those are analogies, not liveness claims, and that region is fenced byte-identical by the spec's worktree constraint, so no task may edit them. Classify them non-blocking and note them.
6. If any blocking inconsistency exists → report BLOCKED naming the contradiction and the owning task.
7. Verify:
   `test -f docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md`
8. Commit:
   `git add docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md`
   `git commit -m "chore(pocket): record final comprehension review"`

Mark in QUALITY BAR: `[no-tdd — verification task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Comprehension, and the per-phase acceptance signal
skills/pocket-help/references/skill-map.md — the routing map a new user reads first
skills/pocket-closing/references/verdict-reconciliation.md — `latest_owned_sha` and `tasks(c)`, the algorithm Step 2 compares against
skills/pocket-development/references/phase-level-pass.md — T7's fan-out `reviewed_sha` rule, the other half of the Step 2 comparison
test/cli.test.js — `npm test` is the entire automated CI surface

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: read-only verification across the whole bundle; the value is a fresh reader detecting a stage that reads as both live and retired.
Complexity: standard review

## SANDWICH CONTEXT

[CRITICAL: The reviewing subagent must receive NO context from this session.]
You are running the final comprehension review for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the new review record only — no product file may be edited.
Test framework: node:test — `npm test` result is recorded, not fixed, here.
Available after: T13
Architecture rule: this task reports; it never fixes.
[RESTATE: Zero session context to the reviewer. A stage reading as both live and deprecated is always blocking.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given `npm test`, When it runs, Then it is green and the summary is recorded.
Given the synthetic fixture, When T7's fan-out rule and `verdict-reconciliation.md`'s `latest_owned_sha` are both applied to T1's owned set, Then they yield the same commit, and both values are recorded side by side.
Given the dispatched subagent, When it reports, Then it lists the pipeline stages in the correct order and identifies which are user-triggered.
Given its report, When inconsistencies are classified, Then none are blocking and no stage reads as both live and deprecated.
Given the review record, When read, Then it contains the answer verbatim, the test result, and a verdict.
[must-not] Given a blocking inconsistency, When found, Then this task must NOT fix it.

Commit exists matching `chore(pocket): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — verification task]`
  - `npm test` actually executed, result recorded verbatim
  - The closing-arithmetic cross-check actually run on a throwaway fixture, both values recorded
  - Reviewer dispatched with no session context

Must-not-have:
  - Editing any skill, CLI, or manifest file
  - Declaring success without running the test command
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Documentation only

Red flags:
  - "Tests should pass" without output → STOP, run them
  - Reviewer given the spec or this plan → the test is void, re-dispatch

## STOP CONDITIONS

Done when: `npm test` green, review recorded, no blocking inconsistency, commit created
Uncertain when: an inconsistency's severity is ambiguous
Escalate when: a stage reads as both live and deprecated — name the owning task and stop

---

## Plan Summary

| Task | Name | Depends | Complexity | Key Verification |
|------|------|---------|------------|------------------|
| T1 | CLI — PIPELINE marker + stamp at init | prereq | lightweight | init from scratch writes `header.pipeline`; `CONTRACT` unchanged |
| T2 | CLI — refusal gate at the readLog choke point | T1 | standard | marker-less log refused non-zero, file byte-identical |
| T3 | Rewrite two-stage-review.md as the audit contract | prereq | standard | eleven contract sections present; escape hatch absent |
| T4 | SKILL.md — per-task in-loop build cycle | T3 | standard | "quick audit inline" gone; contract cited 3+ times |
| T5 | pocket-planning — refactor auditor-judged | T3 (∥ T4) | lightweight | "Nothing to refactor" absent; heuristics word-identical |
| T6 | Comprehension review — Phase A | T2, T4, T5 | standard review | fresh reader describes the loop; no blocking inconsistency |
| T7 | references/phase-level-pass.md | T6 | standard | `reviewed_sha` = max-by-commit-time over the owned set |
| T8 | references/enterprise-reporting.md | T6 (∥ T7) | standard | E1–E6 intact; zero `gh` calls when non-enterprise |
| T9 | SKILL.md — phase-completion wiring | T7, T8 | standard | order is pass → record → REVIEW → report |
| T10 | Comprehension review — Phase B | T9 | standard review | fresh reader describes the pass and the no-PR path |
| T11 | Deprecate pocket-review + pocket-correction | T9 | standard | both descriptions say deprecated; all four references survive with schema fields intact |
| T12 | Documentation sync (9 files) | T11 | standard | only the expected hits remain, bare names included |
| T13 | Version 3.0.0 + manifests + release notes | T12 | lightweight | version 3.0.0, `CONTRACT` 2, `npm test` green |
| T14 | Final comprehension + end-to-end verification | T13 | standard review | no stage reads as both live and deprecated |
