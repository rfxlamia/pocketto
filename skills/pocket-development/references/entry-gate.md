# Entry Gate Checklist

The Entry Gate is a mandatory 5-question checkpoint before any subagent spawn.

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

5. VERIFICATION DEFINED?
   ├── Know exact criteria for "done"?
   ├── Can write 3-5 verification checklist items?
   └── Have review strategy (explore reviewer plan)?
```

## Decision Matrix

| All 5 Pass | Action |
|------------|--------|
| YES | Construct Pocket Packet → Spawn |

| Any "NO" | Action |
|---------|--------|
| 1. TASK BOUNDED = NO | Redefine scope or KEEP LOCAL |
| 2. PACKET CONSTRUCTIBLE = NO | Cannot delegate precisely → KEEP LOCAL |
| 3. TASK TYPE UNCLEAR = NO | Clarify task type before proceeding |
| 4. PROMPT SANDWICH = NO | Restructure prompt or KEEP LOCAL |
| 5. VERIFICATION DEFINED = NO | Define verification or KEEP LOCAL |

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

## KEEP LOCAL Triggers

When gate fails, use KEEP LOCAL:

```
KEEP LOCAL: [specific failure reason]
WHY UNSAFE: [what could go wrong]
NEXT ACTION: [concrete local step to make progress]
```

## Gate vs Packet Relationship

```
Gate (5 questions) ──→ Packet (8 fields)
     │                        │
     ↓                        ↓
  "Can I delegate?"    "Here's HOW to delegate"
```

Gate answers: Should I delegate?
Packet answers: HOW to delegate if yes.

Both are mandatory. Gate doesn't replace packet; packet doesn't bypass gate.
