# pocketto

> Pocket-driven development skills: structured subagent delegation, bug hunting, iterative planning, and code review workflows.

Provides 10 skills for systematic, structured development — from raw idea to shipped code.

New here? Start with [`pocketto:pocket-help`](#pocketto-pocket-help) — a compact onboarding and routing guide to the whole system. It explains what Pocket is and which skill to reach for, without loading every skill into context.

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

Pocket has two kinds of skills:

- **Chained skills** (`pocket-*`) — the multi-stage pipeline. Each stage invokes the next at handoff, carrying spec, plan, and acceptance criteria forward. Use these for real features and non-trivial work.
- **Standalone skills** (`pocket-help`, `bug-hunting`, `hotfix`, `brand-design`) — lighter, single-purpose, no pipeline. Reach for these for everyday work.

### The Pocket Pipeline (chained)

Skills are designed to chain together in sequence:

```
pocket-pitching → pocket-grinding → pocket-planning → pocket-structuring → pocket-development → pocket-review
```

| Skill | Trigger |
|-------|---------|
| `pocket-pitching` | Rough idea, no clear problem yet |
| `pocket-grinding` | Clear problem, need spec + acceptance criteria |
| `pocket-planning` | Spec ready, need execution plan |
| `pocket-structuring` | Plan ready (any size) — passthrough ≤6 tasks, phase-split ≥7 |
| `pocket-development` | Plan ready, execute task-by-task via subagents |
| `pocket-review` | User-triggered after a phase/plan is DONE |

### Standalone skills

| Skill | Trigger |
|-------|---------|
| `pocket-help` | "What is Pocket?", which skill to use, how the flow works |
| `bug-hunting` | Fix a bug, debug a failure, audit code for hidden bugs |
| `hotfix` | Small-to-medium change where the full pipeline is overkill |
| `brand-design` | Design system, creative brief, brand identity, UI tokens |

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

### `pocketto:brand-design`

Brand-aware design system generator that acts as Head of Brand. Translates abstract brand language into a mathematically-validated, implementation-ready design system, then writes `creative-brief.md` as the source of truth for all UI/UX in a project. Standalone skill (like bug-hunting and hotfix — no full pipeline required).

**Trigger:** "brand-design", "design system", "creative brief", "define the brand", "brand identity", "set up UI tokens"

**Deliverables:**
- `docs/pocket/rule/creative-brief.md` — the design system source of truth
- `docs/pocket/rule/creative-brief-preview.html` — visual preview for alignment
- `.claude/rules/brand-design.md` — enforcement rule for future UI work

---

### `pocketto:pocket-help`

Compact onboarding and routing guide for the whole Pocket system. Explains what Pocket is, when it beats lighter Superpowers-style flows, which skill to invoke for the situation, and the full idea→reviewed-code flow — all without loading every individual skill into context. Frames itself as an entry point, not a replacement for the detailed skills.

**Trigger:** "what is pocket", "how do I use pocket", "which pocket skill", "pocket-help", or any onboarding/routing question about the Pocket ecosystem.

## CLI

The `pocket-structuring` and `pocket-development` skills drive a single cross-platform
Node CLI, run via `npx` — no install step, PATH setup, or Python required. Works the same
on Windows, macOS, and Linux. Requires Node.js ≥ 18 (already part of the npm toolchain).

| Command | Usage |
|---------|-------|
| `npx pocketto-pi structure <execution-plan.md> [--dry-run]` | Split a plan into phase files (passthrough if < 7 tasks) |
| `npx pocketto-pi log init <plan_dir>` | Initialize `log.json` for a plan directory (migrates task-less logs) |
| `npx pocketto-pi log update <plan_dir> <phase_file> <status> [--task TN]` | Update phase or task status |
| `npx pocketto-pi log close <plan_dir>` | Finalize log after all phases complete |

Status values: `WAITING` → `REVIEW` → `DONE` \| `BLOCKED`

Add `--json` for a stable output envelope — `{ ok, command, cliVersion, contract, data, error }` —
that skills parse instead of scraping text. Add `--contract <N>` for a version handshake: a
mismatch fails loudly with guidance rather than emitting output an older skill can't read.

---

## License

MIT
