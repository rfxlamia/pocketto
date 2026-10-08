# Parallel Group Execution

Load this reference only when the Entry Gate classifies ready tasks as a PARALLEL GROUP. It owns worktree isolation, dispatch, audit, merge, recovery, log updates, and cleanup. FOUNDATION and SOLO tasks stay sequential in the main repository.

Activates when Entry Gate item 5 classifies tasks as PARALLEL GROUP. Subagents are spawned as twins/forks inheriting CWD; without isolation they collide on `git status`, `git log`, lockfiles, and shared registries. Worktree-per-task gives each subagent a clean checkout.

**Classification happens in `entry-gate.md`.** This reference covers execution mechanics after the Entry Gate classifies ready tasks as PARALLEL GROUP.

### Worktree Setup (main agent, before dispatch)

Worktrees are **retained** on BLOCKED for diagnosis, so setup SHALL be resumable: a later
session must be able to re-enter a group without tripping over its own retained state.

```bash
parent_sha=$(git rev-parse HEAD)        # latest merged task or baseline

# One-time per repo (idempotent). Local execution metadata belongs in the repo's private
# exclude file, NOT in tracked .gitignore — mutating a tracked file leaves the main tree
# dirty for the whole run, collides with any task that also edits .gitignore, and survives
# cleanup.
grep -qxF '.worktree/' .git/info/exclude || echo '.worktree/' >> .git/info/exclude

# Clear metadata for worktrees whose directory was deleted out from under git.
git worktree prune

# Per task in the group — resume before create:
for task in group:
    if git worktree list --porcelain | grep -qx "worktree $(pwd)/.worktree/<task_id>"; then
        # Registered. Reuse only if it is this task's branch AND still based on the parent.
        [[ $(git -C .worktree/<task_id> branch --show-current) == "task/<task_id>" ]] \
            || INSPECT: worktree_branch_mismatch; identify the task branch and recover without deleting work
        git -C .worktree/<task_id> merge-base --is-ancestor $parent_sha HEAD \
            || INSPECT: worktree_stale_parent; rebase or merge the retained work onto the current parent, then verify it
        REUSE
    elif git show-ref --verify --quiet refs/heads/task/<task_id>; then
        # Branch survived, directory did not — reattach, do not re-create the branch.
        git worktree add .worktree/<task_id> task/<task_id>
    elif [[ -e .worktree/<task_id> ]]; then
        # Path on disk but unregistered even after prune — inspect before touching it.
        INSPECT: worktree_path_occupied; preserve unknown or uncommitted data
    else
        git worktree add .worktree/<task_id> -b task/<task_id> $parent_sha
    fi
```

`worktree_stale_parent` means a task merged after this worktree was created, so its base no
longer matches the group's parent. Inspect its commits and working-tree state, then rebase or
merge onto the new parent and verify. For `worktree_branch_mismatch`, identify the correct
task branch and registration before reuse. For `worktree_path_occupied`, inspect but do not
remove or overwrite unknown or uncommitted data; ask the user only if ownership or safe
disposition cannot be established. Never discard retained work without explicit authorization.

Path: `<cwd>/.worktree/<task_id>` — conventional location, excluded via `.git/info/exclude` on
first parallel run so the main working tree stays clean.

### Pocket Packet — WORKTREE Field (parallel tasks only)

Sequential tasks: omit. Parallel tasks: required.

```markdown
## WORKTREE
Path:       <abs_path>/.worktree/<task_id>
Branch:     task/<task_id>
Parent SHA: <parent_sha>
[CRITICAL: ALL operations must run from this worktree.
 First action: `cd <abs_path>/.worktree/<task_id>`. Do NOT touch parent repo.]
```

SANDWICH CONTEXT enforces CWD twice (Iron Law #4):

```
FIRST LINE: [CRITICAL: cd <abs_worktree_path> BEFORE any file or git
             operation. Wrong CWD = audit fail.]

NEAR END:   [REPEAT: Final commit must land on branch task/<task_id>.
             Verify before reporting DONE:
               git -C <abs_worktree_path> branch --show-current]
```

### Parallel Dispatch

Dispatch ALL tasks in the group in ONE batch — single message containing N parallel Agent calls. Same batching the main agent uses when dispatching read-only auditors per `two-stage-review.md`.

**Never** dispatch sequentially within a group. Concurrency is the entire point.

### Per-Worktree Quick Audit (main agent)

**Normative contract:** `two-stage-review.md` — cite it; do not restate its rules here.

When a subagent reports DONE, run the in-loop cycle against ITS worktree per the contract. The main agent never judges code; every criterion is executed by a read-only auditor subagent.

1. **Mechanical gate** (main agent) — command-and-commit evidence only, inside the worktree. Cite `two-stage-review.md` § Mechanical gate.
2. **Deep audit** — dispatch a read-only auditor subagent against the worktree tip per `two-stage-review.md`.
3. **Fix/refactor round** — when the artifact requires a round, re-dispatch the implementer with the same WORKTREE field, then re-run the mechanical gate, then re-dispatch the auditor per `two-stage-review.md`.
4. **Re-audit** — same auditor path as step 2, against the new worktree tip.

On `audit-failed` or `auditor-unavailable`, halt the group — no merge (see `two-stage-review.md`). Worktrees RETAINED.

Passing in-worktree audits proceed to Group Merge below. Do not pass `--sha` of the worktree tip.

### Group Merge (main agent, after ALL group tasks audit-pass)

Main agent performs merges sequentially in plan order from the main repo:

```bash
for task in group_in_plan_order:                    # T5 → T6 → T7
    git merge --no-ff task/<task_id> \
              -m "Merge <task_id> (parallel group)"

    # On conflict:
    #   git merge --abort
    #   → Diagnose the conflict and continue with materially different recovery
    #     strategies until the merge succeeds or a human decision is required
    #     (separate from per-task audit cycles and phase-level recovery cycles).
    #     All artifact I/O uses
    #     <plan_dir>/reviews/<task_id>-review.json:
    #     1. Resume implementer, gate, auditor, or merge_retry from the
    #        persisted stage after interruption.
    #     2. Persist merge_recovery_consumed: true and
    #        merge_recovery_stage: "implementer" BEFORE the first recovery
    #        dispatch; mirror merge_recovery_stage on every group task verdict
    #        artifact involved in the conflict (group-visible resume state).
    #     3. Dispatch an implementer against the retained worktrees
    #        with the conflicting file list and both tasks' packets
    #        (same WORKTREE-field dispatch as a fix round)
    #     4. Set merge_recovery_stage: "gate"; run the mechanical gate
    #     5. Set merge_recovery_stage: "auditor"; re-dispatch an independent auditor
    #     6. Set merge_recovery_stage: "merge_retry"; retry git merge --no-ff
    #        task/<task_id>
    #        - success → rewrite <plan_dir>/reviews/<task_id>-review.json
    #          reviewed_sha to the merge commit SHA, clear merge_recovery_stage
    #          on the group artifacts, then fall through to log update below
    #        - conflict → git merge --abort; persist
    #          merge_recovery_stage: "parallel-conflict" on the group artifacts;
    #          ask a fresh read-only advisor to inspect both task packets, diffs,
    #          and conflict, then start a materially different recovery stage.
    #   → If evidence cannot resolve a semantic/product choice, report
    #     BLOCKED with the conflicting tasks/files and the specific choice needed.
    #     Retain worktrees; do NOT log update until the conflict is resolved.

    # Merge succeeded → log THIS task NOW, before the next merge. HEAD is
    # this task's merge commit, so done_sha = that commit.
    npx -y pocketto-pi log update <plan_dir> <phase_file> DONE --task <task_id> --json --contract 3
```

[CRITICAL] One task per loop iteration: `git merge` then `log update`, then the
next task. NEVER merge the whole group first and log afterwards — every
`log update` would capture the final merge commit, collapsing all tasks onto a
single `done_sha`. That silently empties the `prev_sha..done_sha` diff range
for the 2nd+ task — the range the phase-level pass diffs per task
(`phase-level-pass.md`) and pocket-closing's owner-map attribution
depends on — so that content goes unreviewed and misattributed. The CLI
refuses a duplicate `done_sha` across sibling tasks in a phase
(`DUPLICATE_DONE_SHA`, exit 1, nothing written). Recover by re-running with
`--sha <that task's own merge commit>` (find it via `git log --merges
--oneline`); only for a task that legitimately produced no new commit, pass
`--allow-duplicate-sha` to record the duplicate anyway (the main agent writes
a REVIEW_PASS skip stub for it per `two-stage-review.md`).

Merge commit SHA becomes that task's `done_sha` in log.json — **schema stays linear**, keeping the phase-level pass's per-task diff ranges and pocket-closing's owner-map attribution intact.

### Cleanup (main agent, after group fully merged + logged)

```bash
for task in group:
    git worktree remove .worktree/<task_id>
    git branch -d task/<task_id>
```

If ANY task in the group is BLOCKED → NO cleanup of any worktree in that group. Diagnosability over tidiness.

### Risk Mitigations Built Into Flow

| Risk | Mitigation |
|------|------------|
| Subagent ignores `cd` instruction | Audit Step 1 verifies `branch --show-current` = `task/<task_id>`. Wrong branch = AUDIT FAIL — no human-trust gap |
| Lockfile / build artifact race | Each worktree builds independently. Shared caches (pnpm store, cargo target) are project-specific — handle in plan, not skill |
| `.worktree/` polluting repo | Excluded via `.git/info/exclude` on first parallel run (untracked, leaves the working tree clean), auto-removed after merge |
| Conflict mid-merge | Sequential merge in plan order + `--abort` + independent diagnosis and alternate recovery; BLOCKED only for a human decision |
| log.json schema drift | `done_sha = merge_sha` keeps log linear; phase-level pass diff ranges and pocket-closing's owner-map attribution stay intact |
| Misclassified parallel/sequential | Caught at Entry Gate item 5 (classification), not here |

### Sample Flow

```
Plan: T5, T6, T7 — parallel group after T4

1. T4 merged. parent = git rev-parse HEAD (= T4's done_sha)

2. Entry Gate items 1-4 pass for each task individually.
   Item 5 classifies all three as PARALLEL GROUP.

3. Worktree setup (resume-before-create per task — see Worktree Setup):
   git worktree add .worktree/T5 -b task/T5 parent
   git worktree add .worktree/T6 -b task/T6 parent
   git worktree add .worktree/T7 -b task/T7 parent

4. Dispatch [T5, T6, T7] in ONE message — each packet has its WORKTREE field

5. All return DONE → mechanical gate then read-only auditor against each worktree tip → all pass

6. Main agent merges sequentially, logging each task BEFORE the next merge
   (one merge + one log update per iteration — never merge all three then log):
   git merge --no-ff task/T5  →  log update --task T5 DONE   # done_sha[T5] = T5 merge commit
   git merge --no-ff task/T6  →  log update --task T6 DONE   # done_sha[T6] = T6 merge commit
   git merge --no-ff task/T7  →  log update --task T7 DONE   # done_sha[T7] = T7 merge commit
   → each done_sha is a distinct merge commit; log stays linear

7. Cleanup: remove worktrees, delete branches

8. Continue to T9 (deps now satisfied)
```
