---
name: pocket-planning
description: Converts a pocket-grinding spec into a TDD-structured execution plan of full Pocket Packets. Use when pocket-grinding handoff arrives (spec path + acceptance criteria). Trigger on "create plan", "build plan", "pocket-planning", or when pocket-grinding skill invokes this. Outputs tasks ready to dispatch via pocket-development skill.
---

# Pocket Planning

Bridges pocket-grinding spec and pocket-development execution. Scans codebase context, maps file structure, decomposes acceptance criteria into TDD-structured tasks, generates Pocket Packets with test-first steps and commits, then runs a spec reviewer subagent — plus a conditional test strategy audit when any Phase 6 trigger fires (cross-unit GWT scenario, ambiguous test level, persistence/concurrency/network/external-service behavior that materially changes how the task must be tested, or a `[test-risk]` task) — before handoff.

**Core principle:** Every task is red → green → refactor → commit. Steps live inside the task. Pocket enforces execution order and parallelism.

**Test boundary:** Planning owns test *intent*. Development owns test *implementation*. Packets carry test intent — never test source code (Phase 4).

## When to Use

- pocket-grinding skill has invoked this with a spec path + acceptance criteria
- User says "create plan from spec", "build execution plan", "plan this"
- A spec exists in `docs/pocket/spec/` and needs to become executable tasks

Do NOT use:
- Without a completed pocket-grinding spec (use pocket-grinding skill first)
- To re-plan a task already in execution (use pocket-development directly)

## Operating Rules

- **Start from the user's request.** Use a clear handoff, correction, or approval already given. Do not ask the user to repeat a decision or choose a numbered option.
- **Recover missing context first.** Search the conversation and expected spec directory before reporting an input missing. Treat open questions as optional; record `none identified` when there are none.
- **Preserve independent review with bounded recovery.** A separate Spec Reviewer must review the plan, and a Test Strategy Audit must run when its triggers fire. After the initial review, allow at most two materially different correction/review or reviewer-recovery rounds for each review gate. At the cap, report `RECOVERY_CHECKPOINT`, preserve findings, and wait for explicit user authorization before another bounded window. Never claim approval or hand off with unresolved blocking findings.
- **Use evidence for library decisions.** Check the version in the lockfile or proposed dependency and query version-matched documentation. When a source is missing, try official documentation or release notes and record what remains unverified.
- **Honor the authorized handoff.** If the user clearly requested plan generation and structuring, that instruction authorizes the plan handoff once the required checks pass. Otherwise, present the completed plan and wait for approval before generating derived execution artifacts. This approval never authorizes implementation.

---

## Input Requirements

Read the located spec in Phase 1. The table below is a checklist of what to extract.

| Input | Source | Required |
|-------|--------|----------|
| Spec path | `docs/pocket/spec/{date}-{slug}/topic.md` | Yes |
| Acceptance criteria | Spec `## Acceptance Criteria` or concrete behavioral requirements | Required; derive and mark `[derived]` when unambiguous |
| Architecture constraints | Spec `## Architecture Constraints` and codebase | Required; record `none identified` when applicable |
| Design decision | Spec `## Design Decision` or explicit handoff context | Required to plan implementation; use the stated recommendation if clear |
| Open questions / assumptions | Spec `## Open Questions` | Optional; write `none identified` if absent |
| Out-of-scope list | Spec `## Scope → Out-of-Scope` | Required; record `none stated` if absent |
| Dependencies | Spec `## Dependencies` | If present |
| Rollback plan | Spec `## Rollback Plan` | If present |

---

## Phase 0: Preflight

**Goal:** Gather context BEFORE parsing the spec. Prevents planning against stale or incomplete understanding.

### Codebase Scan

Locate the spec from the handoff or conversation. If no path is present, search
`docs/pocket/spec/` for a clear match; ask for the path only if several candidates
fit or the spec cannot be found. In Phase 0, read only `## Context → Related Areas`
to seed the scan; verify the listed paths exist and add relevant callers, tests, or
related modules discovered while scanning. Read the full spec in Phase 1.

Scan identified areas:
- Read the codebase files listed under Related Areas
- Check recent commits in affected paths: `git log --oneline -10 -- <path>`
- Identify existing test patterns: framework, naming conventions, folder layout
- Identify existing file conventions: module boundaries, error handling, logging
- Search for existing shared helpers/utilities the plan can reuse — glob for helper-style
  names (`*util*`, `*helper*`, `lib/`, `shared/`) AND use `rg` to find exported symbols used across
  files in the related feature areas, since domain-scoped helpers rarely carry "util" in
  their filename — tasks must import these instead of reinventing them

**Test framework:** Check test files, package scripts, build configuration, and
project conventions. If no tests exist, infer a conventional runner from the stack
when the evidence supports one and record it as a proposal or assumption. Plan test
setup as a prerequisite task when needed. Ask the user only if choosing a framework
would create a consequential project decision that cannot be resolved from context.

### Library Docs Search

For every dependency whose behavior affects a planned task, identify its exact
installed or proposed version from the lockfile or spec. Do not skip documentation
checks because a library is familiar.

1. Use Context7 MCP: `resolve-library-id`, then `query-docs` for the matching version
   when available. Check API usage, version-specific behavior, constraints, and test
   utilities relevant to the plan.
2. If Context7 has no matching result, check the vendor's versioned docs, API
   reference, and release notes. Search the codebase for established usage and tests
   as additional evidence; do not treat repo usage as proof of current external API
   behavior.
3. Record the version, sources, and findings in the Preflight Summary. If distinct
   sources still do not resolve a material claim, mark it unverified, carry the risk
   into affected Pocket Packets, and do not describe the API as verified. Continue
   planning work that does not depend on the unknown.

### Preflight Summary

```
PREFLIGHT COMPLETE
Codebase scanned: <areas reviewed>
Test framework: <detected framework + conventions, inferred proposal, or user-specified>
File conventions: <key patterns>
Existing helpers: <reusable helper/util modules found, or none>
Library docs checked: <library + exact version + Context7 or official source>
Key findings: <anything surprising or constraining for the plan>
Unverified areas: <claim + evidence gap + affected task, or none>
```

---

## Phase 1: Parse Spec

**Goal:** Extract all necessary context. Surface problems before decomposition starts.

Read spec completely, extract:

1. **Feature name** — from spec title
2. **Context summary** — current state, problem, related areas
3. **Design decision** — chosen option + tradeoffs; locate it in the spec or handoff context
4. **Architecture constraints** — layers, patterns, forbidden dependencies
5. **Acceptance criteria** — every rule + its GWT scenarios
6. **Out-of-scope items** — enforced in every Pocket Packet's QUALITY BAR
7. **Open questions / assumptions** — propagate as risks in QUALITY BAR, or record `none identified`
8. **Rollback plan** — propagated into STOP CONDITIONS of affected tasks

### GWT Check
- Rules with GWT → use directly
- Rules without GWT → note as `[N rules missing GWT — derive in Phase 3]`
- Negative rules (must-not) → note as `[N negative rules — need inverted assertions]`

### Conflict Check
- Duplicate rules (same behavior, different wording) → flag `[DUPLICATE]`, merge
- Rule conflicts out-of-scope (`must-have` vs `must-not-touch`) → flag `[CONTRADICTION]`; compare the spec with the user's explicit request and prior decisions. Resolve when intent is clear; ask one focused question only when the conflict leaves a consequential choice unresolved.

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

**Rule 6 — Cross-unit scenarios get explicit integration verification**
A GWT scenario that only holds when 2+ units collaborate (service + repository, producer + consumer, API + client) gets its verification decided here, not discovered mid-execution.

> Independently useful and runnable once its dependencies complete?
> YES → own integration-test task, `[depends: T_a, T_b]`. NO → extra TDD cycle inside the owning task.

Either way it lands in some task's Step 1 test intent — a cross-unit scenario verified nowhere is a defect the Spec Reviewer flags.

### Rule 2 vs Rule 4 Tiebreaker
> Is the second piece verifiable and useful without the first?
> YES → two tasks. NO → one task with sequential steps.

### Conflict Resolution
- Overlapping rules: check if same behavior (merge) or genuinely distinct (keep, note shared precondition)
- Unclear → inspect the spec, handoff context, and codebase evidence; use an explicit assumption for non-blocking details. Ask the user only if the unresolved point changes scope, behavior, or a consequential design choice.

### Dependency Notation

```
[prereq]           — no dependencies, runs first
[depends: T1]      — must wait for T1 to complete
[depends: T1, T2]  — must wait for both
[parallel: T3]     — can run concurrently with T3
[test-risk]        — marker: this task's test strategy is non-obvious (Phase 6 trigger)
```

Dependency annotations are **recommended order** — pocket-development enforces actual sequencing. Communicate this to user in Phase 7.

`[test-risk]` is a marker, not a dependency — always append it **after** a dependency annotation (`### Task 4: Sync worker retry policy [depends: T2] [test-risk]`). Used alone it carries no dependency and parses into the depth-0 prereq tier, silently reordering execution.

### Circular Dependency Check
Walk each task's dependency chain before presenting. If any chain leads back to itself → resolve by removing artificial dependency or extracting a `[prereq]` task.

### Large Spec (10+ tasks)
Recommend phases when 10+ tasks would make the plan difficult to execute or review. If the user already requested one plan or phased work, follow that instruction. Otherwise, choose a dependency-based grouping and state the rationale; ask only if the grouping changes delivery scope or sequencing authority.

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

### Test Intent, Not Test Code

Every behavioral task carries seven fields across the RED cycle — **test file, level, GWT test intent, boundary to exercise, test doubles, expected RED reason** in Step 1, and the **exact command** in Step 2 where the test is actually run. Both steps are laid out in the template below; the command is defined once, in Step 2.

Do **not** write test source code into the plan. The implementation does not exist yet, so code here is false precision: it pins imports, signatures, and fixture shapes that may legitimately change while still satisfying the spec. The implementer writes the test during the RED step, against the API that exists by then. The seven fields are what let them do that without guessing.

### Spec → Pocket Packet Mapping

| Pocket Field | Source |
|---|---|
| OBJECTIVE | Rule + TDD steps (red → green → refactor) + commit |
| REFERENCES LOADED | Spec path + relevant codebase files + version-matched docs or recorded source gaps for APIs used |
| WHY THIS APPROACH | Task type → complexity assessment |
| SANDWICH CONTEXT | Architecture constraints + design decision |
| DELIVERABLE | GWT scenarios (or derived) from acceptance criteria |
| QUALITY BAR | Must-haves, must-not-haves, open question risks |
| STOP CONDITIONS | Done = GWT passes + tests green | Escalate = constraint breach |

### Pocket Packet Template

**Canonical representation:** `references/plan-template.md` — cite it; do not restate its contents here.

Load `references/plan-template.md` during Phase 7 when writing the final execution plan document. The template defines the exact format for all `pocket-planning` output, regardless of task count.

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

**Goal:** Verify plan covers the spec completely, carries usable test intent, and has no placeholder failures. Dispatch subagent, wait for result before continuing.

→ Load `references/spec-reviewer-prompt.md` for the full dispatch prompt.

Quick dispatch format:

```
Dispatch: Subagent `spec-reviewer` | Standard complexity
Plan file: docs/pocket/plans/{date}-{slug}/execution-plan.md
Spec file: docs/pocket/spec/{date}-{slug}/topic.md
Return: Status (Approved | Issues Found | Needs Context) + specific findings with task:step references
```

**Review flow:**
- Status = Approved → proceed to Phase 6 (run its trigger check)
- Status = Issues Found → check each finding against the spec and packet, fix valid issues, and re-dispatch an independent reviewer on the changed plan.
- Status = Needs Context → check the spec, preflight summary, and plan for the missing information; provide it and request a focused review. If the missing item is a consequential user decision, ask only for that decision.
- If the reviewer repeats a finding, verify whether the plan addresses it. Correct the plan or provide evidence that the finding does not apply; do not accept or reject it by repetition alone.
- If the review is vague, repair the prompt with the exact task and step, then try a fresh reviewer or another available dispatch route. Never re-run an unchanged failed attempt.
- If no independent reviewer can run within the two-round budget, report the review as incomplete at `RECOVERY_CHECKPOINT`. Do not claim approval or hand off; wait for explicit user authorization before a new bounded window or an explicit decision to proceed without the required review.
- A review recovery round must change the plan, context, prompt, or independent review route. After two rounds with blocking findings or an incomplete review, stop at `RECOVERY_CHECKPOINT`; name the findings, attempts, evidence, and one proposed next strategy. Keep the plan unapproved and do not hand it off. Resume only after the user explicitly authorizes a new bounded window.
- Full reviewer dispatch protocol → `references/spec-reviewer-prompt.md`

---

## Phase 6: Test Strategy Audit (conditional — skipped by default)

**Goal:** Catch test-strategy mistakes the Spec Reviewer cannot see. Never generates test code, never rewrites the plan. **Default is SKIP.**

### Trigger Check (always run — it is free)

Dispatch only if one or more holds:

1. A GWT scenario spans 2+ implementation units (Rule 6 fired in Phase 3)
2. The unit vs integration vs E2E boundary is genuinely ambiguous for some task
3. Persistence, concurrency, networking, or an external service materially changes how a task must be tested
4. A task carries the `[test-risk]` marker

No trigger → record `TEST STRATEGY AUDIT: skipped — no trigger fired`, go to Phase 7, do not load the reference.

Trigger fires → load `references/test-strategy-audit-prompt.md`.

```
Dispatch: Subagent test-strategy-audit | Read-only review
Input: plan draft + spec + preflight findings + which triggers fired, on which tasks
Return: FINDINGS ONLY — missing behavior/edge case, wrong test level,
        wrong mock/fake boundary, missing integration verification,
        TDD ordering violation. No test code. No rewritten plan.
```

Apply findings by editing affected tasks in place. Then, before Phase 7:

- Task added → re-run the Phase 3 circular dependency check, refresh the Phase 2 file map, and update `**Total tasks:**`, the `Recommended Order` and `Parallelizable Groups` blocks, and the Plan Summary table. A new task changes the topology; stale overview blocks contradict the packets.
- **The confirmation review is triggered by mutation, not by the audit having run.** `Clean` → nothing changed → skip it → Phase 7. `Findings` applied → re-dispatch the Spec Reviewer on the changed tasks, since the review must cover the plan the user actually sees. If further valid changes are needed, fix them and review the changed tasks again, up to the same two-round cap. If feedback repeats or becomes inconclusive, change the prompt or reviewer route; at the cap, stop at `RECOVERY_CHECKPOINT` and keep the plan unapproved.

---

## Phase 7: Output Execution Plan

**Goal:** Save and validate the plan, then route it according to the user's authorization.

### Step 1: Save the plan

Save plan to: `docs/pocket/plans/{date}-{slug}/execution-plan.md`

→ Load `references/plan-template.md` for the full execution plan document format.

### Step 2: Validate via dry-run (MANDATORY, non-authorizing)

Run the CLI against the **saved** path to confirm the plan parses, conforms to the
`### Task N: name [annotation]` template, has a valid dependency order, and to capture
the execution flow — **without writing any files**:

```bash
npx -y pocketto-pi structure "docs/pocket/plans/{date}-{slug}/execution-plan.md" --dry-run --json --contract 3
```

Parse the JSON envelope — do not scrape prose:
- **`ok == false`** → **STOP. Do not present the approval gate.** Report `error.message` to the
  user (e.g. `NO_TASKS`, `UNKNOWN_TASK_REF`, `CYCLE_DETECTED` — the plan is malformed or has a
  bad/cyclic dependency). Fix the plan, then re-run this step.
- **`ok == true`** → capture `data.action` (`"single"` | `"split"`) and `data.executionFlow`
  (the run-order graph, e.g. `T1→T2,T3(PARALLEL)→T4`). This dry-run writes nothing and never
  authorizes a handoff — it only validates. Routing does not branch on `data.action`; every
  approved plan goes to pocket-structuring.

### Step 3: Plan approval and authorization

This gate is **plan approval**: the user authorizes generation of derived execution
artifacts (`execution-plan/index.md`, task files, and phase manifests when multi-phase).
It does **not** authorize implementation. Structuring will ask separately for
**execution approval** before pocket-development starts.

If the user has not already authorized handoff to pocket-structuring, present the
result and execution flow:

> "Plan complete — N tasks, TDD-structured, spec-reviewed, test intent defined.
> Test strategy audit: skipped (no trigger) | run on <tasks> — Clean, no findings | run on <tasks> — <N> findings applied, changed tasks re-reviewed | incomplete on <tasks> — <gap and impact>.
> Saved to docs/pocket/plans/…
> Execution flow: {data.executionFlow}
> Plan approval: Ready to hand off to pocket-structuring for execution index generation?"

Wait for approval before invoking pocket-structuring. If the user explicitly
requested plan generation and structuring earlier in the conversation, that
instruction counts as approval for this handoff; report the ready plan and continue
without asking the same question again. Plan approval authorizes generation of
derived plan artifacts only, never implementation.

### Step 3b: Revalidate user-requested edits

`structure --dry-run` validates parsing and dependency topology only. It says nothing about
spec coverage, test intent, mock boundaries, GWT coverage, or audit triggers — so an edit
requested *at* the approval gate can otherwise reach handoff without independent review of the
version that actually executes. Classify each requested edit by its **largest** applicable
tier and re-run that tier's checks:

| Edit | Revalidation |
|---|---|
| Cosmetic / metadata only — prose wording, section order, typos, summary text | Step 2 dry-run |
| Semantic packet edit — merge or split tasks, change a dependency, change a GWT behavior, add or remove a behavioral step, change files in scope | Step 2 dry-run + re-dispatch Spec Reviewer on the changed tasks |
| Test-strategy or topology edit — change a test level or mock boundary, introduce a new cross-unit seam, restructure dependencies | Step 2 dry-run + re-run the Phase 6 trigger check + re-dispatch Spec Reviewer on the changed tasks |

Then return to Step 3 and present the revalidated plan if approval is still needed.
Preserve existing authorization when the user requests edits to that plan unless they
change the requested scope or withdraw the handoff. **Only a version that has passed
the tier its edits require may be approved or handed off.**

Each user-requested edit round is revalidated at its own tier. Reviewer recovery is separate
from user-requested edits but remains bounded to two materially different rounds per review
gate. When findings repeat or the review becomes inconclusive, change the prompt or reviewer
route. At the cap, report `RECOVERY_CHECKPOINT`, preserve the unresolved findings, and wait
for explicit user authorization before another bounded window. Do not hand off an unapproved plan.

### Step 4: Route to pocket-structuring (when authorized)

When the user has approved or already authorized the handoff, invoke
`pocket-structuring` with:
- Execution plan path: `docs/pocket/plans/{date}-{slug}/execution-plan.md`
- Task count (from Phase 3)
- Spec file path

pocket-structuring re-parses the plan from disk and decomposes it into `execution-plan/index.md` + per-task files.

If the user requested only the execution plan and has not authorized structuring,
deliver the validated plan and stop here. Do not infer approval from a successful
dry-run or from the existence of the plan file.

---

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/task-decomposition.md` | Phase 3: **mandatory if 4+ tasks** — run Over-Split/Under-Split. Also: shared interfaces, event-driven, phased rollouts |
| `references/plan-template.md` | Phase 7: writing full execution plan document |
| `references/spec-reviewer-prompt.md` | Phase 5: dispatching spec reviewer subagent |
| `references/test-strategy-audit-prompt.md` | Phase 6: **only when a trigger fires** — dispatching the conditional test strategy audit |
