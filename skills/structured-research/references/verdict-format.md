# Verdict Format

The grading rubric and report template for Phase 5. Load this when grading the assumption.

A verdict is **advisory** — it informs the maintainer, it does not bind them. Always state the evidence behind it and what would flip it.

---

## Grading Rubric

Grade the operationalized assumption into exactly one of three verdicts. The rubric is a floor for consistency, not a formula — when evidence is mixed, prefer the more conservative grade and lower the confidence.

| Verdict | When it applies |
|---------|-----------------|
| **Confirmed** | The disconfirming observation (defined in Phase 1) did NOT occur after an honest refutation attempt, AND the claim is corroborated by **≥3 independent, reputable sources** OR by a **direct reproduction / spike** that exhibits the behavior. No unresolved contradicting evidence. |
| **Refuted** | A valid **counterexample** was found, OR a **reproduction failed**, OR the preponderance of independent evidence contradicts the claim. One solid disconfirming observation refutes a universal claim outright. |
| **Inconclusive** | Evidence conflicts and neither side dominates, OR there is too little evidence (e.g. a single unverified source, no reproduction possible), OR the claim could not be operationalized into something testable. |

**Confidence (orthogonal to the verdict):**
- **High** — multiple independent strong sources or a clean reproduction; refutation attempt was genuine and failed.
- **Medium** — supported but with thin sourcing, minor unresolved gaps, or recency uncertainty.
- **Low** — leans one way but rests on weak/indirect evidence; treat as provisional.

**Anchors:**
- "Independent" means sources that do not trace back to the same origin (apply `Citation Chaining`).
- A `Technical Spike` / `Reproduction Test` that directly exhibits (or fails to exhibit) the behavior outweighs any number of second-hand assertions.
- If the only evidence is a single source, the verdict cannot be Confirmed — it is at best Inconclusive.

---

## Report Template

Write to `docs/pocket/research/YYYY-MM-DD-kebab-slug/research-report.md`:

```markdown
# Research Report — [short title]

- **Date:** YYYY-MM-DD
- **Verdict:** [Confirmed | Refuted | Inconclusive]
- **Confidence:** [low | medium | high]

## Assumption tested
[The operationalized, falsifiable restatement from Phase 1.]
**Disconfirming observation:** [what would make it false]

## Methods used
- [Method] ([category]) — [what it was used to check]
- [Method] ([category]) — refutation method

## Evidence
| Finding | Source | Supports / Refutes |
|---------|--------|--------------------|
| [finding] | [URL / doc / file:line / spike output] | Supports |
| [counter-finding] | [source] | Refutes |

## Curation notes
[From the curation gate — strongest support, strongest counter-evidence, remaining gaps. Note if the inline fallback was used instead of advisor.]

## Verdict & reasoning
[2-4 sentences tying the grade to the evidence above against the rubric.]

## Recommendation (non-binding)
[What the maintainer might do — adopt / adapt / investigate further. Advisory only.]

## What would change this verdict
[The specific evidence that would flip it.]
```
