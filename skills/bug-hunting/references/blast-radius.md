# Blast Radius Mapping (Phase 2)

## Overview

Every bug lives in a neighborhood. Fixing one bug while its neighbors survive
is how you close a ticket and reopen it three times.

**Core rule:** Before tracing any root cause, map the full surface.
Primary bug + minimum 2 additional suspects. Always.

---

## Why Blast Radius Matters

Without mapping:
- Fix `getUserById()` null crash → Ship it → `getOrderById()` crashes next week (same pattern)
- Fix one SQL injection point → Miss 7 similar queries → Still vulnerable

With mapping:
- Fix the pattern everywhere at once
- Find the systematic weakness, not just the instance
- Prevent the sibling bugs before they're reported

---

## The Mapping Process

### Step 1: Document the Primary Bug

```
Primary Bug:
  Function: [what broke]
  Crash site: [file:line]
  Evidence class: ✅ CONFIRMED / 🔍 SUSPECTED / 💭 THEORETICAL
  Severity: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low
```

### Step 2: Search for Suspects (minimum 2)

Ask these questions to find suspects:

**Same pattern, different location:**
- What other functions have the same structure as the broken one?
- What other places call the same API/method that returned bad data?
- Is there a common utility or helper shared by the broken code?

**Same assumption, different code path:**
- What other code assumes the same thing the broken code assumed?
- Example: if code assumed `user.profile` always exists → who else assumes that?

**Same data flow:**
- Where else does this data come from or go to?
- What other components receive the same input that caused the crash?

**Adjacent components:**
- What is called before this code? Could they fail the same way?
- What calls this code? Do they have similar null-checks missing?

### Step 3: Classify Each Suspect

For each suspect found:

```
Suspect N:
  Location: [file:line or component name]
  Pattern: [why it's similar to the primary bug]
  Evidence class: ✅ / 🔍 / 💭
  Severity: 🔴 / 🟠 / 🟡 / 🟢
  Action: Investigate now / Monitor / Document for later
```

Severity definitions:
- 🔴 **Critical** — data loss, security breach, crash in production critical path
- 🟠 **High** — wrong output, significant user impact, will surface under normal use
- 🟡 **Medium** — intermittent, affects edge cases, workaround exists
- 🟢 **Low** — cosmetic issue, very rare condition, minor annoyance

### Step 4: Prioritize Investigation Order

Fix in severity order: 🔴 → 🟠 → 🟡 → 🟢

Do not fix 🟢 suspects if 🔴 ones are unresolved.

---

## Practical Search Techniques

### Find Similar Code Patterns

```bash
# Find other functions that access the same property
grep -rn "\.preferences\." src/ --include="*.js"

# Find other places that call the same function
grep -rn "getUserById\|getOrderById\|getProductById" src/

# Find other places missing a null check pattern
grep -rn "req\.user\." src/ | grep -v "req\.user &&\|req\.user?"
```

### Find Functions with Same Assumption

```bash
# Example: find all places that assume session exists
grep -rn "session\.userId\|session\.user\." src/

# Find all places that assume config values are present
grep -rn "process\.env\." src/ | grep -v "process\.env\. *[?|]"
```

### Find Adjacent Code Paths

```bash
# Trace who calls the broken function
grep -rn "processOrder\|createOrder" src/

# Find the common entry point
grep -rn "import.*OrderService\|require.*OrderService" src/
```

---

## Blast Radius Report Template

Before proceeding to Phase 3:

```
## Blast Radius Map

Primary Bug:
  [description, file:line, severity, evidence class]

Suspect 1:
  Location: [file:line]
  Pattern: [why similar]
  Severity: [🔴/🟠/🟡/🟢]
  Evidence: [✅/🔍/💭]

Suspect 2:
  Location: [file:line]
  Pattern: [why similar]
  Severity: [🔴/🟠/🟡/🟢]
  Evidence: [✅/🔍/💭]

[additional suspects if found]

Investigation order: Primary → [suspects by severity]
```

---

## Common Blast Radius Patterns

| Bug type | Where to look for suspects |
|----------|---------------------------|
| Null/undefined crash | Other functions accessing same object without guards |
| Missing auth check | Other endpoints in same controller/router |
| SQL injection | Other queries using string interpolation |
| Race condition | Other async operations touching same shared state |
| Missing index (perf) | Other queries on same table without appropriate indexes |
| Foreign key violation | Other delete/update operations on related tables |
| Hardcoded value | Other places with similar hardcoded assumptions |

---

## When to Expand the Radius

**Expand further when:**
- Primary bug is in a utility/shared function (used everywhere → wide radius)
- Bug caused data corruption (what data was affected? what reads that data?)
- Security vulnerability (assume the vulnerability exists elsewhere too)
- Architecture-level assumption (assumption is probably made everywhere)

**Stop expanding when:**
- Suspects are in completely unrelated domains
- Suspects require a different investigation than the primary
- You have 5+ suspects and none are 🔴 — stop, prioritize, proceed

---

## Blast Radius vs Root Cause

Blast radius (Phase 2) and root cause (Phase 3) are different:

- **Blast radius**: How wide is the impact? What else is broken?
- **Root cause**: Why is the primary bug happening?

Map the radius BEFORE tracing root cause. Root cause analysis will reveal fixes
that should apply to all suspects in the radius simultaneously.
