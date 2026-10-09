# Enterprise Lifecycle Contract

This reference defines the Enterprise consumer of Core's neutral lifecycle journal. Package `4.1.0` ships a local-first Core and a separately installed, optional Enterprise adapter. Core commits locally and does not call `gh`. Core does not own GitHub policy, IDs, credentials, or reconciliation; those remain Enterprise-owned.

## Independent release versions

| Boundary | Version |
|----------|---------|
| Package distribution | `4.1.0` |
| CLI JSON contract | `CONTRACT=3` |
| Execution pipeline | `PIPELINE=5` |
| Lifecycle document schema | `LIFECYCLE_SCHEMA=1` |
| Registered adapter protocol | `ADAPTER_CONTRACT=1` |
| Release surface manifest | `SURFACE_MANIFEST=1` |

The version numbers are independent. The manifest schema is `1` and declares exactly `pi/core`, `pi/enterprise`, `claude/core`, and `claude/enterprise`. Each Enterprise role is an additive delta that requires its matching Core role. Core alone is supported and remains local-first.

## Lifecycle document and event boundary

`<spec_dir>/lifecycle.json` is authoritative for lifecycle state, the event journal, and delivery state. `log.json` remains the detailed task-execution projection. Core replaces the lifecycle document atomically; a successful transition commits state and its event together before updating the projection.

The lifecycle document root uses `schema: 1`. Its plan state includes the normalized `plan_id`, required `spec_dir`, optional `plan_dir` (null for `spec-approved`), state snapshot, and revision. Events are allowlisted to `spec-approved`, `phase-complete`, and `plan-closed`; each has a deterministic ID `<plan_id>:<type>:r<revision>`, increasing revision, artifact references, canonical payload hash, opaque proof references, and delivery state. Core does not put GitHub IDs, credentials, Enterprise policy, or remote commands in lifecycle records.

Artifact references contain only `{ root, kind, path, sha256, revision }`, where root is `spec` or `plan`. Paths are relative to the selected root. The Core commit boundary rejects absolute or escaping paths, missing roots, invalid event/root combinations, and hash mismatches before creating an event. Contents are not embedded. A valid artifact that later disappears or changes is terminal `STALE_ARTIFACT`; temporary read failures may be retried.

Event timing is fixed:

- `spec-approved` is emitted at the approved-spec handoff before planning and may reference only `spec` artifacts.
- `phase-complete` is emitted when a phase reaches `REVIEW` after a terminal phase-level pass; it requires a non-null `plan_dir` and may reference plan evidence.
- `plan-closed` is emitted atomically with the successful local transition that closes the plan.

An identical transition is an idempotent no-op using the original event ID. Reusing an event ID with a different canonical payload is an integrity conflict. The event journal is append-ordered and limited to 64 KiB per serialized event.

## Core lifecycle commands

These commands use the v4 JSON envelope and `--contract 3`:

```bash
pocketto-pi lifecycle transition <spec_dir> <event-type> --artifact <root>:<kind>:<relative-path>:<sha256> [--artifact ...] --json --contract 3
pocketto-pi lifecycle drain <spec_dir> --json --contract 3
pocketto-pi lifecycle repair <spec_dir> --json --contract 3
pocketto-pi lifecycle migrate <spec_dir> --from v3 --json --contract 3
```

`transition` validates current state and artifact references, then atomically commits local state and one event. A missing or unavailable adapter cannot undo the local success. `drain` processes pending, retryable, and reconciling events in ascending revision, serially per plan; it does not create events. A revision gap remains pending with an actionable missing-predecessor diagnostic, and a stale lower revision never regresses remote state.

`repair` reconciles lifecycle-owned projection fields only when task-projection state remains losslessly available from an existing structurally valid `log.json` or a verified trusted backup. It preserves task statuses, `done_sha`, corrections, baseline metadata, revision, journal, and delivery state; it does not emit an event or dispatch an adapter. If no trusted task-state source exists, it returns `LIFECYCLE_REPAIR_STATE_UNRECOVERABLE` and leaves the missing or untrusted projection and lifecycle/task state unchanged.

A projection write failure after the authoritative lifecycle commit returns `PROJECTION_REPAIR_REQUIRED`, identifies the committed event and revision, and defers dispatch until repair. Run repair before draining that event.

## Enterprise registration and delivery

Enterprise atomically registers `<project-root>/.pocket/lifecycle-adapter.json` with schema `1`, `adapter_contract: 1`, executable `argv`, an event allowlist, and a timeout. Core invokes the registered executable with the event file and `--json --contract 3`. Responses are limited to the matching event ID, a supported delivery status, opaque proof references, and a bounded error object. A missing registration, or a fail-closed major mismatch, leaves the event pending with no delivery mutation and no remote call. A malformed registration, timeout, malformed response, or non-zero exit is retryable within the configured bound; no fallback writer is permitted.

Run the Enterprise preflight before any issue, PR, or comment operation:

```bash
node enterprise/cli.js preflight <project-root> --json
```

`enterprise/cli.js` is in the pocketto-pi package root, not in the project being checked. The command above is a checkout of this repository. A project that depends on the npm package runs `node node_modules/pocketto-pi/enterprise/cli.js preflight <project-root> --json`.

Proceed only when it confirms compatible Core, lifecycle schema, registration, adapter contract, and executable. Preflight is read-only. Enterprise retains remote IDs in `.pocket-meta.json`; the Core journal contains only opaque proof references. Events are claimed one at a time. An idle claim expires after 60 seconds. Before an adapter invocation, Core extends that claim through the granted timeout plus a release margin, so a second drain cannot reclaim an event while the invocation can still be running. A crashed owner is reclaimed only after its lease expires. Retries are bounded to one initial invocation plus at most five retries (delays: 1, 5, 30, 120, and 600 seconds). Authentication, permission, validation, integrity, and ownership conflicts require manual resolution.

The adapter is the sole v4 remote writer for issue reconciliation, phase reporting, and final tasklist sync. It may create/reconcile one issue for `spec-approved`; phase completion requires an existing PR, and the adapter never auto-creates a PR. Plan closure upserts the `<!-- pocket-tasklist -->` proof only. No operation automatically merges a PR or closes an issue.

## Compatibility and migration

| Core | Enterprise | Result |
|------|------------|--------|
| v3 | v3 | Legacy workflow remains operational with a v4 upgrade warning. |
| v4 | v4 | Supported split and lifecycle contract. |
| v4 | absent | Supported local-first execution; events remain pending without GitHub calls. |
| v3 | v4 | Enterprise fails closed with Core upgrade guidance; Core remains usable. |
| v4 | v3 | Adapter fails closed with Enterprise upgrade guidance; pending events remain preserved. |

The v4 preflight warns about legacy v3 installations; an unchanged v3 binary cannot warn about a future release. Active v3 plans with progress remain on the v3 CLI/Enterprise path. Migration is an explicit operation and is allowed only for a pristine v3 plan with no execution progress. Any progress (`REVIEW`, `DONE`, or `BLOCKED`) or a non-pristine plan header returns `PIN_V3_REQUIRED` without file or remote changes. Migration does not rewrite v3 files or emit retrospective remote side effects. Never silently convert or destructively downgrade a v3 plan.

## Non-destructive rollback

To disable a faulty or unwanted adapter, remove its registration and leave Core and `lifecycle.json` installed. Local work continues and events remain pending under their original IDs. Preserve `.pocket-meta.json`, `log.json`, `lifecycle.json`, task progress, and remote markers. Rollback does not delete or rewrite those files. Keep active v3 plans on the v3 path; do not automatically downgrade v4 state.

Disable. `preflight` only reads the registration. `rm` deletes that registration file and nothing else. A later `lifecycle drain` does not replay while the registration is missing: the event stays pending, the drain reports `adapter-unavailable`, and no remote call is made.

```bash
node node_modules/pocketto-pi/enterprise/cli.js preflight <project-root> --json
rm <project-root>/.pocket/lifecycle-adapter.json
```

From a checkout of this repository, the read-only preflight is `node enterprise/cli.js preflight <project-root> --json`.

Replay only after the adapter is pinned to the last compatible v4 release or reinstalled. That drain uses the original event IDs:

```bash
npx pocketto-pi lifecycle drain <spec_dir> --json --contract 3
```

For issue lookup and ownership, see `issue-reconciliation.md`. For phase PR and closure proof, see `phase-reconciliation.md`.
