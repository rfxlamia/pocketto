# Copy Guidelines — Tone of Voice

Load this during **Step 4** when writing micro-copy. The register comes from
`semantic-map.md` (Formal / Neutral-friendly / Casual). Copy is part of the design system,
not an afterthought — a navy, low-radius, "trustworthy" UI with "Ayo gabung bestie! 🎉"
buttons is a broken brand.

## Contents
- [Pick the Register](#pick-the-register)
- [Copy Surfaces to Define](#copy-surfaces-to-define)
- [Tone Matrix](#tone-matrix)
- [Error Message Rules](#error-message-rules)
- [Universal Rules](#universal-rules)
- [Worked Examples per Register](#worked-examples-per-register)

---

## Pick the Register

Carry over the register decided in Step 2:

| Register | When | Voice |
|----------|------|-------|
| **Formal** | fintech, health, B2B, security, gov, anything serious | precise, respectful, no slang, no exclamation |
| **Neutral-friendly** | most web apps, SaaS, productivity | clear, warm, plain language, sparing exclamation |
| **Casual / energetic** | consumer, social, games, kids, lifestyle | conversational, can use emoji/exclamation, second person |

If Step 2 conflict-resolution capped expressiveness (trust wins on structure), keep copy at
**Neutral-friendly** even if one adjective was "playful" — express play in an accent, not in
risk-bearing copy like errors.

---

## Copy Surfaces to Define

At minimum, produce examples for:

1. **CTA** — primary action button label
2. **Secondary action** — cancel/back/skip label
3. **Error messages** — at least: validation error, failed action, empty/permission error
4. **Placeholder text** — for the Input atom
5. **Empty state** — one short line (optional but recommended)
6. **Success confirmation** — one line

---

## Tone Matrix

| Surface | Formal | Neutral-friendly | Casual |
|---------|--------|------------------|--------|
| CTA (sign up) | "Daftar Sekarang" / "Create Account" | "Get started" | "Join the fun!" |
| CTA (submit) | "Submit" / "Confirm" | "Save changes" | "Done!" |
| Secondary | "Cancel" | "Not now" | "Maybe later" |
| Placeholder (email) | "name@company.com" | "Enter your email" | "your@email.com 👋" |
| Validation error | "Email format is invalid." | "That email doesn't look right." | "Hmm, check that email?" |
| Empty state | "No records found." | "Nothing here yet." | "All clear — nothing to see!" |
| Success | "Your changes have been saved." | "Saved!" | "Boom — saved! 🎉" |

Use this as a guide, not a copy-paste: localize to the actual product nouns (e.g. "invoice",
"workout", "playlist").

---

## Error Message Rules

Errors are the highest-stakes copy. Regardless of register:

1. **Say what happened** — not just "Error".
2. **Say how to fix it** — actionable next step.
3. **Never blame the user** — "That email doesn't look right" not "You typed it wrong".
4. **No internal jargon / codes** in the user-facing string (log codes separately).
5. **Match severity** — a failed payment is not the place for an exclamation mark or emoji,
   even in a casual brand.

Pattern: `[what failed] + [why, if helpful] + [what to do next]`.

---

## Universal Rules

- **Sentence case** for buttons and labels by default (Title Case only if the brand dictates).
- **Active voice, present tense.**
- **Lead with the verb** on CTAs ("Save", "Create", "Send").
- **Be concise** — a button is 1–3 words; an error is one sentence.
- **Consistency over cleverness** — pick "Sign in" or "Log in" and use it everywhere.
- **Emoji/exclamation** only in the Casual register, and never in error/security/payment copy.

---

## Worked Examples per Register

**Formal (fintech dashboard, "trustworthy, secure"):**
- CTA: "Transfer Funds" · Secondary: "Cancel"
- Placeholder: "Enter amount (IDR)"
- Error: "Insufficient balance. Reduce the amount or add funds to continue."
- Success: "Transfer completed. A receipt has been sent to your email."

**Neutral-friendly (project tool, "clear, modern"):**
- CTA: "Create project" · Secondary: "Not now"
- Placeholder: "Project name"
- Error: "That name's already taken — try another."
- Success: "Project created."

**Casual (habit app, "playful, friendly"):**
- CTA: "Start my streak!" · Secondary: "Maybe later"
- Placeholder: "What habit are you building? 💪"
- Error: "Oops — give your habit a name first."
- Success: "Nice! Day 1 logged 🎉"
