# Enterprise Onboarding

This reference owns optional Enterprise setup. Core onboarding remains local-only. Treat a direct user request to enable or set up Enterprise as explicit consent; do not ask for the same consent again. If the user is only asking what Enterprise does, or the request is ambiguous, explain the effects and wait before changing files or accessing external services.

## Consent and prerequisites

Before setup, explain the effects of enabling Enterprise:

- `spec-approved` may create or reconcile one issue for the approved spec.
- `phase-complete` updates the phase summary and reconciles review findings on an existing PR. For stacked plans it is deferred to `phase-closed`.
- `phase-closed` publishes a stacked phase PR and, only with consent, pushes that phase branch as a fast-forward. It never forces.
- `plan-closed` upserts the final tasklist proof on the linked issue.
- The adapter never merges a PR or closes an issue. `create-pr`, scaffolding, label creation, and selecting a custom runner are separate choices.
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

The Enterprise distribution bundles `enterprise/dispatch.js`, which composes the `spec-approved`, `phase-complete`, `phase-closed`, and `plan-closed` handlers behind the Core adapter protocol. The default registration stores the reserved descriptor `@pocketto-runtime-argv-v1`, followed by runtime tokens `@pocketto-node` and `@pocketto-install-root/enterprise/dispatch.js`; it stores no machine-specific paths. Core expands runtime tokens only when the reserved descriptor is the first `argv` entry. Custom `--argv` values without that reserved descriptor remain verbatim. The matching Core release expands the tokens using its active Node executable and installation root, then launches the dispatcher with the project root as its working directory. Core validates the resolved Enterprise package/surface before dispatch and launches that same resolved entrypoint. The Enterprise role is an overlay on its matching Core installation; both must share the same installation root.

`<project-root>/.pocket/lifecycle-adapter.json` is shared project configuration and may be committed when it contains the default portable registration. Custom `--argv` values are stored verbatim and may be machine-specific, so commit them only when the selected runner and its arguments are portable. Run lifecycle drains through the matching installed `pocketto-pi` Core CLI (for example, `npx -y pocketto-pi lifecycle drain ...`). Enterprise preflight checks explicit executable paths; runtime token expansion and package compatibility verification are performed by Core during lifecycle dispatch.

`enterprise/cli.js` is in the pocketto-pi package root, not in the project being registered. The commands below are a checkout of this repository. A project that depends on the npm package replaces `node enterprise/cli.js` with `node node_modules/pocketto-pi/enterprise/cli.js`.

### Phase branches and push consent

Choose these install options before registration. Ask the user for each choice; do not assume a value.

| Option | Values | Effect |
|--------|--------|--------|
| `--phase-branches` | `stacked` (default), `none` | `stacked` publishes each phase as a PR against its explicit base: phase 1 against the recorded root base, phase N against the phase N-1 branch. Under `branch_strategy: main-local` a requested `stacked` is overridden to `none`, and the install reports a warning. |
| `--push-consent` | `phase-branches` | Durable consent for non-force pushes of Pocket phase branches only (`pocket/<plan>/phase-<N>`). Omit it to approve each pushed commit separately with `consent-push --sha`. |

What `--push-consent phase-branches` does and does not allow:

- It allows fast-forward pushes of Pocket phase branches, so `publish-phase` and `phase-closed` delivery can publish a phase without a per-commit approval.
- It never allows a forced push, a rebase, or a PR base retarget. Divergence from the remote is blocked for manual resolution.
- It does not cover any other branch, including `main`, the root base, or a user's own branches.

Install examples:

```bash
node enterprise/cli.js install <project-root> --phase-branches stacked --json
node enterprise/cli.js install <project-root> --phase-branches stacked --push-consent phase-branches --json
node enterprise/cli.js install <project-root> --phase-branches none --json
```

### Reinstall after upgrading

After upgrading to the runtime-token release, rerun `enterprise install` to replace any committed registration that still contains absolute Node, dispatcher, or project-root paths. The new registration requires the matching Core release to expand its runtime tokens. This migration is required even when the adapter contract has not changed. A reinstall is also required after upgrading to an Enterprise release that declares adapter contract 2. A registration written under adapter contract 1 is incompatible: preflight reports `ENTERPRISE_ADAPTER_CONTRACT_MISMATCH`, and the lifecycle adapter fails closed with no remote call. A registration is compatible only when it declares adapter contract 2 and matches the installed Core.

Inspect `<project-root>/.pocket/lifecycle-adapter.json` before reinstalling. `install` atomically replaces this file. Then decide by its contents:

- A bundled default registration (default argv) is replaced by reinstalling with the options above. This is the normal upgrade step.
- A custom registration (non-default `argv`) is replaced only after the user explicitly authorizes replacing it. Reinstall with the same `--argv` entries so the fixed prefix is preserved; for a custom runner, do not change the runner without the user's choice.
- A malformed registration is reported with the exact finding and the proposed repair before it is replaced.

Install the bundled runner only when no registration exists or when the existing registration is a bundled default registration:

```bash
node enterprise/cli.js install <project-root> --json
```

For any custom registration, whether compatible or incompatible, never run bare `install` over it, because that writes the bundled default runner and drops the custom one. An authorized replacement of a custom registration is done with `install` plus the same `--argv` entries, so the fixed prefix and the custom runner are preserved, as the custom-registration bullet above describes.

For a compatible custom runner, `--argv` is an explicit override and requires the user's choice. The supplied argv entries are the complete fixed prefix; Core still appends the event file and the exact protocol flags:

```bash
node enterprise/cli.js install <project-root> --argv <event-executable> [--argv <fixed-arg> ...] --json
```

Then run the read-only compatibility preflight:

```bash
node enterprise/cli.js preflight <project-root> --json
```

Proceed only when it reports success with compatible Core, registration, adapter contract 2, and executable. Preflight also returns `data.warnings`, which lists ignored-artifact warnings to surface to the user. On any failure, stop before issue, PR, or comment operations; give the actionable install/upgrade guidance and leave local Core state untouched. Preflight is read-only. Do not automatically run a drain as the final onboarding step.

## After onboarding

Pending events remain local until a lifecycle drain is explicitly run by the user or by an already-authorized automation. Event handlers must apply the ownership, marker, and replay rules in `issue-reconciliation.md` and `phase-reconciliation.md`. Core approvals and phase transitions remain locally successful if Enterprise is disabled or unavailable.
