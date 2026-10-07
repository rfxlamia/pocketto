# End-to-End Flow

The full chained pipeline, walked stage by stage, with the gates that matter and a worked example. Load an individual skill's `SKILL.md` only when you reach its stage.

## The Chain at a Glance

```text
pocket-pitching → pocket-grinding → pocket-planning → pocket-structuring → pocket-development ──PASS──→ pocket-closing
   (explore)        (specify/BDD)      (plan/TDD)         (phase)          (execute + review)          (close)
```

Standalone skills (`bug-hunting`, `hotfix`, `brand-design`, `structured-research`, `pocket-init`) sit outside this chain. Use them when the task does not need the full pipeline.

## Stage-by-Stage

### 1. pocket-pitching — explore (optional entry)

Use when the problem is fuzzy. Explore the idea, converge on a problem statement, and produce a pitch document.
- **Gate:** The user confirms the problem statement and approves the brief before handoff.
- **Produces:** `docs/pocket/spec/<date>-<slug>/pitch-exploration.md`.
- **Next:** The user chooses whether to start `pocket-grinding`.

### 2. pocket-grinding — specify (BDD)

Scan context → lock scope → question from three lenses → map examples to Given-When-Then scenarios → validate against architecture → write the spec.
- **Gate:** Scope is confirmed before questioning; handoff is blocked if architecture validation fails.
- **Produces:** An approved spec with GWT acceptance criteria, architecture constraints, and a design decision.
- **Next:** After approval, emit the neutral `spec-approved` lifecycle event and hand off to `pocket-planning`.

### 3. pocket-planning — plan (TDD)

Preflight the codebase → parse the spec → map files → decompose acceptance criteria into bounded tasks → write Pocket Packets with failing-test intent → run a spec review.
- **Gate:** The user approves the plan before derived execution artifacts are generated.
- **Produces:** `docs/pocket/plans/<date>-<slug>/execution-plan.md`.
- **Next:** Validate the plan and route it to `pocket-structuring`.

### 4. pocket-structuring — index + task files

Run the structure command to create an execution index, per-task files, and phase manifests when the plan has multiple phases.
- **Gate:** Execution approval is separate from plan approval.
- **Produces:** `execution-plan/index.md`, `execution-plan/tasks/T*-*.md`, and phase files when needed.
- **Next:** Hand one phase at a time to `pocket-development`.

### 5. pocket-development — execute + review

Execute tasks one at a time with a Pocket Packet, the in-loop audit, and an append-only phase-level pass after all tasks are done.
- **Gate:** The prerequisite phase must be complete before a later phase starts.
- **Produces:** Commits, per-task verdict artifacts, and a phase-level pass result.
- **Next:** Leave a passing phase in `REVIEW` and name `pocket-closing` as the user-triggered next step. A phase completion emits the neutral `phase-complete` event.

### 6. pocket-closing — close (user-triggered)

Reconcile task verdicts against the execution log, advance an eligible phase, run the plan close command, and write the closeout summary.
- **Gate:** Every reviewable task must have a current passing verdict.
- **Produces:** An advanced phase or a closed plan, plus `closeout.md` when the plan is complete.
- **Next:** A successful final close emits the neutral `plan-closed` event.

## Worked Example — "Add JWT refresh-token support"

1. The idea is fuzzy → `pocket-pitching` explores directions and produces a brief.
2. `pocket-grinding` locks scope, writes concrete scenarios, validates the design, and saves the approved spec. Approval emits `spec-approved` before planning begins.
3. `pocket-planning` maps the codebase and decomposes the criteria into bounded tasks.
4. `pocket-structuring` creates task files and phase manifests, then asks for execution approval.
5. `pocket-development` executes and reviews each task, then runs the phase-level pass and emits `phase-complete` when the phase reaches `REVIEW`.
6. The user runs `pocket-closing` to reconcile the verdicts and advance the phase. When all phases are complete, closing emits `plan-closed`.

## Entry Points — Don't Always Start at the Top

| You already have… | Start at |
|-------------------|----------|
| Only a fuzzy idea | `pocket-pitching` |
| A clear problem | `pocket-grinding` |
| An approved spec | `pocket-planning` |
| An execution plan | `pocket-structuring` |
| A plan/phase file ready to build | `pocket-development` |
| A finished, passing phase | `pocket-closing` |
| A bug, not a feature | `bug-hunting` |
| A small, clear change | `hotfix` |
