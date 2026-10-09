---
name: create-pr
description: User-triggered Enterprise PR recorder for a completed phase. Creates or reuses the current-branch PR, links the tracked issue, and records PR identity; it never posts review verdicts.
---

# Create PR

Enterprise-owned recorder for opening or reusing a pull request on the **current branch** for a completed development phase. It does not manage branches and does not own phase-verdict reporting.

**Core principle:** This is an explicit user-triggered recorder. It creates or discovers a PR, records its identity, and surfaces non-blocking warnings. Phase summaries and inline verdicts belong to the Enterprise adapter, not this skill or Core.

**v4 boundary:** Package `4.0.0` uses `CONTRACT=3`, `PIPELINE=5`, lifecycle schema `1`, adapter contract `1`, and surface manifest `1`. This skill is part of the additive Enterprise role and requires matching Core. Core is local-first: it does not call `gh`, it does not merge pull requests, and it does not close issues. This recorder may call GitHub only after explicit user invocation and successful Enterprise preflight; it never merges a PR or closes an issue.

**Use this when:** The user requests a phase PR, or explicitly confirms an Enterprise offer, and the target phase is in `REVIEW`.

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
- `<phase_file>` is optional. When omitted, select the unique `log.phases[]` entry with `status == REVIEW`; zero or multiple matches require an explicit phase file.

## Hard Constraints

<HARD-GATE>
1. **No branch management** — never check out, create, switch, or remove a branch. Use the current branch.
2. **Preflight before GitHub** — verify Enterprise mode, compatible Core contract 3, lifecycle schema 1, and registered adapter contract 1 before any GitHub operation.
3. **Traveling state before PR creation** — commit `log.json`, plan docs, and spec docs before `gh pr create`.
4. **Always `--body-file`** — never pass a multiline PR body inline.
5. **Recorder only** — never merge the PR or close the linked issue; `closes #N` is a GitHub link that takes effect only if a human later merges the final PR.
6. **Recorder only** — do not post verdict summaries, inline findings, or tasklist comments from this skill.
</HARD-GATE>

## Preflight

Run these checks before staging files or making a GitHub call.

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

Continue only when preflight succeeds and confirms the compatible Core contract, lifecycle schema, adapter contract, and registration. On failure, stop before GitHub and follow the actionable install/upgrade guidance.

### Step 3: Authentication

```bash
gh auth status
```

If authentication is unavailable, stop with the `gh auth login` corrective action. Do not stage or commit traveling state before preflight and authentication pass.

### Step 4: Resolve paths and linked issue

Read `<plan_dir>/log.json`. Resolve `phase_file` and `phase_key` from the matching log entry; require that the phase status is `REVIEW`.

- `spec_dir` is `docs/pocket/spec/<slug>/`, with `<slug>` matching the plan directory basename.
- `phase_key` is `phase-${phase.order}` from `log.json`.
- Use `log.phases[]` order to determine whether this is the final phase.

Read the linked issue:

```bash
npx -y pocketto-pi meta get <spec_dir> github_issue.number --json --contract 3
```

If no positive issue number exists, stop. Run the approved-spec issue reconciliation through the Enterprise lifecycle adapter before requesting a phase PR.

## Current Branch

```bash
git rev-parse --abbrev-ref HEAD
```

Record the result as `<branch>`. Do not change branches.

## PR Discovery

First check Enterprise metadata:

```bash
npx -y pocketto-pi meta get <spec_dir> phases.<phase_key>.github_pr.number --json --contract 3
```

If it contains a positive number, read its URL and reuse it. Otherwise search for a PR on the current branch:

```bash
gh pr list --head <branch> --json number,url
```

Reuse one exact match and record its identity. If no match exists, continue to explicit creation. If the target is ambiguous or belongs to a different plan/phase, stop for manual resolution.

## Commit Traveling State

Before creating a PR, include the plan and its review evidence:

```bash
git add -f <plan_dir>/log.json <plan_dir> <spec_dir>
git diff --cached --quiet || git commit -m "chore(pocket): traveling state for <phase_key>"
```

If no staged change exists, skip the commit. Push is not performed by this skill.

## Build and Create the PR

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

## Record PR Identity

Only after a successful create or discovery, record the PR under the phase key:

```bash
npx -y pocketto-pi meta set <spec_dir> phases.<phase_key>.github_pr.number <N> --json --contract 3
npx -y pocketto-pi meta set <spec_dir> phases.<phase_key>.github_pr.url "<url>" --json --contract 3
```

## Completion Report

```text
PR_READY: <phase_key>
Branch: <branch>
PR: #<N> <url>
Issue link: <refs|closes> #<issue>
fileWarning: <true|false>
```

If the PR was reused, report `PR_REUSED` instead of `PR_READY`.

## Red Flags

| Thought | Counter |
|---------|---------|
| "I'll create a feature branch first" | **STOP.** This recorder never manages branches. |
| "Skip the traveling-state commit" | **STOP.** Review needs the plan log and artifacts on the PR. |
| "This recorder should post phase verdicts" | **STOP.** The registered Enterprise lifecycle adapter owns phase reporting when a `phase-complete` event is drained. |
| "I'll inline the PR body" | Use `format pr` and `--body-file`. |
| "No issue yet — create the PR anyway" | **STOP.** Reconcile the approved spec issue first. |
