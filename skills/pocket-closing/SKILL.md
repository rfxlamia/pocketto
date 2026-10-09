---
name: pocket-closing
description: Close a reviewed Pocket phase or plan when the user explicitly requests closeout, including as part of an end-to-end request. Reconcile verdicts with log.json, advance only a passing phase, append a readable per-phase closeout, and finalize the plan when all phases are done. A passing verdict alone does not authorize closure.
---

# Pocket Closing

The closing stage of the Pocket pipeline. Use it when the user asks to close a reviewed phase or plan; an explicit end-to-end request that includes closeout also authorizes this stage. Reconcile verdicts against the execution log, advance only a passing phase, and append a readable record of that phase. A passing verdict alone is not authorization to close.

**Core principle:** Current verdicts decide. pocket-closing never re-reviews or overrides them; it reconciles the task verdict artifacts with `log.json`, advances only a passing phase, and records what the sources support. No current clean verdict, no phase advance.

## Core v4 lifecycle boundary

`pocket-closing` is a Core workflow. Core keeps plan closure local-first: `log update` and `log close` commit lifecycle state and neutral events with CLI `CONTRACT=3` and lifecycle schema `1`. Core does not call `gh`, does not merge pull requests, and does not close issues. An optional, compatible Enterprise adapter may later reconcile the `plan-closed` event. Closing locally succeeds without Enterprise, and pending events remain available for replay.

If a projection write needs recovery, run `pocketto-pi lifecycle repair <spec_dir> --json --contract 3` before `pocketto-pi lifecycle drain <spec_dir> --json --contract 3`. Repair preserves task progress and fails closed when task state is unrecoverable; drain replays pending events in order without creating events. Active v3 plans with progress stay on v3 and are never silently converted.

## Position in Pocket Bundle

```text
pocket-grinding → pocket-planning → pocket-structuring → pocket-development → POCKET-CLOSING
                                                                                    ↑
                                                                  After the user authorizes closeout
                                                                  and pocket-development's phase-level pass
                                                                  reaches REVIEW on all tasks passing
```

The user must explicitly authorize closeout, either by invoking this skill or by asking for end-to-end completion that includes closing. After a terminal phase-level pass, Core's lifecycle-aware transition moves the phase to `REVIEW`, commits the neutral `phase-complete` event, and updates the `log.json` projection. This skill reconciles that log and its verdict files, advances a passing phase, appends its phase report, and invokes `log close`. The local `plan-closed` event is committed before the projection update; no Enterprise adapter is required for the close and this skill performs no GitHub operation.

## Invocation

```text
/pocketto:pocket-closing <path-to-execution-plan-or-plan-dir>
```

Examples:
```text
/pocketto:pocket-closing docs/pocket/plans/2026-06-03-typing-dna/
/pocketto:pocket-closing docs/pocket/plans/2026-05-28-auth/execution-plan/phase-2.md
```

## Main Agent Role

Main agent = **Reconciler + Closer only**. Does NOT review code.

| Main agent MUST | Main agent MUST NOT |
|-----------------|---------------------|
| Read log.json and verdict artifacts for phases being closed or recovered | Read implementation files or assess code |
| Read the matching `reviews/phase-notes-<phase_key>.json` when available for narrative context | Read or interpret `reviews/phase-pass-<phase_key>.json` as a verdict source |
| Reconcile each reviewable task to its verdict | Re-run, re-interpret, or override a review verdict |
| Gate close on REVIEW_FAIL / REVIEW_BLOCKED | Close a plan with any failing or missing verdict |
| Advance phases via `pocketto-pi log` CLI | Hand-edit log.json (CLI is the only writer) |
| Run `log close` and write closeout.md | Mark a task DONE or re-touch any `done_sha` |
| Emit a structured CLOSED / PHASE_ADVANCED / NEXT_PHASE_READY / CLOSE_BLOCKED report | Silently block — every block names what, why, unblock |

## Preflight

Run all steps before changing state. If a preflight check fails, leave state unchanged, diagnose what failed, and report the concrete recovery route. `CLOSE_BLOCKED` is a close-gate result; it does not automatically mean the user must intervene.

### Step 1: Resolve plan_dir and the next REVIEW target

Canonical phase identity (always from `log.json`, never from a legacy filename):

```text
phase_file = phase.file
phase_key  = phase-${phase.order}
```

Resolve the target phase:

```text
If invoked with a file path:
  if parent dir is 'execution-plan', plan_dir = grandparent dir; else plan_dir = parent dir
  Read log.json
  Resolve the file to the unique log.phases[] entry (exact phase.file, else basename)
  If phase.status == REVIEW, target = that phase
  If phase.status == DONE and its closeout section is missing, target it for closeout recovery only; do not change phase state
  If phase.status == DONE and its closeout section exists, report that it is already recorded; do not change phase state
  If phase.status is WAITING or BLOCKED, report the current status and next valid action; do not change phase state

If invoked with a dir path:
  if dir ends with 'execution-plan', plan_dir = parent dir; else plan_dir = dir
  Read log.json
  targets = phases where status == REVIEW
  0 matches  → schedule reconciliation for missing closeout sections of phases already DONE; after preflight, if a phase is next to execute, report it and return NEXT_PHASE_READY (no phase advanced); if all phases are DONE but the header is IN_PROGRESS, run `log close` and append the final plan section on success; if the header is DONE, repair missing closeout sections and return ALREADY_CLOSED; otherwise report the missing phase-pass or human dependency.
  >1 matches → sort by phase.order and target the lowest-order REVIEW phase; leave later phases for their turn
  1 match    → target = that phase
```

Directory input therefore advances only the current REVIEW phase. For a normal
multi-phase plan (Phase 1 `REVIEW`, Phase 2 `WAITING`), `/pocketto:pocket-closing <plan_dir>`
targets Phase 1, yields `PHASE_ADVANCED`, and leaves Phase 2 untouched.
If multiple phases are already `REVIEW`, close them in ascending phase order when the user's authorization covers the full plan; never skip an earlier phase.
Before reconciling the current target, validate the verdict freshness for each phase already `DONE`, then append any missing sections from its recorded sources. This repairs an interrupted closeout write without repeating a state transition.

### Step 2: Read log.json

```text
<plan_dir>/log.json
```

Verify:
- File exists → else `CLOSE_BLOCKED: "log.json not found at <path>. Run pocket-development first."`
- `header` present with `status` and `phases[]` → else `CLOSE_BLOCKED: "log.json malformed: <field> missing"`
- If header `status` is `DONE`, do not repeat state transitions. Reconcile current verdicts for completed phases, repair missing phase sections and the final plan summary from recorded artifacts, then report `ALREADY_CLOSED`.
- Otherwise require a valid in-progress plan; leave state unchanged for any unsupported header status.

### Recovery when no phase is in REVIEW

When Step 1 found no `REVIEW` target, do not treat the absent target as a verdict failure. Reconcile the current verdicts for phases already `DONE` and append any missing phase sections in ascending phase order. Then:

- If the header is already `DONE`, append a missing final plan section and report `ALREADY_CLOSED`.
- If the header is `IN_PROGRESS` and every phase is `DONE`, run `log close`; append the final plan section only after it succeeds, then report `CLOSED`.
- If the header is `IN_PROGRESS` and the next phase is `WAITING`, report it and return `NEXT_PHASE_READY`; no phase changed state. Continue into pocket-development when the user's authorization covers the plan.
- If the next phase is `BLOCKED`, report the recorded human dependency and its unblock action.

Never repeat a phase transition during this recovery path.

### Step 3: Load review verdicts and reconcile

For a normal `REVIEW` target—or a specific `DONE` phase whose section needs recovery—load its task verdicts and apply the reconciliation contract below. A `DONE` recovery target only repairs `closeout.md`; it must not advance phase state again.

```bash
ls <plan_dir>/reviews/
```

Read every `reviews/<task_id>-review.json`. For each reviewable task in each target phase (the same task set the phase-level pass computed — `status == DONE` with a non-null `done_sha`):

| Condition | Reconciliation |
|-----------|----------------|
| `DONE` + `done_sha` + review file **current for that `done_sha`** | Reviewable — record its `overall` verdict |
| `DONE` + `done_sha` + review file **stale** (predates the current `done_sha`) | `CLOSE_BLOCKED` — "T{id} verdict is stale: reviewed before the current done_sha. Re-run pocket-development's phase-level pass." |
| `DONE` + `done_sha` but NO review file | `CLOSE_BLOCKED` — "T{id} has no verdict. Run pocket-development's phase-level pass before closing." |
| Task is not `DONE` / missing `done_sha` | Inconsistent with a phase ready for closure — block this phase and route back to pocket-development; do not skip it |
| `reviews/` dir absent or empty | `CLOSE_BLOCKED` — "No reviews found. Run pocket-development's phase-level pass first." |

**Freshness check (mandatory).** A review proves a verdict only for the SHA it actually reviewed. If a task was corrected after review, the old verdict lingers — closing on it would accept code that was never reviewed at the current boundary. For each reviewable task `T`, compute:

```
latest_owned_sha(T) = max-by-commit-time of:
    { T.done_sha }
    ∪ { c.sha : c ∈ phase.corrections and T ∈ tasks(c) }

where tasks(c) = ({ c.for_task } if present) ∪ { owner[f] : f ∈ c.files and owner[f] is defined }
      owner[f]  = the task whose original done-range (prev..done_sha, in plan order) last touched f
```

This is **the identical attribution set the phase-level pass uses** (Task 4), so `reviewed_sha(T)` written by the phase-level pass equals `latest_owned_sha(T)` by construction. The set MUST include corrections where `c.for_task == T` even when no file `c` touches is owned by `T`; using owner-only attribution here would make a `for_task` correction invisible to closing and produce a permanent `CLOSE_BLOCKED` for that task.

The verdict is current iff `reviews/<T>-review.json`.`reviewed_sha == latest_owned_sha(T)` (exact SHA match). If any correction attributed to `T` is newer than its review — meaning `reviewed_sha` lags behind `latest_owned_sha(T)` — the verdict is stale → `CLOSE_BLOCKED: "T{id} verdict is stale: a correction changed its files after review. Re-run pocket-development's phase-level pass."`.

**Fallback (legacy reviews only).** If `reviewed_sha` is absent from the review file (older reviews predating this template change), fall back to the timestamp proxy: run `git show -s --format=%cI <latest_owned_sha(T)>` and require the review `timestamp` to be at or after that commit time. This path is a compatibility shim — any review produced after Task 4 lands will carry `reviewed_sha` and use the exact-match path above.

Reconciliation details, REVIEW_BLOCKED stub handling, and observation extraction: load `references/verdict-reconciliation.md`.

## Gate on Verdicts

A phase may advance only when every task is `DONE`, has a `done_sha`, and has a current `REVIEW_PASS`. A valid no-change `REVIEW_PASS` stub counts as a current verdict.

| Any task verdict | Action |
|------------------|--------|
| `REVIEW_FAIL` | `CLOSE_BLOCKED`. Print each failing task's `fix_instructions` verbatim. Fix → re-run pocket-development's phase-level pass → re-run pocket-closing. |
| `REVIEW_BLOCKED` with `blocked_category: "auditor-unavailable"` | `CLOSE_BLOCKED`. Report the exact human capability or access needed from the artifact, then resume pocket-development after it is available. Do NOT print unrelated `ESCALATE:` instructions. |
| `REVIEW_BLOCKED` with `blocked_category: "audit-failed"` or `fix_instructions` starting with `ESCALATE:` | `CLOSE_BLOCKED`. Print the escalation `fix_instructions`. Resolve the escalation before closing. |
| `REVIEW_BLOCKED` with no `blocked_category` and no `ESCALATE:` prefix | `CLOSE_BLOCKED`. Stale/incomplete stub — re-run pocket-development's phase-level pass; do not close. |
| all `REVIEW_PASS` | Phase passes the gate — proceed to Advance State. |

### Recover a failed close gate

`CLOSE_BLOCKED` describes the result of this gate; it does not mean recovery must stop. Diagnose the artifact and follow the route it supports:

- A failing or stale verdict → resume `pocket-development` for the named task or phase, then run this skill again after the current verdict is refreshed.
- An incomplete target phase → resume its unfinished task in `pocket-development`.
- A recoverable lifecycle projection error → use `lifecycle repair`, then `lifecycle drain`, as described above; never edit `log.json` manually.
- An ambiguous phase target or a genuine missing decision, access, information, or authorization → ask only for that specific human input.

When the user authorized end-to-end completion, continue through the available recovery route and return to closing after the required verdicts are current. Otherwise report the exact next command or human dependency. Never re-review code in this skill.

The **current** per-task verdict decides the gate — an old `REVIEW_FAIL` superseded by a newer `REVIEW_PASS` (advanced `reviewed_sha`, `overall == REVIEW_PASS`) passes cleanly. The gate reads the current `reviews/<T>-review.json`, not any historical state.

Non-blocking observations (`stage_2` Minor issues, strengths, out-of-scope notes on PASSing tasks) do NOT block. Collect them — they go into the closeout summary as "carried forward."

## Advance State

If the target is still `REVIEW`, advance it to `DONE` at the phase level only (`<phase_file>` = `target.file` from `log.json`):

```bash
npx -y pocketto-pi log update <plan_dir> <phase_file> DONE --json --contract 3
```

[CRITICAL] Phase-level update only. NEVER pass `--task` here — task `DONE` recomputes `done_sha` from current HEAD and would corrupt the review's SHA range. Tasks were already marked DONE by pocket-development; leave them untouched. Correction commits are recorded by pocket-development's phase-level pass (via `pocketto-pi log update --correction`), never by closing — this rule is unaffected by the correction cycle.

Parse the envelope, confirm `ok: true` and `data.newStatus == "DONE"` before continuing.

If the target is already `DONE` and was selected for closeout recovery, do not run `log update`; continue directly to the missing closeout append after its verdicts pass reconciliation.

Append the target phase's human-readable section to `<plan_dir>/closeout.md` after the transition succeeds. Keep the file append-only: one section per canonical marker `<!-- pocket-closeout:phase-${order} -->`. Before appending, check for that exact marker; do not use heading substring matching, which can confuse Phase 1 with Phase 10. If the marker already exists, do not duplicate or rewrite the section. If a prior run advanced the phase but stopped before appending, append the missing section from the same durable log and verdict artifacts, then resume.

## Close

Attempt the close once the target phase is `DONE`:

```bash
npx -y pocketto-pi log close <plan_dir> --json --contract 3
```

`log close` verifies **every** phase in the plan is `DONE`. Read the envelope:

| Result | Meaning | pocket-closing output |
|--------|---------|----------------------|
| `ok: true`, `data.status == "DONE"` | All phases DONE → header set to `DONE` + `date_completed` | Append final plan section to closeout.md; report `CLOSED` |
| `ok: false`, code `PHASES_NOT_DONE` | Other phases still `WAITING`/`REVIEW` (multi-phase plan not finished) | `PHASE_ADVANCED` — the target is DONE; name the next phase to run. Do NOT treat the non-zero exit as an error. |

`PHASE_ADVANCED` is the normal mid-pipeline state for phased plans: the phase is DONE and its closeout section is appended, while the plan continues. In the user-facing report, state what was completed, current verdicts, recorded obstacles and resolutions, explicit decisions, evidence-based suggestions, and the next phase's status. If the next phase is `REVIEW` and authorization covers the plan, continue closing phases in order; if it is `WAITING`, continue with pocket-development under that same authorization. Say when an item was not recorded. Do not ask the user to repeat the closing request when the existing authorization covers the plan.

`log close` atomically records the neutral `plan-closed` lifecycle event with the final plan state and artifact references. This local closeout does not wait for a lifecycle consumer.

## Closeout Summary

After every phase successfully advances to `DONE`, append that phase's section to `<plan_dir>/closeout.md` using `references/closeout-summary-template.md`. When `log close` succeeds, append the final plan-completion section. The file is a human-readable, append-only journal; never replace earlier phase sections.

Build the report from `log.json` and current task verdicts for lifecycle and review facts, plus the matching `reviews/phase-notes-<phase_key>.json` for phase narrative when available. The phase note is a presentation handoff only: it cannot establish or change a verdict, freshness result, or gate. If it is missing, use the phase-completion handoff in the conversation and explicit user context; do not block closure solely because the note is missing. Mark unavailable history as `Not recorded in the available phase notes`.

Do not read implementation code or `reviews/phase-pass-<phase_key>.json`, and do not invent unrecorded history. Separate recorded facts from suggestions. Suggestions may synthesize non-blocking reviewer observations, but label them as recommendations and identify their evidence. Read `references/closeout-summary-template.md` for the source rules and append-only format.

Then emit the terminal report:

```text
PLAN CLOSED — <plan_dir>
──────────────────────────────────────────
Phases : N — all DONE
Tasks  : M reviewed — all REVIEW_PASS
Closed : <date_completed>
Carried forward: K non-blocking observations (see closeout.md)
──────────────────────────────────────────
Closeout: <plan_dir>/closeout.md
```

## Output States

| State | Meaning |
|-------|---------|
| `CLOSED` | All phases DONE, header `DONE` + `date_completed`, phase sections and final closeout section written |
| `PHASE_ADVANCED` | A target phase was transitioned to DONE and recorded; other phases remain — plan continues |
| `NEXT_PHASE_READY` | No phase was advanced; the next phase is WAITING and ready for pocket-development |
| `CLOSE_BLOCKED` | Preflight failed, a verdict is missing, or a task is REVIEW_FAIL/REVIEW_BLOCKED |
| `ALREADY_CLOSED` | Header already `DONE`; missing closeout sections, if any, were restored from recorded sources |

## Closeout Invariants

```text
1. Never advance a phase unless every task is DONE and has a current REVIEW_PASS.

2. Never accept a missing or stale verdict; its reviewed SHA must match the current boundary.

3. Never re-review code or override an independent verdict.

4. Use `pocketto-pi log` for state transitions; never edit `log.json` by hand.

5. For every `CLOSE_BLOCKED`, state what failed, why, and the next recovery action. Ask the user only for an unavailable decision, access, information, or authorization.
```

`closeout.md` is a readable journal with one appended section for each completed phase and a final plan section only after `log close` succeeds. See `references/closeout-summary-template.md` for the format.

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/verdict-reconciliation.md` | Mapping tasks↔verdicts, freshness, REVIEW_BLOCKED recovery, carried-forward observations |
| `references/closeout-summary-template.md` | Appending readable per-phase closeout sections and the final plan-completion record |
