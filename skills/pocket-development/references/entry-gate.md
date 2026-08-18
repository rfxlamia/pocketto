# Entry Gate Checklist

The Entry Gate is a mandatory 6-question checkpoint before any subagent spawn.

## The Checklist

```
1. TASK BOUNDED?
   ├── Scope clear? (specific deliverables, not vague goals)
   ├── Deliverables defined? (what exactly counts as "done")
   └── Stop conditions known? (when to stop, what uncertainty looks like)

2. PACKET CONSTRUCTIBLE?
   ├── Can write 8-field packet without leaving fields vague?
   ├── Not using forbidden verbs? (handle, fix, debug, improve, review)
   └── Can provide verification checklist?

3. TASK TYPE CLEAR?
   ├── Implementation task? → proceed with delegation
   ├── Review/audit task? → route to review workflow
   └── Complexity appropriate? (lightweight/standard/deep match task scope)

4. PROMPT SANDWICH?
   ├── Critical instruction can be in FIRST LINE?
   ├── Key constraint can be REPEATED near END?
   └── Middle can stay free of filler?

5. PARALLEL CLASSIFICATION?
   ├── Is this task FOUNDATION? (downstream tasks depend on it)
   │   → Run sequentially in main repo. No worktree.
   ├── Is this task in a PARALLEL GROUP? (≥2 tasks share same dep set, no deps between them)
   │   → Activate worktree protocol. Dispatch group as parallel batch.
   └── Is this task SOLO? (no parallel peers, or group resolved to size 1)
       → Run sequentially in main repo. No worktree overhead.

6. VERIFICATION DEFINED?
   ├── Know exact criteria for "done"?
   ├── Can write 3-5 verification checklist items?
   └── Verification criteria specific enough for the in-loop auditor to judge? (see references/two-stage-review.md)
```

## Decision Matrix

| All 6 Pass | Action |
|------------|--------|
| YES | Construct Pocket Packet → Spawn (with WORKTREE field if PARALLEL GROUP) |

| Any "NO" | Action |
|---------|--------|
| 1. TASK BOUNDED = NO | Redefine scope or KEEP LOCAL |
| 2. PACKET CONSTRUCTIBLE = NO | Cannot delegate precisely → KEEP LOCAL |
| 3. TASK TYPE UNCLEAR = NO | Clarify task type before proceeding |
| 4. PROMPT SANDWICH = NO | Restructure prompt or KEEP LOCAL |
| 5. PARALLEL CLASSIFICATION = unclear | Re-read plan annotations; if still unclear, escalate to user |
| 6. VERIFICATION DEFINED = NO | Define verification or KEEP LOCAL |

## Bounded vs Unbounded Tasks

### Bounded (Pass Gate)

```
✅ "Extract auth layer from user_service.py to auth_service.py,
    including token validation and refresh logic, update imports,
    ensure tests pass"

✅ "Add rate limiting middleware to /api/* routes,
    limit 100 req/min per IP, return 429 with Retry-After header"
```

### Unbounded (Fail Gate)

```
❌ "Handle the auth stuff"
❌ "Fix the login bug"
❌ "Improve performance"
❌ "Review this code"
```

## Foundation vs Parallel-Group vs Solo

Reading the plan's `[depends: TX]` and `[parallel: TY]` annotations classifies each task into one of three execution modes. Item 5 of the gate enforces this BEFORE worktrees and packets are constructed.

### Foundation (Sequential, No Worktree)

A task is FOUNDATION when ≥1 other task lists it in `[depends: ...]`. Downstream work cannot start until it merges.

Examples:
- `T3: Database schema migration` — T4, T5, T6 depend on it
- `T4: Middleware base` — T5, T6, T7 depend on it

Always run sequentially in main repo. Worktree adds overhead without benefit since nothing else runs concurrently.

### Parallel Group (Worktree Required)

A set of ≥2 tasks where:
- All share the SAME dependency set (e.g., all `[depends: T4]`)
- None depends on any other in the set
- Plan annotates with `[parallel: TX]`

Example:
```
T5: Projects + Invites endpoints       [depends: T4]
T6: Roadmap endpoints                  [depends: T4] [parallel: T5]
T7: Owner dashboard endpoints          [depends: T4] [parallel: T5,T6]

→ Group {T5, T6, T7}, parent = T4's done_sha
```

MUST use worktree protocol — twin/fork subagents inherit CWD and will collide on `git status`, `git log`, lockfiles, and shared registries. See "Parallel Group Execution" in SKILL.md for the mechanics.

### Solo (Sequential)

A task with no `[parallel: ...]` peers, OR a parallel group that resolved to size 1 (other group members were skipped or merged elsewhere). Run sequentially in main repo.

## Classification Decision Tree

```
For each task ready to dispatch:

  Does any unstarted task list this in [depends]?
      └── YES → FOUNDATION → sequential, main repo
      └── NO  ↓

  Does this task have [parallel: TX] AND ≥1 peer in TX still pending?
      └── NO  → SOLO → sequential, main repo
      └── YES ↓

  Are all peers' deps satisfied (group is ready as a whole)?
      └── NO  → wait — dispatch when group is ready
      └── YES → PARALLEL GROUP → worktree protocol
```

## Why Classification Belongs Here

The Entry Gate already gatekeeps "should I delegate?" — classification is "HOW to delegate, sequentially or in parallel?". Same checkpoint, same prevention principle: catch the wrong execution mode BEFORE worktrees and packets are constructed.

A misclassified task = a foundation task accidentally worktreed (wasted setup, branch noise) or a parallel group accidentally serialized (lost time, and silent collisions if ever re-parallelized).

## KEEP LOCAL Triggers

When gate fails, use KEEP LOCAL:

```
KEEP LOCAL: [specific failure reason]
WHY UNSAFE: [what could go wrong]
NEXT ACTION: [concrete local step to make progress]
```

## Gate vs Packet Relationship

```
Gate (6 questions) ──→ Packet (7 fields, +WORKTREE for parallel)
     │                        │
     ↓                        ↓
  "Can I delegate?"    "Here's HOW to delegate"
```

Gate answers: Should I delegate?
Packet answers: HOW to delegate if yes.

Both are mandatory. Gate doesn't replace packet; packet doesn't bypass gate.
