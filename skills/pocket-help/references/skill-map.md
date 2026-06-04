# Skill Map

One block per skill: what it does, what it consumes, what it produces, and when to use vs skip. Load a skill's own `SKILL.md` only when you're ready to run that stage.

Two kinds of skills:

- **Chained** (`pocket-*`) — pipeline stages that hand off to one another.
- **Standalone** — `bug-hunting`, `hotfix`, `brand-design`, `pocket-help`. Lighter, single-purpose, no handoff chain. The right choice for most everyday work.

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
- **What:** Converts a spec into a TDD-structured execution plan. Scans codebase, maps files, decomposes acceptance criteria into bounded tasks, writes full 7-field Pocket Packets (red → green → commit), then runs a spec-reviewer and a test-architect subagent.
- **Input:** A completed pocket-grinding spec (path + acceptance criteria + architecture constraints + design decision).
- **Output:** An execution plan of Pocket Packets with tests designed (`docs/pocket/plans/<date>-<slug>/execution-plan.md`).
- **Handoff:** **Auto-invokes `pocket-structuring`** after the user approves the plan.
- **Use when:** A spec exists and needs to become executable tasks; "create plan", "build plan".
- **Skip when:** No spec yet (→ pocket-grinding), or re-running a task already in execution (→ pocket-development directly).

### pocket-structuring
- **What:** Bridges planning and development for **every** plan. Runs a CLI (`npx pocketto-pi structure`) that counts tasks and decides: passthrough or phase-split. The CLI counts exactly — never estimate.
- **Input:** A completed execution plan from pocket-planning.
- **Output:** Either nothing extra (passthrough), or a set of bounded phase files (`execution-plan-phase-N.md`).
- **Handoff:** ≤6 tasks → invokes `pocket-development` directly with the flat plan. ≥7 tasks → hands phase files to `pocket-development` **one at a time**, gating each phase's completion before the next.
- **Use when:** pocket-planning produced a plan (any size). Always runs — the universal gate lives here.
- **Skip when:** Never skip for ≥7-task plans. Bypass requires the exact phrase `OVERRIDE: skip structuring`.

### pocket-development
- **What:** Precise subagent delegation, task-by-task. Main agent is **delegator + auditor only** — it never writes implementation code. Every spawn requires a Pocket Packet (the contract). Enforces 6 iron laws and an entry gate; runs a quick audit (git log + tests + DELIVERABLE) after each implementer reports DONE. Supports parallel groups via git worktrees.
- **Input:** A flat plan (`execution-plan.md`, Type A) or a phase file (`execution-plan-phase-N.md`, Type B).
- **Output:** Committed, audited code, task statuses tracked in `log.json` via the CLI.
- **Handoff:** Emits a `PHASE_COMPLETE` handoff message. Does **NOT** invoke pocket-review — that is user-triggered.
- **Use when:** A plan/phase is ready and tasks are mostly independent; "execute plan", "delegate tasks", "dispatch subagents".
- **Skip when:** No plan yet (→ pocket-planning), or tasks are tightly coupled (manual execution / redesign).

### pocket-review
- **What:** Post-phase batch reviewer. Main agent runs preflight (validates log.json, computes per-task SHA ranges) and dispatches **parallel** reviewer subagents — one per task — then collects results into `reviews/`. No review loop: fix and re-run.
- **Input:** A completed phase/plan with `log.json` (all target tasks DONE with `done_sha`).
- **Output:** Per-task review JSON (`<plan_dir>/reviews/<task>-review.json`) + a summary table. States: `PHASE_REVIEWED` or `PHASE_BLOCKED`.
- **Handoff:** Terminal in this repo. (The pipeline diagram names a later `pocket-closing` log-closeout step, which is **not yet a skill here**.)
- **Use when:** **The user** invokes it after pocket-development finishes a phase/flat plan: `/pocketto:pocket-review <plan_dir>`.
- **Skip when:** During development (pocket-development does its own per-task quick audit; full review is the separate post-phase step).

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
- **Output:** `docs/pocket/rule/creative-brief.md` + `creative-brief-preview.html` + an enforcement rule at `.claude/rules/brand-design.md`.
- **Use when:** Starting UI work without a design authority; "design system", "creative brief", "brand identity", "set up UI tokens".
- **Skip when:** A `creative-brief.md` already exists and needs no change → just read it and build. (Refine mode handles scoped changes.)

### pocket-help
- **What:** This skill — the onboarding and routing entry point. Summarizes every skill so you can orient and route without loading each `SKILL.md`.
- **Input:** A question about Pocket (what it is, which skill, how the flow works).
- **Output:** Orientation + a routing decision pointing you to exactly one skill.
- **Use when:** New to Pocket, unsure which skill fits, or comparing Pocket to lighter flows.
- **Skip when:** You already know which stage you're in — open that skill directly.
