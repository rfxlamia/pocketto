# Iron Laws - Detailed Enforcement

The 6 Iron Laws are non-negotiable rules that govern every delegation decision.

## The Laws

### Law 1: NO PACKET = NO SPAWN

**What it means:**
Every subagent spawn must be accompanied by a complete Pocket Packet. No exceptions.

**Why it exists:**
Prevents vague handoffs where subagents must guess what to do. A subagent without a packet will either:
- Ask clarifying questions (delays)
- Make assumptions (wrong results)
- Report being stuck (BLOCKED)

**Enforcement:**
- Check packet completeness before every spawn
- Packet must have all 7 fields filled
- No "handle this" or "fix X" prompts allowed

### Law 2: NO SKIP THE GATE

**What it means:**
The Entry Gate Checklist must be run and passed before any subagent spawn.

**Why it exists:**
Filters what deserves delegation. Many tasks should stay local but get delegated anyway due to:
- Time pressure
- Sunk cost
- Authority override

**Enforcement:**
- Run all 6 gate questions
- Any "no" triggers KEEP LOCAL
- Document reason for KEEP LOCAL

### Law 3: NO TRUST WITHOUT EVIDENCE

**What it means:**
Subagent reports must be verified, not assumed correct.

**Why it exists:**
Subagents may:
- Miss requirements they didn't understand
- Over-engineer without realizing
- Report "done" when actually broken
- Be optimistic about completeness

**Enforcement:**
- Mechanical gate first (command/commit evidence only), then dispatch the read-only auditor — never trust the implementer's self-report
- The auditor reads the diff directly, not the implementer's summary
- One auditor emits both spec-compliance and code-quality findings into a single verdict artifact — see `references/two-stage-review.md`

### Law 4: NO AMBIGUOUS PROMPT

**What it means:**
Every prompt follows sandwich structure + attention rules.

**Why it exists:**
LLMs have attention mechanics:
- U-shaped bias: best at start/end, degrades 30%+ in middle
- Attention drift: forgets early instructions as output grows
- Context dilution: filler weakens signal

**Enforcement:**
- Critical info in FIRST LINE
- Key constraint REPEATED near END
- Middle section free of filler

### Law 5: NO SILENT ESCALATION

**What it means:**
Every BLOCKED/NEEDS_CONTEXT must have explicit reason + next action.

**Why it exists:**
Vague escalations ("I'm stuck", "can't do this") don't help the controller:
- Don't identify root cause
- Don't suggest solutions
- Waste time on back-and-forth

**Enforcement:**
- Status must include specific blocker type
- Next action must be concrete and actionable
- Controller responds with targeted fix

### Law 6: NO SILENT REFERENCE

**What it means:**
Every decision (task scope, verification approach, routing choice) must cite the specific reference that informed it.

**Why it exists:**
Without citation, decision quality cannot be audited. Agents that skip reference loading produce packets that cannot be traced back to their source constraints — and mistakes cannot be caught or improved.

**Enforcement:**
- Before constructing any Pocket Packet, load the relevant reference file(s)
- Cite each loaded reference in the REFERENCES LOADED section of the packet
- A packet without REFERENCES LOADED is incomplete — do not spawn

---

## Pressure Countermeasures

| Pressure | Countermeasure |
|----------|----------------|
| TIME | Cut niceties, not structure. Packet still required. |
| SUNK COST | Rewrite packet anyway. Bad packets must be rewritten, not patched. |
| AUTHORITY | Keep the law, not the shortcut. "Process protects quality" is the response. |
| EXHAUSTION | Refuse delegation if packet cannot stay legible. KEEP LOCAL until rested. |

## Red Flag Phrases

These phrases indicate iron law violation:

| Phrase | Violation |
|--------|-----------|
| "Just delegate it" | Law 1: No packet |
| "Skip the checklist" | Law 2: Skip the gate |
| "They said it's done" | Law 3: Trust without evidence |
| "Handle X" | Law 4: Ambiguous prompt |
| "I'm stuck" | Law 5: Silent escalation |
| "No REFERENCES LOADED section" | Law 6: Silent reference |

## KEEP LOCAL Format

When any iron law fails and delegation is inappropriate:

```
KEEP LOCAL: [reason why delegation unsafe]
WHY UNSAFE: [specific concern]
NEXT ACTION: [what to do instead, locally]
```

Example:
```
KEEP LOCAL: Cannot construct reviewable packet while fatigued.
WHY UNSAFE: Critical constraints may be forgotten mid-prompt.
NEXT ACTION: Will do initial file survey locally, then revisit
             delegation when scope is bounded and attention fresh.
```
