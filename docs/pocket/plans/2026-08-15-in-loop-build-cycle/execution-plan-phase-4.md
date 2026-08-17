# In-Loop Build Cycle — Documentation sync for the deprecated skills (Phase 4 of 4)

**Date:** 2026-08-15
**Original plan:** docs/pocket/plans/2026-08-15-in-loop-build-cycle/execution-plan.md
**Prerequisite:** Phase 3 must be COMPLETE — all tests green, all commits created
**Contains tasks:** {T12, T13, T14}
**Unlocks next:** All phases complete — proceed to final validation

---

## Task List

Total: 3 tasks | Prerequisite phases must be complete before starting

T12: Documentation sync for the deprecated skills [depends: T11]
T13: Version 3.0.0, manifest sync, and migration release notes [depends: T12]
T14: Final comprehension review and end-to-end verification [depends: T13]

---

## Pocket Packets

---

### Task 12: Documentation sync for the deprecated skills [depends: T11]

## OBJECTIVE

Update every document that names `pocket-review` or `pocket-correction` as live stages so the described pipeline matches reality. Documentation only — no behavior changes.

Files:
- Modify: `llms.txt`
- Modify: `README.md`
- Modify: `skills/create-pr/SKILL.md`
- Modify: `skills/pocket-closing/references/verdict-reconciliation.md`
- Modify: `skills/pocket-closing/SKILL.md` *(prose, frontmatter description and remediation strings only — gate logic untouched)*
- Modify: `skills/pocket-help/SKILL.md`
- Modify: `skills/pocket-help/references/skill-map.md`
- Modify: `skills/pocket-help/references/end-to-end-flow.md`
- Modify: `skills/pocket-help/references/pocket-vs-superpowers.md`

This is a **non-testable structural task**.

Steps:

1. Locate every mention: `grep -rn "pocket-review\|pocket-correction" llms.txt README.md skills/create-pr/ skills/pocket-closing/ skills/pocket-help/`
2. In each, replace pipeline descriptions that route users to those skills with the new flow: grinding → planning → structuring → development (in-loop audit + phase pass) → closing.
3. In `skills/create-pr/SKILL.md`, update only prose that refers to pocket-review as the next stage. Its behavior — committing `log.json` so SHA scope can be computed — is unchanged.
4. In `skills/pocket-closing/references/verdict-reconciliation.md`, update prose naming pocket-review as the verdict writer to name pocket-development's auditor instead. The reconciliation algorithm itself is unchanged.
5. In `skills/pocket-closing/SKILL.md`, update every mention of a retired stage. **Step 1's grep is authoritative; the line numbers here are illustrative, not a closed list** — known instances include the frontmatter `description` (the routing signal), the opening paragraph and "Core principle" at `:8` and `:10` (the first thing T14's fresh reader hits), the pipeline diagram at `:15-22`, the "Re-run pocket-review" remediation strings at `:91-94`, `:107`, `:109`, `:121`, `:185`, and `:166` naming pocket-correction as the correction recorder, plus `:315` and `:330`. Every one of these is prose or an instruction string pointing at a retired stage — the verdict gate, the freshness gate, the Advance State logic and `log close` are **untouched**.
6. In `skills/pocket-help/`, update `SKILL.md` (routing table `:80-81`, pipeline diagram `:118-122`, the "pocket-development does NOT call pocket-review" notes `:133-135`), `references/skill-map.md`, `references/end-to-end-flow.md` (invocation forms at `:58`, `:69`, `:84`) and `references/pocket-vs-superpowers.md:56`.
7. Verify — **quote the glob**; unquoted, zsh (this repo's shell) aborts with `no matches found: --include=*.md`, exit 1 and no stdout, which is indistinguishable from a clean pass:
   `grep -rn "pocket-review\|pocket-correction" llms.txt README.md skills/ --include='*.md'` returns only these expected hits:
   - `skills/pocket-review/SKILL.md`, `skills/pocket-correction/SKILL.md` — the deprecation notices themselves (T11)
   - `skills/pocket-review/references/review-report-template.md`, `subagent-dispatch-template.md` — reconciled by T11
   - the comparative parallel-merge lines in `skills/pocket-development/SKILL.md` (`:401`, `:451`, `:457`, `:460`, `:480`)

   Any other hit that describes either skill as a live stage is unfinished work — bare-name mentions count, not just `/pocketto:` invocation forms.
8. Commit:
   `git add llms.txt README.md skills/create-pr/SKILL.md skills/pocket-closing/references/verdict-reconciliation.md skills/pocket-closing/SKILL.md skills/pocket-help/SKILL.md skills/pocket-help/references/skill-map.md skills/pocket-help/references/end-to-end-flow.md skills/pocket-help/references/pocket-vs-superpowers.md`
   `git commit -m "docs: retire pocket-review and pocket-correction from the documented flow"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — Phase C documentation scope. The spec's Implementation Notes enumerate `llms.txt`, `README.md`, `create-pr/SKILL.md`, `verdict-reconciliation.md` and three pocket-help references; `pocket-closing/SKILL.md` and `pocket-help/SKILL.md` are added here under the spec's scope *clauses* rather than its enumeration — only pocket-closing's **gate logic** is fenced (Out-of-Scope), and pocket-help is documentation-only
skills/create-pr/SKILL.md — `:123-130` commits `log.json` so review can compute SHA scope; behavior stays
skills/pocket-closing/references/verdict-reconciliation.md — the algorithm is unchanged; only the writer's name changes

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: nine files, mechanical replacements, no judgement beyond keeping algorithm prose intact and staying on the prose side of `pocket-closing`'s gate logic.
Complexity: standard

## SANDWICH CONTEXT

[CRITICAL: Documentation only. No behavioral instruction in any of these files may change.]
You are syncing documentation after the deprecation.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the nine files listed in this packet's Files section — no others.
Test framework: none — verified by the grep check in Step 7.
Available after: T11
Architecture rule: `pocket-help` and `create-pr` behavior must not change — only prose naming the retired stages.
[RESTATE: Prose only. `verdict-reconciliation.md`'s algorithm and `create-pr`'s steps stay byte-equivalent in meaning.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given the repo, When searched for invocations of the retired skills, Then none remain outside their own deprecated SKILL.md files.
Given `README.md` and `llms.txt`, When the pipeline is described, Then it matches the new flow.
Given `verdict-reconciliation.md`, When read, Then the reconciliation algorithm is unchanged and only the verdict writer's name differs.
[must-not] Given `skills/create-pr/SKILL.md`, When diffed, Then no step, command, or gate may have changed.
[must-not] Given `skills/pocket-help/`, When diffed, Then no routing behavior beyond the retired stage names may have changed.
[must-not] Given `skills/pocket-closing/SKILL.md`, When diffed, Then the verdict gate, freshness gate, Advance State logic and `log close` invocation must NOT have changed — only prose, the frontmatter description, and remediation strings naming retired stages.

Commit exists matching `docs: ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - Every mention located by grep before editing, so none is missed
  - Algorithm prose preserved

Must-not-have:
  - Behavioral changes to `create-pr` or `pocket-help`
  - Any change to `pocket-closing`'s gate logic, freshness comparison, Advance State, or `log close` call
  - Editing the deprecated SKILL.md files again (T11 owns them)
  - Modifications to files outside the listed scope

Open question risks:
  - `create-pr` needing no change is an assumption → if a doc edit implies a behavior change, report NEEDS_CONTEXT

Rollback note:
  - Documentation only; reverting restores the old prose

Red flags:
  - A step or command changed in `create-pr` → scope violation, STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, commit created
Uncertain when: a mention is load-bearing rather than descriptive
Escalate when: syncing a doc would require a behavior change

---

### Task 13: Version 3.0.0, manifest sync, and migration release notes [depends: T12]

## OBJECTIVE

Cut the major version, keep both host manifests consistent, and publish the migration instruction that is the primary path for users with in-flight plans.

Files:
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md`

This is a **non-testable structural task**.

Steps:

1. Set `package.json` `version` to `3.0.0`. Do not touch `CONTRACT` in `cli/lib/version.js` — it stays `2`.
2. Review `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` for any field that must track the release; keep the Pi manifest (`pi.skills`, `bin`) and the plugin manifest describing the same skill set. Note in the commit body that `marketplace.json` uses `source: url` with no version field, so plugin rollback is "do not update / reinstall an older ref".
3. Add a migration section to `README.md` stating: **close in-flight plans before updating**; a plan started under an older pipeline is refused by the new CLI; recovery is to pin the CLI (`npx -y pocketto-pi@2.4.4`) and keep the plugin at its previous commit until the plan closes.
4. Verify:
   `node -e "const p=require('./package.json'); if(p.version!=='3.0.0') process.exit(1)"` exits 0, and
   `node -e "const v=require('./cli/lib/version'); if(v.CONTRACT!==2) process.exit(1)"` exits 0, and
   `npm test` is green.
5. Commit:
   `git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json README.md`
   `git commit -m "chore(release)!: 3.0.0 — in-loop build cycle, older plans refused"`

Mark in QUALITY BAR: `[no-tdd — structural task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — Rollback Plan and the Migration rule; the release note is the primary migration path
package.json — currently `2.4.4`; `pi.skills` and `bin` are the Pi manifest surface
.claude-plugin/marketplace.json — `source: url` to the git repo with no version field, so installs pin to a commit
cli/lib/version.js — `CONTRACT` must remain `2`; only the package major moves

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: four files, mechanical, but the version/contract distinction is exactly what this release is about and is easy to get wrong.
Complexity: lightweight

## SANDWICH CONTEXT

[CRITICAL: `CONTRACT` stays `2`. Only the package major moves to 3.0.0.]
You are cutting the 3.0.0 release for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A — breaking behavior, additive schema.
Files in scope: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md` — no others.
Test framework: node:test — `npm test` must be green before commit.
Available after: T12
Architecture rule: Pi manifest and Claude Code plugin manifest stay in sync.
[RESTATE: `CONTRACT` = 2. Version = 3.0.0. These are independent numbers.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given `package.json`, When read, Then `version` is `3.0.0`.
Given `cli/lib/version.js`, When read, Then `CONTRACT` is still `2`.
Given `README.md`, When the migration section is read, Then it instructs closing in-flight plans before updating and names the CLI pin as recovery.
Given the repo, When `npm test` runs, Then it is green.
[must-not] Given this task's diff, When inspected, Then `CONTRACT` must NOT appear as changed.
[must-not] Given the manifests, When compared, Then they must NOT describe different skill sets.

Commit exists matching `chore(release)!: ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — structural task]`
  - `version` 3.0.0, `CONTRACT` 2
  - Migration instruction present in README
  - `npm test` green before commit

Must-not-have:
  - Any change to `CONTRACT`
  - Publishing to npm (release is the user's call, not this task's)
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Reverting the version commit restores 2.4.4 metadata; no on-disk plan data is affected

Red flags:
  - `npm publish` executed → STOP, this task never publishes
  - `CONTRACT` bumped → STOP

## STOP CONDITIONS

Done when: DELIVERABLE checks pass, `npm test` green, commit created
Uncertain when: a manifest field appears to require a version that does not exist
Escalate when: keeping the manifests in sync would require a schema change

---

### Task 14: Final comprehension review and end-to-end verification [depends: T13]

## OBJECTIVE

Verify the whole bundle reads as one coherent pipeline to a fresh reader, and that the repo's own checks are green.

Files:
- Create: `docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md`

This is a **non-testable verification task**.

Steps:

1. Run `npm test` — must be green. Record the summary line.

2. **Closing-arithmetic cross-check.** T7's fan-out rule and `pocket-closing`'s freshness gate must compute the same value; a mismatch permanently blocks closing and no automated test covers it. Build a throwaway fixture and compare by hand.

   Two properties the fixture must have, both of which are easy to get wrong:
   - **Bleed is computed from FILES, not commit messages** (`verdict-reconciliation.md:47-48`: `tasks(c) = {c.for_task} ∪ {owner[f] : f ∈ c.files}`). A commit whose message claims it bleeds into T1 but which touches no T1-owned file does **not** bleed. So C2 must actually modify `a.txt`.
   - **`%cI` is second-resolution.** Four back-to-back commits share a timestamp, leaving `max_by_commit_time` indeterminate. Pin the dates explicitly.

   Run the whole thing in a subshell so the working directory is never left inside the fixture:
   ```bash
   (
     TMP=$(mktemp -d) && cd "$TMP" && git init -q
     git config user.email t@t && git config user.name t
     c() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qm "$2"; }
     printf 'a\n' > a.txt && git add a.txt && c "2026-01-01T00:00:00Z" "T1"  && T1=$(git rev-parse HEAD)
     printf 'b\n' > b.txt && git add b.txt && c "2026-01-01T00:01:00Z" "T2"  && T2=$(git rev-parse HEAD)
     printf 'a2\n' > a.txt && git add a.txt && c "2026-01-01T00:02:00Z" "C1 fixes T1" && C1=$(git rev-parse HEAD)
     printf 'a3\n' > a.txt && printf 'b2\n' > b.txt && git add a.txt b.txt
     c "2026-01-01T00:03:00Z" "C2 fixes T2, bleeds T1" && C2=$(git rev-parse HEAD)
     for s in $T1 $T2 $C1 $C2; do git show -s --format='%h %cI %s' "$s"; done
     echo "C2 files:" && git show --name-only --format= "$C2"
     rm -rf "$TMP"
   )
   ```
   `owner[a.txt] = T1`, and C2 touches `a.txt`, so `tasks(C2) ∋ T1` and T1's owned set is `{T1, C1, C2}`. Confirm the max-by-commit-time value the T7 rule yields for T1 is `C2` — and that `verdict-reconciliation.md`'s `latest_owned_sha(T1)` yields the same commit. Record both values side by side in the review file. If they differ → BLOCKED naming T7.

   Note in the record (do **not** fix — `verdict-reconciliation.md`'s algorithm is out of scope per the spec): `max_by_commit_time` documents no tiebreak for two commits sharing a `%cI` second.

3. Dispatch one general-purpose subagent, read-only, with this prompt and no additional context:
   > Read `skills/pocket-help/references/skill-map.md`, `README.md`, `skills/pocket-development/SKILL.md` and its `references/`, and `skills/pocket-closing/SKILL.md`. What do you understand the Pocket pipeline to be — list the stages in order and say which are triggered by the user. Are there any inconsistencies that would confuse you about which stage to run, or any stage that appears both live and deprecated?
4. Record the answer verbatim into the review file, followed by the `npm test` result, the Step 2 cross-check values, and a verdict.
5. Classify each reported inconsistency as blocking or non-blocking. A stage described as both live and deprecated is always blocking — **except** a comparative mention inside the parallel-merge rationale (`skills/pocket-development/SKILL.md` :401, :451, :457, :460, :480 — "same pattern pocket-review uses", "pocket-review's per-task diff range"). Those are analogies, not liveness claims, and that region is fenced byte-identical by the spec's worktree constraint, so no task may edit them. Classify them non-blocking and note them.
6. If any blocking inconsistency exists → report BLOCKED naming the contradiction and the owning task.
7. Verify:
   `test -f docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md`
8. Commit:
   `git add docs/pocket/plans/2026-08-15-in-loop-build-cycle/reviews/comprehension-final.md`
   `git commit -m "chore(pocket): record final comprehension review"`

Mark in QUALITY BAR: `[no-tdd — verification task]`

## REFERENCES LOADED

docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md — rule: Comprehension, and the per-phase acceptance signal
skills/pocket-help/references/skill-map.md — the routing map a new user reads first
skills/pocket-closing/references/verdict-reconciliation.md — `latest_owned_sha` and `tasks(c)`, the algorithm Step 2 compares against
skills/pocket-development/references/phase-level-pass.md — T7's fan-out `reviewed_sha` rule, the other half of the Step 2 comparison
test/cli.test.js — `npm test` is the entire automated CI surface

[CRITICAL: Without this section, packet is incomplete]

## WHY THIS APPROACH

Justification: read-only verification across the whole bundle; the value is a fresh reader detecting a stage that reads as both live and retired.
Complexity: standard review

## SANDWICH CONTEXT

[CRITICAL: The reviewing subagent must receive NO context from this session.]
You are running the final comprehension review for the In-Loop Build Cycle.
Spec: docs/pocket/spec/2026-08-15-in-loop-build-cycle/in-loop-build-cycle.md
Design decision: Option A.
Files in scope: the new review record only — no product file may be edited.
Test framework: node:test — `npm test` result is recorded, not fixed, here.
Available after: T13
Architecture rule: this task reports; it never fixes.
[RESTATE: Zero session context to the reviewer. A stage reading as both live and deprecated is always blocking.]

## DELIVERABLE

Verification — task is DONE when all pass:

Given `npm test`, When it runs, Then it is green and the summary is recorded.
Given the synthetic fixture, When T7's fan-out rule and `verdict-reconciliation.md`'s `latest_owned_sha` are both applied to T1's owned set, Then they yield the same commit, and both values are recorded side by side.
Given the dispatched subagent, When it reports, Then it lists the pipeline stages in the correct order and identifies which are user-triggered.
Given its report, When inconsistencies are classified, Then none are blocking and no stage reads as both live and deprecated.
Given the review record, When read, Then it contains the answer verbatim, the test result, and a verdict.
[must-not] Given a blocking inconsistency, When found, Then this task must NOT fix it.

Commit exists matching `chore(pocket): ...`.

Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR

Must-have:
  - `[no-tdd — verification task]`
  - `npm test` actually executed, result recorded verbatim
  - The closing-arithmetic cross-check actually run on a throwaway fixture, both values recorded
  - Reviewer dispatched with no session context

Must-not-have:
  - Editing any skill, CLI, or manifest file
  - Declaring success without running the test command
  - Modifications to files outside the listed scope

Open question risks:
  - none

Rollback note:
  - Documentation only

Red flags:
  - "Tests should pass" without output → STOP, run them
  - Reviewer given the spec or this plan → the test is void, re-dispatch

## STOP CONDITIONS

Done when: `npm test` green, review recorded, no blocking inconsistency, commit created
Uncertain when: an inconsistency's severity is ambiguous
Escalate when: a stage reads as both live and deprecated — name the owning task and stop

---

## Phase Completion Gate

DONE when ALL of the following:
- Every task in this phase: status DONE
- All tests pass
- All commits created with correct format
- No task has status BLOCKED or NEEDS_CONTEXT

Hand off to (none — all phases complete) ONLY after this gate passes.
