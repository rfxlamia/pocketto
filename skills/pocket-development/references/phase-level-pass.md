[CRITICAL: This file is the single source of truth for the phase-level pass and its corrections. Downstream tasks SHALL cite it and SHALL NOT restate its rules. `done_sha` NEVER moves — every phase-level fix is recorded as an append-only correction. `--correction` is phase-level-pass-only; a fix made before a task has a `done_sha` is a plain commit, never a correction.]

# Phase-Level Pass Contract

Normative contract for the phase-level pass inside `pocket-development`: what it looks for, how its fixes are recorded as append-only corrections, how affected tasks' verdicts are refreshed afterwards, and its own round cap. The pass runs once per phase, after every task in the phase is `DONE`, and sits between the per-task in-loop audits (`references/two-stage-review.md`) and the phase advancing to `REVIEW`.

## Contents
- [Trigger and scope](#trigger-and-scope)
- [Dispatch](#dispatch)
- [Empty result: the "no findings" record](#empty-result-the-no-findings-record)
- [Ordering: REVIEW only after the pass records a result](#ordering-review-only-after-the-pass-records-a-result)
- [Fix rounds and the round cap](#fix-rounds-and-the-round-cap)
- [Correction recording](#correction-recording)
- [In-loop fixes are not corrections](#in-loop-fixes-are-not-corrections)
- [Verdict refresh (fan-out)](#verdict-refresh-fan-out)
- [Resume](#resume)

## Trigger and scope

The phase-level pass SHALL run exactly once per phase, triggered when every task in the phase has reached `DONE` (per-task `done_sha` pinned, per-task verdict artifact written — see `two-stage-review.md`). It SHALL NOT run per-task and SHALL NOT run before the last task in the phase is `DONE`.

The pass SHALL look only for what a per-task audit cannot see, because a per-task audit judges one task's diff in isolation:

- cross-task duplication (two tasks independently building the same thing)
- integration mismatch (task boundaries that don't actually compose)
- cross-file regression (a later task's change silently breaking an earlier task's file)
- spec-level gaps (a scenario or rule the plan's task split left uncovered by any single task)

The pass SHALL NOT re-litigate anything a per-task audit already judged (QUALITY BAR, spec compliance, code quality, or refactor heuristics scoped to one task's own diff — see `two-stage-review.md`). Re-raising a single-task finding at phase level is out of scope for this pass.

## Dispatch

The phase-level pass SHALL be dispatched as a read-only subagent. The main agent SHALL NOT perform the pass itself — it does not read implementation files to judge cross-task coherence, exactly as it does not judge single-task code (see `two-stage-review.md` § Auditor identity).

The dispatch input is the full phase: every task's diff range (`prev_sha..done_sha` per task, in plan order) and every task's packet (QUALITY BAR, DELIVERABLE). The main agent SHALL compute and pass these ranges; it SHALL NOT form its own opinion about what they contain.

## Empty result: the "no findings" record

A phase-level pass that finds nothing SHALL still write a record to disk, so a completed pass is distinguishable from a pass that never ran or died mid-flight (see [Resume](#resume)).

This record SHALL live at:

```
<plan_dir>/reviews/phase-pass-<phase_key>.json
```

`<phase_key>` uses the same derivation `pocket-closing` uses for its own phase-scoped keys: `execution-plan-phase-N.md` → `phase-N`; a flat single-file plan → `phase-1`.

This path is chosen deliberately to satisfy two constraints at once:

1. It lives under `reviews/` so it is discoverable alongside the per-task verdicts, per the design decision that phase-level state stays artifact-only (no new `log.json` fields beyond the pipeline-version marker).
2. Its filename can never collide with `<task_id>-review.json`, because task ids are always `T<N>` and never `phase-pass-<phase_key>`. `pocket-closing`'s Step 3 reads `reviews/<task_id>-review.json` for each task id it already knows from `log.json` — it does not glob every file under `reviews/` and interpret each as a task verdict — so this record is structurally invisible to the verdict gate. `pocket-closing` MUST NOT be changed to read it; it is out of scope for this pass's consumer, not for `pocket-closing`'s gate.

Record shape (clean pass, zero findings):

```json
{
  "phase_key": "<phase_key>",
  "phase_file": "<phase_file>",
  "timestamp": "<UTC ISO 8601 now>",
  "reviewer_mode": "read-only",
  "findings": [],
  "loop_info": { "current_cycle": 1, "max_cycles": 2, "cycles_remaining": 1 },
  "status": "PHASE_PASS_CLEAN"
}
```

A pass with findings (before or between fix rounds) uses the same shape with `findings` populated and `status` reflecting the round in progress (see [Fix rounds](#fix-rounds-and-the-round-cap)). The main agent SHALL create `reviews/` before the first write if it does not already exist. Re-dispatch of the pass overwrites this same path — it is the durable round counter for the phase-level pass, exactly as `loop_info` inside a task's own verdict artifact is the durable round counter for that task.

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

If the round cap is reached with findings still outstanding, the phase SHALL NOT advance to `REVIEW` at all — it goes to `PHASE_BLOCKED` instead (see next section).

## Fix rounds and the round cap

The phase-level pass has the same round budget as a task: **2 rounds**. The record's `loop_info` (`current_cycle`, `max_cycles: 2`, `cycles_remaining`) tracks it exactly as `two-stage-review.md` § Round budget tracks a task's rounds — a clean first pass records `current_cycle: 1`, `cycles_remaining: 1`, no round consumed; each fix round that follows a non-empty finding set consumes one round.

- **Round 1:** pass runs, findings recorded (or `findings: []` and done — no round needed).
- If findings exist: fixes are dispatched, one correction commit per fix (see [Correction recording](#correction-recording)), then the pass **re-runs** to confirm the findings are resolved. This re-run consumes round 1.
- If findings remain after round 1's re-run: round 2 repeats the same fix → correction → re-run cycle.
- If findings remain after round 2's re-run: the phase-level pass ends. The phase is marked `PHASE_BLOCKED` — `reviews/phase-pass-<phase_key>.json` records `status: "PHASE_BLOCKED"` with `blocked_category: "phase-audit-failed"` and the outstanding `findings` attached. The main agent reports `PHASE_BLOCKED` with those findings. Phase status SHALL NOT advance to `REVIEW`.

A clean pass (zero findings on round 1, or zero findings remaining after a fix round's re-run) writes `status: "PHASE_PASS_CLEAN"` (never entered a fix round) or `status: "PHASE_PASS_RESOLVED"` (entered at least one fix round and resolved), and phase status then advances to `REVIEW` per [Ordering](#ordering-review-only-after-the-pass-records-a-result).

## Correction recording

Every phase-level fix is recorded as an append-only correction. `done_sha` for every task NEVER moves — a phase-level fix never re-pins any task's `done_sha`.

Each fix SHALL be exactly one commit containing only the source files being fixed — never `log.json`. The implementer is instructed to stage files by name (`git add <file1> <file2>`, never `git add -A` / `git add .`), the same commit-hygiene requirement `pocket-correction` enforces today.

The main agent SHALL audit the returned commit before recording it: `git show --stat <sha>` must not list `log.json`. If it does, the commit is **rejected** — no correction entry is recorded for that sha — and the implementer is re-dispatched with explicit staging instructions (stage only the named source files; exclude or stash `log.json`).

Once the commit is clean, it is recorded via:

```bash
npx -y pocketto-pi log update <plan_dir> <phase_file> \
  --correction <sha> \
  --for-task <task_id> \
  --json --contract 2
```

`<task_id>` is the task the finding is primarily attributed to (`for_task`); the CLI derives any additional `bleed` attribution from file ownership automatically — the main agent does not compute bleed itself. Parse `data.correction` from the envelope:

- `data.correction.affectedTasks` — every task this correction is attributed to (`for_task` plus owner-file bleed). This is the fan-out set for [Verdict refresh](#verdict-refresh-fan-out).
- `data.correction.skipped == true` — the commit had no file changes; nothing was recorded. Do not treat this sha as a correction and do not use it in the fan-out.
- `ok: false` — halt and report the error; do not continue.

`done_sha` is never touched by this command (`cli/commands/log.js` `recordCorrection` never writes `task.done_sha` — it only appends to `phase.corrections`). This is strictly the same append-only machinery `pocket-correction` used; only the caller changes.

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
- If the file exists with findings recorded but no terminal `status` (i.e. it stopped between a fix round's corrections and its confirming re-run), the pass died mid-flight — resume it from its persisted `loop_info` (`current_cycle`, `cycles_remaining`), not from round 1. The round budget is never reset by a resume.
- If the file records `status: "PHASE_BLOCKED"`, the phase stays blocked. The main agent SHALL NOT re-dispatch the pass and SHALL NOT advance to `REVIEW` until a human resolves the block.

[RESTATE: `done_sha` never moves. `--correction` is phase-level-pass-only — in-loop fixes are plain commits, never `--correction`. `reviewed_sha(T)` after a fan-out is `max-by-commit-time` over `{done_sha} ∪ {corrections in data.correction.affectedTasks attributed to T}` — this is provably `pocket-closing`'s `latest_owned_sha(T)`, not the correction sha in isolation. Phase status becomes `REVIEW` only after `reviews/phase-pass-<phase_key>.json` records a terminal result.]
