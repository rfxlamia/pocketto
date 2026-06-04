# Atomic States — The 5-State Template

Load this during **Step 4 (Atomic Design Definition)**. The atom scope is fixed; the state
set is fixed; the output format is fixed. This is what makes components predictable across
every project brand-design touches.

## Contents
- [The 4 Atoms (fixed scope)](#the-4-atoms-fixed-scope)
- [The 5 States (fixed)](#the-5-states-fixed)
- [Output Format Per State](#output-format-per-state)
- [Per-Atom Guidance](#per-atom-guidance)
- [Molecules](#molecules)
- [Validation Checklist](#validation-checklist)

---

## The 4 Atoms (fixed scope)

```
1. Button   — variants: Primary, Secondary, Ghost
2. Input    — text field
3. Badge     — tag / pill
4. Link
```

Do not add or remove atoms in this step. Extra atoms are added manually to the brief later.

## The 5 States (fixed)

```
Default | Hover | Focus | Disabled | Error
```

Every atom (and every button variant) must define all 5. No state may be omitted, even if it
"looks the same" — state it explicitly so implementers don't guess.

---

## Output Format Per State

Each state is one table row with these columns:

| Column | What it holds | Source |
|--------|---------------|--------|
| Background | OKLCH value (or `transparent`) | shade ramp, math-toolkit |
| Text | OKLCH value | must pass contrast vs Background (Gate 3) |
| Border | width + style + OKLCH, or `none` | |
| Shadow | box-shadow value, or `none` | |
| Cursor | `pointer` / `not-allowed` / `text` | |
| Focus ring | ring spec, or `—` (only the Focus row fills this) | ≥ 3:1 vs adjacent |

Standard table shape:

```markdown
| State    | Background | Text       | Border          | Shadow | Cursor      | Focus ring |
|----------|------------|------------|-----------------|--------|-------------|------------|
| Default  | oklch(...) | oklch(...) | none            | sm     | pointer     | —          |
| Hover    | oklch(...) | oklch(...) | none            | md     | pointer     | —          |
| Focus    | oklch(...) | oklch(...) | none            | sm     | pointer     | 2px solid oklch(...) offset 2px |
| Disabled | oklch(...) | oklch(...) | none            | none   | not-allowed | —          |
| Error    | oklch(...) | oklch(...) | 1px solid error | sm     | pointer     | —          |
```

---

## Per-Atom Guidance

**Button**
- Primary: filled with primary-500; Hover = primary-600; text = white/contrast-checked.
- Secondary: subtle — neutral-100 bg or primary-tinted; border optional.
- Ghost: transparent bg, primary text; Hover = primary-50/neutral-100 bg.
- Disabled (all variants): neutral-200 bg, neutral-400 text, no shadow, `not-allowed`.
- Error: only meaningful for destructive buttons → use error-500 bg.

**Input**
- Default: white/neutral-50 bg, neutral-300 border, neutral-900 text, `text` cursor.
- Focus: border → primary-500 + focus ring; this is the primary affordance.
- Disabled: neutral-100 bg, neutral-400 text, `not-allowed`.
- Error: error-500 border + error-600 helper text below.
- Always pair with a label and (for Error) a visible message — see Molecules.

**Badge**
- Small, often non-interactive. Default/Disabled/Error are the meaningful states;
  Hover/Focus apply only if the badge is clickable (then treat like a small Ghost button).
- Use semantic tints: success/warning/error/info bg at L≈0.95 with matching dark text.

**Link**
- Default: primary-600 text, no underline (or underline-on-hover per brand).
- Hover: primary-700 + underline.
- Focus: focus ring around the text box.
- Disabled: neutral-400, no pointer.
- Error: rarely applies — only for links inside error contexts; keep readable contrast.

Every Text-on-Background pair you produce must be contrast-validated via
`math-toolkit.md` §3. Disabled states are exempt from the 4.5:1 minimum but should still
target ≥ 3:1 so they remain perceivable.

---

## Molecules

Generate **2–3** example molecules composed only from the 4 atoms. Suggested set:

- **Search Bar** = Input + Button(Primary)
- **Form Group** = Label + Input + Error Text (Input in Error state + helper message)
- **Filter Row** = Badge ×N + Link("clear all")

For each molecule, show which atom states are in play (e.g. "Form Group shown in Error state:
Input=Error, helper text=error-600").

---

## Validation Checklist

Before moving to Step 5:

```
[ ] All 4 atoms defined (Button ×3 variants, Input, Badge, Link)
[ ] All 5 states present for each (no omissions)
[ ] Every Background/Text pair has a computed contrast ratio + badge
[ ] Focus state has a visible focus ring ≥ 3:1 against its surroundings
[ ] Disabled state is visually distinct (and uses not-allowed cursor)
[ ] 2–3 molecules defined, each citing the atom states it uses
```
