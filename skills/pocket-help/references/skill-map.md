# Skill Map

One block per skill: what it does, what it consumes, what it produces, and when to use vs skip. Load a skill's own `SKILL.md` only when you're ready to run that stage.

Two kinds of skills:

- **Chained** (`pocket-*`) — pipeline stages that hand off to one another.
- **Standalone** — `bug-hunting`, `hotfix`, `brand-design`, `structured-research`, `pocket-help`, `pocket-init`, `create-pr`. Lighter, single-purpose, no handoff chain. The right choice for most everyday work.

**Pocket Enterprise (opt-in):** with a `## Pocket Enterprise` block in `AGENTS.md`/`CLAUDE.md` (set up via `pocket-init` or `pocketto-pi mode init`), three pipeline stages gain a GitHub trace — grinding creates the issue from the approved spec, development offers `create-pr`, posts its phase-level pass's verdicts to the PR, and syncs a task checklist to the issue, and closing posts the closeout comment (optionally gated on PR approval). Detection is fail-closed: without the block, every stage is byte-identical to local mode and makes zero GitHub calls.

---

## Chained pipeline (`pocket-*`)

### pocket-pitching
- **What:** Pre-grinding problem exploration. Scans project context silently, picks 3–5 brainstorming methods, runs them with LLM-to-LLM advisor curation, optionally runs a technical spike, then converges.
- **Input:** A vague or unformed idea — no clear problem statement yet.
- **Output:** A pitch exploration doc (`docs/pocket/spec/<date>-<slug>/pitch-exploration.md`) with a problem statement and 2–3 approach *directions* (not architecture, not scenarios).
- **Handoff:** Presents 3 options; the user chooses whether to invoke `pocket-grinding`. Does **not** auto-chain.
- **Use when:** "I have a rough idea", "explore this", "pitch this", problem is fuzzy.
- **Skip when:** Problem is already clear (→ pocket-grinding) or a spec exists (→ pocket-planning). Note: the keyword "brainstorm" belongs to pocket-grinding, not pitching.

### pocket-grinding
- **What:** BDD-driven requirement discovery. Scans context, locks scope, questions from three expert lenses (Business / Developer / QA), maps examples to Given-When-Then scenarios, validates against architecture.
- **Input:** A clear problem (optionally a pitch doc as context).
- **Output:** An approved spec with GWT acceptance criteria, architecture constraints, and a design decision (`docs/pocket/spec/<date>-<slug>/topic.md`).
- **Handoff:** **Auto-invokes `pocket-planning`** after the user approves the spec (Gate 4 — not optional).
- **Use when:** Planning a feature, designing a non-trivial fix, refactoring a system boundary; "plan this", "think through", "before we build", "brainstorm".
- **Skip when:** Trivial single-line fixes, or work that already has an approved spec.

### pocket-planning
- **What:** Converts a spec into a TDD-structured execution plan. Scans codebase, maps files, decomposes acceptance criteria into bounded tasks, writes full 7-field Pocket Packets (red → green → refactor → commit), then runs a spec-reviewer and a test-architect subagent.
- **Input:** A completed pocket-grinding spec (path + acceptance criteria + architecture constraints + design decision).
- **Output:** An execution plan of Pocket Packets with tests designed (`docs/pocket/plans/<date>-<slug>/execution-plan.md`).
- **Handoff:** After the user approves, validates the plan with `structure --dry-run` and routes: **≤6 tasks → `pocket-development` directly**; **≥7 tasks → `pocket-structuring`**.
- **Use when:** A spec exists and needs to become executable tasks; "create plan", "build plan".
- **Skip when:** No spec yet (→ pocket-grinding), or re-running a task already in execution (→ pocket-development directly).

### pocket-structuring
- **What:** Sequences execution for **split (≥7-task)** plans. Runs a CLI (`npx pocketto-pi structure`) that counts tasks and decides: passthrough or phase-split. The CLI counts exactly — never estimate.
- **Input:** A completed execution plan from pocket-planning.
- **Output:** Either nothing extra (passthrough), or a set of bounded phase files (`execution-plan-phase-N.md`).
- **Handoff:** ≤6 tasks → invokes `pocket-development` directly with the flat plan. ≥7 tasks → hands phase files to `pocket-development` **one at a time**, gating each phase's completion before the next.
- **Use when:** pocket-planning routed a ≥7-task (split) plan here, or a user invokes it directly (any size — ≤6 passes straight through to pocket-development).
- **Skip when:** Never skip for ≥7-task plans. Bypass requires the exact phrase `OVERRIDE: skip structuring`.

### pocket-development
- **What:** Precise subagent delegation, task-by-task. Main agent is **delegator + auditor only** — it never writes implementation code. Every spawn requires a Pocket Packet (the contract). Enforces 6 iron laws and an entry gate; after each implementer reports DONE it runs a mechanical gate (git log + tests + DELIVERABLE) then dispatches a read-only auditor subagent for the in-loop audit (spec compliance + code quality). Once every task in the phase is DONE it dispatches a phase-level pass over the whole phase — one read-only subagent over every task's diff range and packet — and, for any `REVIEW_FAIL` finding, delegates and records an append-only fix (never writes the fix itself). Supports parallel groups via git worktrees.
- **Input:** A flat plan (`execution-plan.md`, Type A) or a phase file (`execution-plan-phase-N.md`, Type B).
- **Output:** Committed, audited code, per-task review JSON (`<plan_dir>/reviews/<task>-review.json`), task statuses tracked in `log.json` via the CLI.
- **Handoff:** Emits a `PHASE_COMPLETE` handoff message naming `pocket-closing` as the user-triggered next step; on an all-`REVIEW_PASS` phase it can also auto-chain there after one confirmation.
- **Use when:** A plan/phase is ready and tasks are mostly independent; "execute plan", "delegate tasks", "dispatch subagents".
- **Skip when:** No plan yet (→ pocket-planning), or tasks are tightly coupled (manual execution / redesign).

### pocket-closing
- **What:** Terminal stage. Main agent is **reconciler + closer only** — it never reviews code. Reads `log.json` + every `reviews/*.json`, gates the close on review verdicts (any `REVIEW_FAIL`/`REVIEW_BLOCKED` blocks), advances passed phases `REVIEW → DONE` via the CLI, runs `log close`, and writes a closeout summary. State changes go through `pocketto-pi log` only — no hand-editing.
- **Input:** A reviewed phase/plan: `log.json` plus `reviews/<task>-review.json` for every reviewable task.
- **Output:** `log.json` header set to `DONE` + `date_completed`; `<plan_dir>/closeout.md`. States: `CLOSED`, `PHASE_ADVANCED`, `CLOSE_BLOCKED`, `ALREADY_CLOSED`.
- **Handoff:** Terminal — this is where the pipeline ends. For phased plans, `PHASE_ADVANCED` points back to pocket-development for the next phase.
- **Use when:** Reached automatically when pocket-development's phase-level pass chains here on an all-`REVIEW_PASS` phase (after one confirmation), or invoked directly by the user after reviews are written: `/pocketto:pocket-closing <plan_dir>`.
- **Skip when:** Any task is still `REVIEW_FAIL`/`REVIEW_BLOCKED` or unreviewed — follow pocket-development's phase-level pass Action Required block before re-closing.

---

## Standalone skills

### bug-hunting
- **What:** Root-cause-first debugging. Two modes — reactive (fix a known bug) and proactive (hunt for hidden bugs / audit). Both run the same 5 phases (Reconnaissance → Evidence Hunt → Blast Radius → Root Cause Trace → Resolution) under three iron laws: no fix without confirmed root cause, no claim without evidence, fix the source not the symptom.
- **Input:** A bug report, failing test, production error, or code to audit.
- **Output:** A confirmed root cause and a test-first fix at the source, with defense-in-depth.
- **Use when:** "fix this bug", "test failing", "why is X broken", "review/audit this code".
- **Skip when:** It's a feature, not a defect (→ grinding/hotfix).

### hotfix
- **What:** Fast, accurate iteration with a mandatory subagent plan-review gate. 5 steps: capture intent → write a 3–5 bullet brief plan → dispatch a subagent reviewer (validate-plan) → fix CRITICAL/WARNING findings → implement. The reviewer is the anti-self-confidence gate — you do not review your own plan.
- **Input:** A small-to-medium change request.
- **Output:** The implemented change, preceded by a reviewed brief plan.
- **Use when:** Brainstorm → spec → plan → review would be overkill but accuracy still matters; "quick fix", "small change", "just update X".
- **Skip when:** New feature, new system, architectural decision, or unclear requirements (→ pocket-grinding).

### brand-design
- **What:** A "Head of Brand" that turns vague brand language into a math-validated design system — OKLCH color derivation, WCAG-calculated contrast, modular type scale, atomic component states — confirmed via an HTML preview gate, then written as the source of truth. (Renamed from the former `pocket-branding`; standalone, no pipeline.)
- **Input:** Brand intent (name, audience, personality adjectives, platform).
- **Output:** `docs/pocket/rule/creative-brief.md` + `creative-brief-preview.html` + an enforcement rule at `.claude/rules/brand-design.md`, plus an optional generated token file compiled from the brief (Tailwind v4 `@theme` / v3 preset / plain CSS custom properties).
- **Use when:** Starting UI work without a design authority; "design system", "creative brief", "brand identity", "set up UI tokens", "export design tokens".
- **Skip when:** A `creative-brief.md` already exists and needs no change → just read it and build. (Refine mode handles scoped changes.)

### pocket-help
- **What:** This skill — the onboarding and routing entry point. Summarizes every skill so you can orient and route without loading each `SKILL.md`.
- **Input:** A question about Pocket (what it is, which skill, how the flow works).
- **Output:** Orientation + a routing decision pointing you to exactly one skill.
- **Use when:** New to Pocket, unsure which skill fits, or comparing Pocket to lighter flows.
- **Skip when:** You already know which stage you're in — open that skill directly.

### pocket-init
- **What:** Brownfield onboarding. Scans the repo (stack, real build/test/lint commands, layout, conventions), writes an evidence-based project guide into a merge-safe managed section of the memory file (`CLAUDE.md` on Claude Code, `AGENTS.md` on Pi), then — only on explicit opt-in — enables Pocket Enterprise (`mode init`) and scaffolds `.github/` issue + PR templates (`scaffold github`).
- **Input:** An existing project directory (defaults to the repo root).
- **Output:** Created/merged memory file; optionally the enterprise config block, `.gitattributes`, and GitHub templates.
- **Use when:** Adopting Pocket in an existing repo, regenerating a stale project guide, or enabling enterprise mode for a team.
- **Skip when:** The memory file is current and enterprise is already configured.

### create-pr
- **What:** Pocket Enterprise PR recorder. Opens (or reuses — idempotent by meta and branch) the GitHub PR for a completed development phase on the **current branch**; never manages branches. Commits traveling state (`log.json`, plan + spec docs) first, formats a What/Why/How-to-Test body linked to the Pocket issue (`refs #N` mid-plan, `closes #N` on the final phase), and records the PR in `.pocket-meta.json`.
- **Input:** `<plan_dir>` (+ optional `<phase_file>`) with DONE tasks, enterprise mode on, a linked issue in meta.
- **Output:** A PR on GitHub + `phases.<phase_key>.github_pr.*` in `.pocket-meta.json`. States: `PR_READY` or `PR_REUSED`.
- **Use when:** Enterprise mode is on and a phase completed — typically when pocket-development offers it at PHASE_COMPLETE.
- **Skip when:** Enterprise mode is off (the skill stops by design), or the phase has no linked issue yet (run grinding's issue step first).

### structured-research
- **What:** Validates an explicit assumption against evidence. Operationalizes the belief into a falsifiable question, recommends 1–3 research methods (non-binding) from a catalog (`references/research-methods.csv`), gathers cited evidence, runs a curation gate, then grades the result.
- **Input:** One explicit assumption the user still treats as unverified (a technical claim, a library's behavior, a "this is probably how X works").
- **Output:** A graded verdict — Confirmed / Refuted / Inconclusive — with cited evidence and a non-binding recommendation (`docs/pocket/research/<date>-<slug>/research-report.md`).
- **Use when:** A belief is about to enter planning/development unvalidated; "validate this assumption", "is it true that…", "research whether…".
- **Skip when:** Generating/exploring ideas (→ pocket-pitching/grinding), fixing a known defect (→ bug-hunting), or the claim is already settled (→ hotfix).
