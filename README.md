# pocketto

> Pocket-driven development skills: structured subagent delegation, bug hunting, iterative planning, and code review workflows.

Provides 9 skills for systematic, structured development — from raw idea to shipped code.

## Installation

### Pi (Pocket)

```bash
pi install git:github.com/rfxlamia/pocketto
```

Or from npm:

```bash
pi install npm:pocketto-pi
```

### Claude Code

```bash
/plugin marketplace add rfxlamia/pocketto
/plugin install pocketto@pocketto
/reload-plugins
```

Use skills with the `pocketto:` namespace:

```
/pocketto:pocket-grinding
/pocketto:pocket-planning
/pocketto:pocket-development
```

---

## Skills

### The Pocket Pipeline

Skills are designed to chain together in sequence:

```
pocket-pitching → pocket-grinding → pocket-planning → pocket-structuring → pocket-development → pocket-review
                                                                                ↑ invoked internally ↑
```

| Skill | Trigger |
|-------|---------|
| `pocket-pitching` | Rough idea, no clear problem yet |
| `pocket-grinding` | Clear problem, need spec + acceptance criteria |
| `pocket-planning` | Spec ready, need execution plan |
| `pocket-structuring` | Plan has ≥7 tasks, needs phase splitting |
| `pocket-development` | Plan ready, execute task-by-task via subagents |
| `pocket-review` | Called internally by pocket-development after each task |
| `pocket-branding` | Design system, creative brief, brand identity, UI tokens |

---

### `pocketto:pocket-pitching`

Pre-grinding problem exploration. Use **before** `pocket-grinding` when the problem is unformed or needs exploration. Guides diverge→converge with structured brainstorming methods and LLM-to-LLM curation, then produces a pitch exploration doc.

**Trigger:** "pitch this", "explore this idea", "I have a rough idea"

---

### `pocketto:pocket-grinding`

BDD-driven feature/fix discovery before any implementation. Use when planning a feature, designing a fix, or exploring options before building. Invokes `pocket-planning` at handoff.

**Trigger:** "pocket-grinding", "brainstorm", "think through", "plan this", "before we build"

---

### `pocketto:pocket-planning`

Converts a `pocket-grinding` spec into a TDD-structured execution plan of full Pocket Packets. Outputs tasks ready to dispatch via `pocket-development`.

**Trigger:** "create plan", "build plan", or invoked by `pocket-grinding`

---

### `pocketto:pocket-structuring`

Splits a `pocket-planning` execution plan into sequential phase files. Use when the plan has ≥7 tasks. Produces phase files for `pocket-development`, one at a time.

**Trigger:** "structure plan", "split plan", or invoked by `pocket-planning`

---

### `pocketto:pocket-development`

Precise subagent delegation for task-by-task execution. Every delegation requires a Pocket Packet — a structured contract with objective, verification criteria, and stop conditions. Enforces 6 iron laws: no packet = no spawn.

**Trigger:** "execute plan", "delegate tasks", "dispatch subagents"

---

### `pocketto:pocket-review`

Independent two-stage review: spec compliance (Stage 1) then code quality (Stage 2). Called automatically by `pocket-development` after each implementer reports DONE. Returns `REVIEW_PASS`, `REVIEW_FAIL`, or `REVIEW_BLOCKED`.

**Trigger:** Invoked internally by `pocket-development` — not called directly.

---

### `pocketto:bug-hunting`

Systematic debugging with confirmed root cause before any fix. Two modes: reactive (fix known bug) and proactive (hunt for hidden bugs). Enforces the rule: claim ≠ evidence ≠ root cause ≠ fix.

**Trigger:** "fix bug", "debug", "why is X broken", or proactive code review

---

### `pocketto:hotfix`

Fast iteration workflow for small-to-medium changes. Enforces brief-plan + subagent-review gates before implementation — accuracy without full pocket pipeline ceremony.

**Trigger:** "quick fix", "small change", "just update X"

---

### `pocketto:pocket-branding`

Brand-aware design system generator that acts as Head of Brand. Translates abstract brand language into a mathematically-validated, implementation-ready design system, then writes `creative-brief.md` as the source of truth for all UI/UX in a project. Standalone skill (like bug-hunting and hotfix — no full pipeline required).

**Trigger:** "pocket-branding", "design system", "creative brief", "define the brand", "brand identity", "set up UI tokens"

**Deliverables:**
- `docs/pocket/rule/creative-brief.md` — the design system source of truth
- `docs/pocket/rule/creative-brief-preview.html` — visual preview for alignment
- `.claude/rules/pocket-branding.md` — enforcement rule for future UI work

## CLI Tools

The plugin adds these executables to PATH (used by `pocket-development`):

| Command | Usage |
|---------|-------|
| `pocket-log-init <plan_dir>` | Initialize `log.json` for a plan directory |
| `pocket-log-update <plan_dir> <phase_file> <status> [--task TN]` | Update phase or task status |
| `pocket-log-close <plan_dir>` | Finalize log after all phases complete |
| `pocket-structure <execution-plan.md>` | Split plan into phase files |

Status values: `WAITING` → `REVIEW` → `DONE` \| `BLOCKED`

---

## License

MIT
