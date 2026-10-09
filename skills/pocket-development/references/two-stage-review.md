[CRITICAL: This file is the single source of truth for the in-loop audit. Downstream tasks T4, T5, T7, T8, and T9 SHALL cite it and SHALL NOT restate its rules. The main agent never judges code; every criterion is executed by a read-only subagent.]

# In-Loop Audit Contract

Normative contract for the per-task in-loop audit inside `pocket-development`. All audit state lives in the verdict artifact (`CONTRACT` stays 2). The main agent is Delegator + Gate Runner: it runs the mechanical gate, dispatches the auditor, reads labels from the artifact, and drives CLI updates. It SHALL NOT read implementation files to assess quality, spec compliance, or refactor thresholds. Pre-dispatch architecture inspection is limited to constructing and validating the packet; implementation judgments remain with the independent auditor.

## Contents
- [Auditor identity](#auditor-identity)
- [Mechanical gate](#mechanical-gate)
- [Audit input](#audit-input)
- [Criteria](#criteria)
- [Refactor heuristics](#refactor-heuristics)
- [Severity ladder](#severity-ladder)
- [Review cycles and recovery](#review-cycles-and-recovery)
- [BLOCKED categories](#blocked-categories)
- [Minor carry-forward on re-audit](#minor-carry-forward-on-re-audit)
- [SHA pinning](#sha-pinning)
- [Artifact contract](#artifact-contract)
- [Resume](#resume)

## Auditor identity

The auditor SHALL always be a separate read-only subagent.

The auditor SHALL NOT be the main agent. The auditor SHALL NOT be the implementer. The main agent SHALL NOT judge code, SHALL NOT grade findings, and SHALL NOT decide spec compliance, quality, or refactor thresholds by reading implementation files.

Every criterion in this contract is executed by that read-only subagent. The main agent SHALL dispatch it, pass the inputs this contract names, and then read the labels the auditor emitted.

## Mechanical gate

The main agent SHALL run the mechanical gate first, before any auditor dispatch. The gate is command-and-commit evidence only — it is not a code judgement.

The gate SHALL check, in order:

1. A commit exists for the work the implementer reported.
2. **Every distinct exact command the task specifies is green.** A behavioral task carries one RED cycle per GWT scenario it covers, and each cycle names its own exact command in its Step 2. The gate SHALL enumerate every such command in the task and run all of them; a task with three RED cycles is green only when all three commands pass. Running one command and inferring the rest is a gate failure, not a shortcut — it is how a task ships two unproved GWT scenarios.
   Commands SHALL be executed with the task's working tree as cwd. In a parallel group that is the worktree — `( cd "$WT" && <command> )` — never `git -C $WT <command>`, which asks git to run the command as a git subcommand and fails even when the test passes.
3. For a `[no-tdd — structural task]` structural task, the packet's validation command(s) are the mechanical gate (in place of the test commands).
4. **Parallel-group in-worktree pass:** with cwd set to the task worktree, `git branch --show-current` MUST equal `task/<task_id>`. A mismatch is a mechanical gate failure (wrong branch / CWD discipline).
5. If the plan specifies no command at all (neither a test command nor a validation command), the main agent SHALL skip every command check and proceed straight to the auditor.

On any mechanical failure the main agent SHALL re-dispatch the implementer with the failure reason (for example, "tests failing" or "no commit") and SHALL NOT dispatch the auditor. A mechanical failure consumes no round: `loop_info` is unchanged.

After a refactor or fix round returns, the main agent SHALL run this same mechanical gate again before re-dispatching the auditor. Tests going red after a refactor is a mechanical failure: re-dispatch the implementer; record the recovery without treating it as a reason to stop (see [Review cycles and recovery](#review-cycles-and-recovery)).

## Audit input

The auditor SHALL judge only the range this section names. The main agent SHALL compute that range and pass it in the dispatch; it SHALL NOT inspect the files in that range to form a quality opinion.

- **Sequential task:** the auditor SHALL read the diff `prev_sha..HEAD`, where `prev_sha` is the previous task's `done_sha` (or the phase baseline when this is the first task).
- **Parallel-group task:** the auditor SHALL read the worktree tip (the task's own worktree HEAD). The merge commit is not the audit input for the in-worktree pass.

If `prev_sha..HEAD` (sequential) contains no file changes, the main agent SHALL NOT dispatch the auditor. See [SHA pinning](#sha-pinning) for the empty-diff stub.

## Criteria

The auditor SHALL apply all three of the following, in the dispatch, by loading the cited files verbatim. Before dispatch, the main agent SHALL resolve `<skills_root>` as the parent directory of the active `pocket-development` skill directory, construct absolute paths from it, and pass those resolved paths in the dispatch prompt. It SHALL NOT pass the literal placeholders or paraphrase the files' contents.

1. **QUALITY BAR** from the task packet: every must-have present and correct; every must-not-have absent; every red flag checked.
2. **Spec compliance** — reuse verbatim:
   `<skills_root>/pocket-development/references/spec-compliance-review.md`
3. **Code quality** — reuse verbatim:
   `<skills_root>/pocket-development/references/code-quality-review.md`
4. **Architecture and API assumptions**, when the packet relies on them — verify against the relevant repository implementation, configuration, and tests. For framework, library, or external API behavior, verify the installed version using Context7 or current official documentation. Cite the evidence in the verdict; an unverified assumption is not a pass.

The auditor SHALL emit `stage_1` (spec compliance) and `stage_2` (code quality, including QUALITY BAR and refactor heuristics) into the verdict artifact. The main agent SHALL NOT substitute its own checklist for these files.

## Refactor heuristics

The auditor SHALL judge refactor heuristics from the diff. The thresholds are identical logic 3+ times across in-scope files; a modified file crossing ~300 lines; a function exceeding ~50 lines.

No implementer self-report is required or accepted. The main agent SHALL NOT ask the implementer whether a refactor was needed and SHALL NOT accept such a claim as evidence.

A diff that violates none of the thresholds proceeds to commit / DONE with no refactor round.

A diff that crosses any threshold SHALL produce an Important quality finding on that heuristic and requires a fix/refactor cycle (see [Severity ladder](#severity-ladder) and [Review cycles and recovery](#review-cycles-and-recovery)). The subsequent re-audit SHALL confirm the heuristic is cleared and that tests remain green (via the mechanical gate). A refactor that shifts behavior so the test command goes red fails the mechanical gate and is not accepted as DONE.

## Severity ladder

The auditor itself SHALL emit every finding as exactly one of `Critical | Important | Minor`. The main agent SHALL read that label and SHALL never re-interpret, upgrade, or downgrade it.

| Label | Effect |
|-------|--------|
| **Critical** | Forces a fix round. Can end in BLOCKED. Task is not marked DONE. |
| **Important** | Forces a fix or refactor round. Can end in BLOCKED. Task is not marked DONE. |
| **Minor** | Non-blocking observation. Persisted in the verdict artifact and carried forward to closing. Does not start a fix round. |

A Minor-only verdict (no Critical, no Important) SHALL proceed to DONE. Those Minor findings SHALL remain in `stage_2.issues[]` of the artifact.

A verdict that contains any Critical or Important finding SHALL enter a fix or refactor round and SHALL NOT be marked DONE.

## Review cycles and recovery

`max_cycles: 2` is a hard cap of two correction rounds after the initial attempt. Each round must use a materially different recovery strategy and consumes one `cycles_remaining` when entered. A mechanical-gate failure before the first audit also consumes a round. `current_cycle` counts audits, so it may reach 3 (initial audit plus two re-audits), but never exceed `max_cycles + 1`. A cap is a mandatory user checkpoint, not a verdict that the task is BLOCKED.

**Consumes one round** (decrement `loop_info.cycles_remaining` once when the round is entered):

- a fix/refactor round entered because an audit emitted any Critical or Important finding, including a refactor-heuristic finding
- another fix/refactor round entered because the re-audit still has a Critical or Important finding, including a new finding introduced by the previous fix

The finding and the fix/refactor it triggers are one consuming event, not two. A single re-audit that both re-states an unfixed Critical/Important and reports a new finding starts at most one next round.

**Does not consume a fix round:**

- a Minor-only or fully clean PASS
- **auditor infrastructure failure** (subagent dies, times out, or returns unparseable output)

Auditor infrastructure failure does not consume a correction round. Bound recovery to the original auditor attempt, one fresh auditor retry, and one `advisor` attempt. If all three fail, stop and request the specific human action needed to restore an independent review route; do not convert an unavailable subagent into a task verdict.

**Auditor recovery:**

1. Retry with a fresh read-only auditor subagent and the same pinned diff and criteria.
2. If the failure repeats, dispatch a fresh subagent named `advisor` with the `advisor` persona. It performs the same independent, read-only audit and writes the same verdict artifact; the main agent never substitutes its own code judgment.
3. If the advisor cannot complete the review, diagnose recoverable tool or input failures, then stop and report the exact human action needed. Preserve the task state and review history.
4. Use `auditor-unavailable` only when no independent review route is available until a human restores or authorizes a required capability. Record that exact dependency and how the user can unblock it.

On a clean first PASS, the artifact SHALL record `loop_info.current_cycle: 1`, `max_cycles: 2`, and `cycles_remaining: 2`.

After each correction round, update the same verdict artifact and decrement the remaining budget. If Critical or Important findings remain when `cycles_remaining` reaches zero, stop automatic correction and report `RECOVERY_CHECKPOINT` with the unresolved findings, attempted strategies, evidence, and one concrete next strategy. Keep `overall: "REVIEW_FAIL"`; do not label the task BLOCKED solely because the cap was reached. Ask the user whether to authorize another bounded correction window. Resume only under that explicit authorization, with a fresh two-round budget and a different strategy. `REVIEW_BLOCKED` with `audit-failed` remains reserved for a specific human decision, information, access, or authorization needed to choose a safe correction; record that dependency and unblock action in `fix_instructions`.

## BLOCKED categories

Two categories exist. Both SHALL be persisted in the verdict artifact (field `blocked_category`), not only reported in chat. `overall` SHALL be `REVIEW_BLOCKED`. No `done_sha` is written for a BLOCKED task. Do not start tasks that depend on it; continue other ready tasks when the plan confirms they are independent. A blocked member stops its parallel group.

| `blocked_category` | When |
|--------------------|------|
| `audit-failed` | Outstanding Critical or Important findings require a specific human decision, information, access, or authorization; reaching the correction cap alone is not this verdict. |
| `auditor-unavailable` | No independent audit route is available until a human restores or authorizes a required capability; failed attempts alone are insufficient. |

The artifact SHALL also keep the findings (`stage_1.issues`, `stage_2.issues`) and `fix_instructions` so a later session can see why the task blocked.

**Parallel group (Rule A2.2):** a blocked group member stops the whole group. The main agent SHALL NOT merge any member of that group, SHALL NOT remove any worktree, and SHALL NOT delete any branch.

## Minor carry-forward on re-audit

When a re-audit runs, the main agent SHALL supply the previous verdict artifact to the re-auditor.

The re-auditor SHALL re-emit every still-unfixed Minor into the rewritten artifact. Minors that the fix actually resolved MAY be dropped; Minors that remain SHALL appear again in `stage_2.issues[]` with severity `Minor`.

The main agent SHALL NOT merge, union, or rewrite findings itself. The rewritten artifact from the re-auditor is the sole source of the current finding set.

## SHA pinning

The pinned SHA is the SHA the auditor actually read, except where this section names a different rule.

**Sequential tasks.** After a passing audit at commit `X`, the main agent SHALL mark the task DONE with `--sha <audited_head>` (that is, `--sha X`). The artifact SHALL set `reviewed_sha` to `X`. Then `reviewed_sha == done_sha`.

**Parallel-group tasks.** Do not pass `--sha` of the worktree tip. After a passing in-worktree audit:

- `done_sha` for each task is its own merge commit (merge, then `log update`, one task at a time — that loop is unchanged).
- On a **conflict-free** merge, the main agent SHALL rewrite that task's `reviewed_sha` to the same merge commit. No re-audit is dispatched.
- When merging required **manual conflict resolution**, the main agent SHALL dispatch a re-audit against the merge commit. Both `done_sha` and `reviewed_sha` SHALL be that merge commit.

A blocked group member stops the whole group: no merge, no worktree removed, no branch deleted (see [BLOCKED categories](#blocked-categories)).

**Empty-diff tasks.** If the sequential range `prev_sha..HEAD` contains no file changes, the main agent SHALL NOT dispatch the auditor. The task SHALL be marked DONE with `--allow-duplicate-sha`. The main agent SHALL write a REVIEW_PASS stub (no auditor) to `<plan_dir>/reviews/<task_id>-review.json` with `reviewed_sha` equal to `done_sha`.

The skip stub JSON (verbatim):

```json
{
  "task_id": "<task_id>",
  "task_name": "<task_name>",
  "cycle": 1,
  "timestamp": "<UTC ISO 8601 now>",
  "reviewer_mode": "main-agent",
  "reviewer_config": "batch-parallel",
  "stage_1": { "status": "PASS", "issues": [], "concerns_addressed": [] },
  "stage_2": { "status": "PASS", "strengths": [], "issues": [], "assessment": "Approved" },
  "overall": "REVIEW_PASS",
  "fix_instructions": "",
  "loop_info": { "current_cycle": 1, "max_cycles": 1, "cycles_remaining": 0 },
  "skip_reason": "no_file_changes",
  "reviewed_sha": "<task.done_sha>"
}
```

## Artifact contract

Every in-loop audit (and every skip stub, and every BLOCKED outcome) SHALL be written to exactly `<plan_dir>/reviews/<task_id>-review.json`.

The file SHALL conform to `skills/pocket-development/references/review-report-template.md`. It SHALL carry:

- `task_id`
- `overall` (`REVIEW_PASS` | `REVIEW_FAIL` | `REVIEW_BLOCKED`)
- `reviewed_sha`
- `fix_instructions` (empty string on PASS)
- `loop_info` — the durable round counter: `current_cycle`, `max_cycles: 2` (except the empty-diff skip stub, which keeps `max_cycles: 1` as written above), `cycles_remaining`
- `merge_recovery_consumed` (optional, boolean) — compatibility/history marker indicating that merge recovery has started
- `merge_recovery_round` (optional, integer) — current bounded merge-conflict recovery round, maximum `2` before `RECOVERY_CHECKPOINT`; applies separately from the task's in-loop audit budget
- `merge_recovery_stage` (optional) — `implementer` | `gate` | `auditor` | `merge_retry` | `parallel-conflict`; persist the current step on `<plan_dir>/reviews/<task_id>-review.json` and mirror it on peer group tasks involved in the conflict. Resume an interrupted step; after a failed merge retry, `parallel-conflict` records that attempt. See `parallel-group.md` for the two-round cap and user checkpoint. Distinct from phase-level `recovery_stage` on `phase-pass-*.json`
- `stage_2.issues[].severity`
- `stage_2.strengths[]`

When the task is BLOCKED, the artifact SHALL also persist `blocked_category` as `audit-failed` or `auditor-unavailable`.

The main agent SHALL create `<plan_dir>/reviews/` before the first write. Re-audit overwrites the same path; `loop_info` in that file is what resume reads. When rewriting an artifact on re-audit, carry forward `merge_recovery_consumed: true`, `merge_recovery_round`, and any in-progress merge-recovery stage. A successful re-audit must not erase recovery history; clear the stage only after the corresponding merge succeeds. Do not repeat a failed strategy, and stop after two materially different merge recovery rounds until the user authorizes a new bounded window.

## Resume

On resume, the main agent SHALL inspect `log.json` and each existing verdict artifact.

A task already DONE whose artifact's `reviewed_sha` equals its `done_sha` SHALL be skipped. `log update … DONE` SHALL never be re-issued for it.

For any task that is not yet DONE, the round count SHALL be read from that task's `loop_info` (`current_cycle`, `max_cycles`, `cycles_remaining`) and SHALL NOT be reset.

A BLOCKED task (`overall: REVIEW_BLOCKED` with `blocked_category` set) SHALL keep that task and its dependents halted; it does not prevent ready tasks that the plan confirms are independent. The phase SHALL NOT advance to `REVIEW` while any task remains blocked. On resume, first check whether the recorded human dependency has been resolved. If so, continue recovery from the saved artifact and counter; do not restart or erase review history. If it remains unresolved, report the specific action needed from the user and continue any independent work that remains safe.

[RESTATE: This file is the single source of truth. Downstream tasks cite it rather than paraphrasing it. The main agent never judges code — every criterion is executed by a read-only subagent. All audit state lives in `<plan_dir>/reviews/<task_id>-review.json`.]
