# In-Loop Build Cycle — pocket-development SKILL.md — phase-completion wiring (Phase 3 of 4)

**Date:** 2026-08-15
**Original plan:** docs/pocket/plans/2026-08-15-in-loop-build-cycle/execution-plan.md
**Prerequisite:** Phase 2 must be COMPLETE — all tests green, all commits created
**Contains tasks:** {T9, T10, T11}
**Unlocks next:** Phase 4

---

## Task List

Total: 3 tasks | Prerequisite phases must be complete before starting

T9: pocket-development SKILL.md — phase-completion wiring [depends: T7, T8]
T10: Comprehension review — Phase B [depends: T9]
T11: Deprecate the pocket-review and pocket-correction skills [depends: T9]

---

## Pocket Packets

---

### Task 9: pocket-development SKILL.md — phase-completion wiring [depends: T7, T8]

## OBJECTIVE

Wire the phase-level pass and the relocated enterprise reporting into pocket-development's phase-completion path, in the correct order, citing T7 and T8 rather than restating them.

Files:
- Modify: `skills/pocket-development/SKILL.md`

This is a **non-testable structural task**.

Steps:

1. Rewrite `## End-of-Execution Handoff` (`SKILL.md:585-640`) so that after all tasks are DONE the order is: dispatch the phase-level pass (cite `references/phase-level-pass.md`) → record its result → set phase status `REVIEW` → run enterprise reporting (cite `references/enterprise-reporting.md`).
2. Update `## Phase Completion Protocol` (`SKILL.md:719-752`) so `PHASE_COMPLETE` requires the phase-level pass to have recorded a result, and add `PHASE_BLOCKED` for the pass exceeding its round cap.
3. Update the log-command timing table (`SKILL.md:700-713`) so the phase `REVIEW` row states "after the phase-level pass records its result", and rewrite `:709` — the row that credits `pocket-review` with advancing the phase — to name the phase-level pass instead.
4. Remove the instruction to hand off to `/pocketto:pocket-review`; replace it with the phase-level pass being internal, and keep `pocket-closing` as the user-triggered next step. **Also rewrite the `REVIEW_FAIL` row in Status Handling (`SKILL.md:650`)** — it currently instructs re-entry via `/pocketto:pocket-correction`, a skill T11 deprecates. Replace it with the phase-level-pass correction path from `references/phase-level-pass.md`. This row is T9's, not T4's. **Also rewrite the sentence directly beneath it at `:652`** — "`REVIEW_FAIL` … is handled by the standalone `pocket-correction` skill" — which carries no `/pocketto:` form and would therefore survive the Step 6 grep untouched.
5. Add both new references to the Mandatory Reference Preloading and Reference Triggers tables.
6. Verify — the bare-name check is the important one, since an invocation-form grep alone lets prose survive:
   `grep -n "pocket-review\|pocket-correction" skills/pocket-development/SKILL.md` returns only the comparative parallel-merge lines (`:401`, `:451`, `:457`, `:460`, `:480`), and nothing describing either as a live stage; and
   `grep -c "phase-level-pass.md\|enterprise-reporting.md" skills/pocket-development/SKILL.md` returns at least 4.
7. Commit:
   `git add skills/pocket-development/SKILL.md`
   `git commit -m "feat(pocket-development): run the phase pass and reporting at phase-completion"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rules: Phase-level pass, Enterprise reporting
skills/pocket-development/references/phase-level-pass.md (T7) and references/enterprise-reporting.md (T8) — the contracts being wired
skills/pocket-development/SKILL.md — `:585-640` handoff, `:700-713` timing table, `:719-752` completion protocol

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: one file, three interlocking sections, and an ordering constraint (pass → record → REVIEW → report) that is wrong if any step is transposed.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Phase status `REVIEW` is written only AFTER the phase-level pass records its result. Transposing this makes a crashed pass undetectable on resume.]
You are wiring phase-completion for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: `skills/pocket-development/SKILL.md` — no other files.
Test framework: none — verified by the grep checks in Step 6 and by T10's comprehension review.
Available after: T7, T8
Architecture rule: `pocket-closing` still owns `REVIEW → DONE` and `log close` — this task must not advance a phase past `REVIEW`.
[RESTATE: Order is pass → record → REVIEW → report. `pocket-closing` keeps ownership of `REVIEW → DONE`.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given all tasks DONE, When phase-completion runs, Then the phase-level pass is dispatched before the phase status changes.
Given the pass recorded a result, When the phase advances, Then status `REVIEW` is set and only then does enterprise reporting run.
Given the file, When searched for `/pocketto:pocket-review` and `/pocketto:pocket-correction`, Then neither invocation remains — including the `REVIEW_FAIL` row that previously routed to pocket-correction.
Given the completion protocol, When the pass exceeded its round cap, Then `PHASE_BLOCKED` is emitted and the phase does not reach `REVIEW`.
[must-not] Given the file, When read, Then it must NOT advance a phase to `DONE` or call `log close` — those remain `pocket-closing`'s.
[must-not] Given the file, When read, Then it must NOT restate the fan-out or fail-closed rules inline instead of citing T7/T8.

Commit exists matching `feat(pocket-development): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Ordering stated explicitly in all three updated sections
  - Both new references in both reference tables
  - Commit message follows conventional commits format

Must-not-have:
  - Advancing phase status beyond `REVIEW`
  - Restating T7/T8 rules inline
  - Deprecating `pocket-review` here (T11 owns that)
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Revert restores the pocket-review handoff; T7/T8 references become orphaned but harmless

Red flags:
  - `REVIEW` set before the pass records → STOP
  - Work outside listed files → DONE_WITH_CONCERNS

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a section cannot be updated without contradicting T7 or T8
Escalate when: wiring appears to require changing `pocket-closing`

---

### Task 10: Comprehension review — Phase B [depends: T9]

## OBJECTIVE

Verify the Phase B instruction set — the phase-level pass, corrections, and enterprise reporting — is understandable and internally consistent to a reader with no session context.

Files:
- Create: `docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md`

This is a **non-testable verification task**.

Steps:

1. Dispatch one general-purpose subagent, read-only, with this prompt and no additional context:
   > Read `skills/pocket-development/SKILL.md`, `references/phase-level-pass.md`, and `references/enterprise-reporting.md`. What do you understand from these skills — describe what happens after every task in a phase is done, how a phase-level fix is recorded, and what happens in enterprise mode when no PR exists yet. Are there any inconsistencies that would confuse you about what to do?
2. Record the answer verbatim into the review file, followed by a verdict section.
3. Classify each reported inconsistency as blocking or non-blocking.
4. If any blocking inconsistency exists → report BLOCKED naming the contradiction and the owning task. Do not fix it here.
5. Verify:
   `test -f docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md`
6. Commit:
   `git add docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-phase-b.md`
   `git commit -m "chore(pocket): record Phase B comprehension review"`

Mark in QUALITY BAR: `[no-tdd — verification task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Comprehension
skills/pocket-development/SKILL.md, references/phase-level-pass.md, references/enterprise-reporting.md — the artifacts under review

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: read-only verification with a single dispatched reader.
Complexity: standard review

## SANDWICH CONTEXT

[CRITICAL: The reviewing subagent must receive NO context from this session.]
You are running the Phase B comprehension review for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the new review record only.
Test framework: none.
Available after: T9
Architecture rule: this task reports; it never fixes.
[RESTATE: Zero session context to the reviewer. Report blocking contradictions; do not repair them here.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the dispatched subagent, When it reports, Then it correctly describes the post-task phase pass, correction recording, and the no-PR enterprise path.
Given its report, When inconsistencies are classified, Then none are blocking.
Given the review record, When read, Then it contains the answer verbatim plus a verdict.
[must-not] Given a blocking inconsistency, When found, Then this task must NOT fix it.

Commit exists matching `chore(pocket): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — verification task]`
  - Reviewer dispatched with no session context
  - Answer recorded verbatim

Must-not-have:
  - Editing any skill file
  - Coaching the reviewer
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Documentation only

Red flags:
  - Reviewer given the spec or this plan → the test is void, STOP and re-dispatch

## STOP CONDITIONS

Done when: review recorded, no blocking inconsistency, commit created
Uncertain when: an inconsistency's severity is ambiguous
Escalate when: the reviewer cannot describe the phase pass at all

---

### Task 11: Deprecate the pocket-review and pocket-correction skills [depends: T9]

## OBJECTIVE

Mark both skills deprecated so hosts stop routing to them, while leaving the CLI correction machinery fully intact.

Files:
- Modify: `skills/pocket-review/SKILL.md`
- Modify: `skills/pocket-correction/SKILL.md`
- Modify: `skills/pocket-review/references/review-report-template.md`
- Modify: `skills/pocket-review/references/subagent-dispatch-template.md`

This is a **non-testable structural task**.

Steps:

1. In each SKILL.md, rewrite the frontmatter `description` so it states the skill is deprecated as of 3.0.0 and names its replacement — pocket-development's in-loop audit and phase-level pass. The `description` is the routing signal a host uses, so this is what actually stops the skill being selected.
2. Replace each body with a short deprecation notice: what replaced it, where the behavior now lives (`references/two-stage-review.md`, `references/phase-level-pass.md`, `references/enterprise-reporting.md`), and an explicit statement that the CLI correction machinery (`log update --correction --for-task`, `phase.corrections`, `for_task`/`bleed` attribution) is retained and now invoked from pocket-development.
3. Keep `skills/pocket-review/references/*` in place — **do not delete any of them.** `spec-compliance-review.md`, `code-quality-review.md` and `review-report-template.md` are cited by the new contracts (T3, T7).
4. Reconcile the two reference files whose own prose still describes pocket-review as the live writer:
   - `review-report-template.md` — it remains the normative artifact schema. Update prose naming pocket-review as the producer to name pocket-development's in-loop auditor. **Do not change any field name, type or nesting** — `pocket-closing` and T3's contract both depend on the exact shape.
   - `subagent-dispatch-template.md` — superseded by the auditor dispatch defined in `pocket-development/references/two-stage-review.md`. Add a one-line note at the top saying so and pointing there. Do not delete it; nothing cites it after this release, but removing a file is not this task's business.
5. Verify:
   `grep -il "deprecated" skills/pocket-review/SKILL.md skills/pocket-correction/SKILL.md` lists both files, and
   `ls skills/pocket-review/references/` still lists `spec-compliance-review.md`, `code-quality-review.md`, `review-report-template.md` and `subagent-dispatch-template.md`, and
   `node -e "const t=require('fs').readFileSync('skills/pocket-review/references/review-report-template.md','utf8'); for (const f of ['task_id','overall','reviewed_sha','fix_instructions','loop_info','severity','strengths']) if(!t.includes(f)) { console.error('missing field: '+f); process.exit(1) }"` exits 0.
6. Commit:
   `git add skills/pocket-review/SKILL.md skills/pocket-correction/SKILL.md skills/pocket-review/references/review-report-template.md skills/pocket-review/references/subagent-dispatch-template.md`
   `git commit -m "feat(skills)!: deprecate pocket-review and pocket-correction"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — Phase C scope; the CLI machinery is explicitly retained
skills/pocket-review/SKILL.md, skills/pocket-correction/SKILL.md — the skills being retired
skills/pocket-review/references/ — three files that MUST survive because the new contracts cite them
CLAUDE.md — the frontmatter `description` is the routing signal a host uses to decide when to load a skill

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: four files. Two are narrow deprecation notices; the other two are reference files whose prose must change while their schema must not — deleting or reshaping either breaks the contracts written in T3 and T7 and, downstream, `pocket-closing`.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Do NOT delete anything under `skills/pocket-review/references/`, and do NOT change a single field name in `review-report-template.md` — the new audit contracts and `pocket-closing` both depend on that exact shape.]
You are deprecating the pocket-review and pocket-correction skills.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — the skills retire; the CLI correction machinery stays.
Files in scope: the four files listed in this packet's Files section — no others.
Test framework: none — verified by the checks in Step 5.
Available after: T9
Architecture rule: no CLI behavior changes in this task whatsoever.
[RESTATE: Nothing under `references/` is deleted, and `review-report-template.md`'s schema fields are untouched — prose only.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given each deprecated SKILL.md, When its frontmatter is read, Then the description states deprecation and names the replacement.
Given each body, When read, Then it names where the behavior now lives and states that the CLI correction machinery is retained.
Given `skills/pocket-review/references/`, When listed, Then all four reference files are still present.
Given `review-report-template.md`, When read, Then its prose names pocket-development's auditor as the producer and every schema field name is unchanged.
Given `subagent-dispatch-template.md`, When read, Then it carries a superseded-by note pointing at `pocket-development/references/two-stage-review.md`.
[must-not] Given this task's diff, When inspected, Then no file under `cli/` may appear.
[must-not] Given this task's diff, When inspected, Then no reference file may be deleted.
[must-not] Given `review-report-template.md`, When diffed, Then no field name, type or nesting may have changed.

Commit exists matching `feat(skills)!: ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Frontmatter `description` updated in both files (the actual routing signal)
  - Explicit statement that the CLI machinery is retained
  - Conventional-commit `!` marker for the breaking change

Must-not-have:
  - Deleting any file
  - Changing any field name, type or nesting in `review-report-template.md`
  - Touching `cli/`
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Reverting restores both skills verbatim from git history

Red flags:
  - A reference file deleted → the audit contracts break, STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a host requires more than a description change to stop routing
Escalate when: deprecating would orphan a reference another skill cites

---

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to Phase 4 ONLY after this gate passes.
