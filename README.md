<div align="center">

# 🪐 Pocketto

**Structured AI coding workflows for [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Pi](https://github.com/badlogic/pi-mono).**
From a rough idea to reviewed, shipped code — without the agent improvising.

[![npm](https://img.shields.io/npm/v/pocketto-pi?color=cb3837&logo=npm)](https://www.npmjs.com/package/pocketto-pi)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](https://docs.claude.com/en/docs/claude-code)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

---

## Why Pocketto?

Coding agents are great at *writing* code and bad at *not skipping steps*. Pocketto adds the missing discipline:

- **Plan before code.** Specs, acceptance criteria, and TDD-structured plans come before a single line is written.
- **Delegate with contracts.** Every subagent gets a "Pocket Packet" — objective, verification, stop conditions. No packet, no spawn.
- **Gate before done.** Reviews and a hard close step keep finished work from rotting in `IN_PROGRESS` limbo.

11 skills, one namespace, zero lock-in — reach for the full pipeline on real features, or grab a standalone skill for everyday work.

<p align="center">
  <img src="assets/pipeline.svg" alt="The Pocket pipeline: pitching → grinding → planning → structuring → development → review → closing, plus standalone skills (pocket-help, bug-hunting, hotfix, brand-design)" width="100%">
</p>

## Install

<table>
<tr><th>Pi</th><th>Claude Code</th></tr>
<tr><td>

```bash
pi install git:github.com/rfxlamia/pocketto
# or
pi install npm:pocketto-pi
```

</td><td>

```bash
/plugin marketplace add rfxlamia/pocketto
/plugin install pocketto@pocketto
/reload-plugins
```

</td></tr>
</table>

> **New here?** Start with [`pocket-help`](#standalone-skills) — a compact router that explains what Pocket is and which skill to reach for, without loading every skill into context.

## Quickstart

Run a feature through the full pipeline — each stage hands off to the next:

```bash
/pocketto:pocket-grinding   "add dark mode toggle"   # → spec + acceptance criteria
/pocketto:pocket-planning                            # → TDD execution plan
/pocketto:pocket-development                          # → subagents build it, task by task
/pocketto:pocket-review     <plan_dir>               # → parallel reviewers gate the work
/pocketto:pocket-closing    <plan_dir>               # → reconcile, close, summarize
```

Or just fix something:

```bash
/pocketto:bug-hunting   "checkout total is off by one cent"
/pocketto:hotfix        "bump the rate-limit window to 60s"
```

## The 11 skills

### Pipeline (chained)

Each stage invokes the next at handoff, carrying spec, plan, and acceptance criteria forward. Use these for real features and non-trivial work.

| # | Skill | When to reach for it |
|---|-------|----------------------|
| 1 | `pocket-pitching` | Rough idea, no clear problem yet |
| 2 | `pocket-grinding` | Clear problem — need a spec + acceptance criteria |
| 3 | `pocket-planning` | Spec ready — need an execution plan |
| 4 | `pocket-structuring` | Plan ready — passthrough ≤6 tasks, phase-split ≥7 |
| 5 | `pocket-development` | Plan ready — execute task-by-task via subagents |
| 6 | `pocket-review` | After a phase/plan is DONE (user-triggered) |
| 7 | `pocket-closing` | After reviews pass — gate, close, summarize |

### Standalone skills

Lighter, single-purpose, no pipeline. Reach for these for everyday work.

| Skill | When to reach for it |
|-------|----------------------|
| `pocket-help` | "What is Pocket?", which skill to use, how the flow works |
| `bug-hunting` | Fix a bug, debug a failure, audit code for hidden bugs |
| `hotfix` | Small-to-medium change where the full pipeline is overkill |
| `brand-design` | Design system, creative brief, brand identity, UI tokens |

<details>
<summary><b>📖 Full skill reference</b> — what each skill actually does</summary>

<br>

**`pocket-pitching`** — Pre-grinding problem exploration. Use **before** `pocket-grinding` when the problem is unformed. Guides diverge→converge with structured brainstorming and LLM-to-LLM curation, then produces a pitch exploration doc.
*Trigger:* "pitch this", "explore this idea", "I have a rough idea".

**`pocket-grinding`** — BDD-driven feature/fix discovery before any implementation. Use when planning a feature, designing a fix, or exploring options. Invokes `pocket-planning` at handoff.
*Trigger:* "pocket-grinding", "brainstorm", "think through", "plan this", "before we build".

**`pocket-planning`** — Converts a `pocket-grinding` spec into a TDD-structured execution plan of full Pocket Packets. Outputs tasks ready to dispatch via `pocket-development`.
*Trigger:* "create plan", "build plan", or invoked by `pocket-grinding`.

**`pocket-structuring`** — Splits a `pocket-planning` plan into sequential phase files. Passthrough below 7 tasks, phase-split at ≥7. Produces phase files for `pocket-development`, one at a time.
*Trigger:* "structure plan", "split plan", or invoked by `pocket-planning`.

**`pocket-development`** — Precise subagent delegation for task-by-task execution. Every delegation requires a Pocket Packet — a structured contract with objective, verification criteria, and stop conditions. Enforces 6 iron laws: no packet = no spawn.
*Trigger:* "execute plan", "delegate tasks", "dispatch subagents".

**`pocket-review`** — Post-phase batch reviewer. **User-triggered** after `pocket-development` marks a phase/plan DONE — it does NOT auto-call. Dispatches parallel reviewer subagents (one per task), each covering spec compliance and code quality, then writes results to `reviews/`. Returns `PHASE_REVIEWED` or `PHASE_BLOCKED`.
*Trigger:* `/pocketto:pocket-review <plan_dir>`.

**`pocket-closing`** — Terminal stage. **User-triggered** after `pocket-review` writes verdicts. Reconciles every `reviews/*.json` against `log.json`, gates the close on verdicts (any fail or unreviewed task → `CLOSE_BLOCKED`), advances passed phases `REVIEW → DONE`, runs `log close`, and writes `closeout.md`. Returns `CLOSED`, `PHASE_ADVANCED`, `CLOSE_BLOCKED`, or `ALREADY_CLOSED`.
*Trigger:* `/pocketto:pocket-closing <plan_dir>`.

**`bug-hunting`** — Systematic debugging with confirmed root cause before any fix. Reactive (fix known bug) and proactive (hunt hidden bugs) modes. Enforces: claim ≠ evidence ≠ root cause ≠ fix.
*Trigger:* "fix bug", "debug", "why is X broken", or proactive code review.

**`hotfix`** — Fast iteration for small-to-medium changes. Enforces brief-plan + subagent-review gates before implementation — accuracy without full pipeline ceremony.
*Trigger:* "quick fix", "small change", "just update X".

**`brand-design`** — Brand-aware design system generator that acts as Head of Brand. Translates abstract brand language into a mathematically-validated, implementation-ready design system, then writes `creative-brief.md` as the source of truth for all UI/UX.
*Trigger:* "brand-design", "design system", "creative brief", "brand identity", "set up UI tokens".
*Deliverables:* `docs/pocket/rule/creative-brief.md`, `creative-brief-preview.html`, `.claude/rules/brand-design.md`.

**`pocket-help`** — Compact onboarding and routing guide for the whole system. Explains what Pocket is, when it beats lighter flows, and which skill to invoke — without loading every skill into context.
*Trigger:* "what is pocket", "how do I use pocket", "which pocket skill", "pocket-help".

</details>

## CLI

The `pocket-structuring` and `pocket-development` skills drive a single cross-platform Node CLI, run via `npx` — no install, PATH setup, or Python required. Works the same on Windows, macOS, and Linux. Requires Node.js ≥ 18.

| Command | What it does |
|---------|--------------|
| `npx pocketto-pi structure <execution-plan.md> [--dry-run]` | Split a plan into phase files (passthrough if < 7 tasks) |
| `npx pocketto-pi log init <plan_dir>` | Initialize `log.json` for a plan directory |
| `npx pocketto-pi log update <plan_dir> <phase_file> <status> [--task TN]` | Update phase or task status |
| `npx pocketto-pi log close <plan_dir>` | Finalize log after all phases complete |

Status flow: `WAITING` → `REVIEW` → `DONE` \| `BLOCKED`

Add `--json` for a stable output envelope — `{ ok, command, cliVersion, contract, data, error }` — that skills parse instead of scraping text. Add `--contract <N>` for a version handshake that fails loudly on mismatch rather than emitting output an older skill can't read.

## License

[MIT](LICENSE) © [rfxlamia](https://github.com/rfxlamia)
