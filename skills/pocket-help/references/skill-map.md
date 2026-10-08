# Skill Map

One block per Core skill: what it does, what it consumes, what it produces, and when to use it. Load a skill's own `SKILL.md` only when you are ready to run that stage.

## Chained pipeline (`pocket-*`)

### pocket-pitching
- **What:** Pre-grinding problem exploration that converges on a clear problem statement and a small set of directions.
- **Input:** A vague or unformed idea.
- **Output:** A pitch exploration document under `docs/pocket/spec/<date>-<slug>/`.
- **Handoff:** The user chooses whether to invoke `pocket-grinding`.
- **Use when:** The problem itself is unclear.
- **Skip when:** The problem is already clear or an approved spec exists.

### pocket-grinding
- **What:** BDD-driven requirement discovery: context scan, scope, example mapping, architecture validation, and spec authoring.
- **Input:** A clear problem, optionally with a pitch document.
- **Output:** An approved spec with acceptance criteria and architecture constraints.
- **Handoff:** Emits `spec-approved`, then invokes `pocket-planning` after approval.
- **Use when:** Planning a feature, designing a non-trivial fix, or refactoring a system boundary.
- **Skip when:** The change is a trivial fix or an approved spec already exists.

### pocket-planning
- **What:** Converts a spec into a TDD-structured execution plan with bounded task packets.
- **Input:** An approved spec and its acceptance criteria.
- **Output:** An execution plan with test intent, implementation steps, and verification criteria.
- **Handoff:** Validates the plan and routes it to `pocket-structuring`.
- **Use when:** A spec needs to become executable tasks.
- **Skip when:** There is no spec yet or execution is already underway.

### pocket-structuring
- **What:** Creates a manifest and per-task files from an execution plan, adding phase files when needed.
- **Input:** A completed execution plan.
- **Output:** An execution index, task files, and optional phase manifests.
- **Handoff:** Requests execution approval, then hands one phase at a time to `pocket-development`.
- **Use when:** An execution plan needs task-level structure.
- **Skip when:** The plan has already been structured.

### pocket-development
- **What:** Executes tasks with Pocket Packets, test-first commits, per-task audits, and a phase-level pass.
- **Input:** An execution index or a phase file whose prerequisite is complete.
- **Output:** Commits, per-task verdict artifacts, and a phase-level pass result.
- **Handoff:** Leaves a passing phase in `REVIEW`, emits `phase-complete`, and names `pocket-closing` as the next user-triggered step.
- **Use when:** An approved execution plan is ready to build.
- **Skip when:** No execution plan exists or a prerequisite phase is incomplete.

### pocket-closing
- **What:** Reconciles current task verdicts, advances a passing phase, and closes a completed plan.
- **Input:** An execution log and current verdict artifacts.
- **Output:** An advanced phase or a closed plan with a closeout summary.
- **Handoff:** A successful final close emits `plan-closed`.
- **Use when:** A phase-level pass has completed and the user invokes closing.
- **Skip when:** A task is failing, blocked, or missing a current verdict.

## Standalone skills

### bug-hunting
- **What:** Root-cause-first debugging and proactive bug discovery.
- **Input:** A bug report, test failure, production error, or code area to inspect.
- **Output:** A confirmed cause, evidence, and a test-first fix or finding.
- **Use when:** Behavior is broken or a code path needs a focused bug hunt.

### hotfix
- **What:** Fast iteration for a small, well-understood change with a brief-plan review gate.
- **Input:** A bounded small-to-medium change.
- **Output:** A reviewed brief plan and implementation.
- **Use when:** The full pipeline is more ceremony than the change needs.

### brand-design
- **What:** Creates a math-validated brand and design-token authority.
- **Input:** Brand intent, audience, personality, and target platform.
- **Output:** A creative brief, preview, and optional compiled tokens.
- **Use when:** Starting UI work without an existing design authority.

### structured-research
- **What:** Tests an explicit assumption against evidence and reports a graded verdict.
- **Input:** One falsifiable technical or product assumption.
- **Output:** A Confirmed, Refuted, or Inconclusive result with evidence.
- **Use when:** An unverified belief could affect planning or implementation.

### pocket-help
- **What:** This routing guide.
- **Input:** A question about Pocket or which skill to use.
- **Output:** Orientation and a route to one skill.
- **Use when:** New to Pocket or unsure where to start.

### pocket-init
- **What:** Scans a project and writes a merge-safe local project guide, then optionally calibrates a local learner profile through `edu init`.
- **Input:** An existing project directory.
- **Output:** A created or updated managed section in one memory file; optionally a confirmed `## Pocket Education` learner profile outside it.
- **Use when:** Adopting Pocket in an existing repository, refreshing a stale guide, or enabling Education.

### pocket-education
- **What:** Opt-in mentor mode — the human implements, the agent teaches. Loads the persisted learner profile (`pocketto-pi edu`), maps the task to skill dimensions, then runs Understand → Investigate → learner plans → learner implements → review → guided correction → re-review → learning summary. Hints climb a ladder one rung at a time; review findings are phrased as traces that let the learner discover the failure mode. Never edits application code or tests. Recommends level changes from journal evidence; applies them only with the learner's explicit consent.
- **Input:** A task in a repo with Pocket Education enabled (or a learner who wants to work this way).
- **Output:** The learner's own, reviewed change; a learning summary (optionally `docs/pocket/learning/<date>-<slug>.md`); learner-approved profile updates.
- **Use when:** "teach me", "guide me through this", "I want to do it myself", "review my change", "explain testing more slowly", "recalibrate my level".
- **Skip when:** The user explicitly wants the agent to implement (→ hotfix / bug-hunting / pocket-development).
