# Evidence Collection (Phase 1)

## Overview

Evidence collection is not investigation. Do not interpret while collecting.
Collect first, classify, then analyze. Mixing phases causes premature conclusions.

**Core rule:** Every statement about the bug must trace to a piece of evidence.
"Almost certainly X" is not evidence. Running the code and observing X is evidence.

---

## Evidence Classification

Mark every piece of evidence before proceeding to Phase 2:

| Class | Meaning | Example |
|-------|---------|---------|
| ✅ CONFIRMED | Directly observed, reproducible | "Stack trace shows line 47 throws NPE on every run" |
| 🔍 SUSPECTED | Correlated, not yet proven | "Error started after config change" |
| 💭 THEORETICAL | Logical inference, not observed | "jwt.verify could return null if secret is wrong" |

**Rule:** You may not write "root cause is X" if X is SUSPECTED or THEORETICAL.
Only CONFIRMED evidence can support a root cause claim.

---

## Single-Component Bug: Checklist

```
□ Read full error message and stack trace (every line)
□ Note: file path, line number, function name, error type
□ Reproduce: minimum steps to trigger consistently
□ If not reproducible → STOP, gather more data, do not guess
□ Check git log: what changed in the last N commits?
□ Check environment: versions, config, env vars
□ Classify evidence before moving to Phase 2
```

---

## Multi-Component Bug: Diagnostic Instrumentation

When the system has multiple components (API → service → database, CI → build → deploy),
instrument EACH boundary before drawing any conclusions.

**Template:**

```
For EACH component boundary:
  1. Log what data ENTERS the component
  2. Log what data EXITS the component
  3. Verify state/config at this layer
  4. Run once — observe where it breaks
  THEN: identify the failing boundary
  THEN: investigate that specific component
```

**Example — auth pipeline:**
```bash
# Layer 1: Check token at entry point
echo "Token received: ${TOKEN:+SET (${#TOKEN} chars)}${TOKEN:-NOT SET}"

# Layer 2: Check what JWT decode receives
echo "Decoding with secret: ${JWT_SECRET:+SET}${JWT_SECRET:-NOT SET}"

# Layer 3: Check decoded value
# (add console.error before the crash line)
console.error('DEBUG decoded:', JSON.stringify(decoded), 'type:', typeof decoded)

# Layer 4: Check what gets passed to downstream
console.error('DEBUG userId:', userId, 'from decoded:', decoded?.id)
```

Run, observe output. The layer where value goes wrong is your investigation target.

**Do not guess which layer is broken before running this.**

---

## Reproducing Consistently

A bug you cannot reproduce is a bug you cannot fix.

| Situation | What to do |
|-----------|-----------|
| Reproduces every time | Document exact steps. Proceed. |
| Reproduces sometimes | Find the variable (load, data, timing). Do not fix until consistent. |
| Cannot reproduce | Add more logging. Do not fix yet. |
| Only in production | Add prod-safe logging, capture next occurrence. |

**Never fix an unreproducible bug.** You will break something else.

---

## Checking Recent Changes

```bash
# What changed recently?
git log --oneline -20

# What exactly changed in a commit?
git show <hash>

# What changed in a specific file?
git log -p -- path/to/file.js

# What's different between working and broken?
git diff <last-good-commit> HEAD -- path/to/affected/area/
```

Look for: dependency updates, config changes, environment variable additions,
schema migrations, new code paths in the affected area.

---

## Common Evidence Mistakes

| Mistake | What it causes | Correct approach |
|---------|---------------|------------------|
| Reading the error and jumping to cause | Skips evidence collection | Write down the evidence first, analyze second |
| "I've seen this before" | Confirmation bias | Treat each bug as new. Verify your pattern. |
| Accepting correlation as causation | Wrong root cause, wrong fix | Deployment ≠ caused the bug. Prove the link. |
| Stopping at first plausible explanation | Symptom fix | Keep tracing. Is this the source or a midpoint? |
| Not classifying evidence | Claims without foundation | Every statement needs a classification (✅/🔍/💭) |

---

## Evidence Report Template

Before moving to Phase 2, write:

```
## Evidence Report

Error: [exact error message]
Location: [file:line]
Reproducible: YES / NO / SOMETIMES

CONFIRMED evidence:
- [observation 1]
- [observation 2]

SUSPECTED evidence:
- [correlation 1]
- [correlation 2]

THEORETICAL:
- [inference 1]

Recent changes relevant:
- [commit or change]
```

This report is your Phase 2 input. It must exist before Blast Radius Mapping.
