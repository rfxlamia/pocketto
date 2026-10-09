# Advisor Brainstorm Protocol

**Contents:** [How It Works](#how-the-advisor-tool-works) · [Execution Order](#correct-phase-2-execution-order) · [Anti-patterns](#anti-patterns-to-avoid) · [Why LLM-to-LLM](#why-llm-to-llm-works-here)

## How the Advisor Tool Works

The `advisor()` tool takes NO parameters. It automatically forwards the ENTIRE conversation transcript — every message, every tool call, every output. You CANNOT pass context to it directly.

This means: **everything the advisor needs to see must already be in the conversation before you call `advisor()`**.

---

## Correct Phase 2 Execution Order

### Step 1 — Output ALL method results to conversation first

For each selected method, write output to the conversation (visible text):

```
### Question Storming — deep
- What don't we actually know about this problem?
- Are we solving the right thing, or a symptom?
- What would change if this problem didn't exist?
- Who actually feels this pain — user, dev, or system?
- What does failure look like if we get this wrong?

### First Principles Thinking — creative
- What do we know for certain about this domain?
- Which constraints are real vs inherited assumptions?
- If we started from zero, what would we actually build?
- What's the minimum true requirement?

### Six Thinking Hats — structured
White (facts): [specific facts about current state]
Red (emotion): [gut feel about risk/opportunity]
Yellow (benefits): [what works if this succeeds]
Black (risks): [what breaks, what could go wrong]
Green (creative): [wild ideas, novel angles]
Blue (process): [what's the right order to tackle this]
```

Write out ALL methods before calling `advisor()`. The richer the output, the better the curation.

### Step 2 — Call advisor()

After all methods are output, call:
```
advisor()
```

No parameters. No setup. Just call it.

The advisor sees:
- The problem statement from Phase 1
- All method outputs you just wrote
- The full prior conversation context
- The project context from Phase 0

### Step 3 — Read the advisor's response

The advisor will return synthesis, critique, or pattern observations. Common returns:
- "These three ideas cluster around the same root cause: [X]"
- "Method Y surfaced a constraint that Method Z contradicts — which is real?"
- "The strongest ideas are A, B, C. D and E are restatements."
- "You missed [important angle] — consider exploring [method or question]"

### Step 4 — Present synthesis to user

After advisor returns, present the curated synthesis:

```
## Brainstorm Synthesis — [N] methods explored

### Key Insights (advisor-curated)
- [insight 1]
- [insight 2]
- [insight 3]

### Patterns Identified
- [pattern across methods]

### Ideas Worth Pursuing
- [idea A — why it's promising]
- [idea B — why it's promising]

### Discarded
- [idea X — too speculative without more data]
- [idea Y — restatement of insight 1]

Technical unknowns surfaced:
- [unknown 1 — needs spike?]
```

## Independent Subagent Fallback

Independent curation reduces the main agent's confirmation bias. If `advisor()` is
unavailable or fails, dispatch a fresh subagent named `advisor` with the persona
below. Keep this review independent: do not substitute the main agent's own synthesis.

```text
You are Advisor, an independent brainstorm curator and constructive critic. You did
not generate these method results. Assess the confirmed problem, relevant project
context, and complete method outputs independently. The main agent's draft synthesis
and recommendation are intentionally withheld; do not ask for or infer them.

Your task:
1. Identify the strongest insights and recurring patterns across methods.
2. Find contradictions, duplicate ideas, unsupported assumptions, and noise.
3. Name important angles or questions the methods missed.
4. Surface technical unknowns that may need a spike.
5. Separate evidence from inference. Do not invent project facts.
6. Keep the result at problem-exploration level. Do not write implementation plans,
   detailed architecture, or GWT scenarios.

Return:
- Key insights
- Patterns
- Ideas worth pursuing, with brief reasons
- Discarded or duplicate ideas, with reasons
- Contradictions and assumptions to check
- Technical unknowns for possible spikes
```

Start the subagent with an isolated context when the dispatch mechanism supports it.
Send only the confirmed problem, relevant project context, and complete method
outputs. If the dispatch mechanism includes the parent conversation, tell the advisor
to base its review only on that payload and not on any main-agent synthesis. Wait for
the advisor's findings before writing the synthesis. Identify the fallback subagent
as the curation source. If dispatch fails, try another available subagent route. If
no independent reviewer can run, state that limitation, continue work that does not
depend on curation, and leave the synthesis explicitly uncurated.

---

## Anti-patterns to Avoid

**Do NOT:** Call `advisor()` before outputting method results.
→ Advisor will see only the problem statement, not the brainstorm. Curation will be shallow.

**Do NOT:** Say "I'm preparing context for advisor" or "passing ideas to advisor".
→ The advisor has no input parameter. Context is the conversation itself.

**Do NOT:** Call `advisor()` multiple times in Phase 2.
→ One call after ALL methods complete. Multiple calls create redundancy.

**Do NOT:** Skip independent advisor curation because "the synthesis is obvious".
→ Independent curation is required. Use the advisor tool or the `advisor` subagent fallback to catch patterns and discard noise the main agent may miss.

---

## Why LLM-to-LLM Works Here

When the main agent runs brainstorming methods, it generates ideas in sequence. The advisor reads the full set simultaneously and can:
- See connections the main agent didn't notice between methods
- Identify which ideas are genuine insights vs noise
- Spot contradictions that reveal hidden assumptions
- Synthesize at a higher level than each individual method

The result is a curated insight set that's broader (multiple methods) and more focused (advisor synthesis) than either agent alone.
