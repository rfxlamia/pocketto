# Core and Enterprise Agent Surfaces

**Date:** 2026-09-19
**Status:** approved
**Author:** brainstorm session
**Spec path:** docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md

---

## Summary

Separate Core and Enterprise agent-facing surfaces from one canonical repository while preserving local-first Core execution. Core v4 emits neutral, durable lifecycle events; an additive Enterprise adapter consumes those events and performs deterministic GitHub synchronization using the repository's existing marker, metadata, and reconciliation conventions. Enterprise behavior must remain reliable when the model context grows, and v3 installations must remain usable during migration to v4.

---

## Context

### Current State

- The repository currently publishes one `pocketto-pi` package (`3.1.3`) whose package surface includes `skills/**`, `cli/**`, and Pi metadata.
- Core and Enterprise instructions are currently mixed in skills and references. Enterprise phase reporting is documented in `skills/pocket-development/references/enterprise-reporting.md`; `pocket-closing` owns closeout behavior.
- `cli/commands/log.js` owns phase/task state transitions in `log.json`. `cli/lib/logjson.js` currently writes the document directly with `writeFileSync`, so it does not yet provide the required atomic lifecycle commit.
- `.pocket-meta.json` is an additive metadata store for issue/PR identity and phase fingerprints. Existing remote proof uses marker-tagged PR and issue comments.
- Existing Enterprise behavior is fail-closed for non-Enterprise mode and deliberately avoids `gh issue close`; merge remains a human gate.
- The prior session recorded a baseline test pass; the exact command/count is not treated as a contract here. Planning must rerun the repository test command and record its evidence.

### Problem / Motivation

Enterprise users lose required checks when the model context window grows. If Enterprise choreography remains in the model's remembered context, lifecycle synchronization can be skipped, duplicated, or performed in the wrong order. Enterprise behavior must therefore be structurally separate from Core and driven by deterministic state transitions, durable event identity, replay, and reconciliation.

### Related Areas

- `package.json`: package files and release surface.
- `cli/index.js`: JSON contract and command dispatch.
- `cli/commands/log.js`, `cli/lib/logjson.js`: Core execution state and persistence.
- `cli/lib/meta.js`, `cli/commands/meta.js`: additive metadata and issue/PR identity.
- `cli/commands/format.js`, `cli/lib/bodies.js`: issue, PR, phase-summary, tasklist, and closeout bodies/markers.
- `cli/commands/mode.js`, `cli/lib/mode.js`: current Enterprise configuration and compatibility behavior.
- `cli/commands/structure.js`: generated execution-plan layout and existing atomic directory replacement.
- `skills/pocket-development/references/enterprise-reporting.md`: phase-completion remote reconciliation.
- `skills/pocket-closing/SKILL.md`: final closeout and human merge gate.
- `test/cli.test.js`, `test/package.test.js`: CLI, marker, migration, and package archive coverage.

---

## Scope

### In-Scope

- Manifest-driven Core and Enterprise release/install surfaces for Pi and Claude Code from one canonical repository.
- Core v4 removal of Enterprise-only instructions, references, and commands from the Core artifact.
- Additive Enterprise-only lifecycle skills, references, and adapter; Enterprise must not copy Core skills.
- A neutral lifecycle contract for `spec-approved`, `phase-complete`, and `plan-closed`.
- Atomic Core state-transition plus lifecycle-event persistence in one authoritative lifecycle document.
- Durable pending events, event claims, replay, ordering, concurrency control, idempotency, reconciliation, and bounded retry classification.
- Deterministic mapping to existing GitHub issue/PR markers and `.pocket-meta.json` metadata.
- v4 migration behavior, v3 compatibility warnings, missing-Core preflight, tests, and documentation.

### Out-of-Scope

- Repository forks or a second canonical source repository.
- Duplicated Core skills/workflows inside Enterprise.
- GitHub-first execution or making remote Enterprise state a prerequisite for Core state transitions.
- Automatic merge or automatic issue closure. The supervisor's merge remains the human gate.
- A premature generic plugin/event framework unrelated to this lifecycle contract.
- Automatic downgrade, destructive legacy conversion, or a new operator UI.

---

## Architecture Constraints

- **Layers this work may touch:** package/release staging, Core CLI state persistence, neutral lifecycle contract, Enterprise adapter skills/references, existing GitHub formatting/reconciliation helpers, tests, and documentation.
- **Layers this work must not touch:** repository ownership/fork strategy, unrelated Core workflows, or remote operations from Core-only code paths.
- **Patterns that must be followed:** Node.js >=18/CommonJS conventions; existing JSON envelope and contract checks; additive `.pocket-meta.json` schema; `gh` as the existing GitHub transport; marker-based upsert/reconciliation; fail-closed Enterprise preflight; atomic temp-file plus rename for authoritative documents.
- **Boundary rule:** Core may know neutral lifecycle event names and artifact references, but must not know Enterprise policy, GitHub IDs, credentials, issue/PR commands, or remote ownership rules.
- **Architecture validation result:** PASS.

### ARCHITECTURE VALIDATION RESULT

**Status:** PASS

**Checks run:** event-driven contract, shared-state atomicity, Core/Enterprise layer boundary, release surface ownership, version/migration compatibility, remote proof/reconciliation, concurrency/claim recovery, rollback, security, and existing repository marker conventions.

**Anti-patterns reviewed:** leaky Core-to-GitHub abstraction, shared mutable lifecycle state without coordination, non-idempotent remote mutation, implicit breaking contract, synchronous remote dependency in the Core critical path, duplicate v3/v4 Enterprise writers, and cross-root artifact confusion.

**Findings:**

- ✓ Lifecycle state and event journal have one authoritative document and atomic replacement.
- ✓ Event schema is versioned, bounded, idempotent, ordered, and has terminal/retryable handling.
- ✓ Core sees only neutral adapter registration and opaque proof refs; GitHub policy and IDs stay in Enterprise.
- ✓ `spec` and `plan` artifact roots are explicit; malformed commit-time refs and stale delivery refs have different outcomes.
- ✓ Existing issue/PR/tasklist markers remain the canonical remote proof; v4 has one remote writer and v3 remains isolated.
- ✓ Mixed-major behavior, explicit v3 migration refusal, adapter removal, and pending-event replay are defined.

**Implementation constraints carried into planning:**

- The v4 writer must commit `lifecycle.json` before updating the `log.json` projection and must surface `PROJECTION_REPAIR_REQUIRED` without dispatching a pending event.
- The manifest must generate the four declared roles without a package-wide wildcard or copied Core source.
- Existing v3 Enterprise branches must not ship in v4 Core, and the adapter must never auto-create a PR.

### Lifecycle Contract (Normative)

- `spec_dir` is the parent directory of the approved spec file and the home of `.pocket-meta.json`. `plan_id` is the normalized kebab-slug basename of `spec_dir`, matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`; for this plan it is `2026-09-19-split-core-enterprise-agent-surfaces`.
- The authoritative document is `<spec_dir>/lifecycle.json`. It contains lifecycle state, the event journal, and the delivery ledger. `log.json` is only the detailed execution projection for existing skills; v4 `log update` and `log close` commit lifecycle state plus event first, then update `log.json`. A projection write failure returns `PROJECTION_REPAIR_REQUIRED`, leaves the event pending, and defers adapter dispatch until repair. `lifecycle repair <spec_dir> --json --contract 3` rebuilds `log.json` from committed lifecycle state without changing revision or emitting events.
- The root schema is:

  ```json
  {
    "schema": 1,
    "plan": {
      "plan_id": "2026-09-19-split-core-enterprise-agent-surfaces",
      "spec_dir": "docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces",
      "plan_dir": null,
      "branch": null,
      "state": { "approval": "PENDING", "phase_status": {}, "status": "IN_PROGRESS" },
      "revision": 0
    },
    "events": []
  }
  ```

  `plan.spec_dir` is required for every plan; `plan.plan_dir` is null at `spec-approved` and required by `phase-complete` and `plan-closed`; `plan.branch` is captured before phase delivery. Each event is `{ "event_id", "plan_id", "type", "revision", "occurred_at", "artifact_refs", "payload_hash", "proof_ref", "proof_hash", "delivery" }`. `proof_ref` and `proof_hash` are opaque Core values; actual GitHub IDs remain in Enterprise-owned `.pocket-meta.json`.
- The document is replaced by a temp-file plus rename. A successful transition commits its state snapshot and event record together. The event journal is not split across `.pocket-meta.json`, `log.json`, and remote state; `log.json` can only be a repairable projection.
- The event schema is version `1` and is allowlisted to the fields above. Artifact references contain only `{ root: "spec"|"plan", kind, path, sha256, revision }`; `spec` paths are relative to `spec_dir`, `plan` paths are relative to `plan_dir`, `spec-approved` may reference only `spec`, and phase/closure events require a non-null `plan_dir` and may reference `plan`. Absolute paths, path escapes, symlinks escaping the selected root, and missing roots are invalid. Contents are never embedded, and one serialized event is limited to 64 KiB. The canonical payload hash is SHA-256 over stable-key-order JSON with normalized LF text and no volatile delivery fields.
- `revision` increases only for a successful event-emitting transition and is monotonically increasing per `plan_id`. `event_id` is deterministic: `<plan_id>:<type>:r<revision>`. An identical repeated transition is a no-op; the same event ID with a different canonical payload hash is a terminal integrity conflict.
- The Core emitters are fixed: `spec-approved` is emitted at the approved-spec handoff before pocket-planning; `phase-complete` is emitted automatically when pocket-development completes the phase-level pass and emits `PHASE_COMPLETE` while the phase is `REVIEW` (not when closing later changes it to `DONE`); `plan-closed` is emitted automatically by the same atomic operation that makes `log close` set the complete plan to `DONE`.
- Commit validation is fail-closed: an invalid event type/state, missing required artifact, absolute/path-escaping reference, or hash mismatch rejects the transition with no state change and no event. If a committed artifact later disappears or its hash changes, the adapter records terminal `STALE_ARTIFACT`; temporary read/I/O failure is retryable.
- Delivery statuses are `pending`, `claimed`, `succeeded`, `retryable`, `terminal`, and `reconciling`. A claim uses `<spec_dir>/.lifecycle.lock` plus a UUID owner with a 60-second lease; an expired claim may be reclaimed. `attempts` starts at 0 and increments before each invocation; there is one initial invocation plus at most five retries, delayed 1s, 5s, 30s, 120s, and 600s after failures. After the fifth retry the event is terminal/manual resolution.
- Core exposes exact operations `pocketto-pi lifecycle transition <spec_dir> <event-type> --artifact <root>:<kind>:<relative-path>:<sha256> [--artifact ...] --json --contract 3`, `pocketto-pi lifecycle drain <spec_dir> --json --contract 3`, and `pocketto-pi lifecycle repair <spec_dir> --json --contract 3`. `transition` returns the existing JSON envelope with event ID, revision, status, and dispatch result; validation failures use stable error codes. `drain` processes pending/retryable/reconciling events in ascending revision, serially per plan, and never creates a new event. `repair` rebuilds `log.json` from committed lifecycle state without changing revision or emitting events. `PROJECTION_REPAIR_REQUIRED` includes `event_id`, `revision`, `lifecycle_committed: true`, and `dispatch_deferred: true` so the caller can repair before draining.
- Enterprise installs `<project-root>/.pocket/lifecycle-adapter.json` atomically. Its schema is `{ "schema": 1, "adapter_contract": 1, "argv": ["..."], "events": ["..."], "timeout_ms": 30000 }`. Core invokes the registered executable with the event file and `--json --contract 3`; valid responses are `{ "event_id", "status": "succeeded|retryable|terminal|reconciling", "proof_ref?", "proof_hash?", "error?: { "code", "retryable", "message" } }`. Missing registration, timeout, malformed response, or non-zero exit is retryable until the bound; the handler owns GitHub IDs and writes them only to `.pocket-meta.json`.
- The adapter's issue reconciliation algorithm is normative: use a positive `github_issue.number/url` in `.pocket-meta.json` first; validate that it is in the current `origin` repository, open, and tied to the exact normalized `plan_id` in the issue title or embedded full-spec path. Otherwise search open `pocket-plan` issues in the current repository with that exact identity. Zero matches may create, exactly one owned open match may reconcile, and multiple, foreign-owned, manually conflicting, or closed matches become terminal/manual resolution without silent mutation or reopening. A missing issue for `phase-complete` is `ISSUE_REQUIRED` and stops without mutation.
- PR reconciliation is also normative: use `phases.<phase>.github_pr.number/url` first; validate current `origin`, OPEN state, the expected `plan.branch`, and the expected phase marker. If metadata is absent, search the current repository for the exact branch and phase identity. Zero matches returns `PR_REQUIRED`, multiple matches or foreign/closed/mismatched matches return terminal manual resolution, and the adapter never auto-creates a PR. The existing recorder/explicit user flow must supply a PR before phase comments are written.
- Core stores only opaque proof refs: `meta:github_issue` for issue proof, `meta:phases.<phase>.github_pr` plus `meta:phases.<phase>.review.fingerprints` for phase proof, and `meta:github_issue|marker:issue-tasklist` for closure proof. The adapter owns and updates remote IDs in `.pocket-meta.json`; v4 does not require a remote closeout comment, only the existing tasklist marker and local `closeout.md`.
- An explicit `pocketto-pi lifecycle migrate <spec_dir> --from v3 --json --contract 3` may create `lifecycle.json` from a v3 plan snapshot atomically only when the plan has no execution progress. If any task/phase is `REVIEW`, `DONE`, or `BLOCKED`, or the plan header is no longer pristine, it returns `PIN_V3_REQUIRED` and makes no file or remote change; the plan must finish under v3. Migration never rewrites v3 files or emits retrospective remote side effects; future transitions use the v4 contract.

### Release and Ownership Contract (Normative)

- The root `surfaces.json` manifest has schema `1`, release major `4`, and exactly four roles: `pi/core`, `pi/enterprise`, `claude/core`, and `claude/enterprise`. Each role declares explicit `includes`, `requires`, `forbidden_paths`, and `forbidden_content`; Enterprise entries are deltas that require their matching Core role. A build may not rely on the current package-wide `skills/**` wildcard.
- Core includes neutral lifecycle commands and shared workflow files. Enterprise includes the registered adapter and Enterprise-only lifecycle skills/references. `skills/create-pr/**`, `skills/pocket-development/references/enterprise-reporting.md`, and Enterprise-only sections extracted from mixed skills are Enterprise-owned; Core receives only the neutral/shared fragments. v4 Core removes the embedded Enterprise reporting branches from `pocket-development` and `pocket-closing`; v3 artifacts retain the old flow unchanged. No Core file is copied into an Enterprise artifact.
- “v4” means package/distribution `4.0.0`, with `CONTRACT=3` for the new lifecycle CLI envelope and `PIPELINE=5` for the new emission boundary. `LIFECYCLE_SCHEMA=1`, `ADAPTER_CONTRACT=1`, and `SURFACE_MANIFEST=1` are independent protocol versions. A v4 preflight reads the installed surface manifest and adapter contract; it warns about legacy v3 installations, while an unchanged v3 binary cannot be expected to warn about a future release.
- Active v3 plans with progress remain on the v3 CLI/Enterprise path until explicitly upgraded; v4 never silently rewrites them. Supported compatibility is: v3 Core + v3 Enterprise (legacy warning), v4 Core + v4 Enterprise (supported), v4 Core alone (local-first supported), v3 Core + v4 Enterprise (Enterprise fail-closed with Core upgrade guidance), and v4 Core + v3 Enterprise (adapter fail-closed with Enterprise upgrade guidance). Pending v4 events remain durable during mixed-major or interrupted installation.
- In v4, `skills/pocket-development/references/enterprise-reporting.md` and the Enterprise reporting branches embedded in `pocket-development` and `pocket-closing` are absent from Core. The registered adapter is the sole v4 remote writer for phase reporting, tasklist sync, and issue reconciliation; v4 Core performs no `gh` side effect. The old embedded flow remains only in the v3 artifact, so a v4 run cannot produce duplicate remote side effects.

---

## Dependencies

### Existing (to leverage)

- Node.js >=18 built-in filesystem APIs — authoritative document writes, locking/claims, and local journal persistence.
- Existing `gh` CLI integration — GitHub authentication, issue/PR operations, and established fail-closed behavior.
- Existing `.pocket-meta.json` schema — issue/PR identity, phase fingerprints, and additive migration.
- Existing `format` bodies and markers — PR phase summaries, issue tasklists, and closeout comments.
- Existing CLI JSON envelope/contract — deterministic machine-readable success and error reporting.

### New (proposed)

None. Do not add Octokit, a generic queue/event framework, or a retry library. The lifecycle journal, claim semantics, reconciliation rules, and remote marker identity are domain-specific; `gh` is already the repository's established transport. Retry behavior must be a small, bounded policy around the existing transport rather than a new dependency.

---

## Stories + Scenarios

### Story: Separate installable surfaces

> As a Core user, I want a Core artifact with no Enterprise instructions or commands, so that Core execution remains useful without Enterprise and cannot accidentally perform remote side effects.

**Rule 1: Core and Enterprise artifacts are structurally distinct.**
- Example A: A v4 Core build for Pi and Claude contains Core/shared files but no Enterprise-only skill, reference, or command.
- Example B: Enterprise installation adds only adapter/lifecycle files and reuses Core; it does not copy Core skills.

```gherkin
Scenario: Core v4 artifact excludes Enterprise surfaces
  Given the canonical repository is built for Pi and Claude Code
  When the v4 Core artifact is staged
  Then the artifact contains Core and shared files
  And it contains no Enterprise-only skill, reference, GitHub Enterprise instruction, or Enterprise command
  And a structural manifest test proves the forbidden paths and vocabulary are absent

Scenario: Enterprise v4 is additive
  Given Core v4 is installed
  When Enterprise v4 is installed
  Then Enterprise adapter, lifecycle skills, and references become available
  And no Core skill is copied into the Enterprise surface
  And both surfaces remain reproducible from the same canonical source

Scenario: Missing compatible Core fails before Enterprise side effects
  Given Enterprise v4 is installed without Core v4 or with an incompatible Core major
  When Enterprise preflight runs
  Then it stops with an actionable install/upgrade error
  And it writes no partial Enterprise state
  And it makes zero GitHub calls

Scenario: A legacy v3 installation remains usable
  Given a mixed v3 installation or legacy Enterprise configuration is active
  When a supported v3 workflow runs
  Then the workflow remains operational
  And it emits a warning directing the user to v4
  And it is not interrupted solely because migration has not happened
```

### Story: Core emits a durable neutral lifecycle contract

> As a Core workflow, I want successful state transitions to emit durable neutral events, so that Enterprise synchronization does not depend on model memory.

**Rule 1: State and event commit atomically.**
- Example A: A valid transition and its event are persisted together.
- Example B: A failed event write means the transition is not successful and exposes no partial success.

**Rule 2: Events have stable identity and bounded data.**
- Example A: `plan-50:spec-approved:r1` contains plan identity, event type, revision, timestamp, and artifact references.
- Example B: The payload contains no GitHub ID, credential, Enterprise command, or Enterprise policy.

```gherkin
Scenario: A successful spec approval emits one durable event
  Given plan slug `split-core-enterprise-agent-surfaces` has valid approval artifacts
  When Core commits the transition to `spec-approved`
  Then the transition and exactly one `spec-approved` event are committed atomically
  And the event has a stable ID, plan identity, revision, timestamp, and artifact references
  And the payload contains no GitHub ID or Enterprise command

Scenario: A successful phase completion emits the current revision
  Given phase `phase-1` has valid completion evidence, `plan_dir` exists, and branch `feature/issue-50` is captured
  When Core commits `phase-complete` at revision 4
  Then one durable event for revision 4 is recorded
  And it references the phase evidence artifact with root `plan`
  And the event requires the non-null `plan_dir`

Scenario: Spec approval accepts only spec-root artifacts
  Given the approved spec exists under `spec_dir` and no `plan_dir` exists yet
  When Core commits `spec-approved`
  Then every artifact reference has root `spec`
  And the lifecycle document stores `plan_dir: null`
  And a plan-root reference is rejected before event creation

Scenario: A successful plan closure emits final state references
  Given every phase is eligible for closure
  When Core commits `plan-closed`
  Then one durable event points to the final plan state and artifacts

Scenario: A persistence failure prevents partial success
  Given a valid state transition is ready to commit
  When the authoritative document cannot persist both state and event
  Then the transition is reported as unsuccessful
  And neither a successful state nor a processable event is exposed

Scenario: A projection failure defers Enterprise dispatch
  Given Core has committed lifecycle state and event revision 4
  When writing the derived `log.json` projection fails
  Then the command returns `PROJECTION_REPAIR_REQUIRED`
  And the event remains pending with dispatch deferred
  And `lifecycle repair` can rebuild `log.json` without creating a new event

Scenario: An invalid transition emits no event
  Given a phase transition is invalid for the current state
  When the transition is attempted
  Then Core leaves state unchanged
  And Core records no new lifecycle event

Scenario: Core-only execution has no Enterprise side effect
  Given only Core v4 is installed
  When a valid lifecycle transition is committed
  Then local work succeeds and the event remains locally available
  And Core makes zero GitHub or Enterprise calls

Scenario: Repeating an identical logical transition is replay-safe
  Given `plan-50:spec-approved:r1` already exists with an identical payload
  When the same logical transition is submitted again
  Then it is a no-op/replay using the existing event ID
  And no second event is created

Scenario: Reusing an event ID with a different payload is rejected
  Given event ID `plan-50:spec-approved:r1` exists
  When a different payload is submitted with that ID
  Then the operation fails with a terminal integrity conflict
  And no remote mutation is attempted
```

### Story: Enterprise deterministically processes events

> As an Enterprise user, I want lifecycle events synchronized through deterministic handlers, so that issue and review state remains auditable after context loss or process restart.

**Rule 1: Use the minimum remote mapping.**
- `spec-approved` creates or reconciles one issue.
- `phase-complete` updates the existing phase summary/proof.
- `plan-closed` updates final tasklist/closeout state.
- No merge or automatic issue close is performed.

**Rule 2: Existing repository markers are canonical proof.**
- Phase proof uses the existing PR marker `<!-- pocket-phase-<N>-summary -->` plus canonical v4 metadata at `phases.<phase>.review.fingerprints`; the legacy v3 `phases.<phase>.fingerprints` path is read-only compatibility input.
- Closure proof uses the existing `<!-- pocket-tasklist -->` issue marker plus metadata; the local `closeout.md` and current unmarked closeout comment are informational and are not canonical idempotency markers.
- Issue proof includes the reconciled issue number/URL and ownership evidence.

```gherkin
Scenario: spec-approved creates or reconciles one issue
  Given event `plan-50:spec-approved:r1` is pending and Enterprise is compatible
  And no owned issue is recorded for plan 50
  When the adapter processes the event
  Then it creates or reconciles exactly one owned issue
  And the ledger records succeeded, the event ID, the issue number/URL, and reconciliation proof

Scenario: phase-complete updates the existing PR proof
  Given event `plan-50:phase-complete:r4` references phase 1 evidence
  And the phase PR is identified
  When the adapter processes the event
  Then it upserts the existing `pocket-phase-1-summary` marker
  And it records the phase fingerprint at `phases.phase-1.review.fingerprints` in `.pocket-meta.json`
  And it creates no duplicate issue or summary marker

Scenario: plan-closed updates final issue proof without closing the issue
  Given event `plan-50:plan-closed:r9` is valid
  When the adapter processes the event
  Then it upserts the existing `<!-- pocket-tasklist -->` issue marker
  And it records final metadata and the tasklist marker as remote proof
  And it writes local `closeout.md` without requiring a marker on the informational closeout comment
  And it does not merge a PR or call `gh issue close`

Scenario: A succeeded event is idempotent
  Given an event ID already has status `succeeded` and a remote proof
  When the event is replayed
  Then the adapter performs no duplicate create or mutation
  And it returns the existing remote proof

Scenario: Core succeeds when the adapter is unavailable
  Given Core has atomically committed a pending event
  When the Enterprise adapter is missing, disabled, or temporarily unavailable
  Then Core remains locally successful
  And the event remains pending or retryable with an actionable warning
  And replay uses the original event ID

Scenario: Adapter registration mismatch cannot cause a remote call
  Given the registration record is missing, malformed, or declares adapter contract 2 instead of 1
  When Core dispatches a committed event
  Then Core reports a retryable adapter protocol error
  And the event remains pending or retryable
  And no GitHub command is executed

Scenario: Plan closure replay reuses the tasklist marker
  Given the tasklist marker was updated but the local proof write timed out
  When the same plan-closed event is drained again
  Then the adapter finds and upserts the existing tasklist marker
  And it does not create a duplicate tasklist comment
  And the informational closeout comment is not used as an idempotency key
```

### Story: Recovery, ordering, and ownership are deterministic

> As an Enterprise operator, I want ambiguous or partially completed remote operations to stop safely, so that retries never create duplicate or unauthorized changes.

**Rule 1: Claims and revisions protect ordering.**
- A single worker claims an event ID.
- Events for one plan are processed serially.
- Gaps remain pending; stale lower revisions are no-ops; remote state never regresses.

**Rule 2: Ambiguity never causes blind mutation.**
- A malformed, absolute/path-escaping, cross-plan, or hash-mismatched reference is rejected during Core commit and creates no event.
- A reference that was valid at commit but is missing or changed before adapter delivery becomes terminal `STALE_ARTIFACT`; temporary read/I/O failure remains retryable.
- Multiple, foreign-owned, manually conflicting, or ambiguous remote matches require manual resolution.
- A single owned match may be reconciled.

**Rule 3: Failure classes are explicit.**
- Network and rate-limit failures are bounded retryable failures.
- Authentication, permission, validation, integrity, and ownership conflicts are terminal actionable failures.
- Remote success followed by local ledger failure enters `reconciling`; retry looks up the marker/proof before mutating.

```gherkin
Scenario: Out-of-order delivery does not regress state
  Given revision 5 for plan 50 has succeeded
  When revision 3 arrives after revision 5
  Then revision 3 becomes a no-op
  And remote state remains at revision 5

Scenario: A revision gap remains pending
  Given revision 5 arrives while revision 4 is not available
  When the adapter receives revision 5
  Then it does not apply revision 5 out of order
  And it records a pending gap with an actionable diagnostic

Scenario: Concurrent delivery produces one remote effect
  Given two workers receive the same pending event
  When both attempt processing
  Then only one worker holds the event claim
  And the remote result contains one issue/update and one proof

Scenario: Remote success survives a ledger timeout
  Given the remote marker is written but the local ledger write times out
  When the same event is replayed
  Then the adapter searches for the existing marker/proof first
  And it does not blind-create or duplicate the mutation
  And the event can move from `reconciling` to `succeeded`

Scenario: Invalid artifact references are rejected before event creation
  Given a transition submits a malformed, absolute, path-escaping, cross-plan, or hash-mismatched artifact reference
  When Core validates the transition
  Then state remains unchanged
  And no lifecycle event is created
  And no remote mutation is attempted

Scenario: A committed artifact becoming stale is terminal
  Given an artifact reference was valid when event revision 4 was committed
  When the referenced file is missing or its hash changes before adapter delivery
  Then the adapter records terminal `STALE_ARTIFACT`
  And it performs no remote mutation

Scenario: A temporary artifact read failure is retryable
  Given an event artifact is temporarily unavailable because of a transient I/O error
  When the adapter validates the event
  Then it records a retryable error
  And it does not mutate remote state until a later attempt

Scenario: Ambiguous remote ownership stops reconciliation
  Given reconciliation finds zero, multiple, foreign-owned, manually conflicting, or closed matches
  When the adapter evaluates the target
  Then it stops with an actionable manual-resolution state
  And it does not silently mutate an ambiguous target

Scenario: Error classes have bounded resume behavior
  Given `gh` returns a timeout, rate limit, permission error, or validation error
  When the adapter classifies the response
  Then timeout/rate-limit is retried with bounded backoff
  And permission/validation is terminal with an actionable message
  And no credential is written to the ledger or error output
```

### Story: Migration and release behavior is compatible

> As a maintainer, I want v4 packaging and compatibility behavior to be explicit, so that active v3 plans are not stranded and Core remains safe during partial upgrades.

The compatibility matrix is normative:

| Core | Enterprise | Result |
|------|------------|--------|
| v3 | v3 | Legacy workflow remains operational with a v4 warning. |
| v4 | v4 | Supported split and lifecycle contract. |
| v4 | absent | Core-only local execution; events remain pending with no GitHub calls. |
| v3 | v4 | Enterprise fails closed with a Core upgrade instruction; Core remains usable. |
| v4 | v3 | Adapter fails closed with an Enterprise upgrade instruction; events remain pending. |

```gherkin
Scenario: Core v4 and Enterprise v4 are the supported split
  Given Core v4 and Enterprise v4 are installed
  When preflight and lifecycle processing run
  Then the neutral event contract and Enterprise adapter are enabled
  And all supported markers and ledger transitions are available

Scenario: Core v3 and Enterprise v3 remain usable with a warning
  Given a legacy v3 Core/Enterprise pair is active
  When a legacy workflow runs
  Then it remains operational
  And it reports the v4 upgrade warning

Scenario: Core v3 with Enterprise v4 fails closed at the Enterprise boundary
  Given Core v3 is installed and Enterprise v4 is requested
  When Enterprise preflight runs
  Then it stops with a Core upgrade instruction
  And Core remains usable
  And no Enterprise GitHub side effect occurs

Scenario: Core v4 with Enterprise v3 fails closed at the adapter boundary
  Given Core v4 emits a v4 lifecycle event and only Enterprise v3 is installed
  When the adapter preflight runs
  Then it reports an Enterprise upgrade requirement
  And Core keeps the event pending without remote mutation

Scenario: An interrupted Enterprise upgrade is recoverable
  Given Enterprise installation or upgrade stops after partial filesystem work
  When preflight is run again
  Then Core remains usable
  And incomplete Enterprise state is rejected or repaired without deleting Core state
  And pending events retain their original IDs
```

---

## Acceptance Criteria

**Date:** 2026-09-19 | **Scope confirmed:** yes

Legend: `✓` is a required successful behavior; `✗` is a required rejection, safety, or fail-closed behavior.

### Rule: Release surfaces are structurally separate

- ✓ Given the canonical repository is staged for Pi and Claude Code, When the v4 Core artifact is built, Then Enterprise-only skills, references, commands, GitHub vocabulary, and credentials are absent and structural tests prove it.
- ✓ Given Core v4 is installed, When Enterprise v4 is added, Then only additive Enterprise lifecycle files are installed and no Core skill is duplicated.
- ✗ Given Enterprise v4 has no compatible Core, When preflight runs, Then it returns an actionable install/upgrade error, writes no partial Enterprise state, and makes zero GitHub calls.
- ✓ Given a v3 installation is active, When the legacy workflow runs, Then it remains usable and emits a v4 upgrade warning.

### Rule: Core transitions and events are atomic and neutral

- ✓ Given valid approval, phase, or closure state, When Core runs `lifecycle transition`, Then state and exactly one event are persisted atomically in `<spec_dir>/lifecycle.json`.
- ✓ Given `spec-approved` has no plan directory, When Core commits it, Then refs use only `spec` root and `plan_dir` remains null; phase/closure transitions require `plan_dir` and use `plan` refs.
- ✓ Given pending events, When Core runs `lifecycle drain`, Then it dispatches them in ascending revision per plan without creating a new event.
- ✓ Given lifecycle commit succeeds but `log.json` projection fails, When the command returns, Then it reports `PROJECTION_REPAIR_REQUIRED`, defers dispatch, and `lifecycle repair` can rebuild the projection without a new event.
- ✗ Given either state or event persistence fails, When the commit is attempted, Then the transition is unsuccessful and no partial success is exposed.
- ✗ Given an invalid transition or artifact reference, When it is submitted, Then state is unchanged, no event is processable, and no remote mutation occurs.
- ✓ Given an identical transition is repeated, When it is submitted, Then it is an idempotent no-op with the original event ID.
- ✗ Given an existing event ID is reused with a different payload, When validated, Then a terminal integrity conflict is returned.
- ✓ Given only Core is installed, When a transition succeeds, Then local work completes and zero GitHub/Enterprise calls occur.

### Rule: Enterprise sync is deterministic and auditable

- ✓ Given `spec-approved`, When the adapter processes it, Then exactly one owned issue is created or reconciled and issue identity/proof is recorded.
- ✓ Given `phase-complete`, When the adapter processes it, Then the existing PR phase marker and canonical `phases.<phase>.review.fingerprints` metadata are upserted without duplication.
- ✓ Given `plan-closed`, When the adapter processes it, Then the existing `<!-- pocket-tasklist -->` issue marker and metadata are finalized, the unmarked closeout body is informational, and no merge or auto-close occurs.
- ✓ Given a succeeded event is replayed, When the adapter processes it, Then no duplicate remote mutation occurs and the same remote proof is returned.
- ✓ Given the adapter is unavailable or a remote call fails, When Core has already committed, Then Core remains successful and the event stays pending/retryable with an actionable warning.

### Rule: Recovery and concurrency protect data integrity

- ✓ Given duplicate workers receive one event, When they claim it, Then only one claim succeeds and remote effects occur once.
- ✓ Given revisions arrive out of order, When they are processed, Then gaps remain pending, stale revisions are no-ops, and remote state never regresses.
- ✓ Given remote mutation succeeds before the ledger write, When replay occurs, Then existing marker/proof is reconciled before any mutation and no blind-create occurs.
- ✗ Given ownership is ambiguous or a reference is malformed/cross-plan, When reconciliation runs, Then no remote mutation occurs and an actionable terminal/manual state is recorded.
- ✓ Given a transient timeout/rate limit, When the adapter retries, Then backoff is bounded; auth/permission/validation failures are terminal and observable without credential leakage.

### Rule: Version and rollback behavior is explicit

- ✓ Given Core v4 and Enterprise v4 are installed, When preflight runs, Then package major `4.0.0`, CLI `CONTRACT=3`, `PIPELINE=5`, lifecycle schema `1`, and adapter contract `1` are mutually compatible.
- ✓ Given a mixed-major installation, When Enterprise preflight runs, Then Enterprise fails closed while Core remains usable and pending events are preserved.
- ✓ Given the adapter is disabled or removed, When Core continues, Then the journal is retained and no local state is lost.
- ✓ Given a v4 Core run reaches phase completion or closeout, When the old embedded Enterprise branches and `enterprise-reporting.md` are absent, Then only the registered adapter can produce Enterprise remote side effects.
- ✗ Given a v3 plan has execution progress, When `lifecycle migrate --from v3` is attempted, Then it returns `PIN_V3_REQUIRED`, changes no file, and leaves the plan on the v3 path.
- ✓ Given a legacy v3 installation without a future-aware binary, When it runs, Then it remains operational; v4 preflight—not the old binary—emits the upgrade warning without silent destructive migration.

---

## Design Decision

**Chosen option:** Option A — Core transaction + durable lifecycle journal + Enterprise adapter.

**Summary:** Core owns neutral lifecycle state and durable event identity in `<spec_dir>/lifecycle.json`. Enterprise is an additive, separately installed registered CLI adapter that claims and processes pending events using existing GitHub markers, metadata, and fail-closed rules. Core commits locally first, then best-effort dispatches the adapter; `lifecycle drain` provides deterministic replay. The authoritative lifecycle document contains transition-owned state and the event journal together and is replaced atomically.

**Rejected options:**

- **Option B — synchronous adapter dispatch:** rejected because process interruption, concurrent delivery, and remote-success/local-ledger-failure recovery are harder to make deterministic; it also makes the critical path too dependent on adapter dispatch.
- **Option C — artifact reconciler:** rejected because scanning derived artifacts cannot guarantee that every valid transition emitted an event or preserve revision ordering when state changes before scanning.

**Key tradeoffs accepted:**

- A lifecycle persistence boundary and atomic document writer must be added or refactored.
- Release staging becomes manifest-driven for two host surfaces instead of relying on one package-wide `skills/**` inclusion.
- The adapter retains explicit claim, retry, reconciliation, and marker-upsert logic rather than introducing a generic event framework.
- v4 replaces the embedded Enterprise reporting paths; v3 retains them unchanged so a mixed installation cannot execute both old and new remote side effects for the same plan.

---

## Open Questions / Assumptions

| Question | Resolution | Risk if Wrong |
|----------|------------|---------------|
| Where is lifecycle state and the event journal authoritative? | Resolved: `<spec_dir>/lifecycle.json`; v4 `log update`/`log close` commit it first, then maintain `log.json` as a repairable projection. | A cross-file transaction would violate atomicity and require returning to design. |
| Which artifact roots are valid? | Resolved: `spec_dir` is always present; `plan_dir` is null for `spec-approved` and required for phase/closure events. Refs declare `root: spec|plan`. | A ref to the wrong directory could publish stale or cross-plan evidence. |
| Which existing remote proof is canonical? | Resolved: PR marker + `phases.<phase>.review.fingerprints` for `phase-complete`; `<!-- pocket-tasklist -->` + metadata for `plan-closed`; issue identity/ownership proof for `spec-approved`. The unmarked closeout body is informational. | A new remote schema or mandatory closeout comment would add migration and duplicate-replay risk. |
| What are issue and PR ownership rules? | Resolved: current `origin` repository, exact normalized plan/phase identity, open state, expected branch, and metadata-first lookup; zero/multiple/foreign/closed targets stop without mutation. The adapter never auto-creates a PR. | Ambiguous ownership could mutate a wrong issue or PR. |
| What does a v3/v4 mixed installation do? | Resolved by the compatibility matrix: Enterprise fails closed with actionable guidance; active v3 plans with progress return `PIN_V3_REQUIRED`; Core stays usable and pending v4 events are retained. | Incorrect detection could silently skip sync or block local work. |
| What are the adapter and retry bounds? | Resolved: registered CLI adapter, `lifecycle drain`, 60-second claim lease, five bounded retries, and explicit terminal/reconciling statuses. | Unbounded claims or retries could lose events or loop forever. |
| What are the surface ownership and artifact roles? | Resolved: root `surfaces.json` manifest roles `pi/core`, `pi/enterprise`, `claude/core`, and `claude/enterprise`; v4 Core has no embedded Enterprise remote writer; no package-wide wildcard or duplicated Core source. | Implicit ownership could leak Enterprise instructions into Core or omit a required adapter. |

---

## Implementation Notes

- Treat `spec-approved`, `phase-complete`, and `plan-closed` as a small versioned neutral vocabulary, not a general-purpose plugin/event framework.
- Store the allowlisted lifecycle schema and journal in `<spec_dir>/lifecycle.json`; use atomic temp-file plus rename and a per-plan lock/lease. Treat `log.json` as a projection and implement `lifecycle repair` for `PROJECTION_REPAIR_REQUIRED`.
- Keep GitHub IDs, remote ownership, credentials, and `gh` commands inside Enterprise-only handlers. Core's registration record contains only adapter contract/executable information; the registered adapter is the sole v4 remote writer.
- Use `root: spec|plan` artifact references, event IDs `<plan_id>:<type>:r<revision>`, a 64 KiB event limit, 60-second claims, and five bounded retries as normative defaults.
- Use existing marker generation and upsert conventions: `pocket-phase-<N>-summary` plus canonical `phases.<phase>.review.fingerprints` for phase completion, and `<!-- pocket-tasklist -->` plus metadata for closure. The current closeout body is informational; v4 writes local `closeout.md` only.
- Validate issue and PR targets against current origin, exact plan/phase identity, open state, and expected branch. The adapter never auto-creates a PR; missing or ambiguous targets return `ISSUE_REQUIRED`/`PR_REQUIRED` or terminal manual resolution.
- Extend package tests to build the four manifest roles (`pi/core`, `pi/enterprise`, `claude/core`, `claude/enterprise`) and assert forbidden paths/content, additive Enterprise paths, absence of embedded v4 reporting, and absence of duplicated Core sources.
- Preserve the v4 `--json --contract 3` envelope while keeping distribution major, CLI contract, pipeline generation, lifecycle schema, adapter contract, and surface manifest versioned independently.
- Keep Core-only and failed Enterprise paths observable with event ID, plan identity, revision, error class, and retryability, never secrets.
- Define “actionable” machine output as an error code plus event ID, plan ID, revision, retryability, and (when retryable) next-attempt information.

---

## Rollback Plan

- Disable or remove the Enterprise adapter while leaving Core and the authoritative lifecycle journal installed; local execution continues and events remain pending.
- If a v4 adapter release is faulty, pin the Enterprise artifact to the last compatible v4 release and replay pending events by their original IDs after correction.
- Preserve existing `.pocket-meta.json`, `log.json`, and remote marker data; never delete or rewrite them as part of rollback.
- For active legacy plans, use the documented v3 CLI compatibility path with its upgrade warning; do not automatically downgrade v4 state or perform destructive conversion.
