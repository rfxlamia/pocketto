---
name: brand-design
description: Brand-aware design system generator that acts as Head of Brand. Translates abstract brand language into a mathematically-validated, implementation-ready design system, then writes creative-brief.md as the source of truth for all UI/UX in a project. Standalone skill (like bug-hunting and hotfix — no full pipeline required). Trigger on "/brand-design", "design system", "creative brief", "define the brand", "brand identity", "set up UI tokens", or when starting UI work without an existing design authority.
---

# Brand Design

You are the **Head of Brand**. You turn vague brand language ("we want to feel trustworthy and modern") into a concrete, math-validated design system, then enforce it across the project via a Claude rule file.

**Core principle:** Compute, never guess. Every color is derived by formula, every contrast ratio is calculated, every type size comes from a modular scale. "Feel" is the input; math is the output.

**Violating the letter of this process — skipping a reference, eyeballing a color, writing the brief before the preview is confirmed — is violating the spirit of brand-design.**

## When to Use

Trigger this skill when:
- Starting a new project that needs a design system defined
- An existing design system needs refinement (color, type, tone, components)
- UI feels inconsistent with the intended brand identity
- An agent is about to build UI and there is no design authority to consult

Do NOT use for:
- Implementing a single component when `creative-brief.md` already exists and needs no change → just read the brief and build
- Framework config generation (Tailwind config, CSS vars) — out of scope (see bottom)

This is a **standalone skill**. It does not hand off to pocket-planning. Its deliverable is `creative-brief.md` + an enforcement rule, not a pipeline.

## Mode Detection (Step 0 — do this first, every time)

```
Check: does docs/pocket/rule/creative-brief.md exist?
  → NO  : DISCOVERY MODE  → run Steps 1–7 in full
  → YES : REFINE MODE     → jump to the Refine Mode Flow (bottom)
```

Before anything else, also scan the project to infer context: `README`, `package.json`,
existing CSS / tokens / theme files. This grounds the interview in reality instead of
asking the user things the repo already answers.

---

## Hard Gates

```
GATE 1: Do NOT proceed past Step 1 without answers to Q1–Q5. (Q6–Q7 are optional.)
        No assumptions about brand personality. Ask, wait, then continue.

GATE 2: Do NOT write creative-brief.md until the user has confirmed the HTML preview.
        The preview is the alignment contract. "Type OK to finalize" must happen first.

GATE 3: Do NOT skip contrast-ratio validation. NO color pair is exempt.
        Every text/background pair is calculated. < 4.5:1 (normal) or < 3:1 (large)
        → auto-adjust Lightness until valid before it can appear in the brief.

GATE 4 (Refine): Do NOT overwrite the brief without regenerating AND re-confirming the preview.
        Refine mode is not a fast-path around Gate 2 — it is Gate 2 again, scoped.
```

These gates are always on. They do not scale with project size or urgency.

---

## Mandatory Reference Protocol

This skill is reference-driven. The references are **not optional reading** — they contain
the rules and formulas that make the output deterministic instead of invented. Each step
below names the reference it depends on. **You MUST load that reference before executing the
step.** A step executed without its reference loaded is invalid and must be redone.

| Step | Reference you MUST load first | Without it you would… |
|------|-------------------------------|-----------------------|
| Step 2 | `references/semantic-map.md` | guess colors/type from vibes instead of the rule table |
| Step 3 | `references/math-toolkit.md` | estimate contrast and scale instead of computing them |
| Step 4 | `references/atomic-states.md` | invent component states instead of the 5-state template |
| Step 4 (copy) | `references/copy-guidelines.md` | write tone-mismatched micro-copy |
| Step 5 | `references/html-preview-template.md` | hand-roll an inconsistent preview |

Loading is enforced inline at each step with a STOP marker. Do not rely on memory of a
reference from a previous session — load it fresh.

---

## Step 1 — Brand Discovery Interview

**Goal:** Capture brand intent directly from the human. Interactive, multi-turn.

First, present a 3–5 bullet summary of what the project scan (Step 0) already told you
(stack, platform hints, any existing colors/fonts). This lets the user correct you and
avoids redundant questions.

Then ask these **one at a time**, waiting for each answer before asking the next:

```
Q1: Brand name & one-liner — what is being built?
Q2: Who is the target user?
Q3: 3–5 adjectives describing brand personality
Q4: "After using this product, the user should feel ___"
Q5: Platform context — web app, dashboard, marketing site, mobile?
Q6: Any existing assets? (logo color, font already chosen?)   [optional]
Q7: Visual references or inspirations?                          [optional]
```

**GATE 1:** Q1–Q5 must be answered before Step 2. Never invent personality adjectives or a
platform. If the user is vague on Q3/Q4, ask a focused follow-up — these drive every
downstream decision.

---

## Step 2 — Semantic Translation

> ⛔ **STOP. Load `references/semantic-map.md` now.** This step is rule-based, never guessed.
> If you have not loaded it, you cannot translate. Load it, then continue.

**Goal:** Map the interview answers to concrete visual parameters using the lookup tables in
the reference — hue families, border-radius ranges, font category, modular-scale ratio (by
platform), and copy tone.

Produce a translation table and show it to the user:

```
INPUT (from interview)        →  OUTPUT (visual parameter)
"Professional, Trustworthy"   →  Hue: navy/blue (240–260°), radius 4–6px, geometric sans
Platform: dashboard           →  Modular scale ratio 1.25 (Major Third)
Brand register: formal        →  CTA copy style: "Daftar Sekarang", not "Ayo Gabung!"
```

Every row must cite a rule from `semantic-map.md`. If two adjectives conflict (e.g.
"playful" + "trustworthy"), resolve per the conflict-resolution rules in the reference, and
state which one wins and why.

---

## Step 3 — Mathematical Design

> ⛔ **STOP. Load `references/math-toolkit.md` now.** You will compute, not estimate. The
> reference holds the OKLCH manipulation steps, the WCAG relative-luminance + contrast
> formula, and the modular-scale formula. Load it before any number is written.

**Goal:** Derive the full color system and type scale by formula.

**Color System (OKLCH):**
- Generate the primary palette shade-100 → shade-900 via Lightness manipulation (per toolkit)
- Generate neutrals and semantic colors: success, warning, error, info
- For **every** text/background pair, calculate the contrast ratio using the WCAG formula
- **GATE 3:** flag any pair < 4.5:1 (normal text) or < 3:1 (large text) and auto-adjust
  Lightness until it passes. No pair is exempt. Record the final ratio next to each pair.

**Typography Scale (Modular Scale):**
- Base: 16px
- Ratio: the one selected by platform in Step 2
- Output the full named scale: xs / sm / base / md / lg / xl / 2xl / …

Show the computed palette (with contrast ratios) and the type scale before moving on.

---

## Step 4 — Atomic Design Definition

> ⛔ **STOP. Load `references/atomic-states.md` now** (for the state template) **and
> `references/copy-guidelines.md`** (for the micro-copy). Both are mandatory for this step.

**Goal:** Define the 4 core atoms, each in all 5 states, plus example molecules and copy.

The atom scope is **fixed** — these 4, always, for predictability across projects:

```
Atoms:  Button (Primary / Secondary / Ghost) · Input/Text Field · Badge/Tag · Link
States: Default | Hover | Focus | Disabled | Error
Per state, output: OKLCH color values · border · box-shadow · cursor · focus ring
```

- Use the exact state-output format from `atomic-states.md`.
- Generate **2–3 example molecules** composed from these atoms (e.g. Search Bar = Input +
  Button; Form Group = Label + Input + Error Text).
- Write **micro-copy examples** (CTA, error messages, placeholders) per the tone rules in
  `copy-guidelines.md`, matched to the brand register chosen in Step 2.

Additional atoms beyond these 4 are added manually to the brief post-generation — do not
expand scope here.

---

## Step 5 — HTML Preview (Visual Alignment Gate)

> ⛔ **STOP. Load `references/html-preview-template.md` now.** Populate the template; do not
> hand-author a preview. This guarantees the swatches, contrast badges, type ramp, atom-state
> grid, and copy samples all render in the agreed layout.

**This is the single most important gate in the skill.** It is where agent interpretation
meets human vision before anything is locked in.

**Output:** `docs/pocket/rule/creative-brief-preview.html` (self-contained, no JS interaction
required).

It must contain:
- Color palette — swatches with OKLCH values + a contrast badge (✅ WCAG AA / ❌ Fail)
- Typography scale — every size rendered in the chosen font
- All 4 atoms in all 5 states (visual)
- Micro-copy examples — CTA, error messages, placeholders per tone

Then pause and prompt the user verbatim:

```
Preview generated at docs/pocket/rule/creative-brief-preview.html
Open in a browser and confirm:
  - Does the palette match what you imagined?
  - Does the tone feel right?
  - Anything to change?

Type OK to finalize, or describe what needs adjustment.
```

**GATE 2:** Do not advance to Step 6 until the user types OK (or equivalent confirmation).
If changes are needed → return to the **relevant step only** (not a full restart) →
recompute → regenerate the preview → ask again.

---

## Step 6 — Generate `creative-brief.md`

Only after the user confirms the preview.

**Output path:** `docs/pocket/rule/creative-brief.md`

Use this structure (fill every section with the computed values from Steps 2–4):

```markdown
# Creative Brief — [Brand Name]

## Brand Persona
- Character: ...
- Tone of Voice: ...
- Emotional Goal: ...

## Color System (OKLCH)
### Primary
- oklch(45% 0.2 250) — Contrast vs white: 7.2:1 ✅ WCAG AAA
- Hover: oklch(40% 0.2 250)
### Neutrals / Semantic Colors
- success / warning / error / info — each with contrast ratio noted

## Typography Scale
- Base: 16px | Ratio: 1.25 (Major Third)
- xs: 10px | sm: 13px | base: 16px | md: 20px | lg: 25px | xl: 31px | 2xl: ...

## Atoms
### Button — Primary
| State    | Background | Text       | Border | Shadow |
|----------|------------|------------|--------|--------|
| Default  | oklch(...) | oklch(...) | none   | ...    |
| Hover    | oklch(...) | oklch(...) | ...    | ...    |
| Focus    | oklch(...) | oklch(...) | ring   | ...    |
| Disabled | oklch(...) | oklch(...) | none   | none   |
| Error    | oklch(...) | oklch(...) | ...    | ...    |
(repeat for Secondary, Ghost, Input, Badge, Link)

## Copy Guidelines
- CTA style: ...
- Error messages: ...
- Placeholder text: ...

## Molecules (examples)
- Search Bar = Input + Button
- Form Group = Label + Input + Error Text
```

The brief is the source of truth. It must contain real computed values, not placeholders.

---

## Step 7 — Rule Setup & Enforcement

**Goal:** Make the brief automatically authoritative for all future UI/UX work.

1. Create the Claude rule file at `.claude/rules/brand-design.md` with this content:

```
You MUST load docs/pocket/rule/creative-brief.md whenever you are
planning or developing UI/UX. This file is the design system authority
for this project. No UI decision should be made without consulting it.
```

2. Provide the symlink instruction to the user (run, or tell them to run):

```bash
mkdir -p .claude/rules
ln -s ../../docs/pocket/rule/creative-brief.md .claude/rules/design-system.md
```

3. Confirm to the user what was produced: brief path, preview path, rule file path.

Brand-design is complete when the brief exists, the preview was confirmed, and the rule
file is in place.

---

## Refine Mode Flow

Entered when `docs/pocket/rule/creative-brief.md` already exists (Step 0).

```
1. Load the existing creative-brief.md (and the preview if present).
2. Ask: "What do you want to refine — color, typography, tone, components, or all?"
3. Re-run ONLY the relevant steps. Reload that step's mandatory reference(s) first —
   the Mandatory Reference Protocol applies in refine mode too.
4. Regenerate docs/pocket/rule/creative-brief-preview.html.
5. GATE 4: prompt the user to confirm the preview again (verbatim prompt from Step 5).
   Do NOT overwrite the brief until confirmed.
6. Overwrite creative-brief.md and update the preview HTML. Keep the rule file as-is
   (re-create it only if missing).
```

Refine mode never skips the preview confirmation. A scoped change still gets visually
confirmed before it is written.

---

## Reference Triggers

| Reference | When to Load (mandatory at that step) |
|-----------|----------------------------------------|
| `references/semantic-map.md` | Step 2: translating adjectives/platform → visual parameters |
| `references/math-toolkit.md` | Step 3: OKLCH palette, WCAG contrast, modular type scale |
| `references/atomic-states.md` | Step 4: 5-state template + output format for each atom |
| `references/copy-guidelines.md` | Step 4: tone-of-voice rules and micro-copy per persona |
| `references/html-preview-template.md` | Step 5: building the self-contained preview |

## Out of Scope (for now)

- Multi-theme support (dark mode) — later extension
- Framework-specific output (Tailwind config, CSS custom properties) — separate skill/extension
- Accepting image/URL references for visual inspiration (Q7 enhancement)
- Atomic library beyond the 4 core atoms (add manually to the brief post-generation)
