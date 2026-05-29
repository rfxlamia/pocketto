# Semantic Map — Adjective → Visual Parameter

Load this during **Step 2 (Semantic Translation)**. This is a lookup, not a vibe check.
Every translation row in Step 2 must cite a rule from this file.

## Contents
- [How to Use](#how-to-use)
- [Personality → Hue Family](#personality--hue-family)
- [Personality → Border Radius](#personality--border-radius)
- [Personality → Typography Category](#personality--typography-category)
- [Platform → Modular Scale Ratio](#platform--modular-scale-ratio)
- [Personality → Chroma / Saturation](#personality--chroma--saturation)
- [Register → Copy Tone](#register--copy-tone)
- [Conflict Resolution](#conflict-resolution)

---

## How to Use

1. Take the 3–5 adjectives from Q3 and the emotional goal from Q4.
2. For each adjective, find its row(s) below and collect the implied parameters.
3. Take the platform from Q5 → set the modular-scale ratio.
4. If parameters conflict across adjectives, apply [Conflict Resolution](#conflict-resolution).
5. Emit a translation table: `INPUT → OUTPUT (rule cited)`.

Hue values are OKLCH hue angles (0–360°). Pass them to `math-toolkit.md` in Step 3 to
derive the actual palette.

---

## Personality → Hue Family

| Adjective(s) | Hue family | OKLCH hue range |
|--------------|------------|-----------------|
| Professional, Trustworthy, Corporate, Secure | Navy / Blue | 240–265° |
| Calm, Healthy, Natural, Sustainable, Growth | Green / Teal | 150–185° |
| Energetic, Playful, Friendly, Bold, Urgent | Warm Red/Orange | 25–55° |
| Premium, Luxurious, Creative, Sophisticated | Purple / Violet | 285–315° |
| Optimistic, Cheerful, Approachable | Yellow / Amber | 80–95° |
| Neutral, Minimal, Editorial, Serious | Near-grey (low chroma any hue) | any, chroma ≤ 0.04 |

If the brand has an existing logo color (Q6), use its hue as the primary and treat the table
as the validator for accent/semantic hues only.

---

## Personality → Border Radius

| Personality leaning | Radius range | Feel |
|---------------------|--------------|------|
| Formal, Precise, Technical, Serious | 0–4px | sharp, exact |
| Professional, Balanced, Modern | 4–8px | grounded, default-safe |
| Friendly, Approachable, Soft | 8–12px | warm |
| Playful, Energetic, Fun, Kids | 12–16px+ | bouncy, rounded |

Pick one base radius; derive component radii from it (e.g. inputs = base, badges = base × 2,
pills = fully rounded).

---

## Personality → Typography Category

| Personality leaning | Font category | Examples (suggest, don't hard-require) |
|---------------------|---------------|----------------------------------------|
| Professional, Trustworthy, Technical | Geometric / Grotesque Sans | Inter, Geist, IBM Plex Sans |
| Premium, Editorial, Authoritative | Serif (display) + Sans body | Source Serif, Lora + Inter |
| Playful, Friendly, Rounded | Rounded Sans | Nunito, Quicksand, Baloo |
| Minimal, Modern, Neutral | Neo-grotesque Sans | Helvetica Neue, Archivo |
| Creative, Distinctive | Humanist Sans / characterful display | Work Sans, Clash Display |

Respect Q6 if a font is already chosen — then only pick the complementary pair (e.g. body vs
display).

---

## Platform → Modular Scale Ratio

This ratio is consumed directly by `math-toolkit.md` for the type scale.

| Platform (Q5) | Ratio | Name | Rationale |
|---------------|-------|------|-----------|
| Dashboard / data-dense app | 1.20 – 1.25 | Minor Third / Major Third | tight scale, more usable sizes |
| Standard web app | 1.25 | Major Third | balanced |
| Marketing / landing site | 1.333 – 1.414 | Perfect Fourth / Augmented Fourth | dramatic display contrast |
| Mobile | 1.20 | Minor Third | conserve vertical space |

Default to 1.25 if platform is ambiguous.

---

## Personality → Chroma / Saturation

| Leaning | OKLCH chroma (primary) |
|---------|------------------------|
| Muted, Premium, Calm, Serious | 0.04 – 0.10 |
| Balanced, Professional | 0.10 – 0.16 |
| Bold, Energetic, Playful | 0.16 – 0.26 |

Semantic colors (success/warning/error/info) keep their conventional hues regardless of
brand chroma, but match the brand's chroma intensity for harmony.

---

## Register → Copy Tone

Derived from adjectives + Q4. Hand this to `copy-guidelines.md` in Step 4.

| Register | Signals | CTA example |
|----------|---------|-------------|
| Formal | Professional, Corporate, Secure, Trustworthy | "Daftar Sekarang" / "Get Started" |
| Neutral-friendly | Approachable, Modern, Clear | "Create account" |
| Casual / energetic | Playful, Fun, Friendly, Bold | "Ayo Gabung!" / "Let's go!" |

---

## Conflict Resolution

Adjectives often pull in different directions (e.g. "trustworthy" + "playful").

1. **Emotional goal (Q4) is the tiebreaker.** Whatever the user wants the user to *feel*
   after using the product wins.
2. **Trust/clarity beats expressiveness** when the platform is a dashboard, fintech, health,
   or anything handling money/data/safety. Lower radius, lower chroma, formal-leaning copy.
3. **Expressiveness is allowed in accents, not structure.** Keep the primary palette and
   radius grounded; let a playful adjective express through one accent hue and copy tone.
4. State the winner explicitly: "Resolved: trustworthy wins on structure (radius 6px, navy);
   playful expressed via warm accent + friendly micro-copy. Rationale: Q4 = 'feel confident'."
