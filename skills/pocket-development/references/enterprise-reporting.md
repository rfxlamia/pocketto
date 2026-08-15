[CRITICAL: This file is the single source of truth for posting phase verdicts to GitHub. `pocket-development`'s End-of-Execution Handoff SHALL cite it and SHALL NOT restate its steps. Non-enterprise execution SHALL NOT be affected by anything in this file.]

# Enterprise Reporting (Phase-Completion)

Relocated, in substance unchanged, from `pocket-review`'s former Enterprise mode section (E1–E6). Design decision (Option A): reporting moves to phase-completion inside `pocket-development`; `create-pr` (`skills/create-pr/SKILL.md`) stays a recorder — it creates or discovers a PR and records it in `.pocket-meta.json`, and it has **no** verdict-posting logic. Nothing in this file may be delegated to `create-pr`, and nothing in this file may modify `create-pr`.

## Contents
- [Fail-closed contract](#fail-closed-contract)
- [When this file runs](#when-this-file-runs)
- [E1. Discover the phase PR, offer creation if missing](#e1-discover-the-phase-pr-offer-creation-if-missing)
- [E2. Resolve owner/repo](#e2-resolve-ownerrepo)
- [E3. Format the canonical summary body](#e3-format-the-canonical-summary-body)
- [E4. Upsert the canonical summary comment](#e4-upsert-the-canonical-summary-comment)
- [E5. Reconcile and post inline findings](#e5-reconcile-and-post-inline-findings)
- [E6. Enterprise section complete](#e6-enterprise-section-complete)

## Fail-closed contract

Run the preflight before anything else in this file:

```bash
npx -y pocketto-pi mode --json --contract 2
```

Parse the JSON envelope. If `ok` is `false`, the command is missing, or `data.enterprise` is not strictly `true` → **skip this entire file's behavior** and return to the caller (the phase-completion flow in `pocket-development/SKILL.md`) as if this file did not exist. This is fail-closed: any error or malformed output means non-enterprise. Zero `gh` calls are made, and the output stays byte-identical to the non-enterprise path.

No step below is reachable without this preflight passing. If a later step in this file would require a `gh` call and the preflight has not passed, that is a bug in the citing skill, not a case this file handles.

## When this file runs

This file runs at **phase-completion** in `pocket-development`, after every task in the phase is marked DONE and the PHASE_COMPLETE handoff message has been emitted. By the time this file runs, every task in the phase already has a verdict artifact at `<plan_dir>/reviews/<task_id>-review.json`, written by the in-loop audit (`references/two-stage-review.md`) as each task passed — not by a separate post-phase batch reviewer. A BLOCKED task halts the phase before PHASE_COMPLETE is ever emitted, so in practice every artifact seen here carries `overall: REVIEW_PASS`; the `REVIEW_FAIL` / `REVIEW_BLOCKED` handling below is retained defensively (a task's artifact could in principle be re-read after a resumed or partially-corrected session) and MUST NOT be dropped.

## E1. Discover the phase PR, offer creation if missing

Derive the meta location the same way `create-pr` and `pocket-closing` do — `.pocket-meta.json` lives under the **spec** directory, not the plan directory:

- `spec_dir` = `docs/pocket/spec/<slug>/` where `<slug>` matches the plan directory basename (e.g. `2026-06-09-github-trace-loop`).
- `phase_key` = `phase-N` from the phase file name (`execution-plan-phase-N.md` → `phase-N`); flat single-file plan → `phase-1`.

Read the PR number from the phase-nested path `create-pr` writes:

```bash
npx -y pocketto-pi meta get <spec_dir> phases.<phase_key>.github_pr.number --json --contract 2
```

- `ok` is `false` (e.g. `error.code == "NOT_FOUND"` — `spec_dir` doesn't exist) → treat as no-meta and fall back to branch-based discovery, same as the null-value case below.
- `data.value` is a positive integer → use it as the PR number. Skip straight to [E2](#e2-resolve-ownerrepo).
- `data.value` is null (or the envelope was `ok:false`) → fall back to branch-based discovery:
  ```bash
  branch=$(git rev-parse --abbrev-ref HEAD)
  pr_number=$(gh pr list --head "$branch" --json number --jq '.[0].number // empty')
  ```

### No PR found: offer, confirm, then post

If `pr_number` is still empty after both attempts, this is the ordering rule the phase-completion relocation introduces (it replaces the old dead-end STOP that lived in `pocket-review`):

1. Offer `create-pr` and await **exactly one** confirmation — the same offer-then-await pattern used for the `pocket-review → pocket-closing` chain, never a silent auto-create:
   ```
   Enterprise mode is active but no PR exists for branch '<branch>'.
   Run /pocketto:create-pr <plan_dir> [<phase_file>] to open one and post verdicts?
   ```
2. **On confirmation:** invoke `/pocketto:create-pr <plan_dir> [<phase_file>]`. `create-pr` is a recorder only — it commits traveling state, creates the PR, and records `phases.<phase_key>.github_pr.number` / `.url` in `.pocket-meta.json` via its own `meta set` calls (`skills/create-pr/SKILL.md`). It does **not** post verdicts and this file does not ask it to. After it returns, re-read `phases.<phase_key>.github_pr.number` (or use the PR number from its `PR_READY`/`PR_REUSED` completion report) as `pr_number`, then continue to [E2](#e2-resolve-ownerrepo). Verdicts are posted by **this file**, immediately following PR creation, in the same phase-completion pass.
3. **On decline** (e.g. "not yet"): **STOP** this entire enterprise reporting section for this run. Create **no** comments or threads — no orphan comments, ever. Verdicts remain on disk, unposted, in the per-task artifacts already written under `<plan_dir>/reviews/`. `create-pr` is not modified to post them — the recorder/reporter split (Option A) stays intact. Proceed with the rest of phase-completion as if this file had not run.
4. **Idempotent re-run:** a later phase-completion pass — this same phase re-entered after the user eventually runs `create-pr`, or a fresh session — that now finds a PR will post the same verdicts without creating a duplicate marker comment or duplicate inline threads, because E4's marker upsert and E5's fingerprint reconcile are both keyed by content, not by run.

If `pr_number` is empty and the user is not available to confirm (non-interactive context), treat exactly as decline: STOP, no comments, no orphan state.

## E2. Resolve owner/repo

```bash
gh repo view --json owner,name -q '.owner.login + "/" + .name'
```

Store as `<owner>/<repo>` for all subsequent `gh` calls.

## E3. Format the canonical summary body

Build the input JSON for `format comment` from the phase's per-task verdict artifacts (`<plan_dir>/reviews/<task_id>-review.json`, one per task in the phase — see [When this file runs](#when-this-file-runs)):

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
- Map each artifact's `overall` field: `REVIEW_PASS` → `"PASS"`, `REVIEW_FAIL` → `"FAIL"`, `REVIEW_BLOCKED` → `"BLOCKED"`, skipped tasks → `"SKIP"`.
- `prLinked` is always `true` (we have a PR by this point).

Write to a temp file, then:

```bash
npx -y pocketto-pi format comment --input <tmp-verdicts.json> --json --contract 2
```

Read the body from `data.bodyFile`. The body starts with the marker `<!-- pocket-phase-<N>-summary -->` — this marker is the canonical identity for upsert.

## E4. Upsert the canonical summary comment

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

## E5. Reconcile and post inline findings

The CLI computes the set-diff (resolve/post/keep). The skill executes the resulting actions. Fingerprints must match the CLI's `identity.fingerprint()` exactly.

### E5a. Read prior fingerprints

```bash
npx -y pocketto-pi meta get <spec_dir> phases.<phase_key>.review.fingerprints --json --contract 2
```

If `data.value` is null or absent, **or** the envelope is `ok:false` (e.g. `error.code == "NOT_FOUND"` — `spec_dir` doesn't exist), before defaulting to `[]`, check the pre-2.5 location once as a migration fallback:

```bash
npx -y pocketto-pi meta get <plan_dir> review.fingerprints --json --contract 2
```

If that returns a non-null `data.value`, use it as the prior fingerprints (a plan last reviewed under 2.4.x has its fingerprints here). Otherwise treat as `[]` (no prior findings). Do not let a `NOT_FOUND` on either read abort E5 — findings still get posted; only fingerprint persistence (E5f / `meta set`, which always writes the new `<spec_dir>` location) is affected, and it should fail soft (log, don't block) for the same reason.

### E5b. Compute new fingerprints

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

### E5c. Run reconcile

```bash
npx -y pocketto-pi reconcile --prior <prior-fingerprints.json> --new <new-findings.json> --json --contract 2
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

### E5d. Resolve threads for `data.resolve`

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

### E5e. Post inline findings for `data.post`

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

### E5f. Persist new fingerprints

Build the updated fingerprints array:

- `data.keep` entries → include with existing `fingerprint` + `thread` fields.
- `data.post` entries → include with `fingerprint` + the newly captured `thread` node ID.
- `data.resolve` entries → already resolved, do **not** include.

Write to a temp file, then persist:

```bash
npx -y pocketto-pi meta set <spec_dir> phases.<phase_key>.review.fingerprints "$(cat <updated-fingerprints.json>)" --json --contract 2
```

If this returns `ok:false` (e.g. `error.code == "NOT_FOUND"` — `spec_dir` doesn't exist), do not treat it as a phase failure: the inline findings from E5e were already posted successfully. Log the persistence failure and continue — the only consequence is that a future re-review won't see these as prior findings and may repost them.

## E6. Enterprise section complete

After all enterprise steps complete, return control to the citing skill's phase-completion flow. This file does **not** alter phase-completion's own output state — it only posts to GitHub and reconciles threads.

**Cross-OS note:** Fingerprints are sha256 hex strings (16 chars), never raw bytes. The `printf | shasum` pipeline produces identical output on macOS and Linux.

**Fail-closed recap:** everything from [E1](#e1-discover-the-phase-pr-offer-creation-if-missing) through [E5f](#e5f-persist-new-fingerprints) only runs after the [Fail-closed contract](#fail-closed-contract) preflight passed, and E1's no-PR branch only proceeds past the offer on an explicit confirmation. Any other path — preflight failure, decline, or a non-interactive context with no PR — makes zero `gh` calls and leaves zero orphan comments.
