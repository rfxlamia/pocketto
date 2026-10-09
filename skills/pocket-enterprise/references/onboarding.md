# Enterprise Onboarding

This reference owns optional Enterprise setup. Core onboarding remains local-only. Treat a direct user request to enable or set up Enterprise as explicit consent; do not ask for the same consent again. If the user is only asking what Enterprise does, or the request is ambiguous, explain the effects and wait before changing files or accessing external services.

## Consent and prerequisites

Before setup, explain the effects of enabling Enterprise:

- `spec-approved` may create or reconcile one issue for the approved spec.
- `phase-complete` updates the phase summary and reconciles review findings on an existing PR.
- `plan-closed` upserts the final tasklist proof on the linked issue.
- The adapter never creates a PR automatically, merges a PR, or closes an issue. `create-pr`, scaffolding, label creation, and selecting a custom runner are separate choices.
- Enabling the adapter does not itself drain pending events. Remote reconciliation occurs when a lifecycle drain is run.

Then:

1. Confirm that the matching Core v4 role is installed. Enterprise is a delta and is not a standalone workflow.
2. Before any external operation, verify the local prerequisites:

   ```bash
   gh auth status
   git remote get-url origin
   ```

   If authentication is unavailable or no `origin` remote exists, stop with the exact corrective action. Do not partially initialize the integration.

## Configure the Enterprise mode

Read the current mode first:

```bash
npx -y pocketto-pi mode --json --contract 3
```

If Enterprise is already enabled, preserve the existing mode values and do not run `mode init` again. If it is not enabled, inspect the active project memory file and its Pocket Enterprise block first. Select the memory file used by the project (`AGENTS.md` or `CLAUDE.md`) and pass it explicitly; `mode init` otherwise defaults to `AGENTS.md`. Preserve any existing `branch_strategy`, `create_pr`, or `require_approval` choices.

When initialization is needed, show the user the values that will be written and get their choice for any value that is not already configured. `branch_strategy` and `create_pr` are required when Enterprise is true. The example below uses `branch` and `true` only as illustrative values; `create_pr: true` enables the separate recorder and does not create a PR automatically.

```bash
npx -y pocketto-pi mode init <project-root> --enterprise true --branch-strategy <selected-strategy> --create-pr <selected-value> --file <selected-memory-file> --json --contract 3
```

Use `branch` or `main-local` for `<selected-strategy>`, `true` or `false` for `<selected-value>`, and `AGENTS.md` or `CLAUDE.md` for `<selected-memory-file>`. `mode init` validates the configured remote and writes the mode block to the selected project memory file plus `.gitattributes`. Tell the user both files may change. If the user requires an approval gate, pass `--require-approval true`; do not infer it. Do not overwrite an existing mode block with new defaults.

Optional project templates may be created after mode setup:

```bash
npx -y pocketto-pi scaffold github --json --contract 3
```

Existing user files are not overwritten. Create the `pocket-plan` label only when the user requests that project setup step.

## Register and verify the lifecycle adapter

The Enterprise distribution bundles `enterprise/dispatch.js`, which composes the `spec-approved`, `phase-complete`, and `plan-closed` handlers behind the Core adapter protocol. The default registration uses the exact fixed argv `[process.execPath, <absolute enterprise/dispatch.js>, <absolute project-root>]`; Core appends the event-file path and `--json --contract 3`. A registered custom runner receives lifecycle event files on future drains and can perform remote operations, so use one only when the user explicitly selects a runner they trust.

`enterprise/cli.js` is in the pocketto-pi package root, not in the project being registered. The commands below are a checkout of this repository. A project that depends on the npm package replaces `node enterprise/cli.js` with `node node_modules/pocketto-pi/enterprise/cli.js`.

Inspect `<project-root>/.pocket/lifecycle-adapter.json` before installation. `install` atomically replaces this file, including a valid custom registration. If a compatible default registration already exists, keep it and run preflight. If a custom registration exists, preserve it and preflight it; do not replace it without explicit user authorization. If the registration is malformed or incompatible, report the exact finding and proposed repair before replacing it.

Install the bundled runner only when no registration exists or the user explicitly authorizes replacing the existing registration:

```bash
node enterprise/cli.js install <project-root> --json
```

For a compatible custom runner, `--argv` is an explicit override and requires the user's choice. The supplied argv entries are the complete fixed prefix; Core still appends the event file and the exact protocol flags:

```bash
node enterprise/cli.js install <project-root> --argv <event-executable> [--argv <fixed-arg> ...] --json
```

Then run the read-only compatibility preflight:

```bash
node enterprise/cli.js preflight <project-root> --json
```

Proceed only when it reports success with compatible Core, registration, adapter contract, and executable. On any failure, stop before issue, PR, or comment operations; give the actionable install/upgrade guidance and leave local Core state untouched. Preflight is read-only. Do not automatically run a drain as the final onboarding step.

## After onboarding

Pending events remain local until a lifecycle drain is explicitly run by the user or by an already-authorized automation. Event handlers must apply the ownership, marker, and replay rules in `issue-reconciliation.md` and `phase-reconciliation.md`. Core approvals and phase transitions remain locally successful if Enterprise is disabled or unavailable.
