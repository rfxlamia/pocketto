---
name: pocket-review
description: Post-phase batch reviewer. User invokes after pocket-development marks all phase tasks DONE. Main agent runs preflight and dispatches parallel reviewer subagents (one per task). Returns PHASE_REVIEWED or PHASE_BLOCKED; on an all-REVIEW_PASS phase it chains to pocket-closing after one confirmation.
---

# Pocket Review

Post-phase batch reviewer. Invoked directly by the user after pocket-development finishes a phase or flat plan.

**Core principle:** Main agent delegates. Subagents review. One subagent per task, all parallel.

## Position in Pocket Bundle

```
pocket-grinding → pocket-planning → pocket-structuring → pocket-development → POCKET-REVIEW → pocket-closing
                                                                                    ↑
                                                                          User invokes here
                                                                     after phase/plan completes
```

pocket-review is **invoked directly by the user** — not by pocket-development. When pocket-development finishes a phase, it emits a handoff message. The user then spawns pocket-review.

On the other side, pocket-review **chains forward** to pocket-closing. When every reviewable task is `REVIEW_PASS`, it surfaces one confirmation and then invokes pocket-closing (see [Chain to pocket-closing](#chain-to-pocket-closing-conditional)) — the same auto-invoke-behind-one-confirmation pattern pocket-grinding uses for pocket-planning, not a silent close. It still never touches `log.json`; closing owns that.

## Invocation

```
/pocketto:pocket-review <path-to-execution-plan-or-plan-dir>
```

Examples:
```
/pocketto:pocket-review docs/pocket/plans/2026-05-28-auth/execution-plan.md
/pocketto:pocket-review docs/pocket/plans/2026-05-28-auth/execution-plan-phase-1.md
/pocketto:pocket-review docs/pocket/plans/2026-05-28-auth/
```

## Main Agent Role (HARDENED)

Main agent = **Delegator + Preflight only**. Does NOT review code.

| Main agent MUST | Main agent MUST NOT |
|-----------------|---------------------|
| Run preflight and validate log.json | Read implementation files or assess code |
| Compute SHA ranges per task via git diff | Evaluate spec compliance or code quality |
| Dispatch ALL reviewer subagents in one parallel call | Re-dispatch implementers (no loop in batch mode) |
| Collect subagent results and write review JSON files | Interpret subagent findings beyond what they report |
| Print summary table | Update log.json status (leave to user or pocket-closing) |

## Preflight

Run ALL steps before dispatching any subagent. Failure in steps 1–2 → PHASE_BLOCKED immediately.

### Step 1: Resolve plan_dir and phase_file

```
If invoked with a file path → plan_dir = parent dir, phase_file = filename
If invoked with a dir path → scan for execution-plan*.md, use the only/first match
```

### Step 2: Read log.json

```
<plan_dir>/log.json
```

Verify:
- File exists → else `PHASE_BLOCKED: "log.json not found at <path>"`
- `header.baseline_sha` is a non-null string → else `PHASE_BLOCKED: "baseline_sha missing in log.json header"`
- `phases[N].tasks` array exists for the target phase

### Step 3: Build reviewable task list

Iterate tasks in plan order. For each task:

```
prev_sha = header.baseline_sha           (for the first task)
         = previous_task.done_sha        (for subsequent tasks)

files_changed = git diff --name-only <prev_sha>..<task.done_sha>
```

| Condition | Action |
|-----------|--------|
| `task.status != "DONE"` | Skip — log: `"T{id} not DONE (status: {status}) — skipped"` |
| `task.done_sha` missing or null | Skip — log: `"T{id} missing done_sha — skipped"` |
| `files_changed` is empty | Flag for skip stub (see **Skip stub** in Step 5). Do NOT add to reviewable list; do NOT dispatch a subagent. Log: `"T{id} SHA range <prev>..<done> has no file changes — stub pending"` |

If zero tasks are reviewable (no non-empty-diff DONE tasks found) → `PHASE_BLOCKED: "No reviewable tasks found. Ensure all tasks are DONE with done_sha."`. Empty-diff tasks flagged for stubs do **not** count toward this threshold.

#### Corrections: attribution, range-union, and re-review trigger

After applying the first-cycle rules above, also read `phase.corrections` from `log.json` (absent or null → treat as empty array `[]`).

**Build `owner[file]`** — file → owning task id, derived from original task ranges only (correction commits are excluded):

```
prev = header.baseline_sha
for each task T in plan order:
    if T.done_sha is defined:
        for each file f in git diff --name-only <prev>..<T.done_sha>:
            owner[f] = T.id          ← last-writer-wins
        prev = T.done_sha
    else:
        skip T without advancing prev
```

**Compute `tasks(c)` for each correction entry** `c = {sha, files, for_task?}`:

```
tasks(c) = ({c.for_task} if c.for_task is present) ∪ { owner[f] : f ∈ c.files and owner[f] is defined }
```

`for_task` is **first-class** — T is in `tasks(c)` whenever `c.for_task == T`, regardless of whether any file in `c.files` is owned by T. Owner-only attribution strands a failed task whose fix lands in a file last-written by a different task (the common shared-file case), leaving its `REVIEW_FAIL` permanently unresolvable and the plan `CLOSE_BLOCKED` forever.

**Re-review trigger** — a task T is re-reviewable (in addition to the first-cycle reviewable rule) when:
- Some correction `c` has `T ∈ tasks(c)`, **and**
- `c.sha` is newer by commit time (`git show -s --format=%cI <sha>`) than the `reviewed_sha` recorded in `reviews/<T>-review.json`.

If `reviews/<T>-review.json` does not yet exist or lacks a `reviewed_sha` field, treat any owned correction as newer (the task needs review).

**Review range for a re-reviewable task T** (union of original slice + correction slices):

- **Original slice:** files in `prev..T.done_sha` that are owned by T (same diff used in first cycle).
- **Per correction `c` with `T ∈ tasks(c)`:**
  - If `T == c.for_task` → review the **whole** correction commit: `git show <c.sha>`. The `for_task` owns the fix intent even on shared files; the full diff is shown.
  - Else (T is a bleed-owner: `owner[f] == T` for some `f ∈ c.files`) → review only the **slice** of `c` limited to T's owned files: `git show <c.sha> -- <T-owned files in c.files>`.

A correction commit that touches two tasks is presented per the above rule: the `for_task` sees the whole commit; a bleed-owner sees only its own files.

**Cycle bookkeeping and `reviewed_sha` on re-review** — when writing `reviews/<T>-review.json` for a re-review:

- `loop_info.current_cycle` = prior cycle + 1 (increment, not reset). `cycle` mirrors `current_cycle`.
- `reviewed_sha` = the max-by-commit-time of `{ T.done_sha } ∪ { c.sha : c ∈ phase.corrections and T ∈ tasks(c) }`. In other words: the newest commit (by `%cI`) among T's done_sha and all corrections attributed to T; if no corrections exist for T, this equals `T.done_sha`. This must equal what pocket-closing computes as `latest_owned_sha(T)` — the two definitions use the identical `tasks(c)` attribution set, so they cannot diverge.
- A passing re-review writes `overall: REVIEW_PASS`, superseding any prior FAIL.
- A still-failing re-review writes `overall: REVIEW_FAIL` with fresh `fix_instructions` (cumulative across cycles).

### Step 4: Extract task context from plan file

For each reviewable task, read the plan file and extract:
- `DELIVERABLE` section (under `### Task N: Name`)
- `spec_ref` — the spec file the task references (absolute path)
- `quality_bar` — must-have, must-not-have, red flags

### Step 5: Ensure reviews/ directory exists

```bash
mkdir -p <plan_dir>/reviews/
```

Then write a **REVIEW_PASS skip stub** for every empty-diff task flagged in Step 3.

**Skip stub.** For each `DONE + done_sha` task whose SHA range has no file changes, write this JSON to `reviews/<task_id>-review.json` **before dispatching subagents**:

```json
{
  "task_id": "<task_id>",
  "task_name": "<task_name>",
  "cycle": 1,
  "timestamp": "<UTC ISO 8601 now>",
  "reviewer_mode": "read-only",
  "reviewer_config": "batch-parallel",
  "stage_1": { "status": "PASS", "issues": [], "concerns_addressed": [] },
  "stage_2": { "status": "PASS", "strengths": [], "issues": [], "assessment": "Approved" },
  "overall": "REVIEW_PASS",
  "fix_instructions": "",
  "loop_info": { "current_cycle": 1, "max_cycles": 1, "cycles_remaining": 0 },
  "skip_reason": "no_file_changes",
  "reviewed_sha": "<task.done_sha>"
}
```

`reviewed_sha` enables pocket-closing's exact-SHA freshness check (stronger than the timestamp proxy). `skip_reason` marks the file as an auto-generated stub — not a subagent review. Without this stub, pocket-closing treats any `DONE + done_sha` task with no review file as `CLOSE_BLOCKED`.

### Step 6: Load reviewer reference file paths

Note absolute paths — these are passed to subagents:
```
<skill_dir>/references/spec-compliance-review.md
<skill_dir>/references/code-quality-review.md
<skill_dir>/references/review-report-template.md
```

## Dispatch (Parallel)

After all preflight steps pass, load `references/subagent-dispatch-template.md` to get the exact prompt structure.

Construct one review packet per reviewable task. Then dispatch ALL subagents in a **single message** (one Agent tool call per task, all in the same response).

**Subagent type:** `code-reviewer`

**Never dispatch sequentially.** All tasks go in one parallel batch.

## Collect and Write

After ALL subagents complete:

1. For each subagent result:
   - Parse the JSON output from the subagent
   - Write to `<plan_dir>/reviews/<task_id>-review.json`
   - If subagent could not complete → write a REVIEW_BLOCKED stub entry

2. Print summary table:

```
PHASE REVIEW COMPLETE — <phase_file>
──────────────────────────────────────────
T1  <task_name>          REVIEW_PASS
T2  <task_name>          REVIEW_FAIL   ← issues found
T3  <task_name>          skipped (no file changes — REVIEW_PASS stub written)
──────────────────────────────────────────
Pass: 1  Issues: 1  Skipped: 1
```

3. For each REVIEW_FAIL task, print the `fix_instructions` from the report.

4. If any task is `REVIEW_FAIL` or `REVIEW_BLOCKED`, print the **Action Required**
   block below before stopping:

```
ACTION REQUIRED — review did not pass

Do not run pocket-closing yet. Corrections are append-only — done_sha never moves,
so there is no "safe vs unsafe" boundary decision anymore.

▸ MANUAL (a human is applying fixes directly):
  For each REVIEW_FAIL task:
  1. Read reviews/<task_id>-review.json and apply the fix_instructions.
  2. Commit the fix (one commit, only the fix's source files — not log.json), then record it:
       npx -y pocketto-pi log update <plan_dir> <phase_file> \
         --correction <sha> --for-task <task_id> --json --contract 2
  3. Re-run: /pocketto:pocket-review <plan_dir>/<phase_file>

▸ AGENT (you reached here from pocket-development — agent-managed execution):
  The phase already terminated at PHASE_COMPLETE; you are NOT mid-phase.
  Run: /pocketto:pocket-correction <plan_dir>/<phase_file>
  It delegates each fix, records corrections, and hands back for re-review.

For REVIEW_BLOCKED (either path):
- Do not enter a fix cycle. Resolve the blocker or escalate as instructed.
```

Recording a correction never moves an existing done_sha, so it is always safe regardless of task position.

## Enterprise mode (opt-in): post verdicts to PR

This section runs **after** the summary table is printed and review JSONs are written (Collect and Write) and **before** Chain to pocket-closing. In non-enterprise mode, it is skipped entirely — no GitHub calls are made.

### Preflight: detect enterprise mode

```bash
npx pocketto-pi mode --json --contract 2
```

Parse the JSON envelope. If `ok` is false, the command is missing, or `data.enterprise` is not `true` → **skip this entire section** and proceed directly to [Chain to pocket-closing](#chain-to-pocket-closing-conditional). Fail-closed: any error or malformed output means non-enterprise.

### E1. Discover the phase PR

Read the PR number from plan meta:

```bash
npx pocketto-pi meta get <plan_dir> pr.number --json --contract 2
```

- `data.value` is a positive integer → use it as the PR number.
- `data.value` is null → fall back to branch-based discovery:
  ```bash
  branch=$(git rev-parse --abbrev-ref HEAD)
  pr_number=$(gh pr list --head "$branch" --json number --jq '.[0].number // empty')
  ```
- If `pr_number` is empty after both attempts → **STOP**: print `"No PR found for branch '<branch>'. Cannot post verdicts. Create a PR first or run without enterprise mode."` → create **no** comments or threads. Proceed to Chain to pocket-closing. **No orphan comments.**

### E2. Resolve owner/repo

```bash
gh repo view --json owner,name -q '.owner.login + "/" + .name'
```

Store as `<owner>/<repo>` for all subsequent `gh` calls.

### E3. Format the canonical summary body

Build the input JSON for `format comment`:

```json
{
  "phase": <N>,
  "verdicts": [
    { "task": "T1", "verdict": "PASS" },
    { "task": "T2", "verdict": "FAIL" }
  ],
  "prLinked": true
}
```

- `<N>` = phase number from the phase file name.
- Map `REVIEW_PASS` → `"PASS"`, `REVIEW_FAIL` → `"FAIL"`, `REVIEW_BLOCKED` → `"BLOCKED"`, skipped tasks → `"SKIP"`.
- `prLinked` is always `true` (we have a PR by this point).

Write to a temp file, then:

```bash
npx pocketto-pi format comment --input <tmp-verdicts.json> --json --contract 2
```

Read the body from `data.bodyFile`. The body starts with the marker `<!-- pocket-phase-<N>-summary -->` — this marker is the canonical identity for upsert.

### E4. Upsert the canonical summary comment

Exactly **one** marker-tagged summary comment per phase. On re-runs, update in place; never create duplicates. On a race (>1 markered comment), keep the earliest and collapse the rest.

1. List all issue comments on the PR:

   ```bash
   gh api repos/<owner>/<repo>/issues/<pr_number>/comments --paginate
   ```

2. Filter to markered comments: check if `body` starts with `<!-- pocket-phase-<N>-summary -->` (first line). Collect all matches, sorted by `id` ascending (earliest first).

3. Upsert logic:

   | Matches | Action |
   |---------|--------|
   | 0 | Create: `gh api repos/<owner>/<repo>/issues/<pr_number>/comments -f body="$(cat <body-file>)"` |
   | 1 | Update in place: `gh api repos/<owner>/<repo>/issues/comments/<comment_id> --method PATCH -f body="$(cat <body-file>)"` |
   | >1 (race) | Update earliest (lowest `id`) with new body. Delete each later comment: `gh api repos/<owner>/<repo>/issues/comments/<later_id> --method DELETE` |

### E5. Reconcile and post inline findings

The CLI computes the set-diff (resolve/post/keep). The skill executes the resulting actions. Fingerprints must match the CLI's `identity.fingerprint()` exactly.

#### E5a. Read prior fingerprints

```bash
npx pocketto-pi meta get <plan_dir> review.fingerprints --json --contract 2
```

If `data.value` is null or absent, treat as `[]` (no prior findings).

#### E5b. Compute new fingerprints

For each REVIEW_FAIL or REVIEW_BLOCKED task, read `reviews/<task_id>-review.json`. Extract findings (issues, concerns). Compute a fingerprint for each finding using the **shared identity algorithm**:

```bash
printf '%s\0%s\0%s\0%s' "<file>" "<ruleId>" "<normalized_message>" "<occurrence>" \
  | shasum -a 256 | cut -c1-16
```

Where:
- `file` — source file path relative to repo root.
- `ruleId` — rule or check identifier (e.g. `"spec-compliance"`, `"missing-error-handling"`).
- `message` — finding message, normalized: split on `\r?\n`, join with `\n`, trim whitespace.
- `occurrence` — disambiguator for multiple findings on the same file/rule (line number or index).

This matches the CLI's `cli/lib/identity.js` `fingerprint()` exactly — same fields, same `\x00` separator, same sha256 → first 16 hex chars.

Write the new findings array to a temp file `<new-findings.json>`:

```json
[
  {
    "fingerprint": "<sha256-hex-16>",
    "finding": {
      "file": "src/auth.ts",
      "ruleId": "spec-compliance",
      "message": "Missing error handling for invalid token",
      "occurrence": "42",
      "task": "T2",
      "verdict": "FAIL"
    }
  }
]
```

#### E5c. Run reconcile

```bash
npx pocketto-pi reconcile --prior <prior-fingerprints.json> --new <new-findings.json> --json --contract 2
```

Returns:
```json
{
  "data": {
    "resolve": [{ "fingerprint": "...", "thread": "PRRT_...", ... }],
    "post":    [{ "fingerprint": "...", "finding": { ... } }],
    "keep":    [{ "fingerprint": "...", "finding": { ... } }]
  }
}
```

- `resolve` — prior findings no longer present → their threads should be resolved.
- `post` — new findings not in prior → should be posted as inline threads.
- `keep` — findings unchanged → leave as-is.

#### E5d. Resolve threads for `data.resolve`

For each entry in `data.resolve`, the `thread` field is the GitHub review thread node ID from a prior run. Resolve it:

```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }
' -f threadId="<thread_id>"
```

If the thread is already resolved or missing, the mutation returns an error — log and continue (non-fatal).

#### E5e. Post inline findings for `data.post`

For each entry in `data.post`, post as an inline review comment on the PR diff:

```bash
gh api repos/<owner>/<repo>/pulls/<pr_number>/comments \
  -f path="<file>" \
  -f position=<diff_position> \
  -f body="<finding body with fingerprint tag>"
```

- `path` — the file from `finding.file`.
- `position` — the diff line index. If the exact position is unavailable (file not in current diff), post as a top-level PR review comment instead, noting the file path in the body.
- `body` — the finding message plus a hidden fingerprint tag:
  ```
  <finding message>

  <!-- pocket-fp:<fingerprint> -->
  ```

After posting all new findings, query review threads to capture their node IDs:

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) { nodes { body } }
          }
        }
      }
    }
  }
' -f owner="<owner>" -f repo="<repo>" -f pr=<pr_number>
```

Match each posted comment by its `<!-- pocket-fp:<fingerprint> -->` tag to extract the thread node ID.

#### E5f. Persist new fingerprints

Build the updated fingerprints array:

- `data.keep` entries → include with existing `fingerprint` + `thread` fields.
- `data.post` entries → include with `fingerprint` + the newly captured `thread` node ID.
- `data.resolve` entries → already resolved, do **not** include.

Write to a temp file, then persist:

```bash
npx pocketto-pi meta set <plan_dir> review.fingerprints "$(cat <updated-fingerprints.json>)" --json --contract 2
```

### E6. Enterprise section complete

After all enterprise steps complete, proceed to Chain to pocket-closing as usual. The enterprise section does **not** alter the output state (`PHASE_REVIEWED` / `PHASE_BLOCKED`) — it only posts to GitHub and reconciles threads.

**Cross-OS note:** Fingerprints are sha256 hex strings (16 chars), never raw bytes. The `printf | shasum` pipeline produces identical output on macOS and Linux.

## Chain to pocket-closing (conditional)

After the summary table is printed, decide whether to chain into pocket-closing. This is the `review → closing` handoff — the same auto-invoke-behind-one-confirmation pattern pocket-grinding uses for pocket-planning, **not** a silent close.

**Chain ONLY when ALL of these hold:**
- Output state is `PHASE_REVIEWED` (preflight passed — never on `PHASE_BLOCKED`).
- Every reviewable task is `REVIEW_PASS` — **zero** `REVIEW_FAIL`, **zero** `REVIEW_BLOCKED` in the summary.
- Tasks skipped because `not DONE` or missing `done_sha` do **not** block the chain — pocket-closing excludes them from its gate too (they have no `done_sha` to reconcile).
- Tasks skipped because of empty diff (`DONE + done_sha + no file changes`) received a REVIEW_PASS skip stub in Step 5 — pocket-closing will find the file and reconcile them as REVIEW_PASS; they do not block closing.

If the run ended `PHASE_BLOCKED` (preflight failure) → **do NOT chain.** The preflight failure message was already printed in the Preflight step; stop here.

If ANY task is `REVIEW_FAIL` or `REVIEW_BLOCKED` → **do NOT chain.** Print the Action Required block from Collect and Write, then stop. Closing is gated on clean verdicts; chaining a failing phase would only hit `CLOSE_BLOCKED`.

### Confirmation checkpoint (single prompt)

When the all-pass condition holds, surface the result and ask **once** before any state changes:

> "All N tasks passed review (summary above). Close `<phase_file>` now? This advances `REVIEW → DONE`, runs `log close`, and writes `closeout.md`. (yes / not yet)"

- **yes** → invoke pocket-closing (next).
- **not yet / no** → stop here. The user can run `/pocketto:pocket-closing <path>` later. State is unchanged.

Wait for the answer. Do **not** proceed on silence.

### Invoke pocket-closing

On confirmation:

**Step 1 — Identify invocation method:**
- In Claude Code: use the `Skill` tool to invoke `pocket-closing`.
- In other agent platforms: use your platform's skill/agent dispatch mechanism.
- If no dispatch mechanism exists: load and follow the `pocket-closing` skill directly in this session.

**Step 2 — Pass the plan path:** the same `<plan_dir>` / `<phase_file>` this review ran against.

**Step 3 — Let pocket-closing own the close.** It re-runs its own preflight, verdict gate, freshness check, Advance State, and `log close` from scratch. pocket-review does NOT pre-advance state or touch `log.json` (the Main Agent Role table and Iron Laws are unchanged) — it only hands off the path.

**Freshness is satisfied by construction.** Because the chain fires in the same session immediately after the reviews were written, every verdict is current for its task's `done_sha` — pocket-closing's freshness gate (its Iron Law 2) passes naturally.

**Phased plans:** if pocket-closing returns `PHASE_ADVANCED` (other phases remain), the plan is not finished — route back to pocket-development for the next phase. Do NOT loop back into closing.

## Output States

| State | Meaning |
|-------|---------|
| PHASE_REVIEWED | All reviewable tasks reviewed. All `REVIEW_PASS` → chain to pocket-closing (one confirmation). Any issue → print Action Required, then stop |
| PHASE_BLOCKED | Preflight failed — cannot review |

**No automatic fix loop in batch mode.** If issues are found (`REVIEW_FAIL` in JSON), print the Action Required block and stop. The user (or pocket-correction for agent-managed execution) records an append-only correction commit and re-runs pocket-review; done_sha is never moved.
Re-running overwrites existing `reviews/<task_id>-review.json` files.

## Iron Laws

```
1. NO CODE READING BY MAIN AGENT
   Only subagents read implementation files.
   WHY: Main agent is delegator, not reviewer. Self-review defeats the independence principle.

2. NO SEQUENTIAL DISPATCH
   All subagents dispatched in one parallel Agent call.
   WHY: Reviews are independent per task. Serial dispatch wastes time.

3. NO LOOP
   One review per run. Fix issues, then re-run.
   WHY: No implementer to re-dispatch to. Batch mode is observe-and-report only.

4. NO SILENT BLOCK
   Every PHASE_BLOCKED includes: what failed, why, what would unblock.
```

## Sample log.json (Valid Preflight Input)

```json
{
  "header": {
    "plan_dir": "docs/pocket/plans/2026-05-28-auth",
    "plan_type": "flat",
    "status": "IN_PROGRESS",
    "date_started": "2026-05-28",
    "date_completed": null,
    "baseline_sha": "abc1234def5678"
  },
  "phases": [
    {
      "order": 1,
      "file": "execution-plan.md",
      "status": "DONE",
      "tasks": [
        { "id": "T1", "name": "Extract auth layer",    "status": "DONE", "done_sha": "bcd2345efg6789" },
        { "id": "T2", "name": "Add token validation",  "status": "DONE", "done_sha": "cde3456fgh7890" },
        { "id": "T3", "name": "Write integration tests","status": "DONE", "done_sha": "def4567ghi8901" }
      ]
    }
  ]
}
```

SHA ranges computed:
- T1: `abc1234def5678..bcd2345efg6789`
- T2: `bcd2345efg6789..cde3456fgh7890`
- T3: `cde3456fgh7890..def4567ghi8901`

## Reference Files

| Reference | When to Load |
|-----------|--------------|
| `references/subagent-dispatch-template.md` | Before dispatching — exact prompt structure per task |
| `references/spec-compliance-review.md` | Pass absolute path to subagent prompt |
| `references/code-quality-review.md` | Pass absolute path to subagent prompt |
| `references/review-report-template.md` | Pass absolute path to subagent prompt |
