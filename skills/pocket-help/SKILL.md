---
name: pocket-help
description: Onboarding and routing guide for the Pocket skill ecosystem. Use when someone asks what Pocket is, which Pocket skill to use, how the end-to-end flow works, or when Pocket is better than lighter Superpowers-style flows. Trigger on "what is pocket", "how do I use pocket", "which pocket skill", "explain pocket", "pocket-help", or any onboarding/routing question. This is a compact entry point — it summarizes every skill so agents and users do NOT have to load each SKILL.md to orient.
---

# Pocket Help

The map of the Pocket ecosystem. Read this first to understand what Pocket is, pick the right skill for the moment, and run the full flow from rough idea to reviewed code — **without loading every skill into context.**

**Core principle:** Orient cheaply, then load deep. This skill is a summary and a router. Load an individual skill's `SKILL.md` only when you reach the stage that uses it. That is the whole point — it preserves the context window for the actual work.

**This skill does not replace the detailed skills.** It tells you which one to open next.

## What Pocket Is

Pocket is a set of skills for **systematic, structured development** — from a vague idea to shipped, reviewed code. Instead of one agent improvising an entire feature in a single long thread, Pocket breaks the work into bounded stages with explicit gates: explore → specify (BDD) → plan (TDD) → phase → delegate → review.

Each stage produces a concrete artifact (pitch doc → spec → execution plan → phase files → commits → review reports) that the next stage consumes. Gates between stages force confirmation before proceeding, which is what keeps a long build from drifting.

## Two Kinds of Skills

| Kind | Skills | Use for |
|------|--------|---------|
| **Chained** (`pocket-*`) | pocket-pitching · pocket-grinding · pocket-planning · pocket-structuring · pocket-development · pocket-review | Real features, non-trivial work. Each stage hands off to the next, carrying spec/plan/criteria forward. |
| **Standalone** (lighter, daily use) | bug-hunting · hotfix · brand-design · pocket-help | Everyday work that does NOT need the full pipeline. Single-purpose, no handoff chain. |

The `pocket-*` prefix marks a skill as part of the chained pipeline. `bug-hunting`, `hotfix`, and `brand-design` are deliberately *not* prefixed — they stand alone and are the right, lighter choice for most day-to-day tasks.

## Router — Which Skill Right Now?

Match your situation to one skill. Open only that skill.

| Your situation | Skill | Kind |
|----------------|-------|------|
| Rough idea, no clear problem yet — need to explore | `pocket-pitching` | chained |
| Clear problem — need a spec + acceptance criteria | `pocket-grinding` | chained |
| Approved spec — need a TDD execution plan | `pocket-planning` | chained |
| Execution plan ready — sequence/phase it | `pocket-structuring` | chained |
| Plan or phase file ready — execute task-by-task | `pocket-development` | chained |
| A phase/plan is DONE — review it | `pocket-review` | chained |
| A bug, a failure, or "audit this code" | `bug-hunting` | standalone |
| Small-to-medium change, full pipeline is overkill | `hotfix` | standalone |
| Design system / brand identity / UI tokens | `brand-design` | standalone |
| "What is Pocket / which skill / how does this flow?" | `pocket-help` (you are here) | standalone |

**Routing rules of thumb:**
- Don't know if the problem is even well-formed? → `pocket-pitching`.
- Problem is clear but it's a real feature? → start at `pocket-grinding`.
- It's a quick, well-understood change? → `hotfix` (not the pipeline).
- Something is broken? → `bug-hunting` (not the pipeline).
- Already have an approved spec? → skip pitching/grinding, start at `pocket-planning`.

## The End-to-End Flow (chained pipeline)

```
rough idea
   │  pocket-pitching        explore → pitch doc (2–3 directions)        [user picks next]
   ▼
clear problem
   │  pocket-grinding        BDD discovery → spec + GWT acceptance       [auto-invokes planning]
   ▼
approved spec
   │  pocket-planning        TDD plan → Pocket Packets, tests designed   [auto-invokes structuring]
   ▼
execution plan
   │  pocket-structuring     ≤6 tasks: passthrough · ≥7: split to phases [hands phases one at a time]
   ▼
plan / phase file
   │  pocket-development      delegate task-by-task via subagents         [emits PHASE_COMPLETE]
   ▼
phase DONE
   │  pocket-review          USER triggers · parallel review subagents    [PHASE_REVIEWED / BLOCKED]
   ▼
fix findings → continue phases until the whole plan is complete
```

**Handoff facts that matter (so you don't double-invoke or stall):**
- `pocket-grinding` **auto-invokes** `pocket-planning` after you approve the spec.
- `pocket-planning` **auto-invokes** `pocket-structuring` after you approve the plan.
- `pocket-structuring` runs for **every** plan: ≤6 tasks pass straight through to `pocket-development`; ≥7 tasks are split into phase files handed off **one at a time**.
- `pocket-development` does **NOT** call `pocket-review`. It emits a `PHASE_COMPLETE` handoff; **you** invoke `pocket-review` afterward.
- `pocket-pitching` does **not** auto-chain — it presents handoff options and you choose whether to start `pocket-grinding`.

> The pipeline diagram inside `pocket-review` and `pocket-development` also names a final `pocket-closing` step (log closeout). That terminal step is referenced by the design but is **not yet a skill in this repo** — today the chain ends at `pocket-review`.

For the flow walked stage-by-stage with a worked example and every gate, load `references/end-to-end-flow.md`.

## When Pocket Beats a Lighter Flow

If you already use Superpowers-style skills (or just let one agent code straight through), Pocket is **stronger** when the work has any of these:

- **High ambiguity** — the problem isn't crisp yet (pitching/grinding force clarity first).
- **Multi-step build** — many tasks across files/layers (planning + development bound each one).
- **BDD/TDD discipline required** — acceptance criteria and test-first are non-negotiable.
- **Subagent delegation** — work spread across implementers needs contracts, not vibes.
- **Phase gates** — long builds drift; phase boundaries are checkpoints.
- **Context preservation** — phasing + summaries stop the thread from blowing its window.
- **Auditable execution** — every task has evidence (commits, tests, review reports).

Pocket is **overkill** when the change is small and well-understood. Then:
- known bug / failure → `bug-hunting`
- quick small-to-medium change → `hotfix`
- just UI tokens / a brand → `brand-design`

For the full comparison and a "which do I reach for?" decision guide, load `references/pocket-vs-superpowers.md`.

## Context Budget Guidance

This skill exists to protect your context window. Follow this order:

1. **Start here** (`pocket-help`) to orient and route.
2. **Load one skill** — the single skill for your current stage. Not the whole set.
3. **Load that skill's references on demand** — each skill lists Reference Triggers; pull a reference only when its step says to.

Reading every `pocket-*` SKILL.md up front (≈2,800 lines combined) is exactly the waste this skill prevents.

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/skill-map.md` | Need a one-block summary of each skill — what it does, its input, its output/handoff, when to use vs skip |
| `references/end-to-end-flow.md` | Need the full pipeline walked stage-by-stage with a worked example and gates |
| `references/pocket-vs-superpowers.md` | Deciding between Pocket and a lighter Superpowers-style / standalone flow |
