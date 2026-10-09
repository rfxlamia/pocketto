# Spike Protocol

**Contents:** [What Is a Spike](#what-is-a-spike) · [Trigger Conditions](#trigger-conditions) · [Mode Selection](#mode-selection) · [Code Scan](#code-scan-execution) · [Web Search](#web-search-execution) · [Completion Criteria](#spike-completion-criteria)

## What Is a Spike

A spike is a focused technical investigation to resolve one specific unknown that affects approach selection. It is triggered by Phase 2 brainstorming surfacing a technical question that cannot be answered from existing context. A timebox helps the agent reassess effort; it is not a hard stop or a reason to mark the task blocked.

**Scope rule:** One unknown per spike. Do NOT expand into adjacent questions discovered during spike.

---

## Trigger Conditions

Trigger a spike when Phase 2 produces questions like:
- "Can X do Y?" — technical feasibility unknown
- "Does Z already exist in this codebase?" — existing implementation check
- "What does library W support?" — API/library capability unknown
- "Would approach A break existing Z?" — impact/compatibility unknown
- "Is this pattern already in use somewhere?" — codebase convention check

Do NOT trigger a spike for:
- Business or product decisions ("should we prioritize X?")
- Questions resolvable by asking the user
- Architecture decisions (those belong in pocket-grinding Phase 5)

---

## Mode Selection

Agent decides based on the unknown type:

| Unknown Type | Mode | Example |
|-------------|------|---------|
| Is X in the codebase? | Code Scan | "Does an auth middleware already exist?" |
| How does X work internally? | Code Scan | "How does the current caching layer handle invalidation?" |
| What does library X support? | Web Search | "Does Prisma support batch upserts?" |
| Does external API Y do Z? | Web Search | "Does Stripe webhook support idempotency keys?" |
| Does X in codebase conflict with library Y? | Both | "Would our current DB pooling setup work with Drizzle?" |

---

## Code Scan Execution

**Step 1 — Identify target**
Name the specific unknown: "Does an authentication middleware exist?"

**Step 2 — Search the most likely locations**
```bash
rg -l "middleware|auth" src/ -g '*.ts'
```
Read likely entry points, configuration, and tests if the initial search has no
matches. A search with zero matches describes only that search scope; it does not
prove the capability is absent.

**Step 3 — Check recent changes**
```bash
git log --oneline -10 -- src/middleware/
```

**Step 4 — Report**
```
Spike result (code scan):
Unknown: [the question]
Found: [what exists — file path, function name, behavior]
Implication for approaches: [how this affects direction selection]
```

---

## Web Search Execution

**Step 1 — Name the unknown precisely**
"Does Prisma support bulk upsert for PostgreSQL?"

**Step 2 — Search**
Use current library name + capability + "documentation" or "2026"
Example: "Prisma bulk upsert PostgreSQL documentation 2026"

**Step 3 — Extract the answer**
Pull specific confirmation: "Yes, via `createMany` with `skipDuplicates`" or "No, requires raw SQL."

**Step 4 — Report**
```
Spike result (web search):
Unknown: [the question]
Finding: [yes/no + specific mechanism or constraint]
Source: [library + version if available]
Implication for approaches: [how this affects direction selection]
```

---

## Both Modes

Run code scan first (faster, local), then web search if code scan doesn't resolve:
```
Spike result (code scan + web search):
Unknown: [the question]
Code scan: [what was found or not found in codebase]
Web search: [what external docs confirmed]
Combined implication: [synthesis of both findings]
```

---

## When a Search Does Not Resolve the Unknown

Use a different evidence source before repeating a failed search:

| First attempt | Next useful step |
|--------------|------------------|
| Project search has no matches | Inspect entry points, configuration, tests, and relevant git history; broaden the search terms once. |
| Documentation search is inconclusive | Check the official documentation for the project's version, then inspect official examples or release notes. |
| Code and documentation appear to conflict | Verify versions and dates, then test the behavior locally if the project environment supports it. |
| A tool or source is unavailable | Use another available source or mode; record the unavailable source and continue. |

Do not repeat the same query or tool call without changing what evidence it can produce.

## Spike Completion Criteria

A spike is complete when it produces either a verified answer or a useful,
evidence-based account of what remains unresolved:
- "Yes — found at `src/middleware/auth.ts:42`"
- "Not found in the files and terms searched — checked `src/`, configuration, and tests; broader project history remains unchecked"
- "Yes — Prisma supports this via `createMany` (confirmed docs)"
- "No — library doesn't support X, would need raw SQL or alternative"
- "Unresolved — checked the local code and current library docs; neither establishes X. Carry this question into pocket-grinding."

**Do NOT:**
- Report only "it might be possible" — state what evidence you found, what you tried, and the remaining uncertainty
- Expand scope mid-spike if new questions emerge — note them as open questions instead

At about five tool calls, reassess whether the current path is producing evidence.
Change source or investigation mode if it is not. This checkpoint changes strategy;
it does not end the investigation or block the rest of pitching.

If distinct available approaches still cannot resolve the unknown, record the evidence
and the exact open question in the pitch brief for pocket-grinding. Do not claim the
unknown is resolved, and do not block the rest of pitching solely because the
investigation budget or a retry cycle ended.
