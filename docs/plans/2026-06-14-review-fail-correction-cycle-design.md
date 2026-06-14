# Design: REVIEW_FAIL Correction Cycle

- **Issue:** [#34](https://github.com/rfxlamia/pocketto/issues/34) — `[pocket-development] Agent confused on REVIEW_FAIL — no correction cycle guidance`
- **Date:** 2026-06-14
- **Scope:** single, all-in (CLI schema + new skill + review/closing/development updates + full cross-task attribution)
- **Status:** design approved, ready for implementation planning

## Problem

`log.json`'s single `done_sha` per task does double duty: it is both the task's
**final state** and its **diff boundary**. pocket-review computes each task's
review range as `prev_sha..task.done_sha`, where `prev_sha` is the previous task's
`done_sha` (or `header.baseline_sha` for the first task) — a linear chain.
pocket-closing gates per original-task verdict (`REVIEW_FAIL` → `CLOSE_BLOCKED`)
and forbids `--task` `done_sha` refresh (it recomputes from HEAD and corrupts the
range).

Consequently a correction to a **non-last** failed task cannot move its `done_sha`
in place without breaking later tasks' boundaries, and append-only git history
cannot insert a fix "at" an earlier task's position without rebase (destructive;
`rebase -i` is blocked in some host environments). With no safe deterministic path,
an agent receiving `REVIEW_FAIL` in pocket-development mode enters a confused
reasoning loop (the symptom reported in #34).

The root fix is to **decouple state from boundary**: a task keeps its original
`done_sha` boundary, and corrections are tracked as additional owned commits.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Data model | Lazy + `corrections[].files`; re-review flag **emergent** (no stored status field) |
| Correction nesting | **Phase-nested** (`phase.corrections[]`); per-file attribution at review time |
| Cross-task bleed | **Full attribution model** — a correction touching another task's files auto-flags that task for re-review |
| New skill | `pocket-correction` — standalone, user-triggered |
| CONTRACT | Stay additive to CONTRACT `2` (no `2→3` bump) |

## Section A — Data model + CLI foundation

`log.json` addition (additive; absent by default → old plans byte-identical):

```jsonc
phases[i] = {
  order, file, status,
  tasks: [ { id, name, status, depends?, done_sha? } ],          // unchanged
  corrections?: [ { sha, files: ["src/a.js"], for_task?: "T3" } ] // NEW
}
```

- `done_sha` **never moves** — it stays the original range boundary. Corrections
  are append-only. This dissolves the NOT-SAFE problem.
- `corrections` absent by default → CONTRACT stays `2`; the `log.json` writer
  invariant (2-space indent + trailing newline) is unchanged.

**Attribution algorithm** (used by review & closing, computed lazily):

1. Build `owner[file]` by iterating tasks in plan order: for each file in
   `git diff prev..done_sha --name-only`, set `owner[file] = task.id`
   (last-writer-wins within original ranges).
2. For each correction commit `C` with files `F`: each `f ∈ F` is attributed to
   `owner[f]`. Tasks touched = `{ owner[f] : f ∈ F }`.
3. Review union for task `T` = `[prev..done_sha]` (T's files) ⊕ the slice of each
   correction commit limited to T's owned files.

**CLI** — `log update <plan_dir> <phase_file> --correction <sha> [--for-task TN]`:

- Compute `files` via `git diff <sha>^..<sha> --name-only` (root-commit edge:
  parent = empty-tree object).
- Append `{sha, files, for_task?}` to `phase.corrections`.
- **Warn** (non-fatal, mirrors the #28 collision pattern) when any `f` has
  `owner[f] ≠ for_task` — an early cross-task bleed signal.
- Idempotency: a `sha` already present → no-op + warn (guards double-record).
- Envelope gains `data.correction: { sha, files, affectedTasks }`; parity tests in
  `test/cli.test.js` extend accordingly.

## Section B — `pocket-correction` skill flow

**Trigger:** user invokes after pocket-review writes verdicts —
`/pocketto:pocket-correction <plan_dir>/<phase_file>`. Standalone, user-triggered
(peer of review/closing). pocket-development stays one-shot.

**Role:** main agent = **Delegator + Auditor**, never writes code (identical to
pocket-development).

**Preflight:** read `log.json` + `reviews/`. Collect tasks with
`overall == REVIEW_FAIL` that have `fix_instructions`. `REVIEW_BLOCKED` is **not**
a correction case → report for escalation; do not enter the loop.

**Loop (SEQUENTIAL, plan order — never parallel):** parallel would collapse HEAD
onto one commit and re-trigger the #28 collision. For each `REVIEW_FAIL` task TN:

1. Build a correction packet from `reviews/<TN>-review.json` `fix_instructions`
   plus the task's DELIVERABLE / quality_bar.
2. Delegate to an implementer subagent → makes the fix, **one commit**, returns sha.
3. **Quick audit** (tests + git log + deliverable). Fail → re-dispatch with reason.
   Unresolvable → **BLOCKED mid-correction**: record nothing for that task.
4. Record: `log update <plan_dir> <phase_file> --correction <sha> --for-task TN`.
   CLI computes files + bleed warn.
5. Bleed detected (`affectedTasks ⊋ {TN}`) → note it; pocket-review auto-flags the
   affected task for re-review (emergent, Section A).

**Terminal:**

- Success → do **not** auto re-run review. Emit handoff:
  `Corrections recorded for T3, T5, T6 — run /pocketto:pocket-review <plan_dir>/<phase_file>`.
- BLOCKED mid-correction → report which tasks were corrected vs blocked, with
  reason + next action. The phase stays un-closeable until resolved.

**Enterprise:** corrections are commits on the same branch → they flow into the
existing PR via `create-pr` / traveling state; pocket-correction makes no GitHub
calls of its own.

## Section C — pocket-review + pocket-closing changes

**pocket-review (Step 3 — build reviewable list):** also reads `phase.corrections`
and builds `owner[file]` (Section A). A task `T` is reviewable when **either**:

- *First cycle:* `DONE + done_sha + non-empty range` (as today).
- *Re-review:* a correction commit touches T's owned files with a sha **newer** than
  `reviewed_sha` in `reviews/<T>-review.json` (emergent flag — no new status field).

**Review range (full attribution, per-file slicing):** for `T`, the subagent reviews
`[prev..done_sha]` (T's files) ⊕ the slice of each correction commit limited to T's
owned files. A correction commit touching two tasks is presented sliced: T3 sees its
T3-files, T5 sees its T5-files from the same commit. Re-review cycles focus on the new
correction slices.

**Cycle accounting:** a re-reviewed task → `loop_info.current_cycle++`, write
`reviewed_sha = T's newest owned correction sha` (else `done_sha`). The new verdict
supersedes the old; still-failing → `REVIEW_FAIL` again (cycle-2, cumulative).
Empty-diff skip-stub behavior is unchanged.

**pocket-closing — freshness anchor moves:** for each task,
`latest_owned_sha = max-by-commit-time({done_sha} ∪ {correction commits owning T's files})`.
The verdict is current iff `reviewed_sha == latest_owned_sha` (exact match, stronger
than the timestamp proxy). A correction touching T's files **after** its review →
stale → `CLOSE_BLOCKED: "re-run pocket-review"`.

**Gate unchanged** ([pocket-closing/SKILL.md:112]): any `REVIEW_FAIL` →
`CLOSE_BLOCKED`. But the **current** per-task verdict decides — an old FAIL is
superseded by a new PASS because `reviewed_sha` advanced and `overall == PASS`.
The `[CRITICAL]` "never `--task` on close" rule still holds; closing only advances
the phase `REVIEW → DONE`.

## Section D — peripheral, edge cases, testing

**pocket-development:** add a `REVIEW_FAIL` row to the Status Handling table →
point to `/pocketto:pocket-correction`, noting that the phase already reached
`PHASE_COMPLETE` before review, so the agent is **not** mid-phase. One-shot intact.

**pocket-review "Action Required" — simplified:** because corrections never move
`done_sha`, the **entire SAFE/NOT-SAFE branch is removed**. The block becomes a
context-aware two-path:

- *Manual user:* `fix → commit → log update <phase> --correction <sha> --for-task TN → re-run pocket-review`. Always safe; no boundary math.
- *Agent (pocket-development):* `run /pocketto:pocket-correction <plan_dir>/<phase_file>`.

This resolves the core #34 complaint **and** removes the fragile guidance PR #33 added.

**New-skill registration (two hosts):** `package.json` `pi.skills` +
`.claude-plugin/marketplace.json` (and `plugin.json` if required). pocket-help:
register in `SKILL.md`, `references/skill-map.md`, `references/end-to-end-flow.md`.

**Edge cases:**

- *No-op / reverted correction:* empty-diff commit → CLI warns + does not append
  (no files to attribute). A revert that touches files is an ordinary correction
  commit, attributed normally.
- *Cycle-2+:* `corrections[]` grows; `reviewed_sha` always tracks the newest → correct
  by construction.
- *BLOCKED mid-correction:* Section B (record nothing, report, phase stays
  un-closeable).
- *Enterprise:* corrections are commits on the same branch → they ride the existing
  PR; no GitHub calls in pocket-correction.

**Testing:** skills are prompts (no runtime), so `npm test` covers only the CLI.
New tests in `test/cli.test.js`:

- `--correction`: file computation (incl. root-commit edge via empty-tree), append to
  `phase.corrections`, idempotency (duplicate sha → no-op + warn), bleed warn
  (`owner[f] ≠ for_task`), `data.correction` envelope, and **byte-parity** of the
  writer (2-space + trailing newline) + additive schema (old plans without
  `corrections` stay identical).

## Out of scope

- History rewrite / rebase-based correction (destructive; `rebase -i` blocked).
- Auto-running pocket-review or pocket-closing — re-review stays user-triggered.
- Bumping CLI CONTRACT `2→3` — target additive-only; a forced non-additive change is
  a STOP-and-escalate, not a silent bump.
- Reworking the #28 parallel-merge collision logic beyond what corrections require.
- Non-git hosts / non-GitHub remotes for the enterprise PR-comment path.

## Implementation order (suggested)

1. CLI `--correction` + `phase.corrections` schema + tests (foundation).
2. `pocket-correction` SKILL.md + manifest registration + pocket-help.
3. pocket-review attribution + range-union + re-review trigger + cycle/reviewed_sha.
4. pocket-closing freshness anchor on `latest_owned_sha`.
5. pocket-development Status Handling row + pocket-review context-aware Action Required.
