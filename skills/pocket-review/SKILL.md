---
name: pocket-review
description: DEPRECATED as of 3.0.0. Replaced by pocket-development's in-loop audit and phase-level pass (skills/pocket-development/references/two-stage-review.md and references/phase-level-pass.md). Do not route to this skill — pocket-development now performs the two-stage review and phase-level pass automatically at phase completion. Retained only as a historical pointer; not a trigger target.
---

# Pocket Review (Deprecated)

**This skill is deprecated as of version 3.0.0.** Do not invoke it. Hosts should not route to it.

## What replaced it

`pocket-development` now performs the two-stage review and the phase-level pass **in-loop**, as part of its own phase-completion flow, instead of waiting for a separate user-triggered batch reviewer. The behavior that used to live here has moved to:

- `skills/pocket-development/references/two-stage-review.md` — the spec-compliance + code-quality two-stage audit, now run automatically per task inside pocket-development.
- `skills/pocket-development/references/phase-level-pass.md` — the phase-completion pass that used to be this skill's batch dispatch + summary + chain-to-closing behavior.
- `skills/pocket-development/references/enterprise-reporting.md` — the enterprise-mode PR verdict posting (upsert summary comment, inline findings, fingerprint reconcile) that used to live in this skill's "Enterprise mode" section.

## What's retained, unchanged

The CLI correction machinery this skill depended on is untouched and still fully functional — it is simply invoked from `pocket-development` now instead of from this skill:

- `npx pocketto-pi log update --correction <sha> --for-task <task_id>` — append-only correction recording; `done_sha` never moves.
- `phase.corrections` in `log.json` — the correction log entries.
- `for_task` / bleed attribution — the ownership rules that decide which task(s) a correction is attributed to.

## Where the artifacts live now

Reference files this skill used to load have moved to `skills/pocket-development/references/`, where the new contracts cite them:

- `skills/pocket-development/references/spec-compliance-review.md`
- `skills/pocket-development/references/code-quality-review.md`
- `skills/pocket-development/references/review-report-template.md` — still the normative review-report JSON schema; now produced by pocket-development's in-loop auditor instead of this skill.

One file stayed behind in this skill's own `references/`:

- `references/subagent-dispatch-template.md` — superseded; see the note at the top of that file.

If you were about to run `/pocketto:pocket-review`, run `pocket-development` instead — it audits at phase completion without a separate invocation.
