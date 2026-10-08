# Status Handling Guide

Controller responses to implementer and reviewer statuses. A subagent's `BLOCKED` report starts diagnosis; it does not automatically make the task user-blocked.

## Statuses

| Status | Meaning | Controller action |
|---|---|---|
| `DONE` | Implementer reports complete | Run the mechanical gate, then independent read-only audit per `two-stage-review.md`. |
| `DONE_WITH_CONCERNS` | Implementer completed work and names doubts | Attach concerns verbatim to the normal audit input; let the auditor classify them. |
| `NEEDS_CONTEXT` | A needed fact is absent from the packet | Search available sources, add verified context, and re-dispatch; ask the user only for what cannot be obtained. |
| `BLOCKED` | Subagent cannot continue under its current packet or approach | Diagnose, gather evidence, change the recovery approach, and re-dispatch. Tell the user it is BLOCKED only for a genuine human dependency. |

## `DONE_WITH_CONCERNS`

1. Preserve the implementer's concerns verbatim.
2. Run the normal mechanical gate.
3. Dispatch the read-only auditor with the concerns and diff.
4. Use the verdict artifact as the source of truth; the main agent does not classify code concerns.

A concern about a missing product decision or out-of-scope requirement is not a code-quality judgment. Gather available context first; ask the user only if the decision changes the approved outcome or tradeoff.

## `NEEDS_CONTEXT`

Do not guess at the missing fact. Before asking the user:

1. Identify the exact missing fact and why it matters.
2. Check the repository, plan, logs, available tools, and current official documentation.
3. Dispatch a fresh subagent to investigate when that can resolve the gap independently.
4. Add verified context to the packet and re-dispatch. Pause only the work that depends on information unavailable to the agent.

Ask the user only for an unavailable fact or decision. State what is missing and which task depends on it; continue independent tasks when their dependencies allow it.

## `BLOCKED` Recovery

Treat a subagent's `BLOCKED` status as a diagnosis request. Do not simply repeat its packet. Identify the failed assumption, inspect the implementation plan and codebase, and choose a materially different recovery:

- **Context gap:** find the source or gather evidence, then update the packet.
- **Reasoning or architecture uncertainty:** compare options against the approved task, repository conventions, and version-matched official documentation; dispatch a fresh read-only `advisor` subagent with the `advisor` persona to challenge the conclusion.
- **Task too large:** split it into smaller packets without changing the approved outcome, then continue in dependency order.
- **Plan conflicts with the codebase:** document the conflicting plan statement and code evidence. Repair the packet if the approved outcome stays the same; ask the user only when resolving it changes an approved requirement, scope, or tradeoff.
- **Reviewer or tool failure:** diagnose the input or capability issue and try a fresh independent reviewer, including the `advisor` fallback. The main agent must not replace independent review with its own code judgment.
- **Parallel merge conflict:** abort the merge safely, inspect both diffs and the conflict, and try a materially different resolution with independent review. Ask the user only if the conflict requires a product or architectural choice that evidence cannot resolve.

Cycle counters and retry counts record history and help resume. Reaching zero is never, by itself, a reason to stop, mark a task BLOCKED, or mark a phase `PHASE_BLOCKED`. Preserve the counter and audit artifacts while recovery continues; do not repeat an unchanged attempt.

## User-Facing `BLOCKED`

Use `BLOCKED` only when the next safe action requires a human decision, access, information, or authorization the agent cannot obtain. Continue any independent work that remains safe. Persist the required status and include:

```
Status: BLOCKED
Human dependency: [specific decision, access, information, or authorization]
Evidence: [what was inspected and what recovery was attempted]
Unblock action: [the concrete action needed from the user]
Unaffected work: [continue it when dependencies allow]
```

If a subagent says only "I'm stuck," ask it what it tried and what evidence is missing, then inspect the packet, repository, and logs before deciding whether a human is actually needed.
