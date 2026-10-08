# Iron Laws - Detailed Enforcement

The 6 Iron Laws govern the standard Pocket delegated workflow. A user may explicitly choose a different implementation mode or bypass a Pocket gate; honor that instruction, state what will be skipped, and do not claim the skipped check passed.

## The Laws

### Law 1: PACKET FOR STANDARD DISPATCH

**What it means:**
Every subagent dispatched through the standard Pocket path receives a complete Pocket Packet. If the user explicitly chooses a simpler handoff, honor that choice, report that the packet gate was skipped, and do not present the run as standard Pocket execution.

**Why it exists:**
Prevents vague handoffs where subagents must guess what to do. A subagent without a packet will either:
- Ask clarifying questions (delays)
- Make assumptions (wrong results)
- Report being stuck (BLOCKED)

**Enforcement:**
- Check packet completeness before every standard Pocket dispatch
- Packet must have all 7 fields filled
- No "handle this" or "fix X" prompts allowed

### Law 2: NO SILENT GATE SKIP

**What it means:**
For Pocket delegated execution, run the Entry Gate before dispatch and repair any failed item. If the user explicitly chooses another workflow or asks to bypass a gate, honor that instruction, state which checks will not run, and never report a skipped gate as passed.

**Why it exists:**
Filters whether a task is ready for delegation. Common causes of a failed gate include:
- Time pressure
- Sunk cost

**Enforcement:**
- Run all 6 gate questions
- Any "no" pauses dispatch for that task and triggers HOLD LOCAL
- Document reason for HOLD LOCAL
- If the user explicitly chooses a different workflow, record the skipped gate and follow that choice

### Law 3: NO TRUST WITHOUT EVIDENCE

**What it means:**
In the standard Pocket workflow, verify subagent reports rather than assuming they are correct. If the user explicitly asks to skip independent review, honor that instruction and report that implementation was not independently verified.

**Why it exists:**
Subagents may:
- Miss requirements they didn't understand
- Over-engineer without realizing
- Report "done" when actually broken
- Be optimistic about completeness

**Enforcement:**
- In the standard Pocket workflow, run the mechanical gate first (command/commit evidence only), then dispatch the read-only auditor — never treat the implementer's self-report as verification
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

## Recovery Under Pressure

| Pressure | Countermeasure |
|----------|----------------|
| TIME | Cut niceties, not structure. Packet still required. |
| SUNK COST | Rewrite packet anyway. Bad packets must be rewritten, not patched. |
| USER INSTRUCTION | State material consequences briefly, then follow the explicit choice. Never claim skipped checks passed. |
| EXHAUSTION | Simplify or split the packet, or report progress and resume. Do not turn fatigue or a cycle count into BLOCKED. |

## Red Flag Phrases

These phrases indicate iron law violation:

| Phrase | Violation |
|--------|-----------|
| "Just delegate it" without a bounded objective | Law 1: Packet is incomplete |
| "Skip the checklist" without noting the bypass | Law 2: Silent gate skip |
| "They said it's done" | Law 3: Trust without evidence |
| "Handle X" | Law 4: Ambiguous prompt |
| "I'm stuck" | Law 5: Silent escalation |
| "No REFERENCES LOADED section" | Law 6: Silent reference |

## HOLD LOCAL Format

When a gate question fails, the task is **not delegatable yet**. `HOLD LOCAL` records that
state; it never authorizes the main agent to implement the task. The permitted next actions
are: inspect available sources, repair the packet or gather missing context, then re-run the
Entry Gate. Ask the user only when the next safe action needs information, a decision, access,
or authorization unavailable to the agent. If the user explicitly chooses a different
workflow, honor that choice and report which Pocket checks will not run.

```
HOLD LOCAL: [reason the task is not delegatable yet]
WHY UNSAFE: [specific concern]
NEXT ACTION: [source inspection or packet/context repair, then re-run Entry Gate — or the specific human dependency]
```

Example:
```
HOLD LOCAL: Cannot construct reviewable packet — task scope spans two modules.
WHY UNSAFE: Critical constraints may be forgotten mid-prompt.
NEXT ACTION: Re-read the task file and the plan's file map to bound scope, rewrite
             the packet, then re-run the Entry Gate. Ask the user only if bounding it
             would change the approved outcome.
```
