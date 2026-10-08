# Phase Completion Notes

Create one durable summary artifact for each phase that passes the phase-level gate. This note gives `pocket-closing` the context needed to write a human-readable phase closeout across sessions.

## Path and timing

Write the note to:

```text
<plan_dir>/reviews/phase-notes-<phase_key>.json
```

Resolve `phase_key` from `log.json` as `phase-${phase.order}`. Write the note only after all task verdicts pass, the phase-level pass is terminal (`PHASE_PASS_CLEAN` or `PHASE_PASS_RESOLVED`), and the phase completion gate passes. Write it before the phase transitions to `REVIEW`.

The note is a presentation handoff, not a verdict or lifecycle record. It does not change `log.json`, task verdicts, `done_sha`, phase-pass findings, or any gate. `pocket-closing` uses it only to summarize the phase; it must still reconcile every task verdict against `log.json` independently.

If the process resumes after the note was written, reuse the existing note. Do not overwrite it. If it is missing, reconstruct it from evidence still available and mark unavailable history as `not recorded`; never invent past events. A phase that remains `PHASE_BLOCKED` does not get a completed-phase note.

## Required record

Write valid JSON with this shape:

```json
{
  "contract": 1,
  "phase_key": "phase-1",
  "phase_file": "execution-plan/index.md",
  "recorded_at": "<UTC ISO 8601 timestamp>",
  "phase_verdict": "PHASE_PASS_CLEAN",
  "tasks": [
    {
      "task_id": "T1",
      "name": "<task name from log.json>",
      "done_sha": "<full SHA from log.json>",
      "verdict": "REVIEW_PASS"
    }
  ],
  "verification": [
    {
      "check": "<exact check or gate>",
      "result": "PASS",
      "evidence": "<command output, verdict artifact, or phase-pass result>"
    }
  ],
  "obstacles": [
    {
      "summary": "<material obstacle encountered>",
      "resolution": "<how it was resolved>",
      "evidence": ["<task, review, correction SHA, or session report source>"]
    }
  ],
  "decisions": [
    {
      "kind": "user",
      "decision": "<explicit decision, or approved implementation choice>",
      "rationale": "<recorded rationale, when available>",
      "source": "<plan, explicit user instruction, or task report>"
    }
  ],
  "recommendations": [
    {
      "suggestion": "<optional follow-up suggestion>",
      "evidence": "<specific non-blocking review observation or other recorded evidence>"
    }
  ]
}
```

Empty arrays are valid. Keep evidence concise and traceable to the plan, task report, current verdicts, correction entries, or phase-level result. Use full SHAs in JSON; `pocket-closing` may shorten them for display.

## Recording rules

- `tasks` comes from the target phase in `log.json`; include every task in plan order, its pinned `done_sha`, and its current verdict. A valid no-change task remains listed with its `REVIEW_PASS` stub.
- `verification` records only checks whose result was actually observed. Do not turn a pass verdict into an unrecorded claim that a specific test command ran.
- `obstacles` records material problems encountered during execution and how they were resolved. Cite the task report, review artifact, correction SHA, or session evidence. Do not include unresolved human dependencies in a completed note; report those through `PHASE_BLOCKED`.
- `decisions.kind` distinguishes explicit user decisions (`user`) from implementation choices within the approved scope (`implementation`). Do not attribute an agent choice to the user. If no decision is supported by evidence, leave the array empty.
- `recommendations` are optional. Base them on non-blocking reviewer observations or other explicit evidence, and make clear they are suggestions rather than acceptance criteria or review verdicts.
- The main agent compiles the note from recorded evidence and status reports. It does not read implementation code, conduct another review, or add its own quality judgment.
- Never treat missing narrative notes as a reason to invalidate a passing phase. `pocket-closing` may state that a detail was not recorded.
