# In-Loop Build Cycle — CLI — PIPELINE marker constant and stamping at log init (Phase 1 of 4)

**Date:** 2026-08-15
**Original plan:** docs/pocket/plans/2026-08-15-in-loop-build-cycle/execution-plan.md
**Prerequisite:** None (first phase)
**Contains tasks:** {T1, T3, T2, T4, T5}
**Unlocks next:** Phase 2

---

## Task List

Total: 5 tasks | Prerequisite phases must be complete before starting

T1: CLI — PIPELINE marker constant and stamping at log init [prereq]
T3: Rewrite two-stage-review.md as the audit-loop contract [prereq]
T2: CLI — pipeline-marker refusal gate at the readLog choke point [depends: T1]
T4: pocket-development SKILL.md — the per-task in-loop build cycle [depends: T3]
T5: pocket-planning — refactor becomes auditor-judged, not self-reported [depends: T3] [parallel: T4]

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

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to Phase 2 ONLY after this gate passes.
