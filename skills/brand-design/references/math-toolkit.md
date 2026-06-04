# Math Toolkit — Compute, Never Estimate

Load this during **Step 3 (Mathematical Design)**. Every number in the brief comes from a
formula here, computed by hand/by you — no external tools required.

## Contents
- [OKLCH Primer](#oklch-primer)
- [1. Building a Shade Ramp (100–900)](#1-building-a-shade-ramp-100900)
- [2. Neutrals & Semantic Colors](#2-neutrals--semantic-colors)
- [3. WCAG Contrast Ratio (full formula)](#3-wcag-contrast-ratio-full-formula)
- [4. OKLCH → sRGB Conversion](#4-oklch--srgb-conversion)
- [5. Auto-Adjusting Lightness Until It Passes](#5-auto-adjusting-lightness-until-it-passes)
- [6. Modular Type Scale](#6-modular-type-scale)
- [Worked Example](#worked-example)

---

## OKLCH Primer

`oklch(L C H)`:
- **L** = perceptual lightness, 0 (black) → 1 (white). Often written as a percentage.
- **C** = chroma (colorfulness), 0 → ~0.37. 0 = grey.
- **H** = hue angle, 0–360°.

OKLCH is perceptually uniform: equal L steps look like equal lightness steps. That is why we
build ramps by stepping L.

---

## 1. Building a Shade Ramp (100–900)

Inputs from Step 2: primary hue `H`, primary chroma `C`.

Fix H. Step L across 9 stops. Reduce C slightly at the extremes (very light and very dark
colors can't hold high chroma — clamp to keep them in gamut).

| Shade | Lightness L | Chroma |
|-------|-------------|--------|
| 100 | 0.97 | C × 0.25 |
| 200 | 0.92 | C × 0.45 |
| 300 | 0.84 | C × 0.65 |
| 400 | 0.74 | C × 0.85 |
| 500 | 0.64 | C        | ← base/primary |
| 600 | 0.55 | C × 0.95 |
| 700 | 0.46 | C × 0.85 |
| 800 | 0.37 | C × 0.70 |
| 900 | 0.28 | C × 0.55 |

`Hover` for an interactive element = one stop darker (e.g. 500 → 600 ≈ −0.09 L).
`Active/pressed` = two stops darker.

---

## 2. Neutrals & Semantic Colors

**Neutrals:** same ramp formula with chroma 0.005–0.02 (a hint of the brand hue keeps greys
from feeling dead). Stops 100→900 as above.

**Semantic colors** — conventional hues, brand-matched chroma:

| Role | Hue | Notes |
|------|-----|-------|
| success | 145° (green) | |
| warning | 85° (amber) | |
| error | 25° (red) | |
| info | 245° (blue) | reuse primary if brand is blue |

For each, build a small ramp (bg-tint at L≈0.95, solid at L≈0.55, text-on-tint at L≈0.35) and
validate every pairing in §3.

---

## 3. WCAG Contrast Ratio (full formula)

Contrast uses **sRGB relative luminance**, so convert OKLCH → sRGB first (§4), then:

**Step A — linearize each channel.** For each of R, G, B normalized to 0–1 (call it `c`):
```
if c <= 0.03928:  c_lin = c / 12.92
else:             c_lin = ((c + 0.055) / 1.055) ^ 2.4
```

**Step B — relative luminance:**
```
L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
```

**Step C — contrast ratio** between two colors with luminances L1 (lighter) and L2 (darker):
```
ratio = (L1 + 0.05) / (L2 + 0.05)
```

**Thresholds (Gate 3):**
| Use | Minimum |
|-----|---------|
| Normal text (< 18.66px regular / < 24px) | 4.5:1 (AA), 7:1 (AAA) |
| Large text (≥ 24px, or ≥ 18.66px bold) | 3:1 (AA), 4.5:1 (AAA) |
| UI components / focus rings / borders | 3:1 |

Record the computed ratio and the badge (✅ AA / ✅ AAA / ❌) next to every pair.

---

## 4. OKLCH → sRGB Conversion

OKLCH → OKLab → linear sRGB → gamma sRGB.

**OKLCH → OKLab:**
```
a = C * cos(H * π/180)
b = C * sin(H * π/180)
# L stays L
```

**OKLab → linear sRGB** (Björn Ottosson's matrices):
```
l_ = L + 0.3963377774 * a + 0.2158037573 * b
m_ = L - 0.1055613458 * a - 0.0638541728 * b
s_ = L - 0.0894841775 * a - 1.2914855480 * b

l = l_^3 ;  m = m_^3 ;  s = s_^3

R_lin =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
G_lin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
B_lin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
```

**linear → gamma sRGB** (per channel `x`, then clamp to [0,1]):
```
if x <= 0.0031308:  x_srgb = 12.92 * x
else:               x_srgb = 1.055 * x^(1/2.4) - 0.055
```

If any channel falls outside [0,1] after conversion, the color is out of sRGB gamut — reduce
chroma C by 0.01 and recompute until all channels are in range.

For §3 you need the **linear** sRGB values (R_lin etc.) directly — you can skip the gamma
step and feed linear values straight into the luminance formula (Step B), since Step A is
just the inverse of the gamma step.

---

## 5. Auto-Adjusting Lightness Until It Passes

When a text/background pair fails its threshold:

```
while ratio < threshold:
    if text is the darker color:  lower text L by 0.02
    else:                         raise text L by 0.02
    recompute sRGB → luminance → ratio
    if text L hits 0 or 1 and still fails:
        adjust the background L instead, or pick a different shade stop
```

Keep hue and (where possible) chroma fixed — only move L. Note the final values and ratio.

---

## 6. Modular Type Scale

Inputs: base = 16px, ratio `r` (from platform, via `semantic-map.md`).

```
size(step) = base * r^step
```

Steps below base are negative. Round to the nearest px.

| Name | step | formula | r = 1.25 |
|------|------|---------|----------|
| xs   | −2 | 16 / r² | 10px |
| sm   | −1 | 16 / r  | 13px |
| base |  0 | 16      | 16px |
| md   |  1 | 16 × r  | 20px |
| lg   |  2 | 16 × r² | 25px |
| xl   |  3 | 16 × r³ | 31px |
| 2xl  |  4 | 16 × r⁴ | 39px |
| 3xl  |  5 | 16 × r⁵ | 49px |

Pair the scale with a line-height rule: body ≈ 1.5, headings ≈ 1.1–1.25.

---

## Worked Example

Brand: "Professional, Trustworthy" dashboard.
- Step 2 → hue 250°, chroma 0.16, ratio 1.25.
- Primary-500 = `oklch(0.64 0.16 250)`. Hover-600 = `oklch(0.55 0.152 250)`.
- White text on primary-500: convert primary-500 → sRGB → luminance ≈ 0.18; white luminance
  = 1.0. ratio = (1.0 + 0.05) / (0.18 + 0.05) = **4.57:1 → ✅ AA**. Use white text.
- Type scale (r=1.25): 10 / 13 / 16 / 20 / 25 / 31 / 39 / 49 px.
