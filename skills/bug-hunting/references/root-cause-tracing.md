# Root Cause Tracing (Phase 3)

## Contents
- [Overview](#overview)
- [The Backward Trace](#the-backward-trace)
- [When You Can't Trace Manually: Add Instrumentation](#when-you-cant-trace-manually)
- [Example: Full 5-Level Trace](#example-full-5-level-trace)
- [Hypothesis Testing](#hypothesis-testing)
- [Architecture Problem Signal](#architecture-problem-signal)
- [Root Cause vs Proximate Cause](#root-cause-vs-proximate-cause)

## Overview

The crash site is not the source. The error message is not the cause.
The first plausible explanation is not the root cause.

**Core rule:** Trace backward through the call chain until you find the
original trigger. Fix at the source, not at the symptom.

**Root cause is confirmed only when:** you can state
"Root cause is X because I observed [CONFIRMED evidence Y]."
"Probably X" and "appears to be X" are not confirmed root causes.

---

## The Backward Trace

### Step 1: Find the Crash Site

```
Error: TypeError: Cannot read property 'id' of undefined
  at AuthMiddleware.validateToken (auth.middleware.js:47)
```

Crash site: `auth.middleware.js:47`, variable `decoded` is undefined.

### Step 2: Ask "What Created the Bad Value?"

Read the code at the crash site. Find where `decoded` comes from:

```js
// auth.middleware.js
const decoded = jwt.verify(token, process.env.JWT_SECRET);
const userId = decoded.id; // line 47 — crashes here
```

`decoded` is the return value of `jwt.verify()`. When does `jwt.verify()` return undefined?
→ Check jwt documentation / source. When secret is wrong, does it throw or return null?

### Step 3: Ask "What Called This With the Bad Value?"

Trace one level up:
- What passes `token` to `jwt.verify()`?
- Where does `token` come from?
- Could `token` be empty/malformed?

```js
const token = req.headers.authorization?.split(' ')[1];
// What if authorization header is missing? token = undefined
// What does jwt.verify(undefined, secret) return/throw?
```

### Step 4: Keep Tracing Up

Continue backward until you reach the **original trigger** —
the first moment where the bad value was created or an expected value was not provided.

The original trigger might be:
- Missing input validation at API entry
- A code path that was not handled
- A race condition in initialization
- A configuration value not being set

### Step 5: Confirm the Root Cause

**Do not claim root cause until:**
1. You have traced all the way to the origin
2. You can explain the full chain from trigger to crash
3. The evidence for the trigger is ✅ CONFIRMED

**Root cause statement format:**
```
Root cause: [specific thing] at [specific location]
Evidence chain: [trigger] → [intermediate] → [crash site]
CONFIRMED by: [what I ran/observed/read]
```

---

## When You Can't Trace Manually: Add Instrumentation

When the call chain is too deep or implicit, add logging before the crash:

```typescript
// Before the problematic operation
async function processToken(token: string) {
  const stack = new Error().stack;
  console.error('DEBUG token processing:', {
    token: token ? `${token.substring(0, 20)}...` : 'EMPTY',
    hasAuthHeader: !!req.headers.authorization,
    jwtSecretSet: !!process.env.JWT_SECRET,
    stack
  });

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
}
```

**Tips:**
- Use `console.error()` in tests (not logger — may be suppressed)
- Log before the dangerous operation, not after it fails
- Capture: the bad value, where it came from, stack trace, relevant state

```bash
# Capture and filter debug output
npm test 2>&1 | grep 'DEBUG'
```

---

## Example: Full 5-Level Trace

**Symptom:** `.git` created in source code directory instead of temp dir.

| Level | What was found |
|-------|---------------|
| 1 — Crash site | `git init` ran in `process.cwd()` (source dir) |
| 2 — Immediate cause | `cwd` parameter was empty string → resolved to process.cwd() |
| 3 — One level up | `WorktreeManager.createWorkspace('')` called with empty string |
| 4 — One more up | `Session.create()` passed empty `projectDir` |
| 5 — Origin | Test accessed `context.tempDir` before `beforeEach()` ran |

**Root cause:** Top-level test variable accessed before initialization.

**Fix at source:** Made `tempDir` a getter that throws if accessed before `beforeEach`.
**Also fixed at:** All 4 intermediate levels (defense-in-depth).

---

## Hypothesis Testing

When the trace is unclear, form and test hypotheses systematically:

1. **State the hypothesis explicitly:** "I think decoded is null because jwt.verify returns null on wrong secret (not throws)"
2. **Design minimal test:** `jwt.verify('test-token', 'wrong-secret')` — what happens?
3. **Observe result** — CONFIRMED or refuted
4. **If refuted:** Form a new hypothesis. Do not add fixes while testing hypotheses.
5. **If confirmed:** You have CONFIRMED evidence. Document it. Proceed to fix.

**One hypothesis at a time. One test at a time. One variable at a time.**

---

## Architecture Problem Signal

If 3+ hypotheses have been tested and refuted, you likely have an architectural problem.

Signs:
- Each fix reveals a new problem in a different place
- The "correct" fix requires massive refactoring
- Fixing one thing breaks something seemingly unrelated

**Stop. Do not form Hypothesis #4.**
Question the architecture: is the fundamental design flawed?
Discuss with your team before attempting more fixes.

---

## Root Cause vs Proximate Cause

| Type | Definition | Example |
|------|-----------|---------|
| **Root cause** | The original trigger — the first broken thing | Test accesses variable before initialization |
| **Proximate cause** | Where the crash manifests | `git init` receives empty path |

**Always fix the root cause.** The proximate cause is where you find the bug.
The root cause is where you fix it.

Fixing proximate cause alone = the bug returns through a different code path.
