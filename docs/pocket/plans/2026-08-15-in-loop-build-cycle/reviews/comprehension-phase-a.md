# Comprehension Review — Phase A

**Task:** T6 "Comprehension review — Phase A"
**Method:** ONE general-purpose subagent dispatched with zero session context — given only the prompt below, with no mention of the plan, this task, or any design intent — asked to read the three artifacts and report its raw understanding.

**Prompt given to the reader subagent (verbatim):**

> Read `skills/pocket-development/SKILL.md`, `skills/pocket-development/references/two-stage-review.md`, and `skills/pocket-planning/SKILL.md`. What do you understand from these skills — describe the per-task execution loop, what happens when an audit fails, and how the refactor step is verified. Are there any inconsistencies that would confuse you about what to do?

---

## Reader subagent's answer (verbatim, unedited)

I read all three files fully. Here's my understanding and the inconsistencies I found.

## Per-task execution loop (pocket-development)

1. **Entry Gate** — 7-item checklist (bounded scope, references loaded, packet constructible, task type clear, sandwich structure, verification defined; plus item 0 phase pre-gate for Type B). Any fail → KEEP LOCAL.
2. **Classify** task as Foundation/Solo or Parallel Group, construct the Pocket Packet (7 fields, +`WORKTREE` for parallel), spawn implementer.
3. **Wait for status**: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`.
4. On `DONE` → **mechanical gate** (main agent, command-and-commit evidence only, never code judgment): commit exists → test command green (or `[no-tdd]` validation command) → if plan specifies no command at all, skip straight to auditor. Gate fail → re-dispatch implementer, auditor never spawned, no round consumed.
5. Gate pass → **dispatch read-only auditor subagent** against `prev_sha..HEAD` (sequential) or the worktree tip (parallel). If the sequential diff is empty, skip the auditor entirely and write a `REVIEW_PASS` skip stub instead.
6. Auditor applies three criteria verbatim from cited files: packet QUALITY BAR, spec-compliance (`pocket-review/references/spec-compliance-review.md`), code quality incl. refactor heuristics (`pocket-review/references/code-quality-review.md`). Emits `Critical|Important|Minor` findings.
7. Minor-only/clean → `DONE`, `log update --task TN DONE --sha <audited_head>`. Any Critical/Important → fix/refactor round, re-dispatch implementer → re-run mechanical gate → re-audit.
8. After all tasks DONE → `PHASE_COMPLETE` handoff (offers `/pocketto:pocket-review`, and enterprise-mode PR/checklist-sync offers). Main agent never writes or judges implementation code at any point — only Delegator + mechanical-gate + dispatch.

## When an audit fails

Severity ladder: Critical/Important force a round (can end BLOCKED, task never marked DONE); Minor is non-blocking, persisted and carried forward. Budget is **2 rounds per task** (`loop_info`). Consuming events: an audit FAIL at Critical/Important, a refactor round, or a new finding from a fix. Non-consuming: mechanical-gate failure, Minor-only/clean pass, auditor infrastructure failure (which instead gets exactly one retry — two consecutive infra failures → `BLOCKED`/`auditor-unavailable`). When the 2-round budget is spent with Critical/Important still present → `BLOCKED`/`audit-failed`. Either BLOCKED category halts the phase entirely (no next task, no `done_sha` written), and for a parallel group, one blocked member halts the whole group (no merge, no worktree cleanup). Re-audits always re-emit still-open Minors via a fresh auditor dispatch — the main agent never unions/rewrites findings itself.

## How the refactor step is verified

There's a deliberate split: pocket-planning's packet template tells the *implementer* to attempt a bounded refactor (rule-of-three, ~300-line file, ~50-line function) as TDD Step 5 while tests are green. But `two-stage-review.md` is explicit that this is not trusted: "No implementer self-report is required or accepted... The main agent SHALL NOT ask the implementer whether a refactor was needed." The **auditor** independently re-derives the same thresholds from the diff. If any threshold is crossed, that's an automatic Important finding forcing a refactor round regardless of what the implementer claims to have done; the re-audit then confirms the heuristic is cleared and tests are still green (checked via the mechanical gate, not the auditor). So verification authority sits entirely with the auditor reading the diff — the implementer's refactor step is advisory/best-effort, not evidence.

## Inconsistencies / things that would confuse me

1. **Hardcoded absolute path — real bug.** `two-stage-review.md` lines 58-61 cite the auditor's two mandatory reference files as absolute paths tied to one machine:
   ```
   /Users/rfxlamia/project/pocketto/skills/pocket-review/references/spec-compliance-review.md
   /Users/rfxlamia/project/pocketto/skills/pocket-review/references/code-quality-review.md
   ```
   CLAUDE.md is explicit that Pocketto is "a distributable bundle" shipped as both a Pi package and a Claude Code plugin. An absolute path rooted at `/Users/rfxlamia/...` will not resolve on any other user's machine or install location. This should be a repo-relative path (e.g. resolved from the skill's own directory). This is the most concrete, actionable inconsistency I found.

2. **"7-field" vs "9-field" packet, within the same SKILL.md.** The canonical definition states "Every subagent spawn requires this **7-field** structure (plus an 8th `WORKTREE` field...)" (line 203), and the template that follows has exactly 7 named fields. But the Worked Example's own `REFERENCES LOADED` citation says `references/pocket-packet.md — **9-field** packet structure` (line 247). I couldn't resolve from these three files alone whether `pocket-packet.md` defines a different (9-field) structure than what SKILL.md inlines, or whether "9" is simply a stale/wrong number. Worth checking `references/pocket-packet.md` before trusting either count.

3. **Two different BLOCKED taxonomies, not clearly scoped apart on first read.** SKILL.md's "BLOCKED Categorization" table lists 5 generic categories (Context problem, Reasoning needs, Task too large, Plan wrong, Parallel-conflict) for implementer-reported BLOCKED. `two-stage-review.md` defines exactly 2 categories (`audit-failed`, `auditor-unavailable`) for auditor-triggered BLOCKED. The Status Handling table does bridge these ("In-loop categories... persist and halt... Other categories: Fix → Re-dispatch"), so it's resolvable, but a reader skimming just the BLOCKED Categorization table could mistakenly try to fit an audit-failed outcome into the 5-category list.

4. **No stated empty-diff rule for parallel/worktree tasks.** The empty-diff skip-stub rule is explicitly scoped to "the sequential range `prev_sha..HEAD`." There's no equivalent statement for a parallel-group task whose worktree tip has zero diff from `parent_sha` — presumably the same skip logic should apply, but the contract doesn't say so, leaving it to inference.

5. **Minor ambiguity in round-budget bullets.** "Consumes one round" lists "an audit FAIL at Critical or Important" and "a refactor round (entered because the auditor emitted a refactor-heuristic finding)" as two separate bullets — but a refactor-heuristic finding is itself an Important finding, so these look like the same triggering event described twice. The doc does clarify the *combined* case ("re-states an unfixed Critical/Important and reports a new finding... consumes one round, not two") but never explicitly says whether a refactor-only Important finding consumes exactly one round (my reading: yes, one) rather than being double-counted against these two bullets.

None of these are severe enough to block acting on the skills as written — the operational flow (gate → auditor → round budget → BLOCKED categories → SHA pinning) is internally consistent and unambiguous in the parts that matter for execution. Item 1 (hardcoded path) is the one I'd actually flag as a bug to fix, since it will silently break the auditor's citation step for any distribution of this repo outside the original author's machine.

---

## Verdict (written by the reviewing task, T6)

The reader subagent, given zero prior context about this plan or design intent, correctly and fully reconstructed the per-task execution loop, the audit-failure/round-budget mechanics, and the refactor-verification split (implementer attempts, auditor is sole verification authority) from the three cited artifacts alone. This confirms the loop is comprehensible cold.

Five inconsistencies were reported. Each is classified below:

1. **Hardcoded absolute path in `two-stage-review.md` lines 58-61** (`/Users/rfxlamia/project/pocketto/...`) — **non-blocking**. It is a real portability bug (breaks on any other machine/install), but it is not a contradiction between instructions and does not prevent the loop from being followed on this machine — the path resolves correctly here. Worth fixing, but outside this task's scope (verification only, no edits per this task's Must-not-have).

2. **"7-field" (SKILL.md line 203) vs "9-field" (SKILL.md line 247, in the Worked Example's citation) packet structure** — **non-blocking**. Verified against `skills/pocket-development/references/pocket-packet.md`, which itself states "7 mandatory fields" / "7 Required Fields" (lines 9 and 14), matching the canonical statement and the inline template. The "9-field" text in the Worked Example is a stale/incorrect label on a citation line, not a competing instruction — the actual template used and the actual reference file content both agree on 7. Resolvable by checking the primary source; does not block execution.

3. **Two BLOCKED taxonomies (5-category implementer list vs 2-category auditor list)** — **non-blocking**. The reader itself confirmed these are bridged by the Status Handling table. Pre-existing structural note, not a contradiction.

4. **No stated empty-diff rule for parallel/worktree tasks** — **non-blocking**. This is an omission/gap, not a contradiction between two instructions; reasonable inference applies the same skip logic.

5. **Round-budget bullet phrasing (refactor round vs Critical/Important FAIL as two bullets)** — **non-blocking**. Wording ambiguity, resolved by the document's own combined-case clarification.

**No blocking inconsistency was found.** All five findings are non-blocking (portability bug, stale example, and doc-clarity nits). None contradict an instruction the loop depends on or prevent the loop from being followed as written.

**Result: DONE.**
