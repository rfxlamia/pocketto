---
name: pocket-pitching
description: Pre-grinding problem exploration. Use BEFORE pocket-grinding when the problem is unformed or needs exploration. Guides diverge→converge with structured brainstorming methods and independent advisor curation (advisor tool or advisor subagent fallback), then produces a pitch exploration doc. Trigger on "pocket-pitching", "pitch this", "explore this idea", "I have a rough idea", or when no clear problem definition exists yet. Do NOT use for "brainstorm" — that triggers pocket-grinding.
---

# Pocket Pitching

Pre-grinding problem exploration. Scans project context before making project-specific claims, picks 3-5 brainstorming methods based on problem type, runs them with independent advisor curation, investigates technical unknowns that could change the approach, then produces a pitch exploration doc with a problem statement and 2-3 approach directions.

**Core principle:** Diverge first, converge second. Never propose solutions until the problem is fully explored.

Start from the user's request. Use clear instructions, corrections, and approvals already given; do not ask the user to repeat them or select a numbered option. Ask only when an unanswered product decision or fact would materially change the exploration. Otherwise, inspect available context, proceed, and label any assumption that affects the result.

## When to Use

Trigger when:
- Problem is vague, unformed, or needs exploration before spec-writing
- User says "pitch", "explore", "I have a rough idea", "help me think through this"
- Starting a new feature with no clear direction

Do NOT use:
- When problem is already clearly defined (use pocket-grinding)
- When a spec already exists (use pocket-grinding or pocket-planning)
- For "brainstorm" keyword — pocket-grinding owns that trigger

## Boundary with pocket-grinding

| pocket-pitching | pocket-grinding |
|-----------------|-----------------|
| Explores the problem space | Specifies the solution |
| Produces: directions (sync vs async, new module vs extension) | Produces: concrete architecture + GWT scenarios |
| No GWT scenarios — just directional | Full BDD spec with acceptance criteria |
| 2-3 approach directions, no design | Design proposals with scenarios-validated tradeoffs |

When pitching output lands in `docs/pocket/spec/`, grinding reads it as INPUT context — not as a spec.

## Operating Rules

- **Use project evidence.** Scan the project before making project-specific claims. If the user already gave the topic, begin exploring it; do not restart intake with a generic greeting.
- **Confirm only new decisions.** Restate the problem and continue when the summary preserves the user's meaning. Ask for confirmation only when your interpretation adds a consequential assumption or a product choice remains open. Treat the user's clear correction or approval as the answer.
- **Get independent curation.** After all method results are visible, call `advisor()`. If it is unavailable or fails, use the `advisor` subagent fallback in `references/advisor-brainstorm-protocol.md`. Do not present your own synthesis as independent review.
- **Change approach when evidence stalls.** For a technical unknown, try a distinct source or investigation mode when the first attempt does not answer it. A call count or retry limit is a cue to reassess, not a reason to stop. Record the evidence and carry any unresolved question into the brief and pocket-grinding.
- **Honor an authorized handoff.** If the user asks to continue to pocket-grinding, invoke it and pass the brief and open questions. If they have not chosen what to do next, present the choices once and wait.

---

## Phase 0: Preflight

**Goal:** Understand project context before making project-specific claims.

**Scan (read-only):**
- Stack: detect from project root files (package.json, Cargo.toml, requirements.txt, go.mod, pom.xml)
- Architecture: scan top-level dirs (src/, lib/, app/, services/, packages/)
- Recent commits: `git log --oneline -10`
- Existing pitch/spec docs: check `docs/pocket/spec/` for recent work

**Then respond to the request already in the conversation.** Include a concise
project summary when useful. Ask what the user wants to explore only if they have
not already provided a topic.

Example when no topic has been provided:
```
Project: [name] · Stack: [detected stack] · [architecture pattern]
Recent: [3 most relevant recent commits]

What would you like to explore or pitch today?
```

---

## Phase 1: Problem Intake

**Goal:** Establish a shared problem framing before diverging.

**Process:**
1. Extract the problem, affected person or system, and why it matters from the user's request and available project context.
2. Identify only missing facts that could change the framing or exploration direction. Ask a focused question for each consequential gap; usually one or two will be enough. Do not stop at an arbitrary question count if a material ambiguity remains.
3. State the problem in one or two sentences. If it preserves the user's meaning, move to Phase 2. If it adds a consequential assumption, ask the user to correct or confirm that assumption before diverging.

If the problem is too broad to explore usefully, offer a small set of concrete angles and ask which one to pursue. Do not ask for confirmation of facts or choices the user has already made. Silence is not approval for a consequential choice the user has not made.

---

## Phase 2: Diverge

**Goal:** Explore the problem from several useful angles, then have an independent advisor curate the results.

**→ Read `references/brainstorming-methods.csv` to select methods**
**→ Load `references/method-selection.md` for selection criteria and default trio**

### 2a — Method Selection

Read CSV. Select 3-5 methods based on problem type.
Default trio: Question Storming + First Principles Thinking + Six Thinking Hats
State selection rationale (1 line per method): "Chose [X] because [reason]..."

### 2b — Sequential Execution + Output

For each method, **output results to conversation** (visible text):
```
### [Method Name] — [category]
[4-6 insights or ideas generated by applying this method to the problem]
```

Output every selected method before calling advisor.

### 2c — Independent Advisor Curation

After outputting ALL method results, call `advisor()`.
The advisor reads the full conversation including all method outputs.
Do NOT phrase this as "passing context" — advisor auto-reads conversation.

If the call is unavailable or fails, follow the independent `advisor` subagent
fallback in `references/advisor-brainstorm-protocol.md`. That protocol defines the
persona, context, and required response. If neither route can provide an independent
review, continue useful work that does not depend on curation, state what is missing,
and do not present a final synthesis or claim the pitch is complete.

Expected advisor return: key insights, patterns, connections, candidates to discard.

### 2d — Synthesis Presentation

Present to user:
```
## Brainstorm Synthesis — [N] methods explored

### Key Insights
- [3-5 insights from advisor curation]

### Patterns
- [pattern across methods]

### Ideas Worth Pursuing
- [shortlisted ideas]

### Discarded (why)
- [what got cut and why]
```

If a technical unknown could change the approach, investigate it in Phase 3 before converging. If the answer depends on information only the user can provide, ask for that information; otherwise use the available code or documentation sources. Carry unresolved questions forward with the evidence gathered.

---

## Phase 3: Spike (When Needed)

**Goal:** Resolve a technical unknown that could change which approach is worth pursuing.

**→ Load `references/spike-protocol.md` for trigger criteria and execution**

Triggered when Phase 2 surfaces: "can X do Y?", "does Z already exist?", "what does library W support?"

Agent chooses the available mode based on the unknown:
- **Code scan** → architectural unknowns (what's in the codebase)
- **Web search** → library/API capability unknowns
- **Both** → when unknown spans external + internal

Investigate one unknown at a time and present the result before Phase 4. If a search
does not answer it, use the next relevant source or mode in the spike protocol. At
about five tool calls, reassess whether the current path is producing evidence and
switch strategy if it is not. This is a strategy checkpoint, not a stop condition.
If distinct approaches still leave the answer uncertain, state what you checked,
what the evidence supports, and the exact open question; carry it into the pitch
brief for pocket-grinding.

---

## Phase 4: Converge

**Goal:** Synthesize diverge + spike results into a clear problem statement.

**Output to user:**
```
## Problem Synthesis

Problem: [1-2 sentences — clear, actionable]
Root tension: [the core tradeoff or challenge]
Key constraints: [from context scan + brainstorm + spike if ran]
Success looks like: [directional success signal — not GWT, just intent]
```

Adjust when the user adds nuance. If the user already supplied the framing, treat
that instruction as acceptance; ask only about a consequential choice the user has
not made.

---

## Phase 5: Approach Directions

**Goal:** Propose 2-3 solution directions. Keep them at the direction level; leave detailed architecture and scenarios to pocket-grinding.

Directions at this level: sync vs async, new module vs extension, library vs custom, etc.
Leave architecture and scenario validation to pocket-grinding.

**Format:**
```
## Approach Directions

Direction A: [name]
  [1-2 sentences]
  + [main advantage]
  − [main risk or tradeoff]

Direction B: [name]
  [1-2 sentences]
  + [main advantage]
  − [main risk or tradeoff]

Direction C: [name] (only if genuinely distinct from A and B)
  [1-2 sentences]
  + [main advantage]
  − [main risk or tradeoff]

Recommended: Direction [X] — [1-sentence reasoning based on constraints + insights]
```

---

## Phase 6: Brief + Handoff

**Goal:** Write the pitch exploration doc and continue according to the user's stated intent.

**→ Load `references/brief-template.md` for full document format**

**Save to:**
```
docs/pocket/spec/YYYY-MM-DD-kebab-slug/pitch-exploration.md
```

If the user has not already said what to do next, present these choices in natural language:
```
Pitch doc written to: docs/pocket/spec/[path]

What would you like to do next?
  1. Invoke pocket-grinding now (starts from this pitch)
  2. Iterate on [specific phase] before proceeding
  3. Save and stop here — I'll come back to this later
```

If the user asks to proceed to specification or otherwise clearly authorizes the
handoff, invoke `pocket-grinding` and pass the pitch doc path, problem statement,
recommended direction, and unresolved questions. If the user asks to revise, return
to the named phase and update the brief. If the user asks to stop, confirm the saved
path. Do not require the user to reply with an option number.

---

## Reference Triggers

| Reference | When to Load |
|-----------|--------------|
| `references/brainstorming-methods.csv` | Phase 2a: read to select methods |
| `references/method-selection.md` | Phase 2a: selection criteria + default trio |
| `references/advisor-brainstorm-protocol.md` | Phase 2c: LLM-to-LLM curation mechanics |
| `references/spike-protocol.md` | Phase 3: trigger criteria + execution modes |
| `references/brief-template.md` | Phase 6: pitch doc format |
