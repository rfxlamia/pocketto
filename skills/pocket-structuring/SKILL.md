---
name: pocket-structuring
description: Converts a completed Pocket execution plan into per-task Pocket Packets and an execution index with the Pocket CLI. Use after pocket-planning or when the user asks to structure a plan.
---

# Pocket Structuring

Use the Pocket CLI to turn a completed execution plan into `execution-plan/index.md`, one file per task under `execution-plan/tasks/`, and phase manifests when the plan needs multiple phases. The CLI owns parsing, decomposition, file generation, and log reconciliation; use its JSON result as the source of truth.

## Run

Use the plan path from the handoff or the user's request:

```bash
npx -y pocketto-pi structure "<path-to-execution-plan.md>" --json --contract 3
```

Parse the JSON envelope. On success, report the plan feature, task and phase counts, generated paths, and whether the CLI rebuilt the execution log. Do not infer success from prose or generate these files manually.

If the command fails, inspect the error and the plan. Correct recoverable causes—such as a wrong path or malformed input—and rerun the command. Explain the remaining blocker only when it requires missing context, access, or a human decision. A contract mismatch calls for a compatible Pocket CLI version; do not treat it as a plan-format error.

The CLI protects existing execution progress when a changed plan would alter task topology. `--force` can rebuild topology only when there is no execution progress. `--reset` discards progress and starts a fresh execution log: never use it without the user's explicit authorization. Use `--dry-run` to preview a change when its effect is unclear.

## Handoff

Structuring authorizes generation of plan artifacts; it does not by itself authorize implementation. After a successful run, continue to `pocket-development` only if the user asked to begin execution or already authorized that handoff. Otherwise, report the result and stop here. Treat a clear user instruction to structure and execute as authorization; do not ask again for the same approval.

`pocket-development` and `pocket-closing` own task execution, phase review, and phase advancement. Follow their phase gates when continuing a multi-phase plan; do not duplicate or bypass them here.

If the user explicitly asks to skip structuring, explain briefly that the plan will remain flat and follow their instruction. Ask a follow-up only if the requested next step is unclear; do not require a special phrase or argue against the user's decision.
