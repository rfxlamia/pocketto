# Brief Plan Format

What a valid brief plan looks like. Load this during Step 2 of quick-iteration.

## Contents
- [Required Fields](#required-fields)
- [Format](#format)
- [Good Examples](#good-examples)
- [Bad Examples](#bad-examples)
- [One-Liner Changes](#one-liner-changes)
- [What Counts as a Valid Test Step](#what-counts-as-a-valid-test-step)
- [Common Mistakes](#common-mistakes)

---

## Required Fields (every plan must include all 4)

1. **What** — what is changing (specific, not vague)
2. **Where** — which file(s), function(s), or component(s)
3. **How** — the approach in 1-2 sentences
4. **Test** — how to verify it works (even if it's manual)

---

## Format

Write as a bulleted list. 3-5 bullets. No headers, no prose paragraphs.
If you need more than 5 bullets, the task is too large for quick-iteration —
escalate to superpowers/brainstorming.

---

## Good Examples

**Example 1 — Typo fix:**
- Fix: change "Singin" → "Sign in" in login button label
- Where: `src/components/LoginButton.tsx`, line ~34
- How: single string replace, no logic changes
- Test: visual check in browser — confirm button reads "Sign in"

**Example 2 — Loading spinner:**
- Add: `isSubmitting` boolean state to submit handler
- Where: `src/features/checkout/CheckoutForm.tsx`
- How: set true before API call, reset in finally block; disable button + show spinner while true
- Reuse: `<Spinner />` component from `src/components/ui/`
- Test: submit form, verify spinner appears; verify button re-enables on both success and error

**Example 3 — Error message display:**
- Add: error message render below submit button when API call fails
- Where: `src/features/auth/LoginForm.tsx`
- How: read `error.message` from existing `useAuth` hook's error state; render conditionally
- Test: trigger a failed login (bad credentials), confirm error message appears and clears on retry
- Edge case: empty error.message → show fallback "Something went wrong"

---

## Bad Examples (Do Not Write These)

**Too vague:**
- Fix the button
- Make it work
- Update the form

**Too broad (escalate instead):**
- Refactor the entire auth module
- Add error handling to all API calls
- Migrate from REST to GraphQL

**Missing test:**
- Change the label on the submit button
- Add loading state
(no mention of how to verify → not a valid plan)

---

## One-Liner Changes

Even for trivial changes, 2 bullets minimum:
- What + Where (combined): fix typo "Singin" → "Sign in" in `LoginButton.tsx:34`
- Test: confirm in browser

---

## What Counts as a Valid Test Step

The test step is not optional. It must be specific enough to execute.

Valid test steps:
- "Run `npm test` and confirm no failures"
- "Submit the form with bad credentials, confirm error banner appears"
- "Reload the page, confirm the spinner is gone on success"
- "Check network tab: API call fires once, not twice on double-click"
- "Visual check in browser: button label reads 'Sign in'"

Not valid (too vague):
- "Test it"
- "Make sure it works"
- "Verify"

For logic changes, prefer: describe the input → the expected output.
For UI changes, describe what the user would see.
For API changes, describe the expected response or behavior.

---

## Common Mistakes

**1. Merging What + How without Where**
Bad: "Add loading state to the form"
Good: "Add `isLoading` state to `CheckoutForm.tsx`, disable submit button while true"

**2. Plan that starts with implementation details but forgets the test**
Fix: always write the test step last, explicitly.

**3. Plan that's really a task list without decisions**
"Step 1: read the file. Step 2: edit it. Step 3: test."
This is not a plan — it's a procedure without a stated approach.
A valid plan says HOW and WHERE, not just WHAT ORDER.

**4. Over-specifying (brief plan, not implementation spec)**
Wrong: write 10 bullets explaining every function call
Right: 3-5 bullets covering decisions and approach only
