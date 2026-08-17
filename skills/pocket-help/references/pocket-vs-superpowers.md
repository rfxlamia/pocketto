# Pocket vs Superpowers-Style Flows

For users who already work with Superpowers-style skills (or just let one agent code straight through a thread). This explains where Pocket is genuinely stronger, where a lighter flow is the better call, and how to decide quickly.

## The Core Difference

A Superpowers-style flow optimizes for **momentum**: one capable agent moves from request to result in a single thread. That's excellent for bounded, well-understood work.

Pocket optimizes for **structure under ambiguity and scale**: it splits work into staged artifacts (pitch → spec → plan → phases → commits → reviews) with gates between them. The cost is ceremony; the payoff is that long, ambiguous, multi-agent builds don't drift, don't blow the context window, and stay auditable.

Neither is "better" everywhere. Match the tool to the work.

## Where Pocket Is Stronger

| Condition | Why Pocket wins |
|-----------|-----------------|
| **High ambiguity** | pocket-pitching and pocket-grinding force the problem to be defined and scoped *before* any code — instead of discovering the real requirement halfway through implementation. |
| **Multi-step builds** | pocket-planning decomposes into bounded tasks; pocket-development executes each under a contract. No single mega-prompt trying to hold the whole feature at once. |
| **BDD/TDD discipline** | Acceptance criteria are Given-When-Then; every Pocket Packet is failing-test → minimal code → commit. Test-first is structural, not aspirational. |
| **Subagent delegation** | Each delegation is a Pocket Packet (explicit objective, verification, stop conditions). Iron law: no packet, no spawn — subagents don't fill gaps with guesses. |
| **Phase gates** | pocket-structuring splits ≥7-task plans into phases handed off one at a time; a phase must pass its gate before the next begins. |
| **Context preservation** | Phasing + per-stage summaries keep the working set small. The whole reason pocket-help exists is to avoid loading everything at once. |
| **Auditable execution** | Every task leaves evidence: commits, green tests, a quick audit, and parallel review reports in `reviews/`. You can reconstruct *why* each change happened. |

## Where a Lighter Flow Wins

Reach for a **standalone skill** (or a Superpowers-style flow) — not the pipeline — when:

| Situation | Use instead | Why |
|-----------|-------------|-----|
| A known bug or failure | `bug-hunting` | Root-cause discipline without spec/plan ceremony. |
| A small-to-medium, well-understood change | `hotfix` | Brief plan + one subagent review gate — fast *and* accurate. |
| Just a design system / brand / UI tokens | `brand-design` | Self-contained; produces a creative brief, no pipeline. |
| An unverified assumption to validate first | `structured-research` | Grades the assumption against evidence before it enters planning — no spec/plan ceremony. |
| A one-off script, a trivial edit, a question | plain agent / Superpowers | The pipeline's gates would cost more than the work. |

`hotfix` is the deliberate middle ground: lighter than the full pipeline, but it still refuses to let you skip a brief plan and an independent review — because "simple" changes are where silent bugs hide.

## Quick Decision Guide

```
Is it broken (a defect)?           → bug-hunting
Is it only brand / UI tokens?      → brand-design
Is it an unverified assumption?    → structured-research
Is it a feature or real change?
   ├─ Small & well-understood?     → hotfix
   ├─ Clear but non-trivial?       → pocket-grinding (enters the pipeline)
   └─ Fuzzy / unformed?            → pocket-pitching (enters the pipeline)
Not sure which?                    → pocket-help (you're already here)
```

## Common Misconceptions

- **"Pocket is heavier, so it's slower."** For a one-liner, yes — use hotfix. For a real feature, the gates are *faster* than discovering a wrong assumption after implementation and redoing files.
- **"I'll just use the pipeline for everything to be safe."** Over-applying the pipeline to trivial work burns context and time. The standalone skills exist precisely so you don't.
- **"pocket-development reviews its own work."** The main agent never judges code itself: after each task it runs a mechanical gate, then dispatches a read-only auditor subagent for spec compliance and code quality (the in-loop audit); once every task is DONE it dispatches a phase-level pass over the whole phase, the same way an independent reviewer would.
- **"Pocket replaces my judgment."** It structures it. You still confirm scope, approve specs and plans, and trigger review.
