# Pitch Exploration Document Template

**Contents:** [Template](#template) · [Section Notes](#notes)

Save to: `docs/pocket/spec/YYYY-MM-DD-kebab-slug/pitch-exploration.md`

---

## Template

```markdown
# Pitch Exploration: [kebab-slug-of-problem]
Date: YYYY-MM-DD | Project: [project name] | Status: pitch-only

---

## Problem Statement
[1-2 sentences. Actionable and specific. Not "we need to improve X" — "users cannot do Y because Z is missing/broken/unclear."]

## Root Tension
[The core tradeoff or conflict that makes this problem hard.
Example: "We need real-time updates (WebSocket) but our infra is stateless (Lambda)."
Example: "The user wants full history but storage costs grow unboundedly."]

## Key Constraints
[From context scan + brainstorm. Bullet list.]
- [constraint from architecture scan]
- [constraint from brainstorm / spike]
- [constraint from project/domain context]

---

## Brainstorming Methods Used

### [Method 1 Name] — [category]
Key insights:
- [insight]
- [insight]
- [insight]

### [Method 2 Name] — [category]
Key insights:
- [insight]
- [insight]

### [Method 3+ Name] — [category]
Key insights:
- [insight]
- [insight]

---

## Advisor Synthesis
[2-4 sentences summarizing what the advisor curation surfaced. Patterns, clusters, discards.]

---

## Spike Results
[Only include if spike was run. If no spike, delete this section.]

**Unknown resolved:** [what was the question]
**Finding:** [what was discovered — yes/no + evidence]
**Implication:** [how this affects the approach directions below]

---

## Approach Directions

### Direction A: [name]
[1-2 sentences describing the direction at a high level.
"direction" = sync vs async, new module vs extension, custom vs library, etc.
NOT architecture, NOT scenarios — those are pocket-grinding's job.]
+ [main advantage]
− [main risk or tradeoff]

### Direction B: [name]
[1-2 sentences]
+ [main advantage]
− [main risk or tradeoff]

### Direction C: [name]
[Only include if genuinely distinct from A and B. Delete if not needed.]
+ [main advantage]
− [main risk or tradeoff]

---

## Open Questions for pocket-grinding
[Questions that pitching could not resolve. These become Phase 3 Discovery targets in grinding.]
- [ ] [question]
- [ ] [question]
- [ ] [question]

---

## Recommended Direction
Direction [X] — [1-sentence reasoning tied to constraints + insights above]

---

## Handoff Context (for pocket-grinding)
When pocket-grinding reads this doc:
- Start with this problem statement (Phase 1 context)
- Use Direction [X] as the working hypothesis for Phase 5 Design Proposals
- Treat Open Questions above as Phase 3 Discovery targets
- Do NOT treat Approach Directions as final architecture — validate through GWT first
```

---

## Notes

**Problem Statement:** Must be concrete. Bad: "improve performance." Good: "API responses over 2s for queries with >100 joins, breaking mobile UX."

**Root Tension:** One sentence that names the core constraint that makes this hard. If you can't name the tension, you haven't converged yet.

**Constraints:** Only include constraints from actual evidence (context scan, git log, spike). Don't add hypothetical constraints.

**Approach Directions:** These are directions, not designs. "Use a message queue" is a direction. "Use RabbitMQ with a dead-letter queue at 3 retry attempts with exponential backoff" is grinding-level design.

**Open Questions:** Things pitching couldn't resolve. Don't leave them vague — phrase them as questions grinding can actually answer ("Does the auth middleware support X?" not "auth stuff?").
