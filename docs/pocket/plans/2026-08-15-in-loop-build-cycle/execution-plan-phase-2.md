# In-Loop Build Cycle — Comprehension review — Phase A (Phase 2 of 4)

**Date:** 2026-08-15
**Original plan:** docs/pocket/plans/2026-08-15-in-loop-build-cycle/execution-plan.md
**Prerequisite:** Phase 1 must be COMPLETE — all tests green, all commits created
**Contains tasks:** {T6, T7, T8}
**Unlocks next:** Phase 3

---

## Task List

Total: 3 tasks | Prerequisite phases must be complete before starting

T6: Comprehension review — Phase A [depends: T2, T4, T5]
T7: references/phase-level-pass.md — the phase pass and its corrections [depends: T6]
T8: references/enterprise-reporting.md — E1–E6 relocated [depends: T6] [parallel: T7]

---

## Pocket Packets

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

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to Phase 3 ONLY after this gate passes.
