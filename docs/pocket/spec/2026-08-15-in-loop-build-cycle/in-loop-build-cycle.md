# In-Loop Build Cycle — pocket-development as the full development stage

**Date:** 2026-08-15
**Status:** approved
**Author:** brainstorm session (pocket-grinding)
**Spec path:** docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
**Branch:** `feat/in-loop-build-cycle`

---

## Summary

`pocket-development` currently marks a task DONE after a shallow gate (commit exists, tests green, DELIVERABLE checklist), then `pocket-review` re-judges the same task post-phase against deeper criteria (spec compliance, code quality, QUALITY BAR). Tasks therefore pass an easy exam, get their SHA pinned, and fail a harder exam afterwards — at which point fixing them costs an append-only correction, cross-task attribution, and a manual re-review round.

This spec deepens the in-loop gate so the deep judgement happens **before** the SHA is pinned, gives the refactor step a verifier it never had, and collapses the user-triggered `pocket-review` / `pocket-correction` stages into `pocket-development` while keeping their on-disk artifacts and CLI machinery intact.

---

## Context

### Current State

- `pocket-development` quick audit checks: commit exists, tests green, DELIVERABLE checklist (`skills/pocket-development/SKILL.md:568-574`). On pass it runs `log update --task TN DONE`, which records `done_sha` from HEAD (`SKILL.md:706`, `:713`).
- `pocket-review` is user-triggered post-phase. It dispatches one read-only reviewer subagent per task over `prev_sha..done_sha`, judging spec compliance + code quality + `quality_bar`, and writes `reviews/<task_id>-review.json`.
- `QUALITY BAR` is authored into every packet by `pocket-planning` but is never read during development — only post-phase.
- Refactor is step 5 of the planning packet template with the escape hatch `"Nothing to refactor → say so and move to commit"` (`skills/pocket-planning/SKILL.md:320`). Its only real check (rule of three, file ~300 lines, function ~50 lines) lives in QUALITY BAR, i.e. post-phase. Task DELIVERABLE ends at *"All tests PASS. Commit exists"* (`SKILL.md:366`) — refactor is not part of DONE.
- `REVIEW_FAIL` is the only branch in the pipeline that stops and prints "Action Required" instead of chaining behind one confirmation, unlike `review → closing` and `grinding → planning`.
- `pocket-development/SKILL.md` is 807 lines and **already contradicts its own reference**: `SKILL.md:568` says the per-task review is "a quick audit inline — no subagent, no pocket-review", while `references/two-stage-review.md` describes a full two-stage read-only agent loop with the exact Critical/Important/Minor ladder this spec adopts.

### Problem / Motivation

Two symptoms with one mechanism — the in-loop gate and the terminal gate check different criteria:

1. **"Extra step" / extra implementer spawns.** A task clears the shallow gate, `done_sha` freezes, then the deep gate fails it. The fix now requires an append-only correction commit, `owner[file]` / `bleed` attribution, and a user-triggered re-review round.
2. **Strong only at red-green.** Red and green are verified by *running a command* — binary, unfakeable. Refactor has no equivalent verifier; the implementer's assertion is accepted as-is.

### Related Areas

- `skills/pocket-development/**` (SKILL.md + references)
- `skills/pocket-planning/SKILL.md` (packet template, refactor step)
- `skills/pocket-review/**` (criteria references reused; skill deprecated in Phase C)
- `skills/pocket-correction/SKILL.md` (skill deprecated; CLI machinery retained)
- `skills/pocket-closing/**` (verdict consumer — must keep working unchanged)
- `cli/commands/log.js`, `cli/lib/logjson.js`, `cli/lib/git.js`
- `test/cli.test.js` — the legacy fixture at `:982-999` hand-crafts an old-style header (phases without tasks, no pipeline marker) and calls `log init` expecting success

---

## Scope

Delivered on one branch (`feat/in-loop-build-cycle`) as one PR, executed in three phases, reviewed per phase.

### In-Scope

**Phase A — per-task in-loop build cycle**

- Per-task loop inside `pocket-development`: implement → mechanical gate → deep audit by a read-only subagent → fix/refactor round → re-audit → mark DONE + pin `done_sha`.
- Auditor criteria: QUALITY BAR (must-have / must-not-have / red flags) + spec compliance + code quality, judged from the diff `prev_sha..HEAD`.
- Auditor grades its own findings `Critical | Important | Minor`.
- Refactor heuristics judged by the auditor directly from the diff; the `"Nothing to refactor → say so"` escape hatch is removed from the planning packet template.
- Hard cap of 2 rounds per task → task BLOCKED with a persisted category.
- `done_sha` pinned to the exact audited commit for sequential tasks.
- Empty-diff and `[no-tdd]` task handling.
- Resume semantics for a phase interrupted mid-flight.

**Phase B — phase-level pass and enterprise reporting**

- One phase-level pass inside `pocket-development` after all tasks are DONE, looking only for what per-task audits cannot see.
- Phase-level fixes recorded as append-only corrections; `done_sha` never moves.
- Verdict refresh for every affected task after a correction.
- Enterprise reporting (`pocket-review` E1–E6) moved into phase-completion, fail-closed for non-enterprise.

**Phase C — deprecation and migration**

- Deprecate the `pocket-review` and `pocket-correction` **skills**; retain the CLI correction machinery and call it from `pocket-development`.
- Pipeline-version marker in the `log.json` header + fail-closed refusal of plans from an older pipeline.
- Documentation updates where the deprecated skills are named (`llms.txt`, `README.md`, `skills/create-pr/SKILL.md`, `skills/pocket-closing/references/verdict-reconciliation.md`, `pocket-help` references).
- `references/` split of `pocket-development` so the instruction set stays followable.

### Out-of-Scope

- **Changing the meaning of `done_sha`** — it remains the boundary of a task's owned range. Changing it invalidates `buildOwnerMap`, review ranges, and closing's freshness model in one stroke.
- **Parallel-group worktree setup / sequential-merge / cleanup mechanics** — only the audit boundary moves. The merge-then-log-one-task-at-a-time loop (`pocket-development/SKILL.md:428-460`) stays byte-identical; it is what prevents `DUPLICATE_DONE_SHA`.
- **`create-pr` behavior** — it stays a recorder. Adding verdict posting there would duplicate E3–E5 across two skills and invite double-posting against the same marker.
- **`pocket-closing` gate logic** — it must keep working against the same artifact path and schema; no changes to its verdict/freshness algorithm.
- **The E5b fingerprint field mismatch** (`ruleId` / `occurrence` are derived, not stored in the verdict schema) — pre-existing, not created here.
- **`pocket-grinding`, `pocket-pitching`, `hotfix`, `brand-design`, `bug-hunting`, `structured-research`, `pocket-init`, `pocket-help` behavior** — documentation-only touches in Phase C.

---

## Architecture Constraints

- **May touch:** `skills/pocket-development/**`, `skills/pocket-planning/SKILL.md` (packet template), `skills/pocket-review/**` (references reused; skill deprecated), `skills/pocket-correction/SKILL.md` (deprecation only), `cli/**`, `test/**`, docs naming the deprecated skills.
- **Must NOT touch:** `pocket-closing` gate logic, `create-pr` behavior, the enterprise fail-closed contract, worktree setup/merge/cleanup mechanics.
- **Patterns that must be followed:**
  - Main agent is Delegator + Auditor — it never writes implementation code and never judges code itself.
  - The auditor is always a separate read-only subagent, never the main agent, never the implementer.
  - State lives on disk so work is resumable across sessions and inspectable by humans.
  - `log.json` is written only through the CLI.
  - Skills invoke the CLI as `npx -y pocketto-pi … --json --contract <N>`.
  - Contract 2 is additive-only. A non-additive JSON shape change requires bumping `CONTRACT` and the major version together, plus keeping the Pi manifest (`package.json` `pi.skills`, `bin`) and the Claude Code plugin manifest in sync.
  - Enterprise paths stay fail-closed: any error or non-`true` `enterprise` means zero `gh` calls.
  - `npm test` stays green.
- **Architecture validation result:** PASS (Phase 6 checklist, all items satisfied).

---

## Dependencies

### Existing (to leverage)

- **`pocketto-pi` CLI, contract 2** — `log update --task … DONE --sha <commit>`, `--allow-duplicate-sha`, `log update --correction <sha> --for-task <id>`, `phase.corrections` + `for_task`/`bleed` attribution, `format comment` / `format tasklist`, `reconcile`, `meta get|set`, `mode`. All retained and reused; the correction machinery in particular is kept while its skill is deprecated.
- **`pocket-review/references/spec-compliance-review.md`, `code-quality-review.md`, `review-report-template.md`** — reused verbatim as the auditor's criteria and artifact schema. The criteria are identical; only the timing changes.
- **`loop_info` in the verdict artifact schema** (`review-report-template.md:141-147`) — already on disk, already resume-safe; reused as the durable round counter, so no new CLI writer is needed.

### New (proposed)

none — the CLI stays plain Node using only `node:*` builtins.

---

## Stories + Scenarios

### Story A1: Deep audit before the SHA is pinned

> As a plan executor, I want every task checked by an independent auditor before it is marked DONE, so failures surface while the fix is still cheap.

**Rule A1.1: Every task passes a read-only subagent audit before DONE**

- Example: implementer reports DONE with green tests but adds a dependency the QUALITY BAR forbids → auditor FAILs → fix round.

```gherkin
Scenario: Audit catches a must-not-have violation before the SHA is pinned
  Given task T2 whose QUALITY BAR must-not-have says "no new dependencies"
    And the implementer reports DONE with green tests
  When  the main agent runs the mechanical gate then dispatches the read-only auditor
  Then  the auditor returns a Critical finding "dependency X added"
   And  T2 is not marked DONE
   And  no done_sha is written for T2

Scenario: The main agent never acts as auditor
  Given task T2 is ready for audit
  When  spec compliance must be judged
  Then  the judgement is delegated to a read-only subagent
   And  the main agent does not read implementation files to assess quality
```

**Rule A1.2: The mechanical gate runs first and its failures do not consume the round budget**

- Example: tests red → re-dispatch without spawning an auditor.
- Example: `[no-tdd]` structural task → the packet's validation command is the mechanical gate; no command specified at all → straight to the auditor.

```gherkin
Scenario: A mechanical failure does not burn an audit round
  Given the implementer reports DONE for T2
    And the plan's test command exits non-zero
  When  the main agent runs the mechanical gate
  Then  the auditor is not dispatched
   And  the implementer is re-dispatched with reason "tests failing"
   And  T2's round count is unchanged

Scenario: A structural task uses its validation command as the mechanical gate
  Given task T5 is marked [no-tdd — structural task] with a validation command
  When  the implementer reports DONE
  Then  the validation command is the mechanical gate
   And  on success the auditor is dispatched normally

Scenario: A task with no command at all goes straight to the auditor
  Given task T6 specifies neither a test command nor a validation command
  When  the implementer reports DONE
  Then  no mechanical command is run
   And  the auditor is dispatched
```

**Rule A1.3: Severity decides what forces a round**

- `Critical` and `Important` force a fix or refactor round and can end in BLOCKED.
- `Minor` is recorded as a non-blocking observation and carried forward to closing.
- The auditor emits the classification itself; the main agent only reads the label.

```gherkin
Scenario: A Minor-only verdict does not block the task
  Given the auditor returns one Minor finding and nothing higher for T4
  When  the main agent reads the verdict
  Then  T4 proceeds to DONE
   And  the Minor finding is persisted in the verdict artifact
   And  no fix round is started

Scenario: Unfixed Minors survive a re-audit
  Given round 1 recorded Minor findings M1 and M2 for T2
    And a fix round addressed only the Critical finding
  When  the re-audit runs
  Then  the previous verdict is supplied to the auditor
   And  every still-unfixed Minor is re-emitted into the rewritten artifact
   And  the main agent does not merge findings itself
```

**Rule A1.4: Two rounds, then BLOCKED — with the cause distinguished**

- Consumes the budget: an audit FAIL at Critical/Important, a refactor round, a new finding introduced by a fix.
- Does not consume the budget: auditor infrastructure failure. That gets one separate infra retry.

```gherkin
Scenario: Two-round cap ends in BLOCKED
  Given T2 has already consumed both rounds
  When  the auditor returns a Critical finding again
  Then  T2 is marked BLOCKED via the CLI
   And  the verdict artifact records category "audit-failed" with the findings
   And  the phase halts — the next task is not started
   And  no done_sha is ever written for T2

Scenario: A fix that introduces a new finding still consumes a round
  Given T2 failed audit at Important and the fix introduced a new Critical
  When  the second audit runs
  Then  the budget shows 2 of 2 consumed
   And  T2 is BLOCKED with category "audit-failed" listing both findings

Scenario: Auditor infrastructure failure is not the task's fault
  Given the auditor subagent dies or returns unparseable output
  When  the failure is detected
  Then  the round count is unchanged
   And  exactly one infra retry is attempted
   And  a second infra failure marks T2 BLOCKED with category "auditor-unavailable"
   And  no log update DONE is issued
```

**Rule A1.5: The pinned SHA is the audited SHA (sequential tasks)**

```gherkin
Scenario: done_sha names the exact commit the auditor read
  Given the auditor passed T2 having read the diff up to commit X
  When  the main agent marks T2 DONE
  Then  it passes --sha X explicitly
   And  the verdict artifact records reviewed_sha = X
   And  reviewed_sha equals done_sha

Scenario: An empty-diff task is stubbed, not looped
  Given T3's range prev_sha..HEAD contains no file changes
  When  the main agent processes T3
  Then  no auditor is dispatched
   And  T3 is marked DONE with --allow-duplicate-sha
   And  a REVIEW_PASS stub is written with reviewed_sha = done_sha and skip_reason "no_file_changes"
```

**Rule A1.6: Resume never moves a pinned SHA**

```gherkin
Scenario: Resume skips tasks that are already done and fresh
  Given a session ended after T1 and T2 were marked DONE
    And each has a verdict artifact whose reviewed_sha equals its done_sha
  When  pocket-development resumes on the phase
  Then  no log update DONE is re-issued for T1 or T2
   And  execution continues at T3
   And  each task's round count is read from its verdict artifact, not reset
```

### Story A2: A verified refactor round

> As the owner of code quality, I want the refactor step to have a checker, so "I refactored it" is no longer merely asserted.

**Rule A2.1: The auditor judges refactor heuristics from the diff**

- Thresholds: identical logic 3+ times across in-scope files; a modified file crossing ~300 lines; a function exceeding ~50 lines.

```gherkin
Scenario: The auditor demands a refactor round from the diff
  Given T3's diff contains an 80-line function in an in-scope file
  When  the auditor judges the diff
  Then  the verdict includes an Important quality finding on function length
   And  T3 enters a refactor round instead of going to DONE

Scenario: A clean diff triggers no refactor round
  Given T4's diff violates none of the thresholds
  When  the auditor judges the diff
  Then  no quality finding is emitted
   And  T4 proceeds to DONE
   And  no "nothing to refactor" claim from the implementer is required or accepted

Scenario: A behavior-shifting refactor is rejected
  Given T3 is in a refactor round
  When  the implementer splits the function and the test command goes red
  Then  the round is failed
   And  T3 is not marked DONE
   And  the round count increments by one
```

**Rule A2.2: Parallel-group tasks are audited at the worktree tip**

```gherkin
Scenario: Clean merge advances the verdict without a re-audit
  Given T5, T6 and T7 were audited at their worktree tips and passed
  When  each is merged conflict-free and logged one at a time
  Then  done_sha for each task is its own merge commit
   And  reviewed_sha for each task is rewritten to that same merge commit
   And  no re-audit is dispatched

Scenario: A manually resolved conflict requires a re-audit
  Given merging task/T6 required manual conflict resolution
  When  the merge commit is created
  Then  a re-audit is dispatched against the merge commit
   And  both done_sha and reviewed_sha are that merge commit

Scenario: A blocked group member stops the whole group
  Given T6 hit the two-round cap in its worktree
  When  the group is evaluated
  Then  no group member is merged
   And  no worktree is removed and no branch is deleted
```

### Story B1: Phase-level pass and corrections

> As the phase owner, I want one pass that sees the whole phase, so cross-task incoherence does not slip through.

**Rule B1.1: The phase-level pass looks only for what per-task audits cannot see**

```gherkin
Scenario: Cross-task duplication is caught
  Given T1 and T3 each wrote their own token-parsing helper
    And both passed their per-task audits because each is clean alone
  When  the phase-level pass runs after all tasks are DONE
  Then  it reports a duplication finding naming T1 and T3

Scenario: A pass that finds nothing still leaves a record
  Given the phase-level pass completes with zero findings
  When  it finishes
  Then  a "no cross-task findings" record is written to disk
   And  the phase status is set to REVIEW afterwards
   And  no verdict artifact is modified
```

**Rule B1.2: Phase-level fixes are append-only corrections**

```gherkin
Scenario: A phase-level fix does not move any pin
  Given a finding requires changes to files owned by T1 and T3
  When  the fix is committed and recorded via log update --correction --for-task T1
  Then  done_sha for T1 and T3 are unchanged
   And  phase.corrections gains one entry with the sha and file list
   And  bleed attribution names T3

Scenario: A dirty correction commit is rejected
  Given the fix commit includes log.json
  When  the main agent audits the commit
  Then  the commit is rejected and the implementer re-dispatched with explicit staging instructions
   And  no correction entry is recorded for that sha

Scenario: In-loop fixes are not corrections
  Given T2 is in a fix round and has no done_sha yet
  When  the implementer commits the fix
  Then  it is a plain commit
   And  log update --correction is not invoked
```

**Rule B1.3: One auditor reads the correction; the verdict fans out to every attributed task**

```gherkin
Scenario: One correction audit refreshes every attributed task
  Given a correction commit C affects T1 (for_task) and T3 (bleed)
  When  the correction auditor passes C
  Then  exactly one auditor is dispatched
   And  the verdict is written into both T1's and T3's artifacts
   And  each artifact's reviewed_sha is that task's newest owned commit by commit time
   And  tasks outside data.correction.affectedTasks are left untouched

Scenario: Two corrections resolve to the newest owned commit per task
  Given corrections C1 (for T2) and C2 (bleeding into T2 and T5)
  When  the correction audit passes
  Then  T2's reviewed_sha is max-by-commit-time over its owned set including C1 and C2
   And  T5's reviewed_sha is max-by-commit-time over its owned set including C2
   And  each equals what pocket-closing computes as latest_owned_sha

Scenario: The phase-level pass has its own two-round cap
  Given the phase-level pass has consumed two fix rounds
  When  findings remain
  Then  PHASE_BLOCKED is emitted with the findings attached
   And  the phase status is not advanced to REVIEW
```

### Story B2: Enterprise reporting at phase-completion

> As an enterprise user, I want verdicts to reach the PR without an extra manual stage, and non-enterprise users to see no GitHub behavior at all.

**Rule B2.1: Fail-closed for non-enterprise**

```gherkin
Scenario: Non-enterprise touches GitHub not at all
  Given pocketto-pi mode returns enterprise=false, or ok=false, or is missing
  When  phase-completion runs
  Then  no gh command is executed
   And  the handoff output is identical to the non-enterprise path today
```

**Rule B2.2: The PR is offered, never created without consent**

```gherkin
Scenario: Offer, confirm, then post
  Given enterprise mode is active and no PR exists for the branch
  When  phase-completion reaches the reporting step
  Then  create-pr is offered and one confirmation is awaited
   And  on confirmation the PR is created and verdicts are posted

Scenario: Declining leaves the verdicts recoverable
  Given the user answers "not yet" to the create-pr offer
  When  the phase ends
  Then  verdicts remain on disk unposted
   And  create-pr is not modified to post them
   And  re-running phase-completion later posts them with no duplicate marker comment
```

### Story C1: Deprecation and migration

> As a user, I want fewer manual stages without losing evidence or silently corrupting an in-flight plan.

**Rule C1.1: The verdict artifact contract is literal**

```gherkin
Scenario: pocket-closing can still close a phase
  Given a phase completed through the new pipeline with all tasks DONE and passing
  When  the user runs pocket-closing
  Then  every DONE task has a verdict at <plan_dir>/reviews/<task_id>-review.json
   And  each carries task_id, overall, reviewed_sha, fix_instructions, loop_info,
        stage_2.issues[].severity and stage_2.strengths[] per review-report-template.md
   And  the freshness gate passes and log close succeeds
```

**Rule C1.2: Plans from an older pipeline are refused, not repaired**

```gherkin
Scenario: An older plan is refused without a single byte written
  Given a log.json whose header pipeline marker is absent or lower than the current one
  When  a state-changing log command is run by the new CLI
  Then  it exits non-zero with a message naming the detected version and the recovery step
   And  the recovery step names pinning the CLI, e.g. npx -y pocketto-pi@2.4.4
   And  log.json is not modified in any way

Scenario: A new plan is stamped at init
  Given log init runs on a plan directory with no log.json
  When  the log is created from scratch
  Then  the header records the current pipeline marker as an integer
   And  the JSON envelope shape is otherwise unchanged

Scenario: init does not launder an older plan past the gate
  Given a log.json already exists with no pipeline marker
  When  log init is run against it
  Then  it refuses exactly like a state-changing subcommand
   And  it does not stamp a marker onto the existing header
   And  the legacy task-injection path stays reachable only for logs that already carry the marker
```

**Rule C1.3: The instruction set stays followable**

```gherkin
Scenario: The changed skill passes comprehension review
  Given the rewritten pocket-development SKILL.md and its references
  When  a general-purpose subagent is asked what it understands and what is confusingly inconsistent
  Then  it describes the per-task loop, the round budget and the phase-level pass correctly
   And  it reports no mutually contradictory instructions
   And  in particular no contradiction between SKILL.md and references/two-stage-review.md
```

---

## Acceptance Criteria

```
Rule: In-loop deep audit
  ✓ Given a task whose implementer reports DONE with green tests, When the mechanical gate
    passes, Then a read-only auditor subagent is dispatched before any DONE marking
  ✓ Given an auditor Critical/Important finding, When the verdict is read, Then the task
    enters a fix round and is not marked DONE
  ✓ Given a Minor-only verdict, When the verdict is read, Then the task proceeds to DONE and
    the Minor is persisted for closing
  ✗ Given the main agent is tempted to judge the code itself, When audit is due, Then it must
    delegate — self-judgement is a role violation

Rule: Mechanical gate
  ✓ Given a red test command, When the mechanical gate runs, Then no auditor is dispatched and
    the round count is unchanged
  ✓ Given a [no-tdd] task, When the mechanical gate runs, Then the packet's validation command
    is used
  ✓ Given no command of any kind, When the mechanical gate runs, Then the auditor is dispatched
    directly

Rule: Round budget
  ✓ Given two consumed rounds and a remaining Critical/Important finding, When the second audit
    returns, Then the task is BLOCKED with category "audit-failed"
  ✓ Given a fix that introduces a new finding, When the audit returns, Then a round is consumed
  ✓ Given two consecutive auditor infrastructure failures, When detected, Then the task is
    BLOCKED with category "auditor-unavailable" and the round count is unchanged
  ✓ Given a round budget, When the phase is resumed in a new session, Then the count is read
    from the verdict artifact rather than reset

Rule: SHA pinning
  ✓ Given a sequential task passing audit at commit X, When it is marked DONE, Then --sha X is
    passed and reviewed_sha equals done_sha
  ✓ Given a parallel-group task, When it is merged cleanly, Then done_sha is its own merge
    commit and reviewed_sha is advanced to the same commit without a re-audit
  ✓ Given a parallel merge with manually resolved conflicts, When the merge lands, Then a
    re-audit against the merge commit is required
  ✓ Given an empty-diff task, When it is processed, Then it is marked DONE with
    --allow-duplicate-sha and a REVIEW_PASS stub with skip_reason "no_file_changes"
  ✗ Given an already-DONE task on resume, When the phase is re-entered, Then log update DONE is
    never re-issued for it

Rule: Verified refactor
  ✓ Given a diff crossing a refactor threshold, When the auditor judges it, Then a quality
    finding is emitted and a refactor round is entered
  ✓ Given a clean diff, When the auditor judges it, Then no refactor round is entered and no
    implementer claim is required
  ✗ Given a refactor that turns the tests red, When the round completes, Then it is failed, not
    accepted

Rule: Phase-level pass
  ✓ Given all tasks DONE, When the phase-level pass runs, Then it reports only findings that a
    per-task audit could not see
  ✓ Given zero findings, When the pass completes, Then a "no findings" record is written and
    the phase advances to REVIEW afterwards
  ✓ Given two consumed phase-level rounds with findings remaining, When evaluated, Then
    PHASE_BLOCKED is emitted and the phase does not advance to REVIEW

Rule: Corrections
  ✓ Given a phase-level fix, When it is recorded, Then done_sha for every task is unchanged and
    phase.corrections gains an entry
  ✓ Given a correction affecting several tasks, When the correction auditor passes, Then one
    auditor is dispatched and each affected task's reviewed_sha becomes its newest owned commit
    by commit time
  ✓ Given tasks outside affectedTasks, When the refresh runs, Then their artifacts are untouched
  ✗ Given a correction commit containing log.json, When audited, Then it is rejected and no
    correction entry is recorded
  ✗ Given an in-loop fix before done_sha exists, When it is committed, Then --correction is not
    invoked

Rule: Enterprise reporting
  ✓ Given enterprise=true and a confirmed create-pr offer, When phase-completion runs, Then the
    PR is created and verdicts are posted to it
  ✓ Given a declined offer, When the phase ends, Then verdicts stay on disk and create-pr is
    unmodified
  ✗ Given enterprise=false, ok=false, or a missing mode command, When phase-completion runs,
    Then no gh command is executed

Rule: Migration
  ✓ Given a log.json with an absent or lower pipeline marker, When a state-changing log command
    runs, Then it exits non-zero naming the detected version and the CLI-pinning recovery step
  ✓ Given log init on a fresh plan, When the log is created, Then the header records the current
    pipeline marker as an integer
  ✗ Given a refused plan, When the command exits, Then log.json is not modified in any way

Rule: Closing compatibility
  ✓ Given a phase completed through the new pipeline, When pocket-closing runs, Then it finds
    verdicts at the literal path <plan_dir>/reviews/<task_id>-review.json carrying task_id,
    overall, reviewed_sha, fix_instructions, loop_info, stage_2.issues[].severity and
    stage_2.strengths[], and closes successfully

Rule: Comprehension
  ✓ Given each phase's changed skills, When a general-purpose subagent reports its understanding,
    Then the loop, budget and phase pass are described correctly with no contradictory instructions
```

---

## Design Decision

**Chosen option:** Option A — Artifact-only, contract stays 2

**Summary:** All audit state (verdict, severity, round count, BLOCKED category) lives in `reviews/<task_id>-review.json` using the existing `review-report-template.md` schema, including `loop_info` as the durable round counter. `log.json` gains exactly one additive header field: an integer pipeline-version marker. `CONTRACT` stays at `2`; the package major bumps to `3.0.0` because the *behavior* is breaking (older plans are refused), not because the JSON shape changed non-additively.

**Rejected options:**

- **Option B — log.json as the master record (contract 3):** rejected because no scenario requires it. The only new state the scenarios demand is the round count (Rule A1.4), the BLOCKED category (Rule A1.4), and the pipeline marker (Rule C1.2). The first two already have a durable home in the verdict artifact schema; the third is additive. Bumping `CONTRACT` would additionally require new CLI writers, teaching `pocket-closing` a new shape, and rewriting the test fixtures — and a wrong contract-3 shape is not reversible once real plans are on disk.
- **Option C — hybrid summary fields in log.json:** rejected because it adds CLI writers for data that already exists elsewhere, creating two places that can silently diverge, in exchange for human readability that `reviews/` already provides.

**Key tradeoffs accepted:**

- `log.json` alone does not narrate audit history — reading `reviews/` is required. This is already true today for `pocket-closing`.
- Per-task subagent spawns increase (one auditor, up to two rounds). Accepted explicitly in discovery in exchange for fewer user-triggered manual stages.
- Refusing older plans strands anyone who upgrades mid-plan. Mitigated by release notes as the primary path and a fail-closed refusal naming a CLI pin as the recovery.

**Supporting decisions:**

- Auditor criteria reuse `pocket-review/references/spec-compliance-review.md` and `code-quality-review.md` verbatim — identical criteria, different timing.
- `pocket-development/references/two-stage-review.md` is rewritten as the audit-loop contract (severity ladder, round budget, BLOCKED categories, artifact schema). It currently contradicts `SKILL.md:568`; leaving it is not an option.
- Extraction targets to keep `SKILL.md` followable: E1–E6 → `references/enterprise-reporting.md`; the audit-loop contract → the rewritten `two-stage-review.md`; the phase-level pass and correction recording → `references/phase-level-pass.md`. `SKILL.md` keeps the state machine and the CLI call sites.
- The refusal gate lives in the **CLI**, not the skill layer: all 48 CLI call sites across `skills/` invoke `npx -y pocketto-pi` unpinned (only `pocket-structuring/SKILL.md:90` mentions `@2`), so a user who declines to update the plugin still receives the newest CLI. The CLI is the only reliable choke point.

---

## Open Questions / Assumptions

| Question | Resolution | Risk if Wrong |
|----------|------------|---------------|
| Does gating `init` against a marker-less log make `migrateExisting` (`cli/commands/log.js:171-211`) unreachable for the very logs it exists to rescue? | **Resolved, not assumed.** A task-less log with no marker *is* an old-pipeline plan, so refusing it is the intended behavior, not collateral damage. `migrateExisting` stays reachable for its real forward-going case: a marker-carrying log whose plan file gained tasks after `init` (`init` is idempotent and re-migrates). The legacy fixture at `test/cli.test.js:982-999` must therefore be **split**, not patched — one test asserting the marker-less legacy log is now refused, and the migration behavior re-tested against a marker-carrying task-less log. Patching a marker onto that fixture would test laundering, which Rule C1.2 forbids. | If the fixture is patched instead of split, the suite would green-light exactly the laundering path the gate exists to block |
| Does the phase-level pass run as a subagent? | Assumed: yes — consistent with the Iron Law that the main agent never judges code | Main agent self-judging at phase level reintroduces exactly the independence loss this spec preserves elsewhere |
| Where is the "no cross-task findings" record written? | Assumed: alongside the verdict artifacts under `reviews/`, in a form `pocket-closing` ignores | A record `pocket-closing` accidentally reads as a task verdict would block closing |
| Does `create-pr` need any change at all? | Assumed: none. It stays a recorder | If phase-completion cannot post without it, verdicts silently never reach the PR |

---

## Implementation Notes

- `test/cli.test.js` is the entire CI surface and only covers the CLI; skill changes are verified by comprehension review plus the user's `deep-review`, per phase.
- The parallel-group merge loop (`merge` then `log update`, one task per iteration) must stay byte-identical — it is what prevents `DUPLICATE_DONE_SHA` collapsing sibling tasks onto one `done_sha`.
- `--sha <audited_head>` passes the CLI's existing guards in the ordinary sequential case: `resolveCommit` accepts any resolvable commit and `isAncestorOfHead` (`cli/lib/git.js:115-125`) passes because the audited HEAD *is* HEAD. It must **not** be used for parallel-group tasks (see the `buildOwnerMap` corruption described under Story A2).
- Deprecated-skill mentions to update in Phase C: `llms.txt`, `README.md`, `skills/create-pr/SKILL.md`, `skills/pocket-closing/references/verdict-reconciliation.md`, and three `pocket-help` references. Documentation only — no behavior change to `pocket-help` or `create-pr`.
- Release notes must instruct users to close in-flight plans **before** updating; this is the primary migration path, with the refusal as a backstop.

---

## Rollback Plan

- The work lands as one PR on `feat/in-loop-build-cycle` — reverting the merge restores the previous pipeline wholesale.
- For a user already upgraded and stuck mid-plan: pin the CLI (`npx -y pocketto-pi@2.4.4`) and keep the plugin at its previous commit until the in-flight plan closes.
- No data migration is performed by this change, so there is nothing to un-migrate: the refusal path writes nothing, and the pipeline marker is additive and ignored by older readers.
