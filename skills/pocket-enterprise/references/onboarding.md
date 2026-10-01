# Enterprise Onboarding

This reference owns optional Enterprise setup. Core onboarding remains local-only. Never enable this layer or access an external service without the user's explicit choice.

## Consent and prerequisites

1. Ask whether the user wants the Enterprise adapter enabled. If the answer is no, stop; do not inspect remote credentials, configure mode, or write integration files.
2. Confirm that the matching Core v4 role is installed. Enterprise is a delta and is not a standalone workflow.
3. Before any external operation, verify the local prerequisites:

   ```bash
   gh auth status
   git remote get-url origin
   ```

   If authentication is unavailable or no `origin` remote exists, stop with the exact corrective action. Do not partially initialize the integration.

## Enable the Enterprise mode

Read the current mode first:

```bash
npx -y pocketto-pi mode --json --contract 2
```

If it is not already enabled, initialize it only after explicit consent:

```bash
npx -y pocketto-pi mode init --enterprise true --branch-strategy branch --create-pr true --json --contract 2
```

`mode init` validates the configured remote and writes the mode block to the selected project memory file plus `.gitattributes`. If the user requires an approval gate, request that choice and pass `--require-approval true`; do not infer it.

Optional project templates may be created after mode setup:

```bash
npx -y pocketto-pi scaffold github --json --contract 2
```

Existing user files are not overwritten. Create the `pocket-plan` label only when the user requests that project setup step.

## Register and verify the lifecycle adapter

The Enterprise distribution bundles `enterprise/dispatch.js`, which composes the `spec-approved`, `phase-complete`, and `plan-closed` handlers behind the Core adapter protocol. Install registers it by default with the exact fixed argv `[process.execPath, <absolute enterprise/dispatch.js>, <absolute project-root>]`; Core appends the event-file path and `--json --contract 3`.

```bash
node enterprise/cli.js install <project-root> --json
```

For a compatible custom runner, `--argv` remains an explicit override. The supplied argv entries are the complete fixed prefix; Core still appends the event file and the exact protocol flags:

```bash
node enterprise/cli.js install <project-root> --argv <event-executable> [--argv <fixed-arg> ...] --json
```

Then run the read-only compatibility preflight:

```bash
node enterprise/cli.js preflight <project-root> --json
```

Proceed only when it reports success with compatible Core, registration, adapter contract, and executable. On any failure, stop before issue, PR, or comment operations; give the actionable install/upgrade guidance and leave local Core state untouched.

## After onboarding

The user may run the lifecycle drain to process already-pending events. Event handlers must still apply the ownership, marker, and replay rules in `issue-reconciliation.md` and `phase-reconciliation.md`. Core approvals and phase transitions remain locally successful if Enterprise is disabled or unavailable.
