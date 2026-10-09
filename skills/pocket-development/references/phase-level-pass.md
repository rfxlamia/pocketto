[CRITICAL: This file is the single source of truth for the phase-level pass and its corrections. Downstream tasks SHALL cite it and SHALL NOT restate its rules. `done_sha` NEVER moves — every phase-level fix is recorded as an append-only correction. `--correction` is phase-level-pass-only; a fix made before a task has a `done_sha` is a plain commit, never a correction.]

# Phase-Level Pass Contract

Normative contract for the phase-level pass inside `pocket-development`: what it looks for, how its fixes are recorded as append-only corrections, and how affected tasks' verdicts are refreshed afterwards. The initial pass starts after every task in the phase is `DONE`; it sits between per-task audits (`references/two-stage-review.md`) and the phase advancing to `REVIEW`. Findings may require corrections and another pass before the phase can advance.

## Contents
- [Trigger and scope](#trigger-and-scope)
- [Dispatch](#dispatch)
- [Empty result: the "no findings" record](#empty-result-the-no-findings-record)
- [Ordering: REVIEW only after the pass records a result](#ordering-review-only-after-the-pass-records-a-result)
- [Review cycles and recovery](#review-cycles-and-recovery)
- [Correction recording](#correction-recording)
- [In-loop fixes are not corrections](#in-loop-fixes-are-not-corrections)
- [Verdict refresh (fan-out)](#verdict-refresh-fan-out)
- [Resume](#resume)

## Trigger and scope

The initial phase-level pass SHALL start when every task in the phase has reached `DONE` (per-task `done_sha` pinned, per-task verdict artifact written — see `two-stage-review.md`). It SHALL NOT run per-task or before the last task in the phase is `DONE`. Re-run it after corrections until it records a clean or resolved result.

The pass SHALL look only for what a per-task audit cannot see, because a per-task audit judges one task's diff in isolation:

- cross-task duplication (two tasks independently building the same thing)
- integration mismatch (task boundaries that don't actually compose)
- cross-file regression (a later task's change silently breaking an earlier task's file)
- spec-level gaps (a scenario or rule the plan's task split left uncovered by any single task)
- architecture assumptions or external API behavior that do not match the repository or the exact dependency version used

The pass SHALL NOT re-litigate anything a per-task audit already judged (QUALITY BAR, spec compliance, code quality, or refactor heuristics scoped to one task's own diff — see `two-stage-review.md`). Re-raising a single-task finding at phase level is out of scope for this pass.

### Single-task phase fast path

Every item in the scope above is defined *across* tasks. In a phase containing exactly one task there is no second task to duplicate, mismatch, or regress against, so that domain is structurally empty and dispatching a reviewer buys nothing.

The main agent SHALL take the fast path when **all** hold:

1. The phase contains exactly one task.
2. That task is `DONE` and its verdict artifact's `overall` is `REVIEW_PASS`.
3. That artifact's `reviewed_sha` equals the task's `done_sha` in `log.json` — an exact SHA match, never a timestamp or recency comparison. A stale or placeholder timestamp SHALL NOT be accepted as evidence of freshness.
4. No explicit phase-level risk is recorded for the phase (for example a correction already appended to `phase.corrections`, or a `[test-risk]`-style phase note).

Any condition failing → dispatch the pass normally.

On the fast path the main agent SHALL write the terminal artifact itself, without spawning a reviewer, to `reviews/phase-pass-<phase_key>.json`:

```json
{
  "phase_key": "<phase_key>",
  "phase_file": "<phase_file>",
  "timestamp": "<UTC ISO 8601 now>",
  "reviewer_mode": "main-agent",
  "findings": [],
  "loop_info": { "current_cycle": 1, "max_cycles": 1, "cycles_remaining": 0 },
  "skip_reason": "single_task_phase",
  "status": "PHASE_PASS_CLEAN"
}
```

`reviewer_mode` is `main-agent`, not `read-only`, because no reviewer subagent ran — the same attribution rule the empty-diff skip stub follows in `two-stage-review.md` § SHA pinning. `max_cycles` is `1`: a skip has no fix rounds to spend. Everything downstream is unchanged — the phase advances to `REVIEW` on this terminal result exactly as it would on a dispatched clean pass, and no per-task verdict artifact is touched.

## Dispatch

The phase-level pass SHALL be dispatched as a read-only subagent. The main agent SHALL NOT perform the pass itself — it does not read implementation files to judge cross-task coherence, exactly as it does not judge single-task code (see `two-stage-review.md` § Auditor identity).

The dispatch input is the full phase: every task's diff range (`prev_sha..done_sha` per task, in plan order) and every task's packet (QUALITY BAR, DELIVERABLE). The main agent SHALL compute and pass these ranges; it SHALL NOT form its own opinion about what they contain.

## Empty result: the "no findings" record

A phase-level pass that finds nothing SHALL still write a record to disk, so a completed pass is distinguishable from a pass that never ran or died mid-flight (see [Resume](#resume)).

This record SHALL live at:

```
<plan_dir>/reviews/phase-pass-<phase_key>.json
```

`<phase_key>` is canonical from `log.json`: resolve the phase entry, then `phase_file = phase.file` and `phase_key = phase-${phase.order}`. Do not derive identity from a legacy filename.

This path is chosen deliberately to satisfy two constraints at once:

1. It lives under `reviews/` so it is discoverable alongside the per-task verdicts, per the design decision that phase-level state stays artifact-only (no new `log.json` fields beyond the pipeline-version marker).
2. Its filename can never collide with `<task_id>-review.json`, because task ids are always `T<N>` and never `phase-pass-<phase_key>`. `pocket-closing` reads `reviews/<task_id>-review.json` for each task id from `log.json`; it does not treat this record as a task verdict. `pocket-closing` MUST NOT read or interpret this phase-pass artifact as a verdict. It may read the separate `phase-notes-<phase_key>.json` artifact for narrative closeout only; that note never participates in the verdict gate.

Record shape (clean pass, zero findings):

```json
{
  "phase_key": "<phase_key>",
  "phase_file": "<phase_file>",
  "timestamp": "<UTC ISO 8601 now>",
  "reviewer_mode": "read-only",
  "findings": [],
  "loop_info": { "current_cycle": 1, "max_cycles": 2, "cycles_remaining": 2 },
  "status": "PHASE_PASS_CLEAN"
}
```

A pass with findings (before or between recovery cycles) uses the same shape with `findings` populated and `status` reflecting the current work (see [Review cycles and recovery](#review-cycles-and-recovery)). The main agent SHALL create `reviews/` before the first write if it does not already exist. Re-dispatch of the pass overwrites this same path — it is the durable recovery record for the phase-level pass, exactly as `loop_info` inside a task's own verdict artifact is the durable audit record for that task.

Optional recovery fields on the same record: `recovery_attempt_consumed` (boolean, retained as a compatibility/history marker) and `recovery_stage` (`implementer` | `correction` | `refresh` | `confirm`). Persist the stage before each recovery step so resume continues that step. The marker records prior recovery; it is not a retry limit. When the two-round cap is reached with findings unresolved, persist `status: "RECOVERY_CHECKPOINT"`, the findings, `loop_info` at zero remaining, and the two strategies tried. Do not write a terminal pass status or advance the phase to `REVIEW`.

No per-task verdict artifact is modified by a clean pass. Only `reviews/phase-pass-<phase_key>.json` is written.

## Ordering: REVIEW only after the pass records a result

The main agent SHALL NOT set phase status to `REVIEW` until the phase-level pass has recorded its result (clean or resolved-with-corrections) at `reviews/phase-pass-<phase_key>.json`.

Sequence:

```
1. Last task in phase reaches DONE.
2. Phase-level pass is dispatched.
3. Pass records its result to reviews/phase-pass-<phase_key>.json
   (clean → status PHASE_PASS_CLEAN, or resolved → status PHASE_PASS_RESOLVED
    after any fix rounds and their corrections/fan-out complete).
4. Only after step 3 completes: `log update <plan_dir> <phase_file>` (no --task) → REVIEW.
```

This ordering is what makes a mid-flight death detectable: if `reviews/phase-pass-<phase_key>.json` is absent or does not carry a terminal `status`, and the phase's `log.json` status is not yet `REVIEW`, the pass did not finish and SHALL be re-dispatched (or resumed — see [Resume](#resume)). The phase status transition is the last action of this contract, not an early one; nothing about the pass writes `REVIEW` before its record is terminal.

The phase SHALL NOT advance to `REVIEW` while findings remain. The two-round recovery cap is a mandatory user checkpoint, not `PHASE_BLOCKED`.

## Review cycles and recovery

`max_cycles: 2` is a hard cap of two correction rounds after the initial phase pass. Each round must use a materially different strategy and consumes one `cycles_remaining` when entered. `current_cycle` counts passes, so it may reach 3 (initial pass plus two re-passes), but never exceed `max_cycles + 1`. Reaching the cap with findings unresolved requires `RECOVERY_CHECKPOINT`; it does not make the phase `PHASE_BLOCKED`.

For findings that need corrections:

1. Dispatch an implementer with the outstanding findings and the relevant task packets. Keep the main agent in the Delegator + Gate Runner role; independent subagents own code judgments.
2. Record each correction as an append-only commit per [Correction recording](#correction-recording); do not move any task's `done_sha`.
3. Refresh every affected task verdict per [Verdict refresh](#verdict-refresh-fan-out).
4. Re-run the phase-level pass and record the result.

If findings remain after a pass, inspect the evidence and choose a materially different correction strategy: split unrelated findings, improve the packet with code or official-documentation evidence, dispatch a fresh implementer, or ask a fresh read-only subagent named `advisor` with the `advisor` persona to challenge the findings and proposed correction. Preserve the full history and never repeat an unchanged dispatch. After two correction rounds, persist `status: "RECOVERY_CHECKPOINT"` with outstanding findings, both strategies tried, evidence, and one concrete next strategy. Keep the phase out of `REVIEW`; do not set `PHASE_BLOCKED` solely because the cap was reached. Ask the user whether to authorize another bounded two-round window, and resume only under that explicit authorization with a different strategy. On authorization, reset only the new window's `max_cycles` and `cycles_remaining`; preserve prior window details in the record and increment its `recovery_window` number.

If the pass reviewer fails, bound infrastructure recovery to the original reviewer attempt, one fresh independent reviewer, and one fresh subagent named `advisor` with the `advisor` persona performing the same read-only pass. If all three fail, stop and report the exact human action needed to restore an independent review route. `PHASE_BLOCKED` is reserved for an actual human dependency; record the exact decision or capability required and the concrete unblock action. Do not mark the phase blocked because a review or correction counter is exhausted.

A clean pass writes `status: "PHASE_PASS_CLEAN"`; a pass resolved through corrections writes `status: "PHASE_PASS_RESOLVED"`. Only then may the phase advance to `REVIEW` per [Ordering](#ordering-review-only-after-the-pass-records-a-result).

## Correction recording

Every phase-level fix is recorded as an append-only correction. `done_sha` for every task NEVER moves — a phase-level fix never re-pins any task's `done_sha`.

Each fix SHALL be exactly one commit containing only the source files being fixed — never `log.json`. The implementer is instructed to stage files by name (`git add <file1> <file2>`, never `git add -A` / `git add .`).

The main agent SHALL audit the returned commit before recording it: `git show --stat <sha>` must not list `log.json`. If it does, the commit is **rejected** — no correction entry is recorded for that sha — and the implementer is re-dispatched with explicit staging instructions (stage only the named source files; exclude or stash `log.json`).

Once the commit is clean, it is recorded via:

```bash
npx -y pocketto-pi log update <plan_dir> <phase_file> \
  --correction <sha> \
  --for-task <task_id> \
  --json --contract 3
```

`<task_id>` is the task the finding is primarily attributed to (`for_task`); the CLI derives any additional `bleed` attribution from file ownership automatically — the main agent does not compute bleed itself. Parse `data.correction` from the envelope:

- `data.correction.affectedTasks` — every task this correction is attributed to (`for_task` plus owner-file bleed). This is the fan-out set for [Verdict refresh](#verdict-refresh-fan-out).
- `data.correction.skipped == true` — the commit had no file changes; nothing was recorded. Do not treat this sha as a correction and do not use it in the fan-out.
- `ok: false` — halt and report the error; do not continue.

`done_sha` is never touched by this command (`cli/commands/log.js` `recordCorrection` never writes `task.done_sha` — it only appends to `phase.corrections`). This correction path is strictly append-only and never re-pins the original task commit.

## In-loop fixes are not corrections

`--correction` is **phase-level-pass-only**. It records a fix to a task that already has a `done_sha` pinned.

A fix made *before* a task has a `done_sha` — i.e. during that task's own in-loop fix or refactor round, per `two-stage-review.md` — is a plain commit. `log update --correction` is NOT invoked for it, and it does not touch `phase.corrections`. The distinguishing fact is simple: if the task the fix belongs to has no `done_sha` yet, it is in-loop; if it does, and the fix happens afterward as part of this phase-level pass, it is a correction.

## Verdict refresh (fan-out)

Exactly **one** auditor is dispatched per correction commit, and it reads that commit in full. Its verdict is written into the artifact of **every task named in that correction's `data.correction.affectedTasks`** — `for_task` plus every bleed owner — not only the `for_task`. Tasks outside `affectedTasks` are left untouched: their `reviews/<task_id>-review.json` is not rewritten.

For each task `T` in `affectedTasks`, the main agent SHALL overwrite `reviews/<T>-review.json` (same path the per-task audit already wrote, per `two-stage-review.md` § Artifact contract) with the correction auditor's verdict for `T`, and SHALL set that artifact's `reviewed_sha` to:

```
reviewed_sha(T) = max-by-commit-time of:
    { T.done_sha }
    ∪ { c.sha : c ∈ phase.corrections, c.skipped != true, T ∈ c.affectedTasks }
```

This is **exactly** the set `pocket-closing` computes as `latest_owned_sha(T)`:

```
latest_owned_sha(T) = max-by-commit-time of:
    { T.done_sha }
    ∪ { c.sha : c ∈ phase.corrections and T ∈ tasks(c) }

where tasks(c) = ({ c.for_task } if present) ∪ { owner[f] : f ∈ c.files and owner[f] is defined }
```

The two sets are the same set by construction, not by coincidence: `data.correction.affectedTasks`, as returned by `recordCorrection` in `cli/commands/log.js`, is built as `{ for_task } ∪ { owner[f] : f ∈ files, owner[f] defined }` — the identical formula `pocket-closing` calls `tasks(c)`. A `skipped: true` correction (empty diff) never entered `phase.corrections` at all (`recordCorrection` returns before appending), so it can never appear in either set — it is never used as a `reviewed_sha`. Because both `reviewed_sha(T)` here and `latest_owned_sha(T)` in `pocket-closing` fold over the same `{ T.done_sha } ∪ { c.sha : T ∈ c.affectedTasks }`, writing `reviewed_sha(T)` to this value guarantees `reviews/<T>-review.json.reviewed_sha == latest_owned_sha(T)` — the exact-SHA match `pocket-closing`'s freshness gate requires (`skills/pocket-closing/SKILL.md:96-111`). Any other rule — in particular using the correction's own sha alone as `reviewed_sha`, singular — breaks this equality the moment a phase produces a second correction attributed to the same task, and permanently blocks that task from closing.

Two corrections attributed to the same task resolve to whichever of `{done_sha, c1.sha, c2.sha}` has the newest commit time — never simply "the latest correction recorded," since corrections are not guaranteed to be recorded in commit-time order.

Only `reviewed_sha`, `overall`, `stage_1`/`stage_2`, `fix_instructions`, and `cycle`/`loop_info` on the affected task's artifact are rewritten by the fan-out. The task's `done_sha` in `log.json` is never touched by this step.

## Resume

On resume, the main agent SHALL read `reviews/phase-pass-<phase_key>.json` alongside `log.json`.

- If the file is absent and the phase's `log.json` status is not yet `REVIEW`, the pass has not completed (it may never have started, or it died before its first write) — dispatch it fresh.
- If the file exists with `status: "PHASE_PASS_CLEAN"` or `"PHASE_PASS_RESOLVED"` and the phase's `log.json` status is already `REVIEW`, the pass is done — do not re-dispatch it and do not re-issue the `REVIEW` transition.
- If the file exists with `status: "PHASE_PASS_CLEAN"` or `"PHASE_PASS_RESOLVED"` but the phase's `log.json` status is not yet `REVIEW`, the pass result is terminal — perform the pending `log update <plan_dir> <phase_file> REVIEW` transition per [Ordering](#ordering-review-only-after-the-pass-records-a-result), then continue (do not re-dispatch the pass).
- If the file exists with findings recorded but no terminal `status` (i.e. it stopped between corrections and the confirming pass), resume from its persisted `loop_info` and `recovery_stage`, not from cycle 1. Preserve history and obey the remaining two-round budget.
- If the file records `status: "RECOVERY_CHECKPOINT"`, do not resume correction automatically. Wait for explicit user authorization; when granted, begin a new two-round window with a materially different strategy and preserve the prior window in the artifact.
- If the file records `status: "PHASE_BLOCKED"`, check the recorded human dependency. If it has been resolved, continue from the saved state; otherwise report the exact action needed. Do not erase prior findings or restart the pass from cycle 1.

[RESTATE: `done_sha` never moves. `--correction` is phase-level-pass-only — in-loop fixes are plain commits, never `--correction`. `reviewed_sha(T)` after a fan-out is `max-by-commit-time` over `{done_sha} ∪ {corrections in data.correction.affectedTasks attributed to T}` — this is provably `pocket-closing`'s `latest_owned_sha(T)`, not the correction sha in isolation. Phase status becomes `REVIEW` only after `reviews/phase-pass-<phase_key>.json` records a terminal result.]
