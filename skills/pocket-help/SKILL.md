---
name: pocket-help
description: Onboarding and routing guide for the Pocket skill ecosystem. Use when someone asks what Pocket is, which skill to use, or how the local development flow works. Trigger on "what is pocket", "how do I use pocket", "which pocket skill", "explain pocket", or "pocket-help".
---

# Pocket Help

The map of the Pocket ecosystem. Read this first to understand the workflow, choose the right skill, and continue from the current stage without loading every `SKILL.md`.

**Core principle:** Orient cheaply, then load deep. This skill summarizes and routes; open an individual skill only when reaching the stage that uses it.

## What Pocket Is

Pocket is a set of skills for systematic development — from a vague idea to reviewed code. It breaks work into bounded stages with explicit gates: explore → specify → plan → structure → develop → close.

Each stage produces an artifact (pitch doc → spec → execution plan → task files → commits → review reports) that the next stage consumes.

## Two Kinds of Skills

| Kind | Skills | Use for |
|------|--------|---------|
| **Chained** (`pocket-*`) | pocket-pitching · pocket-grinding · pocket-planning · pocket-structuring · pocket-development · pocket-closing | Real features and non-trivial work that need a reviewed handoff between stages. |
| **Standalone** | bug-hunting · hotfix · brand-design · structured-research · pocket-help · pocket-init | Everyday work that does not need the full pipeline. |

The `pocket-*` prefix marks pipeline stages, with `pocket-help` and `pocket-init` as standalone orientation/onboarding helpers. `bug-hunting`, `hotfix`, `brand-design`, and `structured-research` are also standalone.

## Router — Which Skill Right Now?

| Your situation | Skill | Kind |
|----------------|-------|------|
| Rough idea, no clear problem yet — need to explore | `pocket-pitching` | chained |
| Clear problem — need a spec + acceptance criteria | `pocket-grinding` | chained |
| Approved spec — need a TDD execution plan | `pocket-planning` | chained |
| Execution plan ready — sequence/phase it | `pocket-structuring` | chained |
| Plan or phase file ready — execute task-by-task | `pocket-development` | chained |
| Phase-level pass complete — reconcile and close | `pocket-closing` | chained |
| A bug, a failure, or "audit this code" | `bug-hunting` | standalone |
| Small-to-medium change, full pipeline is overkill | `hotfix` | standalone |
| Design system / brand identity / UI tokens | `brand-design` | standalone |
| An assumption to validate before planning | `structured-research` | standalone |
| New to Pocket or unsure which skill fits | `pocket-help` | standalone |
| Existing repo needs a local project guide | `pocket-init` | standalone |

**Routing rules of thumb:**
- Don't know if the problem is well-formed? → `pocket-pitching`.
- Problem is clear but needs a real feature plan? → `pocket-grinding`.
- It's a quick, well-understood change? → `hotfix`.
- Something is broken? → `bug-hunting`.
- Holding an unverified assumption? → `structured-research`.
- Already have an approved spec? → `pocket-planning`.

## The End-to-End Flow

```text
rough idea
   │  pocket-pitching     explore → pitch doc             [user chooses next]
   ▼
clear problem
   │  pocket-grinding     BDD discovery → approved spec   [hands off to planning]
   ▼
approved spec
   │  pocket-planning     TDD plan → full task packets    [routes to structuring]
   ▼
execution plan
   │  pocket-structuring  index + task files              [execution approval]
   ▼
plan / phase file
   │  pocket-development  task execution + in-loop audits [phase-level pass]
   ▼
reviewed phase
   │  pocket-closing      verdict reconciliation + close  [user-triggered]
```

**Handoff facts that matter:**
- `pocket-grinding` hands an approved spec to `pocket-planning`.
- `pocket-planning` validates the plan and routes all plans to `pocket-structuring`.
- `pocket-structuring` creates an execution index and per-task files, then asks for execution approval.
- `pocket-development` executes tasks, records per-task verdicts, and runs a phase-level pass. It leaves the phase in `REVIEW` and names `pocket-closing` as the next user-triggered step.
- `pocket-closing` reconciles verdicts and advances a reviewed phase; it does not review implementation code.
- `pocket-pitching` does not auto-chain — the user chooses whether to start `pocket-grinding`.

For the full stage-by-stage walkthrough, load `references/end-to-end-flow.md`. For concise inputs, outputs, and routing notes, load `references/skill-map.md`.

## When Pocket Beats a Lighter Flow

Use the full pipeline when work has high ambiguity, spans many steps, needs BDD/TDD discipline, or requires phase gates and auditable handoffs.

For smaller work, choose a focused skill:
- known bug or failure → `bug-hunting`
- small-to-medium change → `hotfix`
- design system or UI tokens → `brand-design`
- an assumption to validate → `structured-research`

For the full comparison, load `references/pocket-vs-superpowers.md`.

## Context Budget Guidance

1. Start here to orient and route.
2. Load one skill for the current stage.
3. Load that skill's references only when its instructions call for them.
