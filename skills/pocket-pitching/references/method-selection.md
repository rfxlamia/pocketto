# Method Selection Guide

## Default Starter Trio

For any software development problem, start with:

| Method | Category | Why |
|--------|----------|-----|
| Question Storming | deep | Defines the problem space by generating questions first — ensures solving the right problem |
| First Principles Thinking | creative | Strips assumptions, rebuilds from fundamentals — breaks legacy constraints |
| Six Thinking Hats | structured | 6 perspectives (facts, risks, benefits, creativity, process, emotions) — comprehensive coverage |

This trio covers: depth (deep), innovation (creative), completeness (structured). Use it as the baseline and substitute or add based on problem type below.

---

## Substitution Rules

### If problem is a known bug or regression
Replace **First Principles** with **Five Whys** (deep)
→ Root cause is more valuable than assumption-stripping on a known failure

### If problem involves team/process friction
Add **Role Playing** (collaborative)
→ Multiple stakeholder perspectives are needed

### If problem is architectural (service boundaries, data flow)
Add **Solution Matrix** (structured) or **Constraint Mapping** (deep)
→ Systematic parameter exploration, or constraint visualization

### If problem is a completely new domain (no prior art in codebase)
Add **Analogical Thinking** (creative) or **Cross-Pollination** (creative)
→ Borrow patterns from other domains

### If problem involves UX or user-facing behavior
Add **Reverse Brainstorming** (creative)
→ Generate failure modes → find solution insights

### If problem is complex and time allows (5-method run)
Add **Assumption Reversal** (deep) as 5th method
→ Challenges core assumptions that may be invisible

---

## Selection by Problem Type

| Problem Type | Default Trio | Add | Remove |
|-------------|-------------|-----|--------|
| New feature, unclear domain | ✓ | Analogical Thinking | — |
| New feature, technical | ✓ | Constraint Mapping | — |
| Bug / regression | ✓ | Five Whys | First Principles |
| Refactor / cleanup | ✓ | Assumption Reversal | — |
| Architecture decision | ✓ | Solution Matrix | Six Thinking Hats |
| Performance problem | ✓ | Five Whys, Constraint Mapping | First Principles |
| UX / product direction | ✓ | Reverse Brainstorming, Role Playing | — |
| Exploration (no known problem) | ✓ | What If Scenarios | — |

---

## Depth vs Speed

**3 methods (default):** Default trio. Use when time is limited or problem is moderately clear.

**4 methods:** Add one method based on problem type above.

**5 methods:** Add Assumption Reversal as 5th. Use when problem is high-stakes, novel, or has failed previous attempts.

Never select more than 5 — past 5 methods, diminishing returns dominate and synthesis becomes harder.

---

## Method Pairing Rules

- At least 1 method from `deep` category — ensures root cause focus
- At least 1 method from `creative` OR `structured` — ensures solution space coverage
- Avoid selecting 2 methods from the same category unless problem type specifically demands it
- Avoid `theatrical`, `wild`, `introspective_delight`, `quantum` categories for software engineering context — they produce high noise-to-insight ratio without human facilitation

---

## Output Format for Phase 2a

After selecting methods, state selection rationale:
```
Methods selected:
1. Question Storming (deep) — to define what we don't know yet
2. First Principles Thinking (creative) — to strip existing assumptions about [X]
3. Six Thinking Hats (structured) — to get comprehensive perspectives
```
