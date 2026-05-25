# Defense-in-Depth (Phase 4)

## Overview

A single fix can be bypassed by a new code path, a refactor, or a mock.
Adding validation at one place means you fixed the bug. Adding validation
at every layer means you made the bug structurally impossible.

**Goal:** After fixing, the bug cannot recur through any path.

---

## The Four Layers

### Layer 1: Entry Point Validation

Reject invalid input at the API or function boundary.

```typescript
function createOrder(userId: string, items: CartItem[]) {
  if (!userId || userId.trim() === '') {
    throw new Error('userId is required');
  }
  if (!items || items.length === 0) {
    throw new Error('Order must have at least one item');
  }
  // proceed
}
```

**Catches:** Bad data before it enters the system.

### Layer 2: Business Logic Validation

Validate that data makes sense for this specific operation.

```typescript
function calculateDiscount(price: number, percent: number) {
  if (price < 0) throw new Error('Price cannot be negative');
  if (percent < 0 || percent > 1) throw new Error('Percent must be 0-1');
  return price - (price * percent);
}
```

**Catches:** Edge cases that slip past entry point validation.

### Layer 3: Environment Guards

Prevent dangerous operations in specific contexts (e.g., tests, staging).

```typescript
async function initializeRepository(directory: string) {
  if (process.env.NODE_ENV === 'test') {
    const normalized = path.normalize(path.resolve(directory));
    const tmpDir = path.normalize(path.resolve(os.tmpdir()));
    if (!normalized.startsWith(tmpDir)) {
      throw new Error(
        `Refusing dangerous operation outside temp dir in test: ${directory}`
      );
    }
  }
  // proceed
}
```

**Catches:** Context-specific violations that other layers miss.

### Layer 4: Debug Instrumentation

Capture context for forensics when all other layers fail.

```typescript
async function processPayment(payload: PaymentPayload) {
  logger.debug('Processing payment', {
    userId: payload.userId,
    amount: payload.amount,
    hasToken: !!payload.token,
    stack: new Error().stack
  });
  // proceed
}
```

**Catches:** Problems that reach production without triggering earlier layers.

---

## Applying Defense-in-Depth

When a bug is found:

1. **Trace data flow** — where does bad value originate? where is it used?
2. **Map all checkpoints** — every function the data passes through
3. **Add validation at each layer** — don't stop at the crash site
4. **Test each layer** — try to bypass layer 1, verify layer 2 catches it

```
Data flow: [source] → [validation 1] → [processing] → [validation 2] → [crash site]

If crash happens at crash site:
  Fix at source (root cause)
  Add validation at validation 1 (entry)
  Add validation at validation 2 (business logic)
  Add guard at crash site (last resort)
```

---

## Applying the Fix

**The fix you ship:**
```
1. Fix at root cause (the source)
2. Add entry-point validation
3. Add business logic guard
4. Add instrumentation for monitoring
```

Not all 4 layers are always needed. Use judgment based on risk:
- 🔴 Critical bugs: all 4 layers
- 🟠 High bugs: layers 1-3
- 🟡 Medium bugs: layers 1-2
- 🟢 Low bugs: layer 1 + fix at root cause

---

## Red Flags for Incomplete Defense

| Sign | Problem |
|------|---------|
| "We fixed it in one place" | Same bug will recur via different path |
| "Tests pass but production uses different flow" | Missing layer 3 (environment guard) |
| "We'll add validation when it breaks again" | No defense-in-depth |
| "The root cause fix is enough" | Root cause fix + zero layers = same bug can return |

---

## Real Example

**Bug:** Empty `projectDir` caused `git init` in source code directory.

| Layer | What was added |
|-------|----------------|
| Entry | `Project.create()` validates dir is non-empty and exists |
| Business | `WorkspaceManager` validates projectDir before any operation |
| Environment | Guard refuses git init outside temp dir in test mode |
| Instrumentation | Stack trace logged before any git operation |

**Result:** Bug impossible through any of the 4 paths that could have triggered it.
All 1847 tests passed after adding all layers.
