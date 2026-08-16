# End-to-End Flow

The full chained pipeline, walked stage by stage, with the gates that matter and a worked example. Load an individual skill's `SKILL.md` only when you actually reach its stage.

## The Chain at a Glance

```
pocket-pitching → pocket-grinding → pocket-planning → pocket-structuring → pocket-development ──PASS──→ pocket-closing
   (explore)        (specify/BDD)      (plan/TDD)         (phase)         (delegate, in-loop audit,       (close)
                                                                            phase-level pass)
```

Standalone skills (`bug-hunting`, `hotfix`, `brand-design`, `structured-research`, `pocket-init`, `create-pr`) sit *outside* this chain — see `pocket-vs-superpowers.md` for when to leave the pipeline for one of them.

**Pocket Enterprise (opt-in):** when a `## Pocket Enterprise` block is configured (via `pocket-init` or `pocketto-pi mode init`), the same chain mirrors itself to GitHub — grinding creates the issue (with the full spec attached), development offers `create-pr`, posts its phase-level pass's verdicts to the PR, and syncs a task checklist to the issue, closing posts the closeout comment and can gate on PR approval. Without the block, nothing below changes and no GitHub call is ever made.

## Stage-by-Stage

### 1. pocket-pitching — explore (optional entry)
Use only when the problem is fuzzy. Diverge with brainstorming methods + advisor curation, optionally spike a technical unknown, then converge to a problem statement and 2–3 directions.
- **Gate:** User confirms the problem statement before diverging; user approves the brief before any handoff.
- **Produces:** `docs/pocket/spec/<date>-<slug>/pitch-exploration.md`.
- **Next:** User chooses whether to start `pocket-grinding`. Pitching does **not** auto-chain.
- **Enter here when:** "I have a rough idea." **Skip when:** the problem is already clear → start at grinding.

### 2. pocket-grinding — specify (BDD)
Scan context → lock scope → question from three lenses (Business / Developer / QA) → map examples to Given-When-Then scenarios → validate against architecture → write the spec.
- **Gates:** No implementation until handoff; scope confirmed before questioning; handoff blocked if architecture validation fails.
- **Produces:** An approved spec with GWT acceptance criteria, architecture constraints, and a design decision.
- **Next:** **Auto-invokes `pocket-planning`** once the user approves the spec (mandatory — grinding isn't "done" at "spec written").

### 3. pocket-planning — plan (TDD)
Preflight the codebase → parse the spec → map files → decompose into bounded tasks → write 7-field Pocket Packets (each: failing test → minimal code → commit) → run a spec-reviewer subagent, then a test-architect subagent.
- **Gates:** Handoff inputs verified; spec-reviewer must APPROVE before test-architect runs; user approves the final plan.
- **Produces:** `docs/pocket/plans/<date>-<slug>/execution-plan.md`.
- **Next:** After approval, validates the plan with `structure --dry-run` and routes: **≤6 tasks → `pocket-development` directly**; **≥7 tasks → `pocket-structuring`**.

### 4. pocket-structuring — phase
Runs `npx pocketto-pi structure <plan>` — the CLI counts tasks exactly and decides.
- **≤6 tasks → passthrough:** invokes `pocket-development` directly with the flat plan; no phase files.
- **≥7 tasks → split:** produces `execution-plan-phase-N.md` files and hands them to `pocket-development` **one at a time**.
- **Gate:** A hard override gate — skipping structuring for a ≥7-task plan requires the exact phrase `OVERRIDE: skip structuring`. Verbal insistence is not enough.
- **Next:** `pocket-development`, phase by phase, never all phases at once.

### 5. pocket-development — delegate (+ in-loop audit, phase-level pass)
Main agent is **delegator + auditor only** — it never writes implementation code. For each task: run the entry gate → construct a Pocket Packet → spawn an implementer subagent → on DONE, run the in-loop audit — a mechanical gate (git log + tests + DELIVERABLE checklist), then a read-only auditor subagent covering spec compliance and code quality — → mark DONE in `log.json`. Independent tasks can run as a parallel group in git worktrees.
- **Gates:** 6 iron laws (no packet = no spawn; no trust without evidence; etc.); for phase files, the prerequisite phase must be confirmed COMPLETE before starting.
- **Produces:** Committed, audited code; per-task review JSON (`<plan_dir>/reviews/<task>-review.json`); statuses tracked in `log.json`.
- **Once every task is DONE:** dispatches the phase-level pass — one read-only subagent over the whole phase's diff ranges and packets — and, for any `REVIEW_FAIL` finding, delegates and records an append-only fix as part of the same in-loop flow (never a separate stage). Sets the phase to `REVIEW`.
- **Next:** Emits a `PHASE_COMPLETE` handoff naming `pocket-closing` as the user-triggered next step; on an all-`REVIEW_PASS` phase it can also auto-chain there after one confirmation.

### 6. pocket-closing — close (auto-chained or user-triggered)
Reached automatically when pocket-development's phase-level pass chains here on an all-`REVIEW_PASS` phase (after a single confirmation), or run directly by the user: `/pocketto:pocket-closing <plan_dir>`. Main agent is **reconciler + closer only** — it reads `log.json` + every `reviews/*.json`, gates the close on verdicts (any `REVIEW_FAIL`/`REVIEW_BLOCKED` → `CLOSE_BLOCKED`), advances passed phases `REVIEW → DONE` via the CLI, runs `log close`, and writes `closeout.md`.
- **Output states:** `CLOSED` (header `DONE` + `date_completed`), `PHASE_ADVANCED` (one phase done, plan continues), `CLOSE_BLOCKED`, or `ALREADY_CLOSED`.
- **Closes the loop:** without this stage a finished plan sits in `IN_PROGRESS`/`REVIEW` limbo. This is the terminal step.

## Worked Example — "Add JWT refresh-token support"

1. **Idea is fuzzy** ("auth feels fragile, maybe refresh tokens?") → `pocket-pitching`. Explores directions (rotate vs sliding-window vs short-lived access). User picks "rotating refresh tokens" → chooses to start grinding.
2. **`pocket-grinding`** locks scope (in: refresh endpoint + rotation; out: SSO), questions the three lenses, writes GWT scenarios ("Given an expired access token and valid refresh token, When /refresh is called, Then a new pair is issued and the old refresh token is revoked"), validates architecture. User approves → grinding **auto-invokes** planning.
3. **`pocket-planning`** preflights the auth module, maps files, decomposes into 8 tasks (schema, endpoint, rotation logic, revocation, tests, etc.), writes Pocket Packets, runs spec-reviewer + test-architect. User approves → validates via `structure --dry-run` → 8 tasks (≥7) → routes to **structuring**.
4. **`pocket-structuring`** runs the CLI → 8 tasks ⇒ **split** into Phase 1 (schema + scaffolding) and Phase 2 (endpoint + rotation + revocation). Hands Phase 1 to development.
5. **`pocket-development`** executes Phase 1 task-by-task (packet → spawn → in-loop audit → log DONE). Once every task is DONE, it dispatches the phase-level pass over Phase 1, sets the phase to `REVIEW`, and emits `PHASE_COMPLETE`.
6. Phase-level pass is clean → structuring proceeds to Phase 2 → development runs its in-loop audit and phase-level pass again.
7. Repeat until both phases are DONE and reviewed, then run `/pocketto:pocket-closing <plan_dir>`.

## Entry Points — Don't Always Start at the Top

| You already have… | Start at |
|-------------------|----------|
| Only a fuzzy idea | pocket-pitching |
| A clear problem | pocket-grinding |
| An approved spec | pocket-planning |
| An execution plan | pocket-structuring (or it's already been invoked) |
| A plan/phase file ready to build | pocket-development |
| A finished phase, phase-level pass all passing | pocket-closing |
| A bug, not a feature | bug-hunting (leave the pipeline) |
| A small, clear change | hotfix (leave the pipeline) |
