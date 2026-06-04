# Closeout Summary Template

The artifact written to `<plan_dir>/closeout.md` on a `CLOSED` result. It is the durable record that the plan finished: what shipped, at which SHAs, with which verdicts, and what review flagged-but-accepted. Written once, only when every phase reached `DONE` and `log close` succeeded.

Load `references/verdict-reconciliation.md` to gather the verdicts and observations this template renders.

## Structure

```markdown
# Closeout — <plan slug>

- **Plan:** <plan_dir>
- **Type:** flat | phased
- **Started:** <date_started>  ·  **Closed:** <date_completed>
- **Baseline SHA:** <baseline_sha>  ·  **Final SHA:** <last task done_sha>
- **Result:** CLOSED — all phases DONE, all reviewable tasks REVIEW_PASS

## Phases

### Phase <order> — <phase_file>  (DONE)

| Task | Name | done_sha | Verdict |
|------|------|----------|---------|
| T1 | <name> | <sha> | REVIEW_PASS |
| T2 | <name> | <sha> | REVIEW_PASS |

_SHA range: <baseline_or_prev_sha>..<last_done_sha>_

## Carried Forward

Non-blocking observations from review — accepted at close, recorded for follow-up.

- **T2** (Minor): <stage_2 minor issue description> — <location>
- **T1** (strength): <stage_2 strength>

_None_ if review raised nothing non-blocking.

## Skipped Tasks

Tasks excluded from review (not DONE, or no file changes in their SHA range).

- **T3** — <reason: not DONE | no done_sha | empty SHA range>

_None_ if every task was reviewable.
```

## Filled example

```markdown
# Closeout — 2026-06-03-typing-dna

- **Plan:** docs/pocket/plans/2026-06-03-typing-dna
- **Type:** flat
- **Started:** 2026-06-03  ·  **Closed:** 2026-06-04
- **Baseline SHA:** abc1234  ·  **Final SHA:** cde3456
- **Result:** CLOSED — all phases DONE, all reviewable tasks REVIEW_PASS

## Phases

### Phase 1 — execution-plan.md  (DONE)

| Task | Name | done_sha | Verdict |
|------|------|----------|---------|
| T1 | Capture keystroke timing | bcd2345 | REVIEW_PASS |
| T2 | Derive dwell features | cde3456 | REVIEW_PASS |

_SHA range: abc1234..cde3456_

## Carried Forward

- **T2** (Minor): unused import `statistics` — features.py:3
- **T1** (strength): clean separation between capture and storage layers

## Skipped Tasks

_None_
```

## Rules

- Write **only** on `CLOSED`. On `PHASE_ADVANCED` the plan is not finished — no closeout.md yet.
- Pull every value from `log.json` and the `reviews/*.json` files — do not invent SHAs, dates, or verdicts.
- One row per reviewable task, in plan order. List skipped tasks separately so the record is complete.
- Keep it factual: this is an audit record, not a narrative. No code reading, no new assessment.
