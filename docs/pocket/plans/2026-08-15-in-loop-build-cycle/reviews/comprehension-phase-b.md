# Comprehension Review — Phase B

**Task:** T10 "Comprehension review — Phase B"
**Method:** ONE general-purpose subagent dispatched with zero session context — given only the prompt below, with no mention of the plan, this task, or any design intent — asked to read the three artifacts and report its raw understanding.

**Prompt given to the reader subagent (verbatim):**

> Read `skills/pocket-development/SKILL.md`, `references/phase-level-pass.md`, and `references/enterprise-reporting.md`. What do you understand from these skills — describe what happens after every task in a phase is done, how a phase-level fix is recorded, and what happens in enterprise mode when no PR exists yet. Are there any inconsistencies that would confuse you about what to do?

---

## Reader subagent's answer (verbatim, unedited)

## What I read

- `skills/pocket-development/SKILL.md` — the main development skill
- `skills/pocket-development/references/phase-level-pass.md` — contract for the post-phase read-only pass and its corrections
- `skills/pocket-development/references/enterprise-reporting.md` — contract for posting phase verdicts to GitHub

I also spot-checked `skills/pocket-structuring/SKILL.md` because one line in `phase-level-pass.md` ("pocket-structuring may proceed to Phase N+1") pointed at a claim I needed to verify against its actual consumer.

## After every task in a phase is DONE

Fixed ordering, enforced in three places (`SKILL.md` § End-of-Execution Handoff, § Execution Log "Phase-completion ordering", and `phase-level-pass.md` § Ordering) — all three state it identically:

1. **Dispatch the phase-level pass** — a read-only subagent, once per phase, given every task's `prev_sha..done_sha` diff range plus its packet, in plan order. It looks only for what a per-task audit can't see: cross-task duplication, integration mismatches, cross-file regressions, spec-level gaps left uncovered by any single task's split. It must NOT re-litigate anything a per-task audit already judged.
2. **Record the result** at `<plan_dir>/reviews/phase-pass-<phase_key>.json` — even a zero-finding pass writes a record (`status: PHASE_PASS_CLEAN`), so a completed pass is distinguishable from one that never ran or died mid-flight. If findings exist, fix rounds run (see below) until `PHASE_PASS_RESOLVED` or the round cap trips.
3. **Only now** set phase status to `REVIEW` via `log update <plan_dir> <phase_file> REVIEW`. This is a hard gate: `REVIEW` must never be set before the pass record is terminal.
4. **Emit the PHASE_COMPLETE handoff**, then run enterprise reporting (`enterprise-reporting.md`), then — enterprise-only, same fail-closed guard — sync the live task checklist to the linked GitHub issue.
5. The handoff explicitly names the next step as **user-triggered**: `/pocketto:pocket-closing <plan_dir>/<phase_file>`. `pocket-development` states plainly it "never advances a phase beyond REVIEW" — closing to `DONE` is pocket-closing's job.

If the pass exceeds its 2-round cap with findings still outstanding, the phase goes to `PHASE_BLOCKED` instead — `REVIEW` is forbidden in that case.

## How a phase-level fix is recorded

Distinct from a per-task in-loop fix. Rules from `phase-level-pass.md`:

- `done_sha` on any task **never moves** because of a phase-level fix.
- Each fix is exactly one commit, source files only, never touching `log.json` (implementer stages by name, `git add <file>`, never `-A`/`.`). The main agent audits `git show --stat <sha>` before recording; if `log.json` appears, the commit is rejected outright.
- Recorded via `npx pocketto-pi log update <plan_dir> <phase_file> --correction <sha> --for-task <task_id> --json --contract 2`. The CLI computes `affectedTasks` = `{for_task} ∪ {owner[f] for f in changed files}` — the main agent doesn't compute file-ownership "bleed" itself.
- Round budget mirrors task-level: 2 rounds. Round 1 = pass, fix, re-run; round 2 repeats if findings remain; a third failure trips `PHASE_BLOCKED` with `blocked_category: "phase-audit-failed"`.
- **Verdict fan-out**: one auditor per correction commit, its verdict overwrites `reviews/<T>-review.json` for every `T` in `affectedTasks`. Each `reviewed_sha(T)` is set to the max-by-commit-time of `{T.done_sha} ∪ {correction shas attributed to T}` — proven algebraically identical to `pocket-closing`'s `latest_owned_sha(T)`, so the freshness gate at closing never desyncs.
- A fix made **before** a task has a `done_sha` (i.e., during its own in-loop round) is a plain commit — `--correction` must not be used for it.

## Enterprise mode, no PR yet

`enterprise-reporting.md` E1, entered only after the fail-closed preflight (`pocketto-pi mode` must return `data.enterprise === true`, otherwise the whole file is skipped as if it didn't exist):

1. Try `.pocket-meta.json` (`phases.<phase_key>.github_pr.number`) → if null/not-found, fall back to `gh pr list --head <branch>`.
2. If still no PR: **offer, don't auto-create** — exactly one confirmation prompt: `Run /pocketto:create-pr <plan_dir> [<phase_file>] to open one and post verdicts?`
   - **Confirm** → invoke `create-pr` (a pure recorder — commits, opens PR, writes `phases.<phase_key>.github_pr.number/.url` to meta; it does *not* post verdicts). Re-read the PR number, then continue into E2 onward — verdicts get posted in the same pass, right after creation.
   - **Decline**, or non-interactive with nobody to answer → treated identically: STOP the entire enterprise-reporting section, zero `gh` calls, zero orphan comments. Verdicts stay on disk in the per-task artifacts, unposted. Phase-completion otherwise proceeds as if this file hadn't run.
3. This is explicitly idempotent: a later re-run (once a PR exists) posts the same verdicts without duplicating the marker comment (E4) or inline threads (E5), since both are keyed by content/fingerprint, not by run.

## Inconsistencies that would confuse me

1. **Two different phase-completion report templates inside the same skill.** § End-of-Execution Handoff emits a generic `PHASE_COMPLETE: All tasks marked DONE...` block whose "next step" is `/pocketto:pocket-closing`. Separately, § Phase Completion Protocol (Type B only) emits its own `PHASE_COMPLETE: Phase N of M ... Gate: PASS → pocket-structuring may proceed to Phase N+1` block. The dot-graph in § The Process implies both fire in sequence for Type B ("Emit PHASE_COMPLETE handoff" → "Phase file?" → "Evaluate Phase Completion Gate"), but the prose never says so explicitly, and it's not obvious whether emitting *two* PHASE_COMPLETE reports back-to-back — one naming pocket-closing, one naming pocket-structuring, as the "next step" — is intended, or whether these are stale duplicates of each other.

2. **That ambiguity resolves into a real cross-skill contradiction.** I checked `pocket-structuring/SKILL.md` § Step 3 / Phase Completion Gate: it gates the handoff to Phase N+1 on "every task DONE, tests pass, commits correct format, no BLOCKED/NEEDS_CONTEXT" — it says nothing about the phase-level pass, nothing about `REVIEW` status, and nothing about pocket-closing. Taken literally, pocket-structuring would invoke pocket-development on `execution-plan-phase-2.md` as soon as it sees Phase 1's tasks done, *before* the user ever runs pocket-closing on Phase 1 — directly contradicting pocket-development's stated invariant "pocket-closing owns everything after REVIEW; this skill never advances a phase beyond REVIEW." This reads like `pocket-structuring.md` predates the REVIEW-gate/phase-pass/pocket-closing design added by the recent commits and hasn't been updated to check for `REVIEW` (or wait for pocket-closing) before firing the next phase.

3. **Minor terminology looseness:** `phase-level-pass.md` and the Phase Completion Protocol both say the pass triggers "after all tasks reach DONE/DONE_WITH_CONCERNS," but per SKILL.md's own Execution Log section, a task's persisted `log.json` status is only ever `WAITING → DONE | BLOCKED` — `DONE_WITH_CONCERNS` is a transient subagent return status that must resolve to `DONE` (via the in-loop audit) before it's ever written to the log. Harmless in practice, but the phrasing momentarily suggests `DONE_WITH_CONCERNS` is a state the phase-level pass might see persisted, which it never is.

No modifications were made to any files.

---

## Verdict (written by the reviewing task, T10)

The reader subagent, given zero prior context about this plan or design intent, correctly reconstructed the phase-completion ordering (pass → record → REVIEW → report), the phase-level correction/fan-out mechanics, and the enterprise no-PR offer/decline path from the three cited artifacts alone — and, on its own initiative, cross-checked a claim in `phase-level-pass.md` against `pocket-structuring/SKILL.md`, which is what surfaced the one blocking finding below.

Three inconsistencies were reported. Each is classified below:

1. **Two PHASE_COMPLETE report templates in the same skill (generic handoff vs. Type-B Phase Completion Protocol)** — **non-blocking**. This is a documentation-clarity gap (whether both reports fire, and in what relationship) but not a contradiction that would cause wrong action — either reading still ends at "user runs pocket-closing next," since finding 2 below is what actually determines whether pocket-structuring may act on the Type-B report unattended.

2. **`pocket-structuring/SKILL.md` § Step 3 / Phase Completion Gate contradicts pocket-development's REVIEW-gate invariant — CONFIRMED, blocking.** Verified directly: `skills/pocket-structuring/SKILL.md:108-125` states pocket-structuring "wait[s] for explicit DONE confirmation," then gates Phase N+1 handoff on "every task DONE, tests pass, commits correct format, no BLOCKED/NEEDS_CONTEXT" — with **no mention of `REVIEW` status, the phase-level pass, or `pocket-closing`**. Under this plan's new design (T7–T9), pocket-development stops a phase at `REVIEW` and never advances it further; only the user-triggered `pocket-closing` moves `REVIEW → DONE`. If pocket-structuring is followed literally as written, it would treat pocket-development's `PHASE_COMPLETE` handoff (phase status `REVIEW`, not `DONE`) as satisfying its own gate and immediately invoke pocket-development on the next phase file — skipping the phase-level pass's fix window and the user's `pocket-closing` checkpoint entirely. This is a genuine, verified contradiction between two skills that are meant to compose, not a resolvable ambiguity.
   **No task in this plan (T1–T14) modifies `pocket-structuring/SKILL.md`** — grepped the plan and spec directories; the only hit is an unrelated CLI-pinning footnote in the spec. This gap has no owning task.

3. **`DONE_WITH_CONCERNS` phrasing in phase-level-pass.md / Phase Completion Protocol implying a persisted state** — **non-blocking**. Confirmed against SKILL.md's Execution Log section: task status is only ever persisted as `WAITING → DONE | BLOCKED`; `DONE_WITH_CONCERNS` is transient and always resolves before being written to `log.json`. Wording looseness only, does not change what any reader would actually do.

**One blocking inconsistency was found (item 2).**

## Report: BLOCKED

**What's blocked:** T10 comprehension review cannot certify Phase B as internally consistent — `pocket-structuring/SKILL.md`'s Phase Completion Gate (lines 108-125) omits the `REVIEW`-status / phase-level-pass / pocket-closing dependency that T9 just wired into pocket-development, and would let pocket-structuring auto-advance to the next phase file before the user runs `pocket-closing`.

**Why:** `pocket-structuring/SKILL.md` predates this plan's REVIEW-gate design (T7-T9) and was never updated to check for it. This is a scope gap, not a mistake inside any completed task — no task in the plan (T1-T14) lists `pocket-structuring/SKILL.md` as in-scope.

**What would unblock it:** Add a task (or amend T9/T12's scope) to update `pocket-structuring/SKILL.md` § Step 3 / Phase Completion Gate so it requires phase status `REVIEW` (not just "tasks DONE") and explicitly waits for user-triggered `pocket-closing` before invoking pocket-development on the next phase file. This is a plan-scope decision — escalating to the user/main agent rather than fixing it here, per this task's Must-not-have (`this task must NOT fix it`).

**Result: BLOCKED.**
