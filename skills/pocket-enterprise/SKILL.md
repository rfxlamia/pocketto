---
name: pocket-enterprise
description: Adds the registered Enterprise lifecycle adapter to a compatible Core installation. Use only when the user explicitly enables the Enterprise layer.
---

# Pocket Enterprise

Additive adapter surface for teams that explicitly choose remote lifecycle synchronization. Install it beside its matching Core role; this skill does not bundle or copy Core skills.

**Core principle:** Core commits local state and neutral lifecycle events first. This adapter validates compatibility before any external operation, reconciles events deterministically, and leaves ambiguous ownership for a human.

## Activation and compatibility

1. Require the user's explicit choice to enable this layer. Do not infer consent from a project remote or existing credentials.
2. Run the Enterprise preflight from the project root:

   ```bash
   node enterprise/cli.js preflight <project-root> --json
   ```

   Continue only when the result is successful and reports a compatible Core installation and adapter registration. Missing Core, an unsupported contract, malformed registration, or a missing executable is fail-closed: make no external call and give the install/upgrade action from the error.
3. Follow `references/onboarding.md` for the explicit setup and registration steps.
4. Process pending events with the Core lifecycle drain command only after preflight succeeds. Core remains locally useful if this surface is absent or temporarily unavailable; pending event identity is retained for replay.

## Lifecycle routing

Core emits only these neutral event names:

| Event | Enterprise-owned action |
|-------|-------------------------|
| `spec-approved` | Reconcile the approved spec with its owned issue; see `references/issue-reconciliation.md`. |
| `phase-complete` | Reconcile the existing phase PR and its proof; see `references/phase-reconciliation.md` and `skills/pocket-development/references/enterprise-reporting.md`. |
| `plan-closed` | Reconcile the final tasklist and closeout proof; see `references/phase-reconciliation.md`. |

The event journal and protocol boundary are defined in `references/lifecycle-contract.md`. Events carry artifact references and opaque proof only; remote IDs and credentials remain outside Core lifecycle records.

## Ownership rules

- Issue, PR, comment, and closeout synchronization belongs to this Enterprise surface.
- `create-pr` remains an explicit, user-triggered recorder: it may create or discover a PR and record its identity, but it does not post review verdicts.
- Never copy or modify a Core skill to add remote behavior. Keep Core source canonical and install this role only as the declared delta requiring matching Core.
- Do not guess when a remote issue, PR, marker, or ownership check is ambiguous. Stop with an actionable resolution request instead of mutating an uncertain target.
