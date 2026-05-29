# HTML Preview Template — The Alignment Gate

Load this during **Step 5**. Populate this skeleton with the computed values from Steps 2–4
and write the result to `docs/pocket/rule/creative-brief-preview.html`. Do not hand-author a
different layout — consistency of the preview is part of the contract.

## Contents
- [Rules](#rules)
- [What Must Render](#what-must-render)
- [Skeleton](#skeleton)
- [How to Populate](#how-to-populate)

---

## Rules

- **Self-contained.** One file, inline `<style>`, no external CSS/JS, no build step. The user
  opens it directly in a browser.
- **No interaction required.** All 5 states render side-by-side as static swatches — do not
  rely on `:hover`/`:focus` to reveal a state. (You may *also* wire real `:hover`/`:focus`,
  but the static grid is mandatory so every state is visible at once.)
- **Show the math.** Every color swatch prints its OKLCH value and its contrast ratio + badge.
- **Use the real font.** Load the chosen font via a `<link>` to Google Fonts (or system stack
  fallback) so the type scale renders truthfully.

## What Must Render

```
[ ] Color palette — primary ramp, neutrals, semantic — swatches w/ OKLCH + contrast badge
[ ] Typography scale — every named size rendered in the chosen font, labelled px
[ ] All 4 atoms × all 5 states — static visual grid
[ ] Micro-copy — CTA, error messages, placeholders, per tone
```

---

## Skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Creative Brief Preview — {{BRAND_NAME}}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="{{GOOGLE_FONTS_URL}}" rel="stylesheet">
<style>
  :root {
    --font: "{{FONT_FAMILY}}", system-ui, sans-serif;
    /* paste computed tokens, e.g.: */
    --primary-500: oklch(0.64 0.16 250);
    --primary-600: oklch(0.55 0.152 250);
    /* ...neutrals, semantic... */
  }
  body { font-family: var(--font); margin: 0; padding: 2rem; color: #111; background:#fff; line-height:1.5; }
  h1,h2 { font-weight:700; } h2 { margin-top:3rem; border-bottom:1px solid #eee; padding-bottom:.5rem; }
  .swatches { display:flex; flex-wrap:wrap; gap:1rem; }
  .swatch { width:160px; border:1px solid #eee; border-radius:8px; overflow:hidden; font-size:12px; }
  .swatch .chip { height:72px; }
  .swatch .meta { padding:.5rem; }
  .badge { display:inline-block; padding:1px 6px; border-radius:99px; font-weight:600; }
  .badge.pass { background:#dcfce7; color:#166534; } .badge.fail { background:#fee2e2; color:#991b1b; }
  .typerow { display:flex; align-items:baseline; gap:1rem; margin:.5rem 0; }
  .typerow .label { width:64px; color:#888; font-size:12px; }
  .stategrid { display:grid; grid-template-columns:repeat(5,1fr); gap:1rem; max-width:880px; }
  .stategrid .cell { text-align:center; font-size:12px; color:#888; }
  /* component styles — derive from tokens; one class per atom/variant */
</style>
</head>
<body>
  <h1>Creative Brief Preview — {{BRAND_NAME}}</h1>
  <p>{{BRAND_ONE_LINER}} · Persona: {{ADJECTIVES}} · Goal: feel {{EMOTIONAL_GOAL}}</p>

  <h2>Color System</h2>
  <h3>Primary</h3>
  <div class="swatches">
    <!-- repeat per shade -->
    <div class="swatch">
      <div class="chip" style="background:var(--primary-500)"></div>
      <div class="meta">
        primary-500<br>oklch(0.64 0.16 250)<br>
        on white: 4.6:1 <span class="badge pass">AA</span>
      </div>
    </div>
  </div>
  <h3>Neutrals</h3>  <div class="swatches"><!-- ... --></div>
  <h3>Semantic</h3>  <div class="swatches"><!-- success/warning/error/info ... --></div>

  <h2>Typography Scale — base 16px · ratio {{RATIO}}</h2>
  <div class="typerow"><span class="label">xs 10</span><span style="font-size:10px">The quick brown fox</span></div>
  <div class="typerow"><span class="label">base 16</span><span style="font-size:16px">The quick brown fox</span></div>
  <div class="typerow"><span class="label">xl 31</span><span style="font-size:31px">The quick brown fox</span></div>
  <!-- one row per named size -->

  <h2>Atoms</h2>
  <h3>Button — Primary</h3>
  <div class="stategrid">
    <div class="cell">Default<br><button class="btn-primary">Save changes</button></div>
    <div class="cell">Hover<br><button class="btn-primary is-hover">Save changes</button></div>
    <div class="cell">Focus<br><button class="btn-primary is-focus">Save changes</button></div>
    <div class="cell">Disabled<br><button class="btn-primary is-disabled" disabled>Save changes</button></div>
    <div class="cell">Error<br><button class="btn-primary is-error">Delete</button></div>
  </div>
  <!-- repeat the 5-cell grid for: Button Secondary, Button Ghost, Input, Badge, Link -->

  <h2>Micro-copy</h2>
  <ul>
    <li><strong>CTA:</strong> "{{CTA}}"</li>
    <li><strong>Secondary:</strong> "{{SECONDARY}}"</li>
    <li><strong>Validation error:</strong> "{{ERROR_MSG}}"</li>
    <li><strong>Placeholder:</strong> "{{PLACEHOLDER}}"</li>
    <li><strong>Success:</strong> "{{SUCCESS_MSG}}"</li>
  </ul>
</body>
</html>
```

---

## How to Populate

1. Replace every `{{TOKEN}}` with values from the interview (Step 1) and computations
   (Steps 2–4).
2. Paste the full shade ramp, neutrals, and semantic colors as CSS custom properties in
   `:root`, then reference them in swatches and component classes.
3. For each atom, write `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.input`, `.badge`,
   `.link` classes plus `.is-hover/.is-focus/.is-disabled/.is-error` modifiers that hard-code
   each state's values from `atomic-states.md` — so all 5 render statically without
   interaction.
4. Compute each contrast badge from `math-toolkit.md` §3 and mark `pass`/`fail`. Per Gate 3,
   a `fail` should not survive — if one appears, fix the color in Step 3 and regenerate.
5. Write to `docs/pocket/rule/creative-brief-preview.html`, then issue the Step 5 prompt and
   wait for the user's "OK".
