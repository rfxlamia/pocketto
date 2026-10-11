---
name: create-pr
description: User-triggered Enterprise PR recorder for a completed phase. Stacked plans publish their phase branch through the publish-phase repair command; other plans create or reuse the current-branch PR. Links the tracked issue and records PR identity. It never posts review verdicts, never rebases, and never force-pushes.
---

# Create PR

Enterprise-owned recorder for opening or reusing a pull request for a completed development phase. It has two paths selected from `log.json`:

- **Stacked plans** (`header.phase_branches.mode == "stacked"`): a manual repair recorder that runs `publish-phase` against the recorded phase branch. The phase branch is read by ref and is never checked out.
- **Other plans** (`none` or no `phase_branches` header): creates or reuses the PR for the current branch.

It does not own phase-verdict reporting.

**Core principle:** This is an explicit user-triggered recorder. It creates or discovers a PR, records its identity, and surfaces preflight warnings verbatim. Phase summaries and inline verdicts belong to the Enterprise adapter, not this skill or Core.

**v4 boundary:** Package `4.1.0` uses `CONTRACT=3`, `PIPELINE=5`, lifecycle schema `2`, adapter contract `2`, and surface manifest `1`. This skill is part of the additive Enterprise role and requires matching Core. Core is local-first: it does not call `gh`, it does not merge pull requests, and it does not close issues. This recorder may call GitHub only after explicit user invocation and successful Enterprise preflight; it never merges a PR or closes an issue.

**Use this when:** The user requests a phase PR, or explicitly confirms an Enterprise offer. For a non-stacked plan the target phase is in `REVIEW`. For a stacked plan the target phase is `DONE` and its `phase-closed` event exists (created by `log handoff`, see pocket-closing's Stacked Handoff).

**Do NOT use when:** Enterprise is disabled, a compatible Core/adapter preflight fails, or there is no linked issue.

---

## Invocation

```text
/pocketto:create-pr <plan_dir> [<phase_file>]
```

Examples:

```text
/pocketto:create-pr docs/pocket/plans/2026-09-19-feature/
/pocketto:create-pr docs/pocket/plans/2026-09-19-feature/ execution-plan/phase-1.md
```

- `<plan_dir>` contains `log.json` and the execution-plan files.
- `<phase_file>` is optional. When omitted, select the unique `log.phases[]` entry that is eligible for the plan's path: `status == REVIEW` for non-stacked plans, or `status == DONE` for stacked plans. Zero or multiple matches require an explicit phase file.

## Hard Constraints

<HARD-GATE>
1. **No branch management** — on the non-stacked path never check out, create, switch, or remove a branch; use the current branch. The stacked path reads the recorded phase branch by ref and never checks it out.
2. **Preflight before GitHub** — verify Enterprise mode, compatible Core contract 3, lifecycle schema 2, and registered adapter contract 2 before any GitHub operation.
3. **Traveling state before PR creation (non-stacked only)** — commit `log.json`, plan docs, and spec docs before `gh pr create`. On the stacked path `log handoff` has already committed the phase's traveling state to its phase branch; this recorder does not stage or commit.
4. **Always `--body-file`** — never pass a multiline PR body inline (non-stacked path; the stacked body is built by `publish-phase`).
5. **Recorder only** — never merge the PR or close the linked issue; `closes #N` is a GitHub link that takes effect only if a human later merges the final PR.
6. **Recorder only** — do not post verdict summaries, inline findings, or tasklist comments from this skill.
7. **Never rebase, never force-push, never retarget** — do not run any rebase, do not perform any forced push of any kind, and do not change a PR base. Stacked pushes are fast-forward only and are performed by `publish-phase` itself. If a push, divergence, or base conflict blocks the run, stop and report it for manual resolution.
</HARD-GATE>

## Preflight

Run these checks before staging files or making a GitHub call. They apply to both paths.

### Step 1: Enterprise mode

```bash
npx -y pocketto-pi mode --json --contract 3
```

Stop unless the envelope succeeds and `data.enterprise` is strictly `true`.

### Step 2: Core and adapter compatibility

`enterprise/cli.js` is in the pocketto-pi package root, not in the project being checked. A checkout of this repository runs:

```bash
node enterprise/cli.js preflight <project-root> --json
```

A project that depends on the npm package runs `node node_modules/pocketto-pi/enterprise/cli.js preflight <project-root> --json`.

Continue only when preflight succeeds and confirms the compatible Core contract, lifecycle schema 2, adapter contract 2, and registration. On failure, stop before GitHub and follow the actionable install/upgrade guidance. A registration written under adapter contract 1 fails preflight with `ENTERPRISE_ADAPTER_CONTRACT_MISMATCH`; the user must reinstall the adapter (see `skills/pocket-enterprise/references/onboarding.md`).

Preflight returns `data.warnings`, an array of ignored-artifact warnings. Keep this array for the report (see Completion Report).

### Step 3: Authentication

```bash
gh auth status
```

If authentication is unavailable, stop with the `gh auth login` corrective action. Do not stage or commit traveling state before preflight and authentication pass.

### Step 4: Resolve paths, path, and linked issue

Read `<plan_dir>/log.json`. Determine the path from `header.phase_branches.mode`:

- `"stacked"` → Stacked Path.
- anything else, including an absent `phase_branches` header → Non-Stacked Path.

Resolve `phase_file` and `phase_key` from the matching `log.phases[]` entry, requiring the status for that path (see Invocation).

- `spec_dir` is `docs/pocket/spec/<slug>/`, with `<slug>` matching the plan directory basename.
- `phase_key` is `phase-${phase.order}` from `log.json`.
- Use `log.phases[]` order to determine whether this is the final phase.

Read the linked issue:

```bash
npx -y pocketto-pi meta get <spec_dir> github_issue.number --json --contract 3
```

If no positive issue number exists, stop. Run the approved-spec issue reconciliation through the Enterprise lifecycle adapter before requesting a phase PR.

---

## Stacked Path

Use this path when `log.json` records `header.phase_branches.mode == "stacked"`. The phase must be `DONE`, and `log handoff` must already have committed its `phase-closed` event. `publish-phase` does the remote work and its own identity recording, so this path does not build a PR body, call `gh pr create`, or write `github_pr` metadata itself.

### Run publish-phase

From a checkout of this repository:

```bash
node enterprise/cli.js publish-phase <project-root> <spec_dir> <phase_key> --json
```

For a project that depends on the npm package, replace `node enterprise/cli.js` with `node node_modules/pocketto-pi/enterprise/cli.js`. Do not add `--contract`; this command does not accept it.

`publish-phase` reruns preflight itself. It pushes the phase branch only as a fast-forward, and only when consent exists. Consent is either the durable `push_consent` recorded by `install --push-consent phase-branches`, or an approval bound to the exact commit. It creates the PR against its explicit base (phase 1: the recorded root base; phase N: the phase N-1 branch) or reuses the one already recorded, and it records PR identity in Enterprise metadata. It writes no lifecycle events and changes no branch.

Its envelope is `{ ok, command: "enterprise-publish-phase", data: { phase_key, pr_number, pr_url, created, notices }, error }`.

- `created: true` → report `PR_READY`. `created: false` → report `PR_REUSED`.
- Relay each `notices[].message` as written (`PR_CREATED` or `PR_REUSED`).

### Stacked error handling

| Code | Action |
|------|--------|
| `PUSH_CONSENT_REQUIRED` | Stop and show the exact `consent-push … --sha <40-hex>` command from the error message. Run it only after the user approves that commit SHA, then rerun `publish-phase`. Never record approval on the user's behalf. |
| `PHASE_CLOSED_EVENT_REQUIRED` | No `phase-closed` event exists for the phase. Run `log handoff` through pocket-closing's Stacked Handoff first, then rerun. |
| `PHASE_CLOSED_NOT_STACKED` | The plan is not stacked. Use the Non-Stacked Path. |
| `PR_BLOCKED` | Manual resolution. The message names the reason: base retargeted on GitHub, duplicate open PR for the same head and base, a foreign PR for the head, an unrecorded root base, or an unpublished parent branch. Pocket does not retarget, close duplicates, or rebase; the user fixes it on GitHub, then reruns. |
| `PUSH_FAILED`, `REMOTE_UNAVAILABLE`, `GIT_UNAVAILABLE`, `GH_MALFORMED_OUTPUT` | Retryable. Report it and rerun after the condition clears. Do not work around it with a rebase or a forced push. |
| `ENTERPRISE_*` or preflight codes | Follow the install/upgrade guidance in the message. |
| Any other code | Report the code and message verbatim and stop. |

A failed run leaves no lifecycle state changed. Report the code; do not retry in a loop.

---

## Non-Stacked Path

Use this path when the plan does not record stacked phase branches. Behavior is unchanged from earlier releases.

### Current Branch

```bash
git rev-parse --abbrev-ref HEAD
```

Record the result as `<branch>`. Do not change branches.

### PR Discovery

First check Enterprise metadata:

```bash
npx -y pocketto-pi meta get <spec_dir> phases.<phase_key>.github_pr.number --json --contract 3
```

If it contains a positive number, read its URL and reuse it. Otherwise search for a PR on the current branch:

```bash
gh pr list --head <branch> --json number,url
```

Reuse one exact match and record its identity. If no match exists, continue to explicit creation. If the target is ambiguous or belongs to a different plan/phase, stop for manual resolution.

### Commit Traveling State

Before creating a PR, include the plan and its review evidence:

```bash
git add -f <plan_dir>/log.json <plan_dir> <spec_dir>
git diff --cached --quiet || git commit -m "chore(pocket): traveling state for <phase_key>"
```

If no staged change exists, skip the commit. Push is not performed by this skill.

### Build and Create the PR

Write a temporary structured input file using Node `fs` (not a shell heredoc) with:

| Field | Source |
|-------|--------|
| `issue` | Linked issue number from metadata |
| `finalPhase` | Whether this is the last phase in `log.json` |
| `fileCount` | Deduplicated paths changed in this phase |
| `what` | Phase file and task summaries |
| `why` | Approved spec or plan context |
| `howToTest` | Acceptance criteria and task verification commands |

Format the body:

```bash
npx -y pocketto-pi format pr --input <pr-input.json> --json --contract 3
```

Read `data.bodyFile` and `data.fileWarning`. If `fileWarning` is true, tell the user but continue; it is not a creation gate.

```bash
gh pr create --head <branch> --title "<phase title>" --body-file <data.bodyFile>
```

Use `closes #N` for the final phase and `refs #N` for an earlier phase. The reference does not close the issue when the PR is created; a human-controlled merge is required. Parse the resulting PR number and URL.

### Record PR Identity

Only after a successful create or discovery, record the PR under the phase key:

```bash
npx -y pocketto-pi meta set <spec_dir> phases.<phase_key>.github_pr.number <N> --json --contract 3
npx -y pocketto-pi meta set <spec_dir> phases.<phase_key>.github_pr.url "<url>" --json --contract 3
```

---

## Completion Report

**Warnings:** Report the preflight `data.warnings` entries verbatim under `Warnings:`, in the same text and order preflight produced. Do not summarize, reword, or drop them. Write `none` only when the array is empty.

Stacked path:

```text
PR_READY: <phase_key>        (or PR_REUSED when created is false)
Path: stacked (publish-phase)
PR: #<pr_number> <pr_url>
Warnings: <verbatim preflight warnings, or none>
```

Non-stacked path:

```text
PR_READY: <phase_key>        (or PR_REUSED when the PR was reused)
Path: non-stacked
Branch: <branch>
PR: #<N> <url>
Issue link: <refs|closes> #<issue>
fileWarning: <true|false>
Warnings: <verbatim preflight warnings, or none>
```

## Red Flags

| Thought | Counter |
|---------|---------|
| "I'll create a feature branch first" | **STOP.** This recorder never manages branches. |
| "Skip the traveling-state commit" | **STOP.** Review needs the plan log and artifacts on the PR. This applies to the non-stacked path; on the stacked path `log handoff` already committed them. |
| "This recorder should post phase verdicts" | **STOP.** The registered Enterprise lifecycle adapter owns phase reporting when a `phase-complete` or `phase-closed` event is drained. |
| "The push was rejected, so force it" | **STOP.** Pocket never force-pushes. Divergence is blocked for manual resolution. |
| "Rebase the phase branch to clear the conflict" | **STOP.** This recorder never rebases. |
| "Point the PR at the root to fix the base" | **STOP.** Pocket does not retarget. Fix the base on GitHub, then rerun. |
| "Run consent-push myself so it goes through" | **STOP.** Show the user the exact command and wait for their approval of that SHA. |
| "I'll inline the PR body" | Use `format pr` and `--body-file` (non-stacked path). |
| "No issue yet — create the PR anyway" | **STOP.** Reconcile the approved spec issue first. |
