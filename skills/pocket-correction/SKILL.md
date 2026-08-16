---
name: pocket-correction
description: DEPRECATED as of 3.0.0. Replaced by pocket-development's in-loop audit and phase-level pass (skills/pocket-development/references/two-stage-review.md and references/phase-level-pass.md), which now delegate and record fixes for REVIEW_FAIL findings as part of the same in-loop flow. Do not route to this skill — it is no longer a trigger target.
---

# Pocket Correction (Deprecated)

**This skill is deprecated as of version 3.0.0.** Do not invoke it. Hosts should not route to it.

## What replaced it

`pocket-development` now performs the in-loop audit and phase-level pass directly, so the separate user-triggered correction cycle this skill provided is no longer needed as its own stage. The behavior that used to live here has moved to:

- `skills/pocket-development/references/two-stage-review.md` — the two-stage audit that surfaces failing findings in-loop.
- `skills/pocket-development/references/phase-level-pass.md` — the phase-completion pass, including delegating fixes for failed tasks, that used to be this skill's correction loop.

## What's retained, unchanged

The CLI correction machinery this skill depended on is untouched and still fully functional — it is simply invoked from `pocket-development` now instead of from this skill:

- `npx pocketto-pi log update --correction <sha> --for-task <task_id>` — append-only correction recording; `done_sha` never moves.
- `phase.corrections` in `log.json` — the correction log entries.
- `for_task` / bleed attribution — the ownership rules that decide which task(s) a correction is attributed to.

If you were about to run `/pocketto:pocket-correction`, run `pocket-development` instead — it delegates and records fixes for failing findings as part of the same in-loop flow.
