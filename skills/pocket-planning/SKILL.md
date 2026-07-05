---
name: pocket-planning
description: Converts a pocket-grinding spec into a TDD-structured execution plan of full Pocket Packets. Use when pocket-grinding handoff arrives (spec path + acceptance criteria). Trigger on "create plan", "build plan", "pocket-planning", or when pocket-grinding skill invokes this. Outputs tasks ready to dispatch via pocket-development skill.
---

# Pocket Planning

Bridges pocket-grinding spec and pocket-development execution. Scans codebase context, maps file structure, decomposes acceptance criteria into TDD-structured tasks, generates Pocket Packets with test-first steps and commits, then runs spec reviewer and test-architect subagents before handoff.

**Core principle:** Every task is red → green → refactor → commit. Steps live inside the task. Pocket enforces execution order and parallelism.

## When to Use

- pocket-grinding skill has invoked this with a spec path + acceptance criteria
- User says "create plan from spec", "build execution plan", "plan this"
- A spec exists in `docs/pocket/spec/` and needs to become executable tasks

Do NOT use:
- Without a completed pocket-grinding spec (use pocket-grinding skill first)
- To re-plan a task already in execution (use pocket-development directly)

## Hard Gates

```
GATE 0: POCKET-GRINDING HANDOFF VERIFICATION.
        Before doing ANYTHING else, verify you have ALL of these:
        - [ ] Spec file path (e.g., docs/pocket/spec/YYYY-MM-DD-slug/topic.md)
        - [ ] Acceptance criteria (full GWT list)
        - [ ] Architecture constraints
        - [ ] Design decision
        - [ ] Open questions / assumptions
        If ANY is missing → STOP. "HANDOFF_INCOMPLETE: Missing [list missing items].
        Return to pocket-grinding or provide manually."
        Do NOT proceed to Phase 0 until all inputs are verified.

GATE 1: Spec must exist and be readable. Missing → ask user for correct path.

GATE 2: Acceptance criteria must be present and usable.
        Rules with GWT → use directly.
        Rules without GWT → derive behavioral assertions, mark [derived].
        No acceptance criteria at all → STOP. Return to pocket-grinding.

GATE 3: Design Decision section must be present in spec.
        Missing → STOP. "Design Decision not found. Return to pocket-grinding
        or provide the decision manually." Do not proceed to Phase 2.

GATE 4: Spec Reviewer must APPROVE before Test-Architect runs.
        Issues Found → fix plan, re-run reviewer. Do not skip.

GATE 5: User must approve the final plan before ANY downstream handoff —
        pocket-structuring (split, ≥7 tasks) OR pocket-development (passthrough, ≤6 tasks).
        Running `structure --dry-run` is validation only and never authorizes a handoff.
        Do not invoke either skill before the user explicitly approves.
```

---

## Input Requirements

Read the spec file at Phase 1. The table below is a checklist of what to extract.

| Input | Source | Required |
|-------|--------|----------|
| Spec path | `docs/pocket/spec/{date}-{slug}/topic.md` | Yes |
| Acceptance criteria | Spec `## Acceptance Criteria` | Yes |
| Architecture constraints | Spec `## Architecture Constraints` | Yes |
| Design decision | Spec `## Design Decision` | Yes — GATE 3 |
| Open questions / assumptions | Spec `## Open Questions` | If present |
| Out-of-scope list | Spec `## Scope → Out-of-Scope` | Yes |
| Dependencies | Spec `## Dependencies` | If present |
| Rollback plan | Spec `## Rollback Plan` | If present |

---

## Phase 0: Preflight

**Goal:** Gather context BEFORE parsing the spec. Prevents planning against stale or incomplete understanding.

### Codebase Scan

In Phase 0, read only the `## Context → Related Areas` section of the spec to identify which codebase files to scan. Do NOT read the full spec here — that happens in Phase 1.

Scan identified areas:
- Read the codebase files listed under Related Areas
- Check recent commits in affected paths: `git log --oneline -10 -- <path>`
- Identify existing test patterns: framework, naming conventions, folder layout
- Identify existing file conventions: module boundaries, error handling, logging
- Search for existing shared helpers/utilities the plan can reuse (glob/grep for `*util*`,
  `*helper*`, `lib/`, `shared/`) — tasks must import these instead of reinventing them

**Test framework gate:** If zero test files exist in the codebase:
→ STOP. Ask user: "No test files found. Confirm the test framework to use (e.g., pytest, Jest, go test, RSpec) before continuing."
→ Store the answer explicitly in Preflight Summary as `Test framework: <user-specified>`.
Do not proceed until test framework is confirmed.

### Library Docs Search

For every unfamiliar dependency in the spec's tech stack or architecture constraints, and every dependency listed in the spec's `## Dependencies` section (existing to leverage + newly proposed):
- Use context7 MCP (`resolve-library-id` then `query-docs`) to fetch current docs
- Focus on: API usage, version-specific behavior, known constraints, test utilities
- Do NOT skip this for libraries not in your training data — query them

**context7 fallback:** If `resolve-library-id` returns no results or `query-docs` returns empty:
→ Note the library in Preflight Summary under "Unknown areas: <library name> <version> — docs unavailable"
→ Do NOT block Phase 1 on unresolvable library docs
→ Flag in QUALITY BAR of every Pocket Packet that uses this library: "Library docs unavailable — verify API usage carefully"

### Preflight Summary

```
PREFLIGHT COMPLETE
Codebase scanned: <areas reviewed>
Test framework: <framework + conventions found, or user-specified>
File conventions: <key patterns>
Existing helpers: <reusable helper/util modules found, or none>
Library docs fetched: <list of libraries queried>
Key findings: <anything surprising or constraining for the plan>
Unknown areas: <gaps — missing docs, unreadable files, etc.>
```

---

## Phase 1: Parse Spec

**Goal:** Extract all necessary context. Surface problems before decomposition starts.

Read spec completely, extract:

1. **Feature name** — from spec title
2. **Context summary** — current state, problem, related areas
3. **Design decision** — chosen option + tradeoffs → GATE 3 fires if missing
4. **Architecture constraints** — layers, patterns, forbidden dependencies
5. **Acceptance criteria** — every rule + its GWT scenarios
6. **Out-of-scope items** — enforced in every Pocket Packet's QUALITY BAR
7. **Open questions / assumptions** — propagated as risks in QUALITY BAR
8. **Rollback plan** — propagated into STOP CONDITIONS of affected tasks

### GWT Check
- Rules with GWT → use directly
- Rules without GWT → note as `[N rules missing GWT — derive in Phase 3]`
- Negative rules (must-not) → note as `[N negative rules — need inverted assertions]`

### Conflict Check
- Duplicate rules (same behavior, different wording) → flag `[DUPLICATE]`, merge
- Rule conflicts out-of-scope (`must-have` vs `must-not-touch`) → flag `[CONTRADICTION]`, stop and ask user

### SPEC PARSED Summary

```
SPEC PARSED: <feature name>
Design: <chosen option>
Constraints: <key constraints>
Rules: <N> | GWT coverage: <M> with GWT, <K> need derivation, <J> negative
Open questions: <N>
Rollback plan: present | absent
Conflicts: none | <description>
```

---

## Phase 2: File Structure Mapping

**Goal:** Map files to create or modify before task decomposition. Locks in boundaries.

For every acceptance criteria rule, identify:

```
Rule: <rule name>
  Create: exact/path/to/new-file.ext        ← new files
  Modify: exact/path/to/existing.ext:L1-L2  ← existing files + line range if known
  Test:   tests/exact/path/to/test.ext      ← test file (new or existing)
```

**File mapping rules:**
- Each file must have one clear responsibility — no generic catch-alls (`utils.ts`, `helpers.py`)
- When 2+ mapped files need the same logic, plan a named, domain-scoped helper module
  (e.g. `auth/token-utils.ts`) as an explicit Create entry — do not inline duplicates.
  Reuse helpers found in Preflight before creating new ones.
- Files that change together should live together (by feature, not by layer)
- In existing codebases, follow established patterns unless the file is already unwieldy —
  a mapped Modify file already over ~300 lines (or pushed past it by this work) → plan the
  extraction as part of the task and add the extracted file(s) to this map
- Every non-trivial implementation file must have a corresponding test file listed
- Exact paths — no relative paths, no `src/*/...` wildcards

This map directly informs Phase 3 decomposition. No task may touch files not listed here without a reason explained in its Pocket Packet.

---

## Phase 3: Decompose → Tasks

**Goal:** Map rules + file structure into bounded tasks with recommended execution order.

### Decomposition Rules

**Rule 1 — One task = one bounded deliverable**
Correctly sized: one subagent can complete it without waiting for another. Two separate areas with no shared dependency → split.

**Rule 2 — Steps live inside the task**
Sequential work (create → implement → test) → numbered steps in OBJECTIVE. Not separate tasks. Steps are instructions, not delegation units.

**Rule 3 — Scaffolding is always its own task**
Project init, schema, shared interfaces → own task marked `[prereq]`. Never bundle with feature work.

**Rule 4 — One rule can spawn multiple tasks**
Work across distinct layers, independent modules, or separately verifiable deliverables → split. Backend + frontend, service + event handler, DB schema + cache layer. Both tasks reference the same rule's GWT.
For cross-layer patterns → `references/task-decomposition.md`

**Rule 5 — Task scope must be explicit**
Name files, modules, functions in scope. "Implement streaming" is invalid. Infer from file map if spec doesn't specify.

### Rule 2 vs Rule 4 Tiebreaker
> Is the second piece verifiable and useful without the first?
> YES → two tasks. NO → one task with sequential steps.

### Conflict Resolution
- Overlapping rules: check if same behavior (merge) or genuinely distinct (keep, note shared precondition)
- Unclear → stop, ask user before generating packets

### Dependency Notation

```
[prereq]           — no dependencies, runs first
[depends: T1]      — must wait for T1 to complete
[depends: T1, T2]  — must wait for both
[parallel: T3]     — can run concurrently with T3
```

Dependency annotations are **recommended order** — pocket-development enforces actual sequencing. Communicate this to user in Phase 7.

### Circular Dependency Check
Walk each task's dependency chain before presenting. If any chain leads back to itself → resolve by removing artificial dependency or extracting a `[prereq]` task.

### Large Spec (10+ tasks)
Ask user: "This spec produces N tasks — recommend batching into phases for manageability. Proceed as one plan or split into Phase A (foundation), Phase B (features), Phase C (integration)?"

### Task List

```
TASK LIST — <feature name>
Total: <N> tasks | Dependency order is recommended — pocket-development enforces execution

T1: <name> [prereq]
T2: <name> [depends: T1]
T3: <name> [depends: T1] [parallel: T4]
...

Parallelizable groups:
  After T1: T2, T3 can run concurrently
```

For advanced patterns (shared interfaces, event-driven, phased rollouts):
→ Load `references/task-decomposition.md` — **mandatory if spec produces 4+ tasks**

---

## Phase 4: Generate Pocket Packets

**Goal:** Write a complete 7-field Pocket Packet per task. Every packet includes TDD steps and a commit step.

**No Placeholders rule:** Every step must contain what the agent actually needs. These are plan failures:
- "TBD", "TODO", "implement later", "handle edge cases"
- "Write tests for the above" (without specifying what to test)
- "Similar to Task N" (repeat the content — agents may execute tasks out of order)
- Code steps without code

### Spec → Pocket Packet Mapping

| Pocket Field | Source |
|---|---|
| OBJECTIVE | Rule + TDD steps (red → green → refactor) + commit |
| REFERENCES LOADED | Spec path + preflight codebase files read |
| WHY THIS APPROACH | Task type → complexity assessment |
| SANDWICH CONTEXT | Architecture constraints + design decision |
| DELIVERABLE | GWT scenarios (or derived) from acceptance criteria |
| QUALITY BAR | Must-haves, must-not-haves, open question risks |
| STOP CONDITIONS | Done = GWT passes + tests green | Escalate = constraint breach |

### Pocket Packet Template

````markdown
---
### Task N: <task name> [dependency notation]
---

## OBJECTIVE
<Single bounded deliverable — what MUST be done, not how>

Files:
- Create: `exact/path/new-file.ext`
- Modify: `exact/path/existing.ext`
- Test: `tests/exact/path/test.ext`

Steps:
1. Write failing test for: <acceptance criteria rule / GWT scenario name>
   File: `tests/exact/path/test.ext`
   Test verifies: Given <precondition>, When <action>, Then <outcome>
   [Test-Architect will add code here — see Phase 6]

2. Run test — verify FAIL:
   `<exact command with flags>`
   Expected failure: <specific error or assertion failure message>

3. Implement minimal code to satisfy the test:
   File: `exact/path/file.ext`
   Implement: <specific function/class/module — no more than needed>

4. Run test — verify PASS:
   `<exact command>`
   Expected: PASS

5. Refactor while green (bounded):
   - Rule of three: same logic appears 3+ times in the files in scope → extract a named,
     domain-scoped helper (e.g. `auth/token-utils.ts`) — never a generic `utils.ts`
   - A modified file crosses ~300 lines, or a function exceeds ~50 lines → split/extract
   - Refactor only within task-scope files plus helper files declared in the file map
   - Re-run test: `<exact command>` — must stay PASS
   - Nothing to refactor → say so and move to commit

6. Commit:
   `git add exact/path/file.ext tests/exact/path/test.ext`
   `git commit -m "<type>(<scope>): <description>"`
   Valid types: `feat | fix | test | refactor | chore`
   Scope = module or feature name from spec (e.g., `feat(auth): add JWT validation`)
   If Step 5 extracted a helper, commit it separately as `refactor(<scope>): <description>`

[Add additional test→implement→refactor→commit cycles if rule has multiple GWT scenarios]

**Non-testable tasks** (scaffold, directory creation, config setup — no behavioral GWT):
Replace Steps 1–6 with:
1. Create the structure / file / config
2. Verify: `<exact validation command, e.g., ls -la, config lint, or startup check>`
3. Commit: `git commit -m "chore(<scope>): <description>"`
Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED
<spec path> — rule: <rule name>, GWT scenarios used as verification
<codebase file from preflight> — <what was learned about existing patterns>
[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH
Justification: <specific reason — file count + reasoning depth>
Complexity: <lightweight | standard | deep>

## SANDWICH CONTEXT
[CRITICAL: <hard constraint that, if violated, requires full redo>]
You are implementing <task name> for <feature name>.
Spec: <spec path>
Design decision: <chosen option, 1 line>
Files in scope: <explicit list from Phase 2 file map — no other files>
Test framework: <framework + conventions from preflight>
Available after: <dependencies>
Architecture rule: <forbidden dependency or must-use pattern>
[RESTATE: <same hard constraint from first line>]

## DELIVERABLE
Verification — task is DONE when all pass:

Given <precondition>, When <action>, Then <outcome>
Given <edge case>, When <action>, Then <outcome>
[derived] Given <inferred precondition>, When <action>, Then <outcome>
[must-not] Given <condition>, When <action>, Then system must NOT <forbidden outcome>

All tests PASS. Commit exists with message matching `<type>(<scope>): <description>`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - <acceptance criteria item>
  - Tests written BEFORE implementation (TDD — not after)
  - Rule of three enforced — no logic left duplicated 3+ times in the files in scope
  - Commit message follows conventional commits format

Must-not-have:
  - <out-of-scope item from spec>
  - Skipping the failing test step (implement-then-test is a plan violation)
  - Modifications to files outside the listed scope

Open question risks:
  - <unresolved assumption> → if wrong: report NEEDS_CONTEXT immediately

Rollback note:
  - <rollback condition from spec if relevant>

## STOP CONDITIONS
Done when: all DELIVERABLE scenarios pass, tests green, commit created
Uncertain when: <open question assumption proves wrong>
Escalate when: <constraint violated> or <task touches out-of-scope files>
````

### SANDWICH CONTEXT — Constraint Selection

`[CRITICAL]` and `[RESTATE]` only for constraints that, if violated, require full redo:
- Forbidden dependencies from `## Architecture Constraints`
- Must-use patterns (e.g., "all DB access through repository interface")
- Layer boundaries (e.g., "domain must not import infrastructure")

Do NOT fill with style preferences or naming conventions.

### GWT Derivation (rules without scenarios)
1. Identify precondition, trigger, outcome from rule text
2. Write: `Given <precondition>, When <action>, Then <outcome>`
3. Mark `[derived — no GWT in spec]`
4. Add one failure case: `Given <invalid input>, When <action>, Then <error>`

### Negative Criteria (must-not rules)
1. `[must-not] Given <condition>, When <action>, Then system must NOT <outcome>`
2. Also write the enforcement: `Given <condition>, When <action>, Then <system blocks/rejects>`

### Complexity Selection

| Task Type | Complexity | Notes |
|-----------|------------|-------|
| Scaffold, file creation | Lightweight | Minimal reasoning, clear output |
| Single module, clear spec (1–3 files) | Lightweight | Straightforward implementation |
| Multi-file with judgment | Standard | Requires cross-file coordination |
| Complex integration, new patterns | Standard | Novel patterns or unclear boundaries |
| Architecture decisions | Deep | High judgment, broad impact |
| Review / audit | Read-only review | Independent verification |

**Override:** File count is starting point. Branching logic, error handling decisions, or ambiguous spec → promote to Standard.

---

## Phase 5: Spec Reviewer

**Goal:** Verify plan covers the spec completely and has no placeholder failures. Dispatch subagent, wait for result before continuing.

→ Load `references/spec-reviewer-prompt.md` for the full dispatch prompt.

Quick dispatch format:

```
Dispatch: Subagent reviewer | Standard complexity
Plan file: docs/pocket/plans/{date}-{slug}/execution-plan.md
Spec file: docs/pocket/spec/{date}-{slug}/topic.md
Return: Status (Approved | Issues Found) + specific issues with task:step references
```

**Gate 4 enforcement (maximum 2 review cycles):**
- Status = Approved → proceed to Phase 6
- Status = Issues Found → fix issues inline, re-dispatch reviewer (cycle 2)
- Cycle 2 still Issues Found → STOP. Output:
  ```
  REVIEW BLOCKED — <N> unresolved issues after 2 cycles:
  <reviewer's Issues list verbatim>
  ```
  Ask user: "Please resolve the above before proceeding to Test-Architect."
  Do not auto-advance to Phase 6.
- Full reviewer dispatch protocol → `references/spec-reviewer-prompt.md`

---

## Phase 6: Test-Architect

**Goal:** Enrich every Pocket Packet with specific test code. Spawn subagent that reads the plan, inserts test implementations into Step 1 of each task, and validates TDD ordering.

→ Load `references/test-architect-prompt.md` for the full dispatch prompt.

Quick dispatch format:

```
Dispatch: Subagent test-architect | Standard complexity
Input: approved execution plan + spec + preflight codebase findings
Return: updated plan with test code inserted in each task's Step 1,
        integration test tasks added where GWT spans multiple units,
        TDD order validated (test before implement in every task)
```

Apply test-architect's changes to the plan before Phase 7.

---

## Phase 7: Output Execution Plan

**Goal:** Save the plan, validate it parses, then get user approval and route to exactly one downstream skill.

### Step 1: Save the plan

Save plan to: `docs/pocket/plans/{date}-{slug}/execution-plan.md`

→ Load `references/plan-template.md` for the full execution plan document format.

### Step 2: Validate via dry-run (MANDATORY, non-authorizing)

Run the CLI against the **saved** path to confirm the plan parses, conforms to the
`### Task N: name [annotation]` template, has a valid dependency order, and to capture
its routing decision — **without writing any files**:

```bash
npx -y pocketto-pi structure "docs/pocket/plans/{date}-{slug}/execution-plan.md" --dry-run --json --contract 2
```

Parse the JSON envelope — do not scrape prose:
- **`ok == false`** → **STOP. Do not present the approval gate.** Report `error.message` to the
  user (e.g. `NO_TASKS`, `UNKNOWN_TASK_REF`, `CYCLE_DETECTED` — the plan is malformed or has a
  bad/cyclic dependency). Fix the plan, then re-run this step.
- **`ok == true`** → capture `data.action` (`"passthrough"` | `"split"`) and `data.executionFlow`
  (the run-order graph, e.g. `T1→T2,T3(PARALLEL)→T4`). This dry-run writes nothing and never
  authorizes a handoff — it only validates and decides the route.

### Step 3: User Approval Gate (branch-aware)

Present the result, showing the execution flow and the route the dry-run selected:

- **Passthrough (`data.action == "passthrough"`, ≤6 tasks):**
  > "Plan complete — N tasks, TDD-structured, spec-reviewed, tests designed.
  > Saved to docs/pocket/plans/…
  > Execution flow: {data.executionFlow}
  > N tasks (≤6) — no phase-splitting needed. Ready to hand off directly to pocket-development?"

- **Split (`data.action == "split"`, ≥7 tasks):**
  > "Plan complete — N tasks, TDD-structured, spec-reviewed, tests designed.
  > Saved to docs/pocket/plans/…
  > Execution flow: {data.executionFlow}
  > Dependency order shown is recommended — pocket-structuring enforces phase sequencing.
  > N tasks (≥7) — ready to hand off to pocket-structuring for phasing?"

Wait for confirmation. Apply any changes requested (re-run Step 2 if the plan changed).

### Step 4: Route to exactly one target (MANDATORY)

**DO NOT STOP AFTER USER APPROVAL.** Route on `data.action` — invoke exactly one skill:

- **`passthrough`** → invoke the `pocket-development` skill (use the Skill tool: `pocket-development`)
  directly with the flat plan `docs/pocket/plans/{date}-{slug}/execution-plan.md`. Do not invoke
  pocket-structuring — there are no phases to split.
- **`split`** → invoke the `pocket-structuring` skill (use the Skill tool: `pocket-structuring`) with:
  - Execution plan path: `docs/pocket/plans/{date}-{slug}/execution-plan.md`
  - Task count (from Phase 3)
  - Spec file path

  pocket-structuring re-parses the plan from disk and writes the phase files, so any edit made
  between approval and structuring is re-validated there (self-healing).

---

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/task-decomposition.md` | Phase 3: **mandatory if 4+ tasks** — run Over-Split/Under-Split. Also: shared interfaces, event-driven, phased rollouts |
| `references/plan-template.md` | Phase 7: writing full execution plan document |
| `references/spec-reviewer-prompt.md` | Phase 5: dispatching spec reviewer subagent |
| `references/test-architect-prompt.md` | Phase 6: dispatching test-architect subagent |
