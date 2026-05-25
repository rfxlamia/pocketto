# Spike Protocol

**Contents:** [What Is a Spike](#what-is-a-spike) · [Trigger Conditions](#trigger-conditions) · [Mode Selection](#mode-selection) · [Code Scan](#code-scan-execution) · [Web Search](#web-search-execution) · [Completion Criteria](#spike-completion-criteria)

## What Is a Spike

A spike is a time-boxed technical investigation to resolve one specific unknown that blocks approach selection. It is triggered by Phase 2 brainstorming surfacing a technical question that cannot be answered from existing context.

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

**Step 2 — Search**
```bash
grep -r "middleware" src/ --include="*.ts" -l
grep -r "auth" src/ --include="*.ts" -l
```
Or read specific files if location is known.

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

## Spike Completion Criteria

Spike is complete when the original unknown has a yes/no answer with evidence:
- "Yes — found at `src/middleware/auth.ts:42`"
- "No — no existing implementation found, search returned zero matches"
- "Yes — Prisma supports this via `createMany` (confirmed docs)"
- "No — library doesn't support X, would need raw SQL or alternative"

**Do NOT:**
- Leave a spike with "it might be possible" — investigate until you have a concrete answer
- Run a spike longer than ~5 tool calls — if unresolved after 5, document the uncertainty and note it as an open question for grinding
- Expand scope mid-spike if new questions emerge — note them as open questions instead
