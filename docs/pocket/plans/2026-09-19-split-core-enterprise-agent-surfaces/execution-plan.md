# EXECUTION PLAN — Core and Enterprise Agent Surfaces

**Date:** 2026-09-19
**Spec:** docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md
**Status:** draft
**Total tasks:** 14

---

## Execution Overview

### Recommended Order

```text
T1 → T2 → T3, T5, T7 (parallel) → T4, T6, T8, T9, T10 (parallel where unblocked) → T11, T12 (parallel where unblocked) → T13, T14 (parallel)
```

The three execution batches produced by the dependency-depth layout are:

- **Phase 1 — Contracts, storage, and parallel surface boundaries:** T1, T2, T3, T5, T7
- **Phase 2 — Core replay plus skill and remote handlers:** T4, T6, T8, T9, T10
- **Phase 3 — Compatibility, integration, documentation, and release gate:** T11, T12, T13, T14

> Dependency order above is recommended — pocket skill enforces actual parallelism and sequencing based on the task annotations.

### Parallelizable Groups

| Group | Tasks | Unblocked After |
|-------|-------|-----------------|
| Group A | T3, T5, T7 | T2 completes |
| Group B | T4, T6, T8, T9, T10 | T3/T5/T7 respective prerequisites complete |
| Group C | T11, T12 | T4 plus their listed prerequisites complete |
| Group D | T13, T14 | T6, T11, and T12 complete |

### Constraints Reminder

**Architecture:** Core may know only neutral lifecycle event names, artifact references, and the opaque adapter registration/proof contract. Core must not know GitHub IDs, credentials, `gh` commands, Enterprise policy, or remote ownership rules. `lifecycle.json` is the authoritative state/event/ledger document and must be replaced atomically; `log.json` remains a repairable projection. All JSON CLI behavior keeps the existing envelope and explicit contract checks. Release staging must use the explicit `surfaces.json` manifest rather than the package-wide `skills/**` wildcard.

**Out-of-scope:** repository forks or a second canonical source; duplicated Core workflows inside Enterprise; GitHub-first Core execution; automatic merge or issue closure; a generic plugin/event framework; automatic downgrade or destructive legacy conversion; and a new operator UI.

**Assumptions at risk:** `spec_dir` and `plan_dir` remain the only artifact roots; marker and metadata paths in the spec remain canonical; mixed-major Enterprise behavior remains fail-closed while Core stays local-first; the 60-second claim lease and five retry bound are sufficient; and v3 compatibility is provided by the existing released v3 artifact rather than a second in-repository Core source.

**Sequencing:** Dependency order shown is recommended only — pocket enforces actual blocking rules. Do not treat `[depends: TN]` as a hard lock unless the task cannot logically proceed without the prerequisite's output.

### File Structure Map

#### Rule: Release surfaces are structurally separate

```text
Create: surfaces.json                                      (created by: T5)
Create: scripts/build-surfaces.js                         (created by: T5)
Create: cli/lib/surface-manifest.js                       (created by: T5)
Create: skills/pocket-enterprise/SKILL.md                  (created by: T6; modified by: T13)
Create: skills/pocket-enterprise/references/lifecycle-contract.md (created by: T6; modified by: T13)
Create: skills/pocket-enterprise/references/issue-reconciliation.md (created by: T6; modified by: T13)
Create: skills/pocket-enterprise/references/phase-reconciliation.md (created by: T6; modified by: T13)
Create: skills/pocket-enterprise/references/onboarding.md   (created by: T6)
Create: test/surfaces.test.js                              (created by: T5)
Create: test/skill-surfaces.test.js                        (created by: T6)
Modify: package.json:L1-L51                                (T5)
Modify: rebuild-skills.sh                                  (T5, T6)
Modify: .claude-plugin/plugin.json                         (T5)
Modify: .claude-plugin/marketplace.json                    (T5)
Modify: skills/pocket-development/SKILL.md                 (T6, T13)
Modify: skills/pocket-development/references/enterprise-reporting.md (T6)
Modify: skills/pocket-grinding/SKILL.md                    (T6)
Modify: skills/pocket-init/SKILL.md                        (T6)
Modify: skills/pocket-help/SKILL.md                        (T6)
Modify: skills/pocket-closing/SKILL.md                     (T6, T13)
Modify: skills/create-pr/SKILL.md                          (T6, T13)
Modify: skills/pocket-development/pocket-development.skill (T6)
Modify: skills/pocket-closing/pocket-closing.skill         (T6)
Modify: skills/pocket-grinding/pocket-grinding.skill       (T6)
Modify: skills/pocket-init/pocket-init.skill               (T6)
Modify: skills/pocket-help/pocket-help.skill               (T6)
Modify: skills/create-pr/create-pr.skill                   (T6)
Create: skills/pocket-enterprise/pocket-enterprise.skill  (created by: T6)
Test:   test/package.test.js                               (T5, T6, T14)
```

#### Rule: Core transitions and events are atomic and neutral

```text
Create: cli/lib/lifecycle-contract.js                      (created by: T1)
Create: cli/lib/atomic-file.js                             (created by: T2)
Create: cli/lib/lifecycle-store.js                         (created by: T2)
Create: cli/lib/lifecycle-transition.js                    (created by: T3)
Create: cli/commands/lifecycle.js                          (created by: T3)
Create: cli/lib/lifecycle-dispatch.js                      (created by: T4)
Create: test/lifecycle-contract.test.js                    (created by: T1)
Create: test/lifecycle-store.test.js                       (created by: T2)
Create: test/lifecycle-cli.test.js                         (created by: T3)
Create: test/lifecycle-dispatch.test.js                    (created by: T4)
Modify: cli/lib/version.js:L1-L48                         (T1)
Modify: cli/index.js:L36-L281                             (T3, T4)
Modify: cli/commands/log.js:L418-L779                    (T3)
Modify: cli/lib/logjson.js:L9-L40                         (T3)
Modify: cli/commands/mode.js                              (T5 ownership classification)
Modify: cli/lib/mode.js                                    (T5 ownership classification)
Modify: cli/commands/meta.js                              (T5 ownership classification)
Modify: cli/lib/meta.js                                    (T5 ownership classification)
Modify: cli/commands/format.js                            (T5 ownership classification)
Modify: cli/lib/bodies.js                                  (T5 ownership classification)
Modify: cli/lib/identity.js                                (T5 ownership classification)
Modify: cli/lib/reconcile.js                               (T5 ownership classification)
```

#### Rule: Enterprise sync is deterministic and auditable

```text
Create: enterprise/cli.js                                (created by: T7)
Create: enterprise/adapter.js                            (created by: T7)
Create: enterprise/registration.js                       (created by: T7)
Create: enterprise/github.js                             (created by: T7)
Create: enterprise/meta.js                               (created by: T7)
Create: enterprise/retry.js                              (created by: T7)
Create: enterprise/issue-handler.js                      (created by: T8)
Create: enterprise/phase-handler.js                      (created by: T9)
Create: enterprise/closure-handler.js                    (created by: T10)
Modify: enterprise/issue-handler.js                      (T12 integration seam)
Modify: enterprise/phase-handler.js                      (T12 integration seam)
Modify: enterprise/closure-handler.js                    (T12 integration seam)
Create: test/enterprise-protocol.test.js                 (created by: T7)
Create: test/enterprise-issue.test.js                    (created by: T8)
Create: test/enterprise-phase.test.js                    (created by: T9)
Create: test/enterprise-closeout.test.js                 (created by: T10)
Modify: skills/pocket-development/references/enterprise-reporting.md (T6)
Modify: skills/pocket-development/SKILL.md                (T6, T13)
Modify: skills/pocket-closing/SKILL.md                    (T6, T13)
```

#### Rule: Recovery and concurrency protect data integrity

```text
Create: test/integration/lifecycle-enterprise.test.js    (created by: T12)
Modify: cli/commands/lifecycle.js                          (T4)
Modify: cli/lib/lifecycle-store.js                        (T4)
Modify: cli/lib/lifecycle-dispatch.js                    (T4, T12)
Modify: enterprise/adapter.js                             (T7, T12)
Modify: enterprise/github.js                              (T7)
Modify: enterprise/meta.js                                (T7)
```

#### Rule: Version and rollback behavior is explicit

```text
Create: cli/lib/lifecycle-migration.js                    (created by: T11)
Create: test/compatibility.test.js                        (created by: T11)
Create: test/documentation.test.js                        (created by: T13)
Create: test/release-regression.test.js                   (created by: T14)
Create: test/fixtures/v3-plan/log.json                   (created by: T11)
Create: test/fixtures/v3-plan/execution-plan.md          (created by: T11)
Modify: cli/commands/lifecycle.js                          (T11)
Modify: enterprise/registration.js                        (T11)
Modify: enterprise/adapter.js                             (T7, T12)
Modify: README.md                                          (T13)
Modify: CHANGELOG.md                                       (T13)
Modify: llms.txt                                           (T13)
Modify: skills/pocket-development/pocket-development.skill (T13)
Modify: skills/pocket-closing/pocket-closing.skill         (T13)
Modify: skills/create-pr/create-pr.skill                   (T13)
Modify: skills/pocket-enterprise/pocket-enterprise.skill  (T13)
Modify: test/cli.test.js                                  (T14)
Modify: test/package.test.js                              (T14)
Modify: package.json                                      (T14)
```

---

## Pocket Packets

---

### Task 1: Define v4 neutral lifecycle and adapter contracts [prereq]

## OBJECTIVE
Define the versioned, allowlisted contracts that every later Core and Enterprise task imports. Keep the contract neutral: event names and opaque proof/artifact references are allowed, while GitHub IDs, credentials, remote policy, and `gh` commands remain forbidden.

Steps:
1. Write failing test for: lifecycle protocol constants are independently versioned.
   Test file: `test/lifecycle-contract.test.js`
   Level: unit
   Test intent: Given the current v3 constants, When the v4 contract module is loaded, Then it exposes `CONTRACT=3`, `PIPELINE=5`, `LIFECYCLE_SCHEMA=1`, `ADAPTER_CONTRACT=1`, and `SURFACE_MANIFEST=1` without conflating the protocol versions; package major validation is owned by T5.
   Exercise through: `require('../cli/lib/version')` and the exported protocol constants.
   Test doubles: none; use the real version module.
   Expected RED: `CONTRACT`/`PIPELINE` are currently 2/4 and the lifecycle protocol constants do not exist.
2. Run test — verify FAIL: `node --test test/lifecycle-contract.test.js`
3. Implement the independent protocol constants without changing the package major, verify PASS, refactor while green, and commit: `chore(version): define v4 lifecycle protocol constants`.

4. Write failing test for: lifecycle events accept only the neutral schema.
   Test file: `test/lifecycle-contract.test.js`
   Level: unit
   Test intent: Given an event with an allowlisted type, deterministic ID, revision, normalized artifact refs, opaque proof refs, and delivery state, When it is validated, Then it passes; when it contains GitHub IDs, credentials, Enterprise commands, unknown top-level fields, or an unsupported type, Then validation fails with a stable machine error.
   Exercise through: `cli/lib/lifecycle-contract.js` exported validation and canonicalization functions.
   Test doubles: inject a fixed clock and payload; do not mock the contract validator.
   Expected RED: no module currently validates lifecycle event schema or neutral-field boundaries.
5. Run test — verify FAIL: `node --test test/lifecycle-contract.test.js`
6. Implement `cli/lib/lifecycle-contract.js` with the allowlist for `spec-approved`, `phase-complete`, and `plan-closed`, delivery statuses, 64 KiB serialized-event bound, stable event IDs, and canonical payload hashing; verify PASS, refactor while green, and commit: `feat(lifecycle): add neutral event contract`.

7. Write failing test for: canonical payload hashing is stable and bounded.
   Test file: `test/lifecycle-contract.test.js`
   Level: unit
   Test intent: Given semantically equivalent payloads with reordered keys, CRLF/LF-equivalent text, and differing delivery fields, When canonical hashing runs, Then equivalent payloads have the same hash, volatile delivery fields do not affect it, semantic content changes do affect it, and exactly-at/over-64 KiB serialized event payloads produce the specified boundary result.
   Exercise through: canonical payload serialization/hash and event-size validator.
   Test doubles: fixed payloads and clock; no filesystem, network, or contract-validator mock.
   Expected RED: canonical hashing currently has no tested stable-key/LF/volatile-field rules or size-boundary vectors.
8. Run test — verify FAIL: `node --test test/lifecycle-contract.test.js`
9. Implement stable-key ordering, LF normalization, delivery-field exclusion, and the 64 KiB boundary validator, verify PASS, refactor while green, and commit: `test(lifecycle): lock canonical payload identity`.

10. Write failing test for: artifact references are root-relative and hash-bounded.
   Test file: `test/lifecycle-contract.test.js`
   Level: unit
   Test intent: Given a serialized `spec` or `plan` artifact reference, When the pure contract validator receives it, Then it accepts only the allowlisted root/kind/relative-path/SHA-256 shape and rejects absolute, escaping, wrong-root, malformed, or mismatched-hash fields; filesystem-root existence and symlink checks are verified at T2's store boundary.
   Exercise through: `validateArtifactRef` and canonical artifact serialization.
   Test doubles: fixed path/hash objects only; no network or filesystem mock is needed for pure validation.
   Expected RED: artifact-reference shape validation is not present.
11. Run test — verify FAIL: `node --test test/lifecycle-contract.test.js`
12. Implement root-specific artifact-reference validation and stable error codes, verify PASS, refactor while green, and commit: `feat(lifecycle): validate artifact references`.

13. Write failing test for: adapter responses remain opaque and version-bounded.
   Test file: `test/lifecycle-contract.test.js`
   Level: unit
   Test intent: Given an adapter response with a supported outcome and matching event ID, When it is validated, Then it passes without requiring GitHub fields; given malformed status, missing event ID, credential, remote identifier, or unknown response field, Then validation fails with a stable code.
   Exercise through: `validateAdapterResponse` and stable adapter error-code exports.
   Test doubles: fixed response objects only; no filesystem or network.
   Expected RED: no adapter response validator exists.
14. Run test — verify FAIL: `node --test test/lifecycle-contract.test.js`
15. Implement the opaque adapter-response validator and neutral-field rejection, verify PASS, refactor while green, and commit: `feat(lifecycle): validate opaque adapter responses`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — Lifecycle Contract, Release and Ownership Contract, and acceptance rules for neutral events.
- `cli/lib/version.js` — current contract/pipeline version ownership.
- `cli/lib/envelope.js` — stable CLI error conventions.
- `test/cli.test.js` — existing `node:test` and JSON contract assertions.
- Context7 `/nodejs/node` — Node.js built-in API baseline for CommonJS modules.

## WHY THIS APPROACH
Complexity: deep
Justification: This is the shared interface for the event producer, Core dispatcher, Enterprise adapter, migration path, and release manifest. A mistake here would force every downstream task to reinterpret event identity, hashes, versions, or allowed fields.

## SANDWICH CONTEXT
[CRITICAL: Core may expose only neutral lifecycle names, artifact references, and opaque proof refs; it must not contain GitHub IDs, credentials, `gh` commands, or Enterprise policy.]
You are defining the v4 contract shared by Core and Enterprise for `Core and Enterprise Agent Surfaces`.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Design decision: Core transaction + durable lifecycle journal + Enterprise adapter.
Files in scope: `cli/lib/version.js`, `cli/lib/lifecycle-contract.js`, `test/lifecycle-contract.test.js`.
Architecture rule: the contract is versioned and allowlisted, and all later adapters consume opaque Core proof references rather than remote identity.
[RESTATE: Core must remain neutral; GitHub identity and Enterprise policy stay outside this contract.]

## DELIVERABLE
Given a valid v4 event type and neutral fields, When the contract is validated, Then it passes with a deterministic event identity and canonical payload hash.
Given the version module is loaded, When protocol constants are read, Then CLI contract, pipeline, lifecycle schema, adapter contract, and surface manifest versions are independently exposed.
Given a serialized artifact reference with an absolute path, path escape, wrong root, malformed field, or mismatched hash, When pure contract validation runs, Then it fails with a stable error; filesystem missing-root/symlink rejection and no-event behavior are verified by T2.
Given an adapter response with a supported status, When validation runs, Then it passes without requiring GitHub fields in Core.
Given an unknown top-level field or Enterprise/GitHub vocabulary in a Core event, When validation runs, Then it is rejected.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Independent constants represent CLI contract, pipeline, lifecycle schema, adapter contract, and surface manifest versions; package major 4 is validated by T5.
  - Event types, fields, statuses, artifact roots, stable IDs, canonical hashes, and serialized-size limits are allowlisted.
  - Validation errors are deterministic and contain no credential or remote identifier.
  - Tests are written before implementation and cover both accepted and rejected shapes.

Must-not-have:
  - No GitHub transport, GitHub ID, credential, remote ownership, merge, issue-close, or generic plugin framework.
  - No dependency beyond Node.js built-ins.

Open question risks:
  - If the spec changes the event vocabulary or artifact-root rule, stop and report NEEDS_CONTEXT before downstream tasks consume the contract.

Rollback note:
  - Revert the contract/version commit before any v4 release; do not rewrite existing v3 plan files or metadata.

Red flags:
  - Work outside the listed files → DONE_WITH_CONCERNS.
  - Any remote/Enterprise policy in the contract → STOP.

## STOP CONDITIONS
Done when: all contract tests pass, the neutral allowlist is explicit, and no remote vocabulary is accepted by Core validators.
Uncertain when: a required event field or version boundary is not settled by the spec.
Escalate when: implementing the contract would require Core to import Enterprise or GitHub code.

---

### Task 2: Build atomic lifecycle storage and artifact validation [depends: T1]

## OBJECTIVE
Create the authoritative lifecycle document store and reusable atomic file primitive. Persist plan state, event journal, and delivery ledger as one document; validate commit-time artifact references; support deterministic replay and integrity conflict detection without exposing partial success.

Steps:
1. Write failing test for: a valid transition commits state and one event atomically.
   Test file: `test/lifecycle-store.test.js`
   Level: integration
   Test intent: Given a plan directory and a valid neutral transition, When the lifecycle store commits it, Then `<spec_dir>/lifecycle.json` contains one state snapshot and one event with incremented revision, deterministic ID, normalized artifact reference, and delivery `pending`.
   Exercise through: the public lifecycle-store transition API against a temporary `spec_dir`.
   Test doubles: inject a deterministic clock and hash reader; use a real temporary filesystem and do not mock the store.
   Expected RED: `lifecycle.json` and a lifecycle-store API do not exist.
2. Run test — verify FAIL: `node --test test/lifecycle-store.test.js`
3. Implement `cli/lib/atomic-file.js` and `cli/lib/lifecycle-store.js` using temp-file plus rename, preserving file mode where applicable and cleaning temporary files; verify PASS, refactor while green, and commit: `feat(lifecycle): add atomic authoritative store`.

4. Write failing test for: root-specific artifact validation rejects invalid commit references.
   Test file: `test/lifecycle-store.test.js`
   Level: integration
   Test intent: Given `spec_dir` exists and `plan_dir` is null for `spec-approved`, When a plan-root, absolute, escaping, symlink-escaping, missing, cross-plan, or hash-mismatched artifact is submitted, Then state remains byte-identical and no event is appended; given a phase/closure transition without `plan_dir`, Then it is rejected.
   Exercise through: the lifecycle-store commit boundary with real temporary roots and symlinks where supported.
   Test doubles: inject the hash/stat reader only for deterministic I/O-error cases; do not mock path validation.
   Expected RED: no authoritative commit boundary enforces event-specific artifact roots.
5. Run test — verify FAIL: `node --test test/lifecycle-store.test.js`
6. Implement event-specific root/path/hash validation and stable failure codes, verify PASS, refactor while green, and commit: `feat(lifecycle): enforce artifact-root boundaries`.

7. Write failing test for: an invalid current-state transition emits no event.
   Test file: `test/lifecycle-store.test.js`
   Level: integration
   Test intent: Given a plan whose current lifecycle state cannot legally accept the requested event type, When the transition is submitted, Then state remains byte-identical, no event is appended, and no delivery entry becomes processable.
   Exercise through: the lifecycle-store transition API with a real persisted state fixture.
   Test doubles: deterministic clock only; use the real state validator and filesystem.
   Expected RED: no lifecycle state machine rejects invalid transitions before journal mutation.
8. Run test — verify FAIL: `node --test test/lifecycle-store.test.js`
9. Implement state-transition validation and the no-event failure path, verify PASS, refactor while green, and commit: `fix(lifecycle): reject invalid state transitions safely`.

10. Write failing test for: persistence failure prevents partial success.
   Test file: `test/lifecycle-store.test.js`
   Level: integration
   Test intent: Given a valid transition, When temp-file writing or same-directory rename fails before replacement, Then neither state nor event is visible, the previous lifecycle document is byte-identical, and no orphaned temporary file remains.
   Exercise through: the lifecycle-store API with injected write and rename failures plus a real temporary directory.
   Test doubles: fake only the atomic writer failure/rename boundary; use real JSON serialization, filesystem state, and cleanup assertions.
   Expected RED: direct `writeFileSync` behavior cannot provide all-or-nothing lifecycle state/event semantics, rename-failure handling, or temp cleanup.
11. Run test — verify FAIL: `node --test test/lifecycle-store.test.js`
12. Implement failure rollback and cleanup, verify PASS, refactor while green, and commit: `fix(lifecycle): prevent partial journal commits`.

13. Write failing test for: identical replay is a no-op.
   Test file: `test/lifecycle-store.test.js`
   Level: integration
   Test intent: Given an identical existing event, When the same logical transition repeats, Then it returns the original event ID and revision without appending a second event.
   Exercise through: the lifecycle-store API with a real persisted replay.
   Test doubles: deterministic clock only; use the real event lookup.
   Expected RED: no deterministic replay lookup exists.
14. Run test — verify FAIL: `node --test test/lifecycle-store.test.js`
15. Implement idempotent replay lookup, verify PASS, refactor while green, and commit: `feat(lifecycle): make identical transitions idempotent`.

16. Write failing test for: event ID payload conflict is terminal.
   Test file: `test/lifecycle-store.test.js`
   Level: integration
   Test intent: Given the same event ID with a different canonical payload, When it is submitted, Then a terminal integrity conflict is returned with no state, journal, or delivery mutation.
   Exercise through: the lifecycle-store API with two canonical payloads.
   Test doubles: none; use real hashing and persistence.
   Expected RED: event identity and payload integrity are not enforced together.
17. Run test — verify FAIL: `node --test test/lifecycle-store.test.js`
18. Implement canonical-hash conflict handling, verify PASS, refactor while green, and commit: `feat(lifecycle): enforce event payload integrity`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — normative lifecycle schema, artifact references, atomicity, identity, and conflict rules.
- `cli/lib/logjson.js` — existing direct writer and pipeline gate that must remain a projection concern.
- `cli/commands/structure.js:L635-L654` — existing temp-directory replacement pattern to reuse conceptually.
- `cli/lib/meta.js` — existing additive JSON serialization convention.
- `test/cli.test.js` — byte-parity assertions for JSON writers.
- Context7 `/nodejs/node` — exclusive file creation, rename semantics, and atomic temp-file patterns.

## WHY THIS APPROACH
Complexity: deep
Justification: The authoritative document is the consistency boundary for state, event identity, delivery status, and recovery. It needs filesystem failure injection, path security, canonicalization, and replay behavior that cannot be safely added as incidental logic in `log.js`.

## SANDWICH CONTEXT
[CRITICAL: `lifecycle.json` is the single authoritative document and must be replaced atomically; `log.json` and `.pocket-meta.json` must not become a second event journal.]
You are implementing the durable Core lifecycle store for the selected transaction-plus-journal design.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `cli/lib/atomic-file.js`, `cli/lib/lifecycle-store.js`, `test/lifecycle-store.test.js`.
Architecture rule: use Node built-ins, temp-file plus rename, event-specific root validation, and stable canonical hashes.
[RESTATE: No transition may expose partial state/event success or split the journal across other files.]

## DELIVERABLE
Given a valid transition, When it commits, Then state and exactly one event are durable in one authoritative document.
Given an invalid or unsafe artifact reference, When commit validation runs, Then state and events remain unchanged.
Given a writer failure, When commit runs, Then no successful state or processable event is exposed.
Given an identical replay, When commit runs, Then the original event is returned without a duplicate; given a different payload for the same event ID, Then a terminal integrity conflict is returned.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Atomic writer uses a same-directory temporary file and rename, cleans up on failure, and supports deterministic failure injection.
  - Root-relative references reject absolute paths, escapes, symlink escapes, missing roots, cross-plan paths, and hash mismatches.
  - Revision increments only on successful event-emitting transitions; identical replay does not increment.
  - Tests cover real filesystem persistence plus injected writer failures.

Must-not-have:
  - No direct remote calls, no GitHub fields, no second event journal, and no destructive v3 conversion.
  - Do not reimplement canonical event hashing from T1.

Open question risks:
  - If the filesystem cannot guarantee same-device rename for the selected temp path, report NEEDS_CONTEXT and preserve the old authoritative file rather than falling back to copy.

Rollback note:
  - Remove the new lifecycle store and leave existing `log.json`/metadata untouched; pending v4 files may be deleted only by an explicit operator rollback outside this task.

Red flags:
  - Any write to `log.json` or `.pocket-meta.json` from the store → STOP.
  - Any copied-file fallback after rename failure → STOP.

## STOP CONDITIONS
Done when: store tests pass, failed commits leave the authoritative file unchanged, and replay/conflict semantics are deterministic.
Uncertain when: a path or rename error cannot be classified without weakening fail-closed behavior.
Escalate when: a second authoritative state file or remote dependency is proposed.

---

### Task 3: Integrate Core transitions with log state and projection [depends: T2] [parallel: T5]

## OBJECTIVE
Expose `lifecycle transition` through the CLI and make `log update`/`log close` commit lifecycle state and event before updating the repairable `log.json` projection. Keep the Core critical path local-first and extract orchestration from the already-large `cli/commands/log.js` into a focused transition module.

Steps:
1. Write failing test for: CLI transition emits a valid spec-approved event.
   Test file: `test/lifecycle-cli.test.js`
   Level: integration
   Test intent: Given an approved spec with valid spec-root artifacts, When `pocketto-pi lifecycle transition <spec_dir> spec-approved ... --json --contract 3` runs, Then the JSON envelope contains event ID, revision, status, and `plan_dir: null`, and exactly one durable event is recorded.
   Exercise through: `cli/index.js` child-process entry point and the real temporary spec layout.
   Test doubles: inject a deterministic clock and local artifact fixture; do not mock CLI dispatch or the store.
   Expected RED: CLI has no `lifecycle` command or contract 3 transition path.
2. Run test — verify FAIL: `node --test test/lifecycle-cli.test.js`
3. Implement lifecycle argument parsing, `lifecycle transition`, and `cli/lib/lifecycle-transition.js`; route through the existing envelope and contract handshake; verify PASS, refactor while green, and commit: `feat(cli): expose neutral lifecycle transitions`.

4. Write failing test for: phase completion captures branch and emits only at REVIEW.
   Test file: `test/lifecycle-cli.test.js`
   Level: integration
   Test intent: Given phase `phase-1` has valid completion evidence, `plan_dir` exists, and branch `feature/issue-50` is current, When Core commits `phase-complete` at revision 4, Then the event records the branch and plan-root evidence while the phase is `REVIEW`; changing that phase to `DONE` later does not emit a second phase-complete event.
   Exercise through: phase-level `log update` and lifecycle store inspection in a temporary git repository.
   Test doubles: deterministic clock and git fixture; do not mock event persistence.
   Expected RED: `log update` only mutates `log.json` and captures no lifecycle branch/revision event.
5. Run test — verify FAIL: `node --test test/lifecycle-cli.test.js`
6. Integrate phase-complete emission into `log update` without changing existing task/SHA rules, verify PASS, refactor while green, and commit: `feat(log): emit phase completion lifecycle events`.

7. Write failing test for: plan closure commits the final event with DONE atomically.
   Test file: `test/lifecycle-cli.test.js`
   Level: integration
   Test intent: Given every phase is eligible for closure, a non-null `plan_dir`, and final closure artifacts, When `pocketto-pi log close <plan_dir> --json --contract 3` runs, Then the authoritative lifecycle document records one `plan-closed` event with final plan state and plan-root artifact references in the same operation that sets the projected plan status to `DONE`, and replay does not emit another closure event.
   Exercise through: public `log close`, lifecycle document, final artifact references, and projected `log.json` in a temporary plan.
   Test doubles: deterministic clock and projection writer only; use real lifecycle persistence.
   Expected RED: `log close` currently writes only `log.json` and has no closure event boundary or final artifact validation.
8. Run test — verify FAIL: `node --test test/lifecycle-cli.test.js`
9. Integrate closure emission with `log close`, verify PASS, refactor while green, and commit: `feat(log): emit plan closure lifecycle events`.

10. Write failing test for: Core CLI starts without Enterprise-only modules.
   Test file: `test/lifecycle-cli.test.js`
   Level: integration
   Test intent: Given a staged Core role that omits `cli/commands/mode.js`, `cli/commands/meta.js`, and `cli/commands/format.js`, When the Core CLI runs `--version` and a neutral lifecycle command, Then it starts successfully, loads only the neutral command registry, and does not require Enterprise policy or GitHub metadata modules; the omitted-module list is a local fixture and final module ownership follows the T5 manifest.
   Exercise through: the staged Core CLI entry point and a temporary role directory.
   Test doubles: temporary filesystem and module-load recorder; do not mock the neutral dispatcher.
   Expected RED: `cli/index.js` eagerly imports every command module, so omitting Enterprise-only modules causes startup failure.
11. Run test — verify FAIL: `node --test test/lifecycle-cli.test.js`
12. Refactor `cli/index.js` into a Core-safe lazy command registry with an explicit Enterprise registration hook, verify PASS, refactor the registry while green, and commit: `refactor(cli): isolate Enterprise command loading`.

13. Write failing test for: projection failure is explicit and defers dispatch.
   Test file: `test/lifecycle-cli.test.js`
   Level: integration
   Test intent: Given lifecycle state and event revision 4 commit successfully, When the derived `log.json` projection write fails, Then the command returns `PROJECTION_REPAIR_REQUIRED` with event ID, revision, `lifecycle_committed: true`, and `dispatch_deferred: true`; the event remains pending and no adapter invocation occurs.
   Exercise through: `log update` and `log close` with an injected projection writer failure and recording adapter runner.
   Test doubles: fake only the projection writer and adapter executable; keep lifecycle persistence real.
   Expected RED: `logjson.writeLog` cannot distinguish authoritative commit from projection failure or prevent dispatch.
14. Run test — verify FAIL: `node --test test/lifecycle-cli.test.js`
15. Extract state-changing orchestration from `cli/commands/log.js` into `cli/lib/lifecycle-transition.js`, make `cli/lib/logjson.js` an explicit projection writer, and return the stable repair error without dispatch; verify PASS, refactor while green, and commit: `refactor(log): isolate lifecycle transition orchestration`.

16. Write failing test for: Core-only transition never performs Enterprise work.
   Test file: `test/lifecycle-cli.test.js`
   Level: integration
   Test intent: Given only Core v4 is installed and no adapter registration exists, When a valid transition is committed, Then local state succeeds, the event is available as pending, and no `gh`, Enterprise handler, credential, or remote operation is attempted.
   Exercise through: CLI transition and `log update` using a temporary project without `.pocket/lifecycle-adapter.json`.
   Test doubles: recording child-process/adapter runner; do not mock lifecycle persistence.
   Expected RED: no local-first event path exists.
17. Run test — verify FAIL: `node --test test/lifecycle-cli.test.js`
18. Implement the local-first dispatch decision and stable JSON data fields without importing Enterprise modules, verify PASS, refactor while green, and commit: `feat(cli): preserve Core-only local execution`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — Core emitter timing, projection failure, exact CLI operations, and Core-only behavior.
- `cli/index.js:L36-L281` — parser, contract check, command dispatch, and envelope ownership.
- `cli/commands/log.js:L418-L779` — phase/task mutation and close paths; this file is 798 lines and requires extraction.
- `cli/lib/logjson.js:L9-L40` — current pipeline gate and direct projection writer.
- `test/cli.test.js` — current child-process CLI fixtures and envelope assertions.

## WHY THIS APPROACH
Complexity: deep
Justification: This task crosses the public CLI boundary, existing state-machine invariants, and the new authoritative commit/projection order. Extracting orchestration prevents the 798-line log command from becoming an unreviewable mixed Core/Enterprise module.

## SANDWICH CONTEXT
[CRITICAL: Core commits lifecycle state/event before `log.json`; a projection failure must be repairable and must never dispatch a pending event.]
You are integrating the neutral lifecycle transaction into existing Core commands.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `cli/index.js`, `cli/commands/log.js`, `cli/lib/logjson.js`, `cli/lib/lifecycle-transition.js`, `cli/commands/lifecycle.js`, `test/lifecycle-cli.test.js`.
Architecture rule: preserve the existing JSON envelope/contract checks and keep `log.json` as a projection only.
[RESTATE: A projection failure is `PROJECTION_REPAIR_REQUIRED`, not a successful dispatch.]

## DELIVERABLE
Given valid approval, phase, or closure state, When Core transitions, Then one event and the state snapshot are committed before the projection update.
Given a phase completion, When the transition is emitted, Then it is tied to `REVIEW`; changing the phase to `DONE` later does not emit a duplicate `phase-complete` event.
Given projection failure, When the command returns, Then the lifecycle commit remains durable, dispatch is deferred, and repair can be invoked later.
Given no Enterprise installation, When Core succeeds, Then no remote operation occurs and the event remains locally available.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - `lifecycle transition` supports repeatable `--artifact <root>:<kind>:<relative-path>:<sha256>` and emits contract 3 envelopes.
  - `log update` and `log close` use the same transition coordinator and preserve all existing pipeline/status/SHA rules.
  - `PROJECTION_REPAIR_REQUIRED` includes the normative fields and leaves dispatch deferred.
  - `cli/commands/log.js` does not grow the lifecycle orchestration inline; extracted logic has a focused responsibility.

Must-not-have:
  - Core must not import `enterprise/**`, call `gh`, inspect GitHub IDs, or encode Enterprise policy.
  - Do not emit `phase-complete` when `log close` later changes `REVIEW` to `DONE`.

Open question risks:
  - If an existing log shape cannot be projected from lifecycle state without losing v3 fields, report NEEDS_CONTEXT and preserve the old projection rather than silently dropping fields.

Rollback note:
  - Pin active v3 plans to the v3 CLI; remove the v4 lifecycle hooks while preserving existing `log.json` and metadata.

Red flags:
  - Any remote invocation before authoritative local commit → STOP.
  - Any direct hand-edit or second writer for `log.json` → DONE_WITH_CONCERNS.

## STOP CONDITIONS
Done when: lifecycle CLI and existing log commands pass the new tests plus the baseline CLI suite, projection failures are explicit, and Core-only runs have zero remote calls.
Uncertain when: an existing status transition cannot be represented in lifecycle state without changing v3 behavior.
Escalate when: a change requires the Core command to know Enterprise/GitHub policy.

---

### Task 4: Implement lifecycle drain, repair, claims, and opaque adapter dispatch [depends: T3] [test-risk]

## OBJECTIVE
Add deterministic replay operations that process pending lifecycle events without creating new events. Implement `drain` ordering, per-plan claims and lease recovery, registered-adapter invocation, bounded retry classification, and `repair` projection rebuild while keeping the adapter opaque to Core.

Steps:
1. Write failing test for: drain processes contiguous revisions in order without creating events.
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given pending/retryable events for one plan at contiguous revisions 1, 2, and 3, When `lifecycle drain` runs, Then it dispatches them serially in ascending revision, creates no new event, and preserves each original event ID.
   Exercise through: public `lifecycle drain` with a temporary plan and fake adapter executable.
   Test doubles: fake adapter executable and fixed clock; use real store/ledger files.
   Expected RED: no drain command or revision-ordered delivery loop exists.
2. Run test — verify FAIL: `node --test test/lifecycle-dispatch.test.js`
3. Implement the drain command, revision ordering, and no-event-creation behavior; verify PASS, refactor while green, and commit: `feat(lifecycle): add ordered event drain`.

4. Write failing test for: revision gaps remain pending with an actionable diagnostic.
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given revision 5 arrives while revision 4 is unavailable, When drain runs, Then revision 5 is not applied out of order, remains pending, and the result includes plan ID, blocked revision, missing predecessor, and the next actionable recovery step.
   Exercise through: public `lifecycle drain` and JSON envelope inspection.
   Test doubles: fake adapter executable and fixed clock; use real event ledger.
   Expected RED: no gap classification or actionable diagnostic exists.
5. Run test — verify FAIL: `node --test test/lifecycle-dispatch.test.js`
6. Implement gap detection and stable diagnostic data, verify PASS, refactor while green, and commit: `feat(lifecycle): preserve revision gaps during drain`.

7. Write failing test for: repair rebuilds the projection without a new event.
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given committed lifecycle state and event revision 4 with a damaged or missing `log.json`, When `lifecycle repair <spec_dir> --json --contract 3` runs, Then `log.json` is rebuilt, revision and journal length remain unchanged, and no adapter dispatch or new event occurs.
   Exercise through: public `lifecycle repair` and real temporary projection files.
   Test doubles: injected projection writer failure only; use real lifecycle state.
   Expected RED: no repair command or projection rebuild exists.
8. Run test — verify FAIL: `node --test test/lifecycle-dispatch.test.js`
9. Implement repair projection reconstruction and idempotence, verify PASS, refactor while green, and commit: `feat(lifecycle): add projection repair`.

10. Write failing test for: duplicate workers cannot both claim one event.
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given two workers receive the same pending event, When both attempt processing, Then only one UUID-owned claim succeeds and only one adapter invocation is possible.
   Exercise through: the drain worker with concurrent processes or deterministic lock-owner simulation.
   Test doubles: fake adapter runner; use real `.lifecycle.lock` and ledger state.
   Expected RED: no exclusive claim primitive or owner record exists.
11. Run test — verify FAIL: `node --test test/lifecycle-dispatch.test.js`
12. Implement exclusive claim acquisition and cleanup, verify PASS, refactor while green, and commit: `feat(lifecycle): prevent duplicate event claims`.

13. Write failing test for: expired claims are reclaimable without concurrent invocation.
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given a claimed event with an expired 60-second lease, When a later worker drains, Then it may reclaim the event, records the new owner, and does not overlap the expired worker's invocation.
   Exercise through: the drain worker with deterministic clock and lock-owner fixtures.
   Test doubles: fake clock and adapter runner; use real claim/ledger state.
   Expected RED: no lease-expiry or safe reclaim behavior exists.
14. Run test — verify FAIL: `node --test test/lifecycle-dispatch.test.js`
15. Implement lease expiry, reclaim, and cleanup behavior, verify PASS, refactor while green, and commit: `feat(lifecycle): recover expired event claims`.

16. Write failing test for: adapter protocol failures are bounded and remote-free in Core.
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given missing registration, wrong adapter contract, timeout, non-zero exit, or malformed response, When Core drains a committed event, Then it records a retryable protocol error with the original event ID and bounded attempt count; given timeout/rate-limit after the initial invocation, Then delays are `1s`, `5s`, `30s`, `120s`, and `600s` before terminal/manual state; Core performs zero GitHub calls.
   Exercise through: Core drain with temporary `.pocket/lifecycle-adapter.json` variants and recording executables.
   Test doubles: fake executable/runner and clock; never invoke a real network or `gh` command.
   Expected RED: Core has no registered adapter protocol, retry schedule, or failure classification.
17. Run test — verify FAIL: `node --test test/lifecycle-dispatch.test.js`
18. Implement `cli/lib/lifecycle-dispatch.js` for registration validation, argv invocation, timeout/non-zero handling, bounded retry classification, response validation from T1, and opaque proof persistence; verify PASS, refactor while green, and commit: `feat(lifecycle): dispatch registered adapters safely`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — delivery statuses, claims, retry bounds, drain ordering, repair, and adapter registration.
- `cli/lib/lifecycle-contract.js` — shared status/response validation from T1.
- `cli/lib/atomic-file.js` and `cli/lib/lifecycle-store.js` — atomic state and lock primitives from T2.
- `cli/commands/structure.js:L635-L654` — existing atomic replacement behavior for projection/layout recovery.
- `cli/lib/envelope.js` — stable error envelope expectations.
- `test/cli.test.js` — child-process and deterministic fixture conventions.

## WHY THIS APPROACH
Complexity: deep
Justification: Drain combines persistence, ordering, concurrency, subprocess boundaries, retry classification, and projection repair. The test level is intentionally integration because isolated unit tests cannot prove that claims, revisions, the event ledger, and the adapter invocation cooperate safely.

## SANDWICH CONTEXT
[CRITICAL: `drain` never creates events, processes one plan serially in ascending revision, and Core treats the registered adapter as an opaque executable.]
You are implementing replay and recovery for the Core lifecycle journal.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `cli/commands/lifecycle.js`, `cli/lib/lifecycle-dispatch.js`, `cli/lib/lifecycle-store.js`, `test/lifecycle-dispatch.test.js`.
Architecture rule: claims use a 60-second UUID-owned lease; retries are bounded; no GitHub policy enters Core.
[RESTATE: Never dispatch a pending event out of order or turn a protocol failure into a remote mutation.]

## DELIVERABLE
Given revisions with no gap, When drain runs, Then events process serially in ascending revision and no event is created.
Given a revision gap, When a later event arrives, Then it remains pending with an actionable diagnostic.
Given duplicate workers, When they claim one event, Then only one can invoke the adapter.
Given an expired claim, When a later worker retries, Then the event is reclaimable.
Given a projection failure, When repair runs, Then `log.json` is rebuilt without changing revision or emitting an event.
Given protocol/timeout/non-zero failures, When dispatch runs, Then delivery is retryable or terminal according to the bounded policy and no credentials enter output.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Delivery attempts increment before invocation and distinguish `pending`, `claimed`, `succeeded`, `retryable`, `terminal`, and `reconciling`.
  - A stale lower revision is a no-op, while a missing predecessor leaves a gap pending.
  - The adapter command receives an event file plus `--json --contract 3`; Core validates only the neutral response envelope.
  - Repair is idempotent and never changes lifecycle revision or emits an event.

Must-not-have:
  - No unbounded retry loop, concurrent per-plan remote delivery, event creation from drain, or GitHub call in Core.
  - Do not use a generic queue/event framework.

Open question risks:
  - If platform-specific locking cannot provide the lease semantics, report NEEDS_CONTEXT and keep the event pending rather than allowing concurrent delivery.

Rollback note:
  - Disable/remove the adapter registration; retain lifecycle journal and replay original event IDs after a corrected adapter is installed.

Red flags:
  - A retryable protocol error mutates remote state → STOP.
  - A repair command increments revision or writes a new event → STOP.

## STOP CONDITIONS
Done when: drain/repair tests pass, claim/retry behavior is bounded and deterministic, and the baseline CLI suite remains green.
Uncertain when: a filesystem lock race cannot be reproduced or classified.
Escalate when: safe ordering requires a remote queue or a Core-to-GitHub dependency.

---

### Task 5: Build the manifest-driven four-role release surfaces [depends: T2]

## OBJECTIVE
Replace implicit package-wide inclusion with an explicit `surfaces.json` manifest and deterministic staging for `pi/core`, `pi/enterprise`, `claude/core`, and `claude/enterprise`. Make Enterprise a delta that requires its matching Core role, classify every CLI module as Core/shared/Enterprise-owned, and make staging/installation atomic through the shared file primitive. The manifest must also describe the lazy CLI boundary so Core can start without Enterprise-only command modules.

Steps:
1. Write failing test for: the manifest declares exactly four explicit roles and no wildcard package surface.
   Test file: `test/surfaces.test.js`
   Level: integration
   Test intent: Given a synthetic source fixture and the canonical manifest, When the surface manifest is loaded, Then it contains exactly `pi/core`, `pi/enterprise`, `claude/core`, and `claude/enterprise`, each with explicit `includes`, `requires`, `forbidden_paths`, and `forbidden_content`; Enterprise roles require matching Core roles, no role relies on `skills/**`, and ownership explicitly classifies `cli/commands/mode.js`, `cli/lib/mode.js`, `cli/commands/meta.js`, `cli/lib/meta.js`, `cli/commands/format.js`, `cli/lib/bodies.js`, `cli/lib/identity.js`, and `cli/lib/reconcile.js`.
   Exercise through: `scripts/build-surfaces.js` manifest validation with the fixture source tree.
   Test doubles: temporary synthetic source/output directories; do not mock manifest parsing.
   Expected RED: no `surfaces.json` or manifest builder exists and `package.json` still has `skills/**`.
2. Run test — verify FAIL: `node --test test/surfaces.test.js`
3. Create `surfaces.json`, `scripts/build-surfaces.js`, and `cli/lib/surface-manifest.js`; update `package.json` to major `4.0.0` while leaving archive/host integration for Step 9, with no publish until Step 9 completes; verify PASS, refactor while green, and commit: `feat(release): add explicit four-role surface manifest`.

4. Write failing test for: manifest staging rejects missing, duplicate, or forbidden fixture entries before partial output.
   Test file: `test/surfaces.test.js`
   Level: integration
   Test intent: Given a synthetic manifest/source fixture, When a declared include is missing, a source is owned by two roles, or forbidden content is present, Then validation fails before replacing the target role directory and returns the offending role/path/content.
   Exercise through: manifest-driven staging against temporary fixture variants.
   Test doubles: temporary source/output directories; use real atomic replacement and validators.
   Expected RED: current package selection has no explicit ownership or pre-write validation.
5. Run test — verify FAIL: `node --test test/surfaces.test.js`
6. Implement explicit include/require/forbidden checks, deterministic copy ordering, same-root atomic replacement, and role-specific validation; verify PASS, refactor while green, and commit: `feat(release): stage manifest roles atomically`.

7. Write failing test for: package metadata and role staging use v4 release inputs.
   Test file: `test/surfaces.test.js`
   Level: integration
   Test intent: Given the v4 manifest builder exists, When the release/archive integration runs before host integration is wired, Then it fails until `rebuild-skills.sh`, the explicit package file list, and both Claude host manifests consume the manifest without wildcard ownership.
   Exercise through: `node scripts/build-surfaces.js --role pi/core --output <dir>`, `rebuild-skills.sh` in a temporary copy, and host/package metadata inspection.
   Test doubles: temporary output/archive directory; no network or registry access.
   Expected RED: Step 3 created the builder and changed the package major, but archive rebuilding and host-manifest integration are still direct/wildcard-based.
8. Run test — verify FAIL: `node --test test/surfaces.test.js`
9. Update `rebuild-skills.sh`, the explicit package file list, and `.claude-plugin/plugin.json`/`.claude-plugin/marketplace.json` to consume the manifest while preserving archive generation; verify PASS, refactor while green, and commit: `chore(release): align package and host metadata with surfaces`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — Release and Ownership Contract and surface acceptance rules.
- `package.json:L1-L51` — current package major, files wildcard, and scripts.
- `rebuild-skills.sh` — current archive generation behavior.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — current Claude host metadata.
- `cli/commands/structure.js:L635-L654` and `cli/lib/atomic-file.js` — atomic replacement patterns.
- `test/package.test.js` — tarball, archive, citation, and asset inventory conventions.

## WHY THIS APPROACH
Complexity: standard
Justification: The manifest is an independent release boundary and can be implemented while Core command work proceeds. Explicit role validation is safer than trying to infer ownership from directory names during packaging.

## SANDWICH CONTEXT
[CRITICAL: The v4 manifest must define exactly four roles and may not rely on the package-wide `skills/**` wildcard or duplicate Core source inside Enterprise.]
You are implementing deterministic staging for the same canonical repository's Pi and Claude Code surfaces.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `surfaces.json`, `scripts/build-surfaces.js`, `cli/lib/surface-manifest.js`, `package.json`, `rebuild-skills.sh`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `test/surfaces.test.js`.
Architecture rule: Enterprise entries are deltas requiring matching Core entries, and staging uses atomic replacement.
[RESTATE: A role that leaks Enterprise content or duplicates Core source is invalid and must fail closed.]

## DELIVERABLE
Given a valid manifest and source fixture, When a role is staged, Then all declared includes exist and all forbidden paths/content are absent.
Given an Enterprise role, When it is staged, Then its matching Core role is required and no Core skill is copied into the Enterprise delta.
Given a CLI module classified as Enterprise-only, When the manifest is validated for a Core role, Then its ownership/exclusion is explicit; Core startup without that module is verified by T3's dispatcher test.
Given a duplicate/missing/wildcard role definition, When validation runs, Then release staging fails before writing partial output; final canonical role contents are verified by T6, T7, and T14.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - `surfaces.json` has schema 1, release major 4, and exactly four named roles.
  - Each role has explicit includes/requires/forbidden paths/content; all copies are deterministic and atomic.
  - CLI command/module ownership is explicit; T3 proves the Core dispatcher does not fail at startup when Enterprise-only modules are omitted.
  - Package version is `4.0.0` and package files no longer rely on `skills/**`.
  - The manifest builder has fixture-backed validation independent of later Enterprise source files.
  - Existing archive/citation checks continue to run.

Must-not-have:
  - No second source repository, package-wide wildcard, or copied Core tree in Enterprise.
  - No removal of v3 source behavior from the already-published v3 artifact through a destructive rewrite.

Open question risks:
  - If a current skill cannot be classified as Core/shared/Enterprise without changing behavior, report NEEDS_CONTEXT and preserve it outside the Core role until the ownership decision is explicit.

Rollback note:
  - Pin/release the last compatible v4 staging script; restore prior package metadata without deleting `.pocket-meta.json`, `log.json`, or remote markers.

Red flags:
  - A manifest validation failure leaves a partially written role directory → STOP.
  - A role silently includes a path not listed in its manifest → STOP.

## STOP CONDITIONS
Done when: the four role definitions validate, synthetic role staging is atomic/reproducible, forbidden checks pass, and package metadata no longer relies on `skills/**`; canonical role contents are completed by T6/T7/T14.
Uncertain when: ownership cannot be represented without copying Core files.
Escalate when: release staging requires a second canonical source or an implicit wildcard.

---

### Task 6: Split Core and Enterprise skill instructions without duplicating Core [depends: T5]

## OBJECTIVE
Remove Enterprise choreography from v4 Core skill artifacts while preserving neutral lifecycle handoffs. Move issue creation, onboarding remote setup, and phase/closure reporting into the Enterprise-owned adapter surface. Add the Enterprise-only lifecycle adapter skill and references as a manifest-owned delta. Keep the existing published v3 flow unchanged through release/version compatibility rather than maintaining a second mutable Core copy.

Steps:
1. Write failing test for: Core skill staging has no Enterprise instructions while retaining neutral lifecycle handoffs.
   Test file: `test/skill-surfaces.test.js`
   Level: integration
   Test intent: Given the four-role staging output, When the Pi/Claude Core artifacts are inspected and the grinding handoff fixture is executed, Then `create-pr`, `enterprise-reporting.md`, embedded `gh` issue/PR instructions from `pocket-grinding`, `pocket-init`, `pocket-development`, and `pocket-closing`, Enterprise policy, and remote credentials are absent, while Core lifecycle event names, artifact references, and local-first repair/drain instructions remain; the handoff invokes neutral `spec-approved` before pocket-planning rather than performing issue creation.
   Exercise through: role staging, Markdown path/content scanners, and the ordered pocket-grinding handoff fixture.
   Test doubles: temporary staging output and a recording CLI/skill runner; do not mock the scanner or builder.
   Expected RED: current grinding has embedded `gh issue create` after approval, current development/closing have Enterprise branches, and no Core/Enterprise distinction exists.
2. Run test — verify FAIL: `node --test test/skill-surfaces.test.js`
3. Modify `skills/pocket-grinding/SKILL.md` to remove `gh issue create`/`.pocket-meta.json` writes and emit `spec-approved` through the neutral lifecycle CLI before handing off to pocket-planning; modify `skills/pocket-init/SKILL.md` to keep local onboarding only, `skills/pocket-help/SKILL.md` to keep Core routing only, `skills/pocket-development/SKILL.md` and `skills/pocket-closing/SKILL.md` to remove Enterprise reporting, and `skills/pocket-development/references/enterprise-reporting.md` to remain Enterprise-owned; verify PASS, refactor while green, and commit: `refactor(skills): remove Enterprise choreography from Core`.

4. Write failing test for: Enterprise staging adds adapter skills/references without copying Core skills and preserves legacy v3 ownership.
   Test file: `test/skill-surfaces.test.js`
   Level: integration
   Test intent: Given a Core role, When its matching Enterprise role is staged, Then only the registered adapter, Enterprise lifecycle instructions, onboarding reference, reconciliation references, and Enterprise-owned `create-pr`/reporting references are added; no Core skill is copied into the Enterprise delta, and the v3 source snapshot is not destructively rewritten.
   Exercise through: `pi/enterprise` and `claude/enterprise` manifests plus role-owned archive source/member parity checks.
   Test doubles: temporary role directories and archive inspection; no GitHub calls.
   Expected RED: no Enterprise lifecycle skill or role-specific archive exists, and current mixed files are not classified by a manifest.
5. Run test — verify FAIL: `node --test test/skill-surfaces.test.js`
6. Create `skills/pocket-enterprise/SKILL.md`, `skills/pocket-enterprise/references/lifecycle-contract.md`, `skills/pocket-enterprise/references/issue-reconciliation.md`, `skills/pocket-enterprise/references/phase-reconciliation.md`, and `skills/pocket-enterprise/references/onboarding.md`; classify `skills/create-pr/**`, `skills/pocket-development/references/enterprise-reporting.md`, and the extracted Enterprise onboarding content from `skills/pocket-init/SKILL.md`/`skills/pocket-help/SKILL.md` as Enterprise-owned, update `skills/create-pr/SKILL.md` to the v4 adapter contract, rebuild exactly `skills/pocket-development/pocket-development.skill`, `skills/pocket-closing/pocket-closing.skill`, `skills/pocket-grinding/pocket-grinding.skill`, `skills/pocket-init/pocket-init.skill`, `skills/pocket-help/pocket-help.skill`, `skills/create-pr/create-pr.skill`, and `skills/pocket-enterprise/pocket-enterprise.skill` from their role-owned manifest source sets with `rebuild-skills.sh`, and verify PASS, refactor while green, and commit: `feat(skills): add Enterprise lifecycle adapter surface`.

7. Write failing test for: skill citations and bundled archives remain self-consistent after the split.
   Test file: `test/package.test.js`
   Level: integration
   Test intent: Given all source skill directories and archives, When the package/archive suite runs, Then every active citation resolves within the selected role, every archive member matches the archiveable source files owned by its selected role in `surfaces.json`, deprecated skill names remain absent, and Core artifacts contain no Enterprise-only path/content.
   Exercise through: `npm pack`, archive extraction, citation scanner, and surface builder.
   Test doubles: temporary tarball/extraction directory; no network.
   Expected RED: the existing archive/citation test has no role-aware forbidden-content assertions, so it cannot prove Core forbidden-content or no-duplication rules even after the archives are rebuilt in Step 6.
8. Run test — verify FAIL: `node --test test/package.test.js`
9. Add role-aware package assertions, rebuild archives, verify PASS, explicitly refactor the scanner/assertion organization while green (whether or not duplication is found), and commit: `test(skills): verify split artifacts and archive parity`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — Core/Enterprise ownership, v3/v4 compatibility, and no-duplicate requirements.
- `skills/pocket-development/SKILL.md` — current embedded Enterprise phase-completion flow.
- `skills/pocket-development/references/enterprise-reporting.md` — current Enterprise-only reporting source of truth.
- `skills/pocket-closing/SKILL.md` — current Enterprise approval/closeout sections.
- `skills/create-pr/SKILL.md` — current recorder-only Enterprise behavior.
- `rebuild-skills.sh` and `test/package.test.js` — archive and citation conventions.

## WHY THIS APPROACH
Complexity: deep
Justification: The skill files are the product surface, and removing Enterprise instructions without losing neutral lifecycle handoffs is a semantic split rather than a copy operation. The task also has to preserve the v3 release contract without creating a second mutable source tree.

## SANDWICH CONTEXT
[CRITICAL: Core artifacts must contain no Enterprise-only paths, instructions, GitHub vocabulary, credentials, or remote commands; Enterprise must be additive and must not copy Core skills.]
You are splitting the host-facing workflow artifacts for v4.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `skills/pocket-grinding/SKILL.md`, `skills/pocket-grinding/pocket-grinding.skill`, `skills/pocket-init/SKILL.md`, `skills/pocket-init/pocket-init.skill`, `skills/pocket-help/SKILL.md`, `skills/pocket-help/pocket-help.skill`, `skills/pocket-development/SKILL.md`, `skills/pocket-development/references/enterprise-reporting.md`, `skills/pocket-development/pocket-development.skill`, `skills/pocket-closing/SKILL.md`, `skills/pocket-closing/pocket-closing.skill`, `skills/create-pr/SKILL.md`, `skills/create-pr/create-pr.skill`, `skills/pocket-enterprise/SKILL.md`, `skills/pocket-enterprise/pocket-enterprise.skill`, `skills/pocket-enterprise/references/lifecycle-contract.md`, `skills/pocket-enterprise/references/issue-reconciliation.md`, `skills/pocket-enterprise/references/phase-reconciliation.md`, `skills/pocket-enterprise/references/onboarding.md`, `surfaces.json`, `rebuild-skills.sh`, `test/skill-surfaces.test.js`, and `test/package.test.js`.
Architecture rule: one canonical source repository, explicit role ownership, and published v3 artifacts remain the compatibility boundary.
[RESTATE: Do not solve v3 compatibility by duplicating or silently rewriting Core workflows.]

## DELIVERABLE
Given the v4 Core role, When it is installed, Then it remains locally useful, emits neutral `spec-approved` before planning, and cannot perform Enterprise remote side effects.
Given Core v4, When Enterprise v4 is added, Then adapter/lifecycle files, issue/PR/closure reconciliation, and onboarding references become available without copied Core skills.
Given the v4 Enterprise role is staged, When ownership validation runs, Then the v3 source snapshot is preserved without destructive rewrite; v3 workflow execution and warning behavior are verified by T11's compatibility task.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Core `pocket-grinding`, `pocket-init`, `pocket-development`, and `pocket-closing` contain only local/neutral lifecycle behavior; Enterprise issue creation, onboarding remote setup, and reporting are Enterprise-owned.
  - New Enterprise skill references at `skills/pocket-enterprise/references/lifecycle-contract.md`, `issue-reconciliation.md`, `phase-reconciliation.md`, and `onboarding.md` explain registration, issue/PR/closure proof, onboarding, and fail-closed behavior without being included in Core.
  - All changed `.skill` archives contain exactly the archiveable source files owned by their selected role in `surfaces.json`.
  - Tests prove forbidden paths/content and no Core duplication.

Must-not-have:
  - Do not copy all Core skills into Enterprise.
  - Do not modify a v3 artifact in place, add automatic downgrade, or add a generic plugin framework.

Open question risks:
  - If a host requires a different plugin entry point for deltas, report NEEDS_CONTEXT and keep the manifest explicit rather than adding a wildcard.

Rollback note:
  - Reinstall the last compatible v4 Enterprise artifact; leave Core and the lifecycle journal in place. Legacy v3 plans stay on the v3 release.

Red flags:
  - Enterprise instruction appears in a Core role → STOP.
  - A changed archive differs from its role-owned manifest source set → STOP.

## STOP CONDITIONS
Done when: Core/Enterprise role tests, archive parity, citation checks, and baseline tests are green.
Uncertain when: a mixed skill cannot be split without changing neutral behavior.
Escalate when: the split requires a second canonical Core source or automatic legacy conversion.

---

### Task 7: Implement Enterprise adapter registration, protocol, and transport seam [depends: T2] [parallel: T3] [test-risk]

## OBJECTIVE
Implement the Enterprise-owned registered adapter executable, atomic installation record, compatibility preflight, `gh` transport seam, metadata access, and explicit error/retry classification. Keep all GitHub IDs, ownership rules, and remote calls in Enterprise-only files; Core sees only the opaque registration contract from T1.

Steps:
1. Write failing test for: registration installation and preflight are atomic and fail closed.
   Test file: `test/enterprise-protocol.test.js`
   Level: integration
   Test intent: Given a project root, When Enterprise installs the adapter, Then `.pocket/lifecycle-adapter.json` is atomically written with schema 1, adapter contract 1, executable argv, event allowlist, and timeout; given missing/incompatible Core, malformed registration, or partial installation, When preflight runs, Then it returns an actionable upgrade/install error, writes no partial Enterprise state, and makes zero GitHub calls.
   Exercise through: `enterprise/cli.js install/preflight` with temporary project roots.
   Test doubles: fake filesystem failure and recording `gh` runner; use the real registration validator.
   Expected RED: no Enterprise executable, registration schema, or preflight exists.
2. Run test — verify FAIL: `node --test test/enterprise-protocol.test.js`
3. Implement `enterprise/cli.js`, `enterprise/registration.js`, and atomic registration install/preflight using T2's file primitive; verify PASS, refactor while green, and commit: `feat(enterprise): add registered adapter preflight`.

4. Write failing test for: valid adapter responses are bounded and secret-free.
   Test file: `test/enterprise-protocol.test.js`
   Level: unit
   Test intent: Given valid event input, When the adapter returns `succeeded`, `retryable`, `terminal`, or `reconciling`, Then the response contains the original event ID and permitted proof fields, and diagnostics contain no token, credential, or raw secret-bearing command argument.
   Exercise through: `enterprise/adapter.js` response serializer and `enterprise/retry.js` redaction.
   Test doubles: fixed response objects and fake `gh` runner; never use live GitHub.
   Expected RED: no adapter response boundary or secret-redaction helper exists.
5. Run test — verify FAIL: `node --test test/enterprise-protocol.test.js`
6. Implement the adapter entry point, response serializer, and redacted diagnostics, verify PASS, refactor while green, and commit: `feat(enterprise): add safe adapter response protocol`.

7. Write failing test for: remote failure classes map to bounded outcomes.
   Test file: `test/enterprise-protocol.test.js`
   Level: unit
   Test intent: Given timeout/rate-limit, auth/permission, validation/integrity, malformed output, or non-zero exit, When the adapter classifies the result, Then timeout/rate-limit is retryable within the configured bound and auth/permission/validation/integrity is terminal, with no remote mutation implied by classification.
   Exercise through: `enterprise/retry.js` and the injectable `enterprise/github.js` runner.
   Test doubles: fake `gh` exit/status responses and clock; no live network.
   Expected RED: no explicit failure taxonomy or bounded retry classifier exists.
8. Run test — verify FAIL: `node --test test/enterprise-protocol.test.js`
9. Implement the safe `gh` runner, metadata reader/writer seam, retry classifier, and timeout policy, verify PASS, refactor while green, and commit: `feat(enterprise): classify remote failures safely`.

10. Write failing test for: adapter contract mismatch prevents handler dispatch.
   Test file: `test/enterprise-protocol.test.js`
   Level: integration
   Test intent: Given a Core event with contract 3 and an adapter registration declaring contract 2, or an otherwise compatible registration whose event allowlist omits the event type, When dispatch is attempted, Then the adapter fails closed before handler/GitHub invocation with an actionable protocol result and leaves the original event pending/retryable for Core replay.
   Exercise through: Core's registered executable invocation plus the Enterprise preflight/allowlist boundary.
   Test doubles: recording adapter/GitHub runner; use real process protocol and temporary registration files.
   Expected RED: no mixed-major or event-allowlist boundary prevents handler dispatch.
11. Run test — verify FAIL: `node --test test/enterprise-protocol.test.js`
12. Implement contract/surface compatibility checks and make the handler dispatch table explicit for the three event types, verify PASS, refactor while green, and commit: `feat(enterprise): enforce adapter compatibility boundary`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — adapter schema, response contract, compatibility matrix, error classes, and remote ownership boundary.
- `cli/lib/lifecycle-contract.js` — neutral event/response contract from T1.
- `cli/lib/atomic-file.js` — shared atomic writer from T2.
- `cli/lib/meta.js` — additive metadata serialization conventions.
- `skills/create-pr/SKILL.md` and `skills/pocket-development/references/enterprise-reporting.md` — existing GitHub transport and recorder/reconciliation behavior to preserve.
- Context7 `/websites/cli_github_manual` — `gh api`, body-file, pagination, JSON, and scripting behavior.

## WHY THIS APPROACH
Complexity: deep
Justification: This is the trust boundary between local Core and remote Enterprise. Registration, subprocess protocol, compatibility, retries, and secret-safe diagnostics must be independently testable before issue/PR/closure handlers are added.

## SANDWICH CONTEXT
[CRITICAL: Every GitHub ID, credential, `gh` invocation, remote ownership rule, and Enterprise policy belongs in Enterprise-only code; Core receives only opaque proof refs and adapter statuses.]
You are implementing the registered v4 Enterprise adapter boundary.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `enterprise/cli.js`, `enterprise/adapter.js`, `enterprise/registration.js`, `enterprise/github.js`, `enterprise/meta.js`, `enterprise/retry.js`, `test/enterprise-protocol.test.js`.
Architecture rule: registration is atomic, preflight is fail-closed, and transport is injectable for tests; `enterprise/meta.js` is a thin wrapper over the `cli/lib/meta.js` helpers for origin/ownership validation and must not rewrite the additive metadata schema.
[RESTATE: No handler may run or call GitHub when the Core/Enterprise contract is incompatible.]

## DELIVERABLE
Given a compatible registration, When an event is delivered, Then the adapter validates protocol input and returns a bounded response.
Given missing/malformed/incompatible registration, When preflight runs, Then it returns an actionable failure with zero GitHub calls.
Given timeout/rate-limit, When classified, Then it is retryable within the bound; given auth/permission/validation/integrity, Then it is terminal without secret leakage.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Registration schema is atomic and contains only executable argv, event allowlist, contract, schema, and timeout.
  - The adapter owns all GitHub IDs and writes them only through Enterprise metadata helpers wrapping `cli/lib/meta.js`.
  - Transport accepts body files/JSON safely and records redacted diagnostics.
  - Tests use injected runners; no live network or credential dependency.

Must-not-have:
  - No Core import from `enterprise/**`, no automatic PR creation, merge, or issue closure.
  - No dependency beyond Node.js built-ins and the existing `gh` transport.
  - No credentials in event files, error output, ledger, or metadata.

Open question risks:
  - If host executable discovery differs between Pi and Claude packaging, report NEEDS_CONTEXT and add an explicit manifest argv rather than a runtime search wildcard.

Rollback note:
  - Remove/disable the registration file, preserve Core journal, and pin the previous compatible v4 Enterprise artifact.

Red flags:
  - A malformed response is treated as success → STOP.
  - A failed preflight still invokes `gh` → STOP.

## STOP CONDITIONS
Done when: protocol, preflight, retry classification, secret-redaction, and contract mismatch tests pass without a live remote dependency.
Uncertain when: `gh` exit output cannot be safely classified without retaining secrets.
Escalate when: the adapter boundary requires Core to know remote identity or policy.

---

### Task 8: Reconcile spec-approved issue identity and ownership [depends: T7] [parallel: T9] [test-risk]

## OBJECTIVE
Implement the `spec-approved` Enterprise handler using metadata-first, exact-plan identity reconciliation. Create or reconcile exactly one owned open issue, record issue proof in `.pocket-meta.json`, and stop without mutation for missing, foreign, closed, conflicting, or ambiguous matches.

Steps:
1. Write failing test for: zero exact open matches create one owned issue.
   Test file: `test/enterprise-issue.test.js`
   Level: integration
   Test intent: Given a pending `spec-approved` event with valid spec artifacts, no owned issue metadata, and zero open `pocket-plan` issues matching the exact normalized plan identity in the current origin repository, When the handler runs, Then it creates exactly one issue and records number/URL/ownership proof in `.pocket-meta.json`.
   Exercise through: `enterprise/issue-handler.js` with a fake `gh` transport and real temporary metadata.
   Test doubles: fake GitHub API responses and clock; do not mock the reconciliation algorithm or metadata store.
   Expected RED: existing Enterprise behavior is skill prose and no deterministic issue handler exists.
2. Run test — verify FAIL: `node --test test/enterprise-issue.test.js`
3. Implement metadata-first lookup, current-origin/open `pocket-plan` validation, exact normalized `plan_id`/full-spec search, issue creation, and proof persistence; verify PASS, refactor while green, and commit: `feat(enterprise): create approved-spec issues deterministically`.

4. Write failing test for: exactly one owned open match is reconciled.
   Test file: `test/enterprise-issue.test.js`
   Level: integration
   Test intent: Given one open `pocket-plan` issue in the current origin repository with exact normalized plan identity, When `spec-approved` runs, Then it reuses that issue, records proof, and performs no duplicate create.
   Exercise through: the handler's metadata/search reconciliation boundary.
   Test doubles: fake paginated `gh issue list/view` responses; real metadata files.
   Expected RED: no owned-match reconciliation path exists.
5. Run test — verify FAIL: `node --test test/enterprise-issue.test.js`
6. Implement the single-owned-match path and stable proof write, verify PASS, refactor while green, and commit: `feat(enterprise): reconcile an owned approved-spec issue`.

7. Write failing test for: multiple, foreign, closed, or conflicting ownership stops without mutation.
   Test file: `test/enterprise-issue.test.js`
   Level: integration
   Test intent: Given positive issue metadata pointing to the wrong origin, a closed issue, or a wrong-plan issue, When metadata-first validation runs, Then the handler rejects it and safely falls back to exact open `pocket-plan` search/manual resolution; given multiple exact matches, a foreign-owned match, or a manually conflicting open match, Then it returns terminal/manual resolution with no issue or metadata mutation and never reopens or silently selects a target.
   Exercise through: the handler's metadata-first and complete search/reconcile boundary.
   Test doubles: fake paginated `gh issue list/view/create` responses; no live GitHub.
   Expected RED: no handler has metadata validation, ownership/ambiguity classification, or safe no-mutation behavior.
8. Run test — verify FAIL: `node --test test/enterprise-issue.test.js`
9. Implement exact match cardinality, ownership/state validation, and stable terminal codes, verify PASS, refactor while green, and commit: `feat(enterprise): fail closed on ambiguous issue ownership`.

10. Write failing test for: issue replay returns existing proof without duplicate creation.
   Test file: `test/enterprise-issue.test.js`
   Level: integration
   Test intent: Given a Core-succeeded event and event-bound issue ownership proof, When the same event is replayed, Then the handler validates `event.delivery.proof_ref` and `event.delivery.proof_hash` against persisted ownership metadata and returns those exact proof values with zero GitHub calls and byte-identical `.pocket-meta.json`; missing or mismatched nested proof is terminal before GitHub or metadata mutation, with no fallback to top-level event proof fields.
   Exercise through: adapter dispatch to the issue handler with persisted event/metadata fixtures.
   Test doubles: recording fake GitHub transport; real metadata files.
   Expected RED: no durable issue proof or idempotent replay path exists.
11. Run test — verify FAIL: `node --test test/enterprise-issue.test.js`
12. Implement a succeeded-only, read-only replay guard that validates Core's nested `event.delivery.proof_ref/hash`, recomputes the issue proof hash, verifies `ownership.event_id`, and fails closed without top-level fallback; claimed/pending/retryable/reconciling events remain eligible for normal reconciliation and partial-work recovery. Verify PASS and commit: `fix(enterprise): make issue reconciliation replay-safe`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — issue reconciliation algorithm, proof requirements, and `ISSUE_REQUIRED` behavior.
- `enterprise/adapter.js`, `enterprise/github.js`, `enterprise/meta.js` — protocol and seams from T7.
- `cli/lib/meta.js` — additive `.pocket-meta.json` schema and dotted-field behavior.
- `cli/lib/bodies.js` and `skills/pocket-grinding/SKILL.md` — existing issue body/marker conventions.
- `skills/pocket-development/references/enterprise-reporting.md` — current metadata-first issue/PR identity guidance.

## WHY THIS APPROACH
Complexity: standard
Justification: Issue creation is a single remote mapping but has high ownership risk. Isolating it lets the handler prove exact identity, cardinality, repository, state, and replay behavior without coupling to PR or closure logic.

## SANDWICH CONTEXT
[CRITICAL: A succeeded event is read-only: validate proof from Core's nested `event.delivery.proof_ref/hash`, return it unchanged if event-bound and valid, and fail closed before GitHub/local writes if missing or mismatched. Claimed/pending/retryable/reconciling events may reconcile; terminal and unknown statuses may not. Never fall back to top-level proof fields.]
You are implementing the Enterprise handler for `spec-approved`.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `enterprise/issue-handler.js` and `test/enterprise-issue.test.js`; import the read-only shared seams from T7 without modifying them.
Architecture rule: metadata-first lookup, exact identity search, one owned open match, and no silent reopening.
[RESTATE: Ambiguity is a terminal/manual state, never permission to guess.]

## DELIVERABLE
Given no owned issue and zero exact matches, When `spec-approved` is processed, Then one issue is created and proof is recorded.
Given one owned open exact match, When processed, Then it is reconciled without a duplicate.
Given multiple/foreign/closed/conflicting matches, When evaluated, Then the handler stops with no remote mutation; zero exact open matches are handled by the creation path above.
Given a succeeded event replay with valid nested delivery proof, When processed, Then the same event-bound proof is returned without GitHub or metadata writes; missing/mismatched nested proof fails closed. Claimed/pending/retryable/reconciling events retain the reconciliation path; terminal and unknown statuses are rejected.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Validate positive metadata issue number/URL against current `origin`, open state, and exact plan identity before use.
  - Search only open `pocket-plan` issues in the current repository and exact normalized plan identity.
  - Persist issue number, URL, and ownership proof through additive metadata.
  - Return actionable codes without credentials.

Must-not-have:
  - No reopening closed issues, mutating foreign/multiple matches, silent target selection, or issue close.
  - No direct Core dependency.

Open question risks:
  - If GitHub search cannot prove exact identity from title/full-spec path, return manual resolution rather than broadening the query.

Rollback note:
  - Restore prior metadata only through an explicit operator action; do not delete remote issue history.

Red flags:
  - More than one remote create/update on one event → STOP.
  - Handler writes a GitHub ID outside Enterprise-owned metadata → STOP.

## STOP CONDITIONS
Done when: issue creation/reconciliation/replay/ambiguity tests pass with fake transport and no live calls.
Uncertain when: repository ownership or exact identity cannot be verified.
Escalate when: the only proposed fix is to mutate a foreign or ambiguous issue.

---

### Task 9: Reconcile phase-complete PR markers and fingerprints [depends: T7] [test-risk]

## OBJECTIVE
Implement the `phase-complete` handler against the existing PR marker and canonical v4 metadata. Persist an event-bound per-phase proof record binding event ID, plan/phase, PR identity, fingerprints, and a recomputable proof hash. Validate metadata-first PR identity, branch/phase/repository/open state, upsert exactly one phase summary marker, persist `phases.<phase>.review.fingerprints`, and never auto-create a PR.

Steps:
1. Write failing test for: phase-complete upserts the existing PR marker and canonical fingerprints.
   Test file: `test/enterprise-phase.test.js`
   Level: integration
   Test intent: Given phase evidence, a valid open PR identified by metadata or exact branch/phase search, and new findings, When the handler runs, Then it updates or creates exactly one `pocket-phase-<N>-summary` marker, reconciles inline findings by the shared fingerprint algorithm, and persists fingerprints at `phases.<phase>.review.fingerprints`.
   Exercise through: `enterprise/phase-handler.js` with fake paginated comments/review-thread APIs and real metadata.
   Test doubles: fake `gh` transport and fixed clock; do not mock marker selection or fingerprint computation.
   Expected RED: current reporting is manual skill prose and no v4 handler owns the complete PR reconciliation transaction.
2. Run test — verify FAIL: `node --test test/enterprise-phase.test.js`
3. Implement metadata-first PR validation, marker upsert/collapse, existing `format comment` body generation, fingerprint reconcile, and metadata persistence; verify PASS, refactor while green, and commit: `feat(enterprise): reconcile phase PR proof`.

4. Write failing test for: missing issue stops phase-complete without mutation.
   Test file: `test/enterprise-phase.test.js`
   Level: integration
   Test intent: Given a valid phase-complete event and PR but no owned issue for the plan, When the handler runs, Then it returns `ISSUE_REQUIRED`, writes no PR comment or metadata proof, and performs no issue creation or other remote mutation.
   Exercise through: the full phase handler using fake issue/PR responses.
   Test doubles: fake `gh issue`/`gh pr` transport; no real network.
   Expected RED: no phase handler enforces the normative existing-issue requirement.
5. Run test — verify FAIL: `node --test test/enterprise-phase.test.js`
6. Implement the issue prerequisite and no-mutation failure path, verify PASS, refactor while green, and commit: `feat(enterprise): require owned issue for phase reporting`.

7. Write failing test for: missing or ambiguous PR stops with no mutation.
   Test file: `test/enterprise-phase.test.js`
   Level: integration
   Test intent: Given positive PR metadata pointing to the wrong origin, closed state, wrong branch, or wrong phase, When metadata-first validation runs, Then the handler rejects it and safely falls back to exact branch/phase search/manual resolution; given missing metadata and zero branch matches, multiple matches, foreign/closed/wrong-branch/wrong-phase PR, or a missing required PR, Then it returns `PR_REQUIRED` or terminal manual resolution, creates no PR, writes no comments/metadata, and preserves the event for retry/manual action.
   Exercise through: the full phase handler using fake repository/PR responses.
   Test doubles: fake `gh pr list/view` and comment APIs; no real network.
   Expected RED: no adapter handler enforces metadata validation, safe fallback, or the no-auto-create-PR rule.
8. Run test — verify FAIL: `node --test test/enterprise-phase.test.js`
9. Implement explicit PR ownership/state/branch/marker checks and no-auto-create behavior, verify PASS, refactor while green, and commit: `feat(enterprise): fail closed on missing phase PR`.

10. Write failing test for: legacy fingerprint metadata is read-only compatibility input.
   Test file: `test/enterprise-phase.test.js`
   Level: integration
   Test intent: Given prior fingerprints only at `phases.<phase>.fingerprints`, When phase-complete reconciles findings, Then it reads that legacy path once for compatibility, writes the resulting proof only to `phases.<phase>.review.fingerprints`, and does not delete or mutate the legacy field.
   Exercise through: phase handler metadata migration boundary with real `.pocket-meta.json`.
   Test doubles: fake GitHub transport; use real metadata serialization.
   Expected RED: no v4 nested fingerprint path or legacy read-only fallback exists.
11. Run test — verify FAIL: `node --test test/enterprise-phase.test.js`
12. Implement legacy read-only fallback and canonical v4 write path, verify PASS, refactor while green, and commit: `feat(enterprise): migrate phase fingerprint proof additively`.

13. Write failing test for: phase marker and finding replay are idempotent.
   Test file: `test/enterprise-phase.test.js`
   Level: integration
   Test intent: Given a `succeeded` event with valid nested `event.delivery.proof_ref/hash` and a recomputable event-bound per-phase proof, When the handler replays it, Then it returns the same proof with zero GitHub calls and byte-identical metadata; given missing/mismatched proof, Then it terminal-fails before repository/issue/PR/thread lookups or metadata writes, without top-level proof fallback; given `reconciling` after partial remote success/local-ledger failure, Then the earliest marker and existing finding threads are reconciled without duplicate inline mutations.
   Exercise through: phase handler replay with persisted proof and fake comment/thread state.
   Test doubles: deterministic fake GitHub API with call recording; real identity helper behavior.
   Expected RED: `succeeded` currently enters reconciliation, nested delivery proof is ignored, and the current hash is not bound to event ID; reconciling recovery must remain functional.
14. Run test — verify FAIL: `node --test test/enterprise-phase.test.js`
15. Implement a succeeded-only read-only guard that validates nested Core delivery proof against a recomputable per-phase record bound to event ID, plan/phase, PR, and fingerprints; fail closed on missing/mismatch and keep remote reconciliation eligible for claimed/pending/retryable/reconciling. Verify PASS, refactor while green, and commit: `fix(enterprise): make phase reporting idempotent`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — PR markers, fingerprints, `PR_REQUIRED`, and no-auto-create rules.
- `enterprise/adapter.js`, `enterprise/github.js`, `enterprise/meta.js` — shared Enterprise seams from T7.
- `cli/lib/identity.js` — canonical fingerprint and phase marker algorithms.
- `cli/lib/bodies.js` and `cli/commands/format.js` — phase summary formatter and marker body conventions.
- `skills/pocket-development/references/enterprise-reporting.md` — existing marker upsert and inline finding reconciliation semantics.

## WHY THIS APPROACH
Complexity: deep
Justification: Phase reporting combines PR ownership, marker races, review-thread reconciliation, fingerprints, metadata migration, and remote-success/local-ledger recovery. It needs an independent integration boundary and explicit fake transport.

## SANDWICH CONTEXT
[CRITICAL: A valid `succeeded` event returns its event-bound proof from nested `event.delivery.proof_ref/hash` without GitHub or metadata writes; missing/mismatched proof fails closed. Claimed/pending/retryable/reconciling may reconcile markers and fingerprints; terminal and unknown statuses are rejected. Never auto-create a PR.]
You are implementing deterministic `phase-complete` synchronization.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `enterprise/phase-handler.js`, `cli/lib/identity.js`, `cli/lib/bodies.js`, and `cli/commands/format.js` read-only for reuse, plus `test/enterprise-phase.test.js`; import the read-only Enterprise seams from T7 without modifying them.
Architecture rule: use current origin, exact branch/phase identity, marker upsert, and metadata-first proof.
[RESTATE: Missing, ambiguous, foreign, closed, or mismatched PRs are never auto-created or silently mutated.]

## DELIVERABLE
Given an owned open PR, When phase-complete is processed, Then the canonical summary marker and v4 fingerprints are upserted exactly once.
Given a missing/ambiguous/foreign/closed/mismatched PR, When processed, Then `PR_REQUIRED` or manual resolution is returned without remote mutation.
Given a valid `succeeded` event proof, When replayed, Then the exact proof is returned read-only; missing/mismatched proof is terminal before remote/local mutation. Given `claimed`, `pending`, `retryable`, or `reconciling`, When processed, Then normal reconciliation can complete or recover partial remote success/local-ledger failure without duplicate markers or finding threads.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Metadata-first PR identity is validated against current origin, open state, expected branch, and phase marker.
  - Existing `markerFor`/fingerprint semantics are reused, not reimplemented with divergent hashing.
  - Exactly one canonical summary marker remains after races; later duplicates are removed deterministically.
  - Legacy `phases.<phase>.fingerprints` is read-only compatibility input; v4 writes the canonical nested path.
  - The canonical phase proof binds event ID, plan/phase, PR identity, and fingerprints in a recomputable hash; old unbound succeeded proofs fail closed.

Must-not-have:
  - No automatic PR creation, merge, issue closure, or mutation of foreign/ambiguous PRs.
  - No remote IDs written by Core.

Open question risks:
  - If a GitHub API response cannot expose enough branch/marker identity, stop with manual resolution rather than weakening ownership checks.

Rollback note:
  - Disable the adapter and replay original event IDs after fixing; retain remote markers and metadata.

Red flags:
  - A handler creates a PR → STOP.
  - A replay creates a second marker or thread → STOP.

## STOP CONDITIONS
Done when: marker, fingerprint, no-PR, ambiguity, valid/invalid succeeded replay, and reconciling recovery tests pass with fake transport.
Uncertain when: an API race cannot be resolved to one canonical marker deterministically.
Escalate when: the implementation proposes replacing marker proof with a new remote schema.

---

### Task 10: Reconcile plan-closed tasklist and closeout proof [depends: T7] [parallel: T8] [test-risk]

## OBJECTIVE
Implement the `plan-closed` handler using the existing tasklist marker and additive metadata, while writing local `closeout.md` as informational output. A valid Core `succeeded` event replays its nested, event-bound `event.delivery.proof_ref/hash` read-only; missing or mismatched proof fails closed. Claimed/pending/retryable/reconciling events may repair or reconcile; terminal and unknown statuses are rejected. The handler never merges a PR or calls `gh issue close`.

Steps:
1. Write failing test for: plan-closed finalizes tasklist and local closeout without closing or merging remotely.
   Test file: `test/enterprise-closeout.test.js`
   Level: integration
   Test intent: Given a valid `plan-closed` event, an owned issue, final plan state, non-null `plan_dir`, and final artifact references, When the handler runs, Then it upserts exactly one `<!-- pocket-tasklist -->` issue comment, records final metadata/proof, writes local `<plan_dir>/closeout.md`, preserves the final plan state/artifact references in the proof, and makes no merge or `gh issue close` call; if the local closeout/ledger write fails after the marker mutation, Then it returns `reconciling` and replay finds the marker before any duplicate mutation.
   Exercise through: `enterprise/closure-handler.js` with fake GitHub transport, real format/tasklist/closeout fixtures, and an injected local-write failure.
   Test doubles: fake `gh` issue/PR runner and filesystem/ledger failure injection; do not mock marker selection or replay lookup.
   Expected RED: current closeout is a skill-level sequence with no event handler, durable proof transaction, or proof-preserving failure path.
2. Run test — verify FAIL: `node --test test/enterprise-closeout.test.js`
3. Implement final tasklist marker reconciliation, local closeout writing, metadata proof, and explicit no-merge/no-close command policy; verify PASS, refactor while green, and commit: `feat(enterprise): reconcile plan closure proof`.

4. Write failing test for: tasklist replay reuses the canonical marker.
   Test file: `test/enterprise-closeout.test.js`
   Level: integration
   Test intent: Given a tasklist marker was updated before a local ledger timeout and the replay event has `delivery.status: reconciling`, When the same event is drained, Then the handler finds and updates the existing marker, repairs the local ledger/closeout without duplication, and returns the recovered proof; this is partial-success recovery, not a succeeded-event replay.
   Exercise through: closure handler replay with fake paginated issue comments and persisted metadata.
   Test doubles: fake GitHub transport and ledger writer failure; no live GitHub.
   Expected RED: reconciling recovery must preserve the existing tasklist marker after ledger failure; succeeded replay is a separate read-only proof-validation case.
5. Run test — verify FAIL: `node --test test/enterprise-closeout.test.js`
6. Preserve reconciling recovery after tasklist success/local-ledger failure; valid succeeded replay is tested separately and must not perform remote or local writes. Verify PASS, refactor while green, and commit: `fix(enterprise): make closure proof replay-safe`.

7. Write failing test for: missing or ambiguous issue stops closure without mutation.
   Test file: `test/enterprise-closeout.test.js`
   Level: integration
   Test intent: Given the issue is absent, foreign, closed, or ownership is ambiguous, When `plan-closed` runs, Then it returns `ISSUE_REQUIRED` or terminal manual resolution, writes no tasklist/closeout remote mutation, and leaves local state safe.
   Exercise through: closure handler issue lookup boundary.
   Test doubles: fake paginated issue comments/metadata; no live GitHub.
   Expected RED: no closure issue prerequisite or no-mutation failure path exists.
8. Run test — verify FAIL: `node --test test/enterprise-closeout.test.js`
9. Implement issue requirements and terminal classification, verify PASS, refactor while green, and commit: `fix(enterprise): fail closed when closure issue is unavailable`.

10. Write failing test for: informational closeout content is not used as idempotency identity.
   Test file: `test/enterprise-closeout.test.js`
   Level: unit
   Test intent: Given two closeout bodies with the same plan but different informational wording, When closure proof is evaluated, Then only the tasklist marker and metadata determine idempotency; the unmarked closeout comment cannot cause a duplicate-proof decision.
   Exercise through: closure proof helper and marker selector.
   Test doubles: none; use pure body/marker inputs.
   Expected RED: no helper distinguishes canonical tasklist proof from informational closeout content.
11. Run test — verify FAIL: `node --test test/enterprise-closeout.test.js`
12. Add the canonical proof selector and tests, verify PASS, refactor while green, and commit: `test(enterprise): lock closure marker identity`.

13. Write failing test for: succeeded closure replay is read-only and bad proof fails closed.
    Test file: `test/enterprise-closeout.test.js`
    Level: integration
    Test intent: Given an event with `delivery.status: succeeded` and a persisted tasklist proof, When nested delivery proof matches the recomputed event-bound record, Then return that exact proof with zero GitHub calls, no `writeMeta`, no closeout write/rename, and byte-identical metadata/closeout; given missing or mismatched nested proof (even with top-level proof fields populated), Then return terminal before remote/local mutation.
    Exercise through: `enterprise/closure-handler.js` with real metadata/closeout files and recording fake GitHub/local writers.
    Test doubles: fake GitHub transport and write counters; no live GitHub.
    Expected RED: succeeded events currently perform GitHub lookups, may reconcile markers, and may rewrite `closeout.md` despite missing or mismatched event-bound proof.
14. Run test — verify FAIL: `node --test test/enterprise-closeout.test.js`
15. Implement an early succeeded-only proof guard before `loadClosureContext`, repository/issue lookup, tasklist listing, or closeout output; validate nested delivery proof, event ID/revision/artifact refs, and recomputed persisted tasklist hash. Verify PASS, refactor while green, and commit: `fix(enterprise): make succeeded closure replay read-only`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — closure mapping, tasklist marker, local closeout, and no merge/issue-close rules.
- `enterprise/adapter.js`, `enterprise/github.js`, `enterprise/meta.js` — shared Enterprise seams from T7.
- `cli/lib/bodies.js` and `cli/commands/format.js` — tasklist/closeout body generation and marker ownership.
- `skills/pocket-closing/SKILL.md` — existing closeout and human merge gate behavior.
- `skills/pocket-development/references/enterprise-reporting.md` — existing tasklist synchronization pattern.

## WHY THIS APPROACH
Complexity: standard
Justification: Closure has a smaller remote surface than phase reporting but is safety-critical because accidental issue closure or merge would violate the human gate. Isolating the tasklist marker from informational closeout text makes replay identity explicit.

## SANDWICH CONTEXT
[CRITICAL: For `succeeded`, validate Core's nested `event.delivery.proof_ref/hash` against the event-bound persisted tasklist record and return read-only; missing/mismatched proof fails closed before GitHub or local output writes. Keep claimed/pending/retryable/reconciling repair behavior, reject terminal/unknown statuses, and never merge or call `gh issue close`.]
You are implementing deterministic `plan-closed` synchronization.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `enterprise/closure-handler.js`, `cli/lib/bodies.js` and `cli/commands/format.js` read-only for reuse, and `test/enterprise-closeout.test.js`; import the read-only Enterprise seams from T7 without modifying them.
Architecture rule: preserve the existing human merge gate and local closeout artifact.
[RESTATE: No plan-closed path may merge a PR or close a GitHub issue automatically.]

## DELIVERABLE
Given a valid plan-closed event and owned issue, When processed, Then tasklist proof, final metadata, and local closeout are written exactly once.
Given a valid succeeded nested proof, When replayed, Then return the same proof without GitHub, metadata, or closeout writes; missing/mismatched proof fails closed.
Given tasklist success followed by ledger timeout with `delivery.status: reconciling`, When replayed, Then the existing marker is repaired without duplication.
Given claimed/pending/retryable/reconciling status, When processed, Then permitted reconciliation and partial-work recovery continue; terminal and unknown statuses never become a write path.
Given missing/ambiguous issue, When processed, Then the handler stops safely with an actionable status.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Tasklist marker is the only remote idempotency marker for closure.
  - Closeout file is written locally with normalized content and does not become a remote identity key.
  - Claimed/pending/retryable/reconciling remote results are reconciled before retry mutation; succeeded events are read-only and validate nested event-bound proof.
  - Tests assert no merge and no `gh issue close` invocation.

Must-not-have:
  - No automatic merge, issue closure, duplicate tasklist comments, or new generic closeout schema.

Open question risks:
  - If issue lookup cannot prove ownership, leave local closeout and event pending/terminal according to the spec rather than mutating remotely.

Rollback note:
  - Disable the adapter; retain local `closeout.md`, tasklist marker, and metadata for manual reconciliation.

Red flags:
  - Any `gh issue close` or merge call → STOP.
  - Informational closeout body used as idempotency key → STOP.

## STOP CONDITIONS
Done when: closure marker, local closeout, missing issue, read-only valid/invalid succeeded replay, explicit reconciling recovery, and no-side-effect tests pass.
Uncertain when: local ledger failure classification would cause duplicate marker mutation.
Escalate when: a human merge gate is replaced by automation.

---

### Task 11: Implement v3 migration and mixed-major compatibility [depends: T4, T7] [test-risk]

## OBJECTIVE
Implement explicit, non-destructive v3 migration and mixed-major preflight behavior. Permit migration only for pristine v3 plans, preserve active v3 plans with progress under v3, retain pending v4 events across adapter/core upgrades, and emit actionable warnings without blocking Core-only local work.

Steps:
1. Write failing test for: pristine v3 migration creates lifecycle state atomically.
   Test file: `test/compatibility.test.js`
   Level: integration
   Test intent: Given a v3 plan with a pristine header and no task/phase progress, When `lifecycle migrate <spec_dir> --from v3 --json --contract 3` runs, Then it creates `lifecycle.json` atomically from the v3 snapshot, emits no retrospective event or remote side effect, and leaves v3 files unchanged.
   Exercise through: public migration CLI and `test/fixtures/v3-plan`.
   Test doubles: temporary filesystem and recording adapter/GitHub runner; no live network.
   Expected RED: no migration command or v3 snapshot importer exists.
2. Run test — verify FAIL: `node --test test/compatibility.test.js`
3. Create `cli/lib/lifecycle-migration.js`, add the migration command, verify PASS for atomic pristine import, refactor while green, and commit: `feat(compatibility): add explicit v3 lifecycle migration`.

4. Write failing test for: pristine migration is idempotent.
   Test file: `test/compatibility.test.js`
   Level: integration
   Test intent: Given a pristine v3 plan already migrated once, When the same migration command runs again, Then it returns the existing lifecycle identity, changes no v3 file, does not increment revision, and emits no retrospective event or remote side effect.
   Exercise through: public migration CLI with a real temporary fixture migrated twice.
   Test doubles: recording adapter/GitHub runner and deterministic clock; use real filesystem comparison.
   Expected RED: no idempotent migration result or revision-preserving replay exists.
5. Run test — verify FAIL: `node --test test/compatibility.test.js`
6. Implement idempotent migration detection and revision preservation, verify PASS, refactor while green, and commit: `fix(compatibility): make v3 migration idempotent`.

7. Write failing test for: active v3 progress refuses migration without changing files.
   Test file: `test/compatibility.test.js`
   Level: integration
   Test intent: Given a v3 plan with `REVIEW`, `DONE`, `BLOCKED`, task progress, or a non-pristine header, When migration is attempted, Then it returns `PIN_V3_REQUIRED`, changes no file or remote state, and gives the v3 completion guidance.
   Exercise through: migration CLI with each progress fixture.
   Test doubles: temporary filesystem snapshot and recording remote runner; do not mock migration classification.
   Expected RED: no progress gate or no-change guarantee exists.
8. Run test — verify FAIL: `node --test test/compatibility.test.js`
9. Implement the explicit progress/pristine checks and no-change failure path, verify PASS, refactor while green, and commit: `feat(compatibility): protect active v3 plans from conversion`.

10. Write failing test for: the immutable v3 workflow remains usable at its legacy artifact boundary.
   Test file: `test/compatibility.test.js`
   Level: integration
   Test intent: Given an immutable v3 Core/Enterprise fixture with an active legacy plan, When the legacy workflow runner executes without a future-aware v4 binary, Then local workflow behavior remains operational and the compatibility fixture records the documented v4 upgrade warning without rewriting v3 files or requiring v4 lifecycle state.
   Exercise through: a process-level legacy artifact runner built from `test/fixtures/v3-plan` and a byte snapshot of its files.
   Test doubles: fixture-local runner and recording remote boundary; no live GitHub.
   Expected RED: no separate legacy artifact boundary proves v3 usability independently of v4 preflight.
11. Run test — verify FAIL: `node --test test/compatibility.test.js`
12. Implement the legacy fixture boundary and warning-preserving behavior, verify PASS, refactor while green, and commit: `test(compatibility): preserve legacy v3 workflow boundary`.

13. Write failing test for: mixed-major matrix and adapter removal remain local-first and actionable.
   Test file: `test/compatibility.test.js`
   Level: integration
   Test intent: Given each v3/v4 Core/Enterprise pairing, When preflight/dispatch runs, Then v3/v3 remains usable with warning, v4/v4 is supported, v4 Core alone remains locally successful with pending events, v3 Core/v4 Enterprise and v4 Core/v3 Enterprise fail closed at the Enterprise boundary, and disabled/removed adapters preserve pending event IDs and local state.
   Exercise through: Core preflight, Enterprise preflight, and drain with version/manifest fixtures.
   Test doubles: fake installed surface/adapter files and recording `gh` runner; no live remote.
   Expected RED: no surface/adapter major detection or compatibility matrix enforcement exists.
14. Run test — verify FAIL: `node --test test/compatibility.test.js`
15. Implement mixed-major checks, v4 warning output, adapter-removal handling, and stable compatibility error codes; verify PASS, refactor while green, and commit: `feat(compatibility): enforce mixed-major fail-closed behavior`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — compatibility matrix, migration command, rollback, and version contracts.
- `cli/commands/lifecycle.js` and `cli/lib/lifecycle-dispatch.js` — Core command/dispatch boundaries from T4.
- `enterprise/registration.js` — Enterprise preflight boundary from T7; `enterprise/adapter.js` is read-only compatibility input and is not modified by T11.
- `cli/lib/version.js` and `surfaces.json` — independent protocol and release versions.
- `test/fixtures/v3-plan/*` — immutable migration inputs created by this task.

## WHY THIS APPROACH
Complexity: deep
Justification: Compatibility is a phased rollout boundary with irreversible-risk behavior. A dedicated task makes the no-destructive-conversion rule, mixed-major matrix, warning semantics, and adapter-removal durability independently verifiable.

## SANDWICH CONTEXT
[CRITICAL: Active v3 plans with progress must remain on v3; migration is explicit and pristine-only, and mixed-major Enterprise paths fail closed while Core remains usable.]
You are implementing the compatibility boundary for v3/v4 lifecycle releases.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `cli/lib/lifecycle-migration.js`, `cli/commands/lifecycle.js`, `enterprise/registration.js`, v3 fixtures, and `test/compatibility.test.js`; read `enterprise/adapter.js` for its contract but do not modify it in this task.
Architecture rule: never rewrite v3 files, emit retrospective remote effects, or silently downgrade.
[RESTATE: A plan with execution progress returns `PIN_V3_REQUIRED` and remains on the v3 path.]

## DELIVERABLE
Given a pristine v3 plan, When explicit migration runs, Then lifecycle state is created atomically and v3 files are unchanged.
Given any v3 execution progress, When migration runs, Then it returns `PIN_V3_REQUIRED` with no file/remote change.
Given mixed majors or a removed adapter, When preflight/dispatch runs, Then Enterprise fails closed, Core stays usable, and pending event IDs survive.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Compatibility checks cover all five matrix rows and independent protocol versions.
  - Migration snapshots only pristine v3 plans and is idempotent.
  - Warnings are emitted by v4-aware components; an unchanged v3 binary is not expected to predict a future release.
  - Rollback preserves `.pocket-meta.json`, `log.json`, lifecycle journal, and remote markers.

Must-not-have:
  - No automatic downgrade, destructive conversion, retrospective remote side effect, or Core blocking because Enterprise is absent.

Open question risks:
  - If a v3 fixture contains undocumented progress fields, classify it as progress and return `PIN_V3_REQUIRED` rather than guessing pristine.

Rollback note:
  - Disable/remove Enterprise, retain the journal, pin a compatible v4 adapter, or use the documented v3 CLI path for active legacy plans.

Red flags:
  - Any migration changes a v3 file before all checks pass → STOP.
  - Mixed-major Core local execution is blocked solely by missing Enterprise → STOP.

## STOP CONDITIONS
Done when: pristine migration, progress refusal, matrix, warnings, and rollback-preservation tests pass.
Uncertain when: a v3 plan cannot be classified without a destructive rewrite.
Escalate when: compatibility requires maintaining duplicate mutable v3/v4 writers.

---

### Task 12: Verify Core-to-Enterprise lifecycle integration and recovery [depends: T4, T8, T9, T10] [test-risk]

## OBJECTIVE
Prove the cross-unit scenarios that cannot be established by Core or handler unit tests alone: Core transition to adapter drain, ordering, claim concurrency, replay after remote-success/local-ledger failure, stale artifacts, and zero Core remote side effects.

Steps:
1. Write failing test for: a Core event flows through drain to exactly one Enterprise remote effect.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given a valid approved spec, a phase with completion evidence, a complete plan, and a compatible registered adapter, When the public flow runs `lifecycle transition`/planning handoff for `spec-approved`, then `log update` emits `phase-complete`, then `lifecycle drain` invokes the phase handler, then `log close` emits `plan-closed`, and a later drain invokes the closure handler, Then events are delivered in revision order, each handler writes only its canonical proof, the Core ledger stores opaque proof refs, and repeated drain creates no duplicate issue/marker/tasklist effect; the test must not bypass the `log update`/`log close` emitters by constructing only raw lifecycle transitions.
   Exercise through: public Core CLI commands plus the registered Enterprise executable with a fake GitHub server/runner.
   Test doubles: fake GitHub transport and clock only; do not mock Core store, dispatcher, log emitters, or Enterprise handlers.
   Expected RED: producer/dispatcher/adapter collaboration and the real log emitter boundaries are not yet wired end-to-end.
2. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
3. Implement the shared integration harness and fix only the named seams in `cli/lib/lifecycle-dispatch.js`, `enterprise/adapter.js`, `enterprise/issue-handler.js`, `enterprise/phase-handler.js`, and `enterprise/closure-handler.js` required for the event-to-handler flow; use `cli/commands/lifecycle.js` as a read-only public boundary; verify PASS, refactor while green, and commit: `test(integration): verify lifecycle delivery to Enterprise adapter`.

4. Write failing test for: the Enterprise adapter defers an out-of-order revision until its predecessor is applied.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given the Core journal contains valid append-ordered events r1 through r5 and Enterprise `.pocket-meta.json` has `lifecycle_delivery.last_applied_revision = 3`, When the registered Enterprise executable receives event r5 before r4, Then it returns `retryable` with stable code `REVISION_GAP` and an actionable diagnostic containing the plan ID, blocked revision 5, and missing predecessor 4; it invokes no handler or GitHub operation and leaves the watermark at 3. When r4 is then delivered and r5 is retried, Then Enterprise applies both in order and advances the watermark to 5 without duplicate proof.
   Exercise through: the public registered Enterprise executable using valid event files produced from real Core transitions; reorder only adapter delivery order, never the authoritative Core journal.
   Test doubles: fake GitHub transport and clock only; use real Enterprise adapter, dispatcher, metadata writer, and handlers.
   Expected RED: Enterprise has no per-plan applied-revision watermark or adapter-boundary gap classification.
5. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
6. Implement the Enterprise-owned revision watermark and retryable gap guard in `.pocket-meta.json`, verify PASS, refactor while green, and commit: `fix(integration): preserve lifecycle revision gaps`.

7. Write failing test for: stale lower revisions are no-ops across Core and Enterprise.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given revision 5 has succeeded, When revision 3 arrives, Then it becomes a no-op, remote state never regresses, and no handler mutation occurs.
   Exercise through: public drain with a real ledger and fake adapter.
   Test doubles: fake clock and GitHub runner; use real event ordering.
   Expected RED: stale-revision behavior is not proved at the producer/consumer boundary.
8. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
9. Implement/fix the stale-revision collaboration seam, verify PASS, refactor while green, and commit: `fix(integration): ignore stale lifecycle revisions`.

10. Write failing test for: concurrent workers produce one remote effect.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given two workers receive one pending event, When both claim and process it, Then only one claim succeeds and exactly one remote effect occurs.
   Exercise through: two real drain processes or deterministic worker harness against one temporary lifecycle document.
   Test doubles: fake GitHub runner; use real lock and ledger files.
   Expected RED: isolated claim tests cannot prove Core worker coordination with Enterprise effects.
11. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
12. Implement/fix the concurrent-claim collaboration seam, verify PASS, refactor while green, and commit: `fix(integration): preserve single-worker remote effects`.

13. Write failing test for: expired claims are safely reclaimed.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given a worker claim lease has expired, When a later worker drains, Then it reclaims the event and completes without overlapping the expired invocation or duplicating remote proof.
   Exercise through: deterministic worker harness with a fake clock and real claim ledger.
   Test doubles: fake clock and GitHub runner; use real lock state.
   Expected RED: cross-unit lease recovery is not proved.
14. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
15. Implement/fix the lease-recovery collaboration seam, verify PASS, refactor while green, and commit: `fix(integration): reclaim expired lifecycle claims`.

16. Write failing test for: remote success survives a local ledger timeout.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given a marker is written before the local ledger write times out, When the same event is replayed, Then the adapter finds existing proof before mutation and reaches `succeeded` without a duplicate remote effect.
   Exercise through: end-to-end drain/replay with a fake remote ledger timeout.
   Test doubles: fake GitHub runner, ledger writer failure, and clock; do not mock proof lookup.
   Expected RED: remote-success/local-ledger recovery is not proved across units.
17. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
18. Implement/fix only the reconciling collaboration seam, verify PASS, refactor while green, and commit: `fix(integration): recover remote success before mutation`.

19. Write failing test for: stale artifacts become terminal without remote mutation.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given a committed artifact is missing or changed before delivery, When the event is drained, Then delivery becomes terminal `STALE_ARTIFACT` and no remote handler is invoked.
   Exercise through: end-to-end drain with mutable temporary artifacts.
   Test doubles: fake GitHub runner and clock; use real artifact validation.
   Expected RED: commit-time versus delivery-time artifact classification is not covered across units.
20. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
21. Implement/fix stale-artifact collaboration handling, verify PASS, refactor while green, and commit: `test(integration): reject stale lifecycle artifacts`.

22. Write failing test for: temporary artifact I/O failure remains retryable.
   Test file: `test/integration/lifecycle-enterprise.test.js`
   Level: integration
   Test intent: Given a temporary artifact read failure during delivery, When the event is drained, Then delivery is retryable, remote state remains unchanged, and a later attempt can proceed.
   Exercise through: end-to-end drain with injected artifact reader failure.
   Test doubles: fake GitHub runner, artifact reader failure, and clock; do not mock reconciliation.
   Expected RED: transient delivery I/O is not distinguished from stale content across units.
23. Run test — verify FAIL: `node --test test/integration/lifecycle-enterprise.test.js`
24. Implement/fix transient artifact retry handling, verify PASS, refactor the harness while green, and commit: `test(integration): cover transient artifact recovery`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — cross-unit acceptance scenarios for ordering, claims, retries, stale artifacts, and replay.
- `cli/commands/lifecycle.js`, `cli/lib/lifecycle-store.js`, `cli/lib/lifecycle-dispatch.js` — Core producer/consumer boundary.
- `enterprise/adapter.js`, `enterprise/dispatch.js`, `enterprise/meta.js`, `enterprise/issue-handler.js`, `enterprise/phase-handler.js`, `enterprise/closure-handler.js` — registered Enterprise boundary, metadata, and handler units from T7–T10.
- `test/enterprise-protocol.test.js` — user-approved fixture-only correction to supply valid v4 package/release majors for the Core contract mismatch scenario.
- `test/lifecycle-dispatch.test.js`, `test/enterprise-protocol.test.js`, `test/enterprise-issue.test.js`, `test/enterprise-phase.test.js`, and `test/enterprise-closeout.test.js` — unit/integration seams that this task must not duplicate as substitutes.

## WHY THIS APPROACH
Complexity: deep
Justification: These GWT scenarios span the lifecycle store, claim/dispatch worker, adapter process, remote reconciliation, and ledger. A dedicated integration task prevents all individual unit suites from passing while the actual event-to-remote collaboration is broken.

## SANDWICH CONTEXT
[CRITICAL: Core remains locally successful and remote effects are exactly-once-by-proof, not exactly-once-by-process; replay must reconcile existing markers before mutation.]
You are verifying the full Core-to-Enterprise lifecycle boundary.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `test/integration/lifecycle-enterprise.test.js`, `cli/lib/lifecycle-dispatch.js`, `enterprise/adapter.js`, `enterprise/dispatch.js`, `enterprise/meta.js`, `enterprise/issue-handler.js`, `enterprise/phase-handler.js`, and `enterprise/closure-handler.js`; `test/enterprise-protocol.test.js` is approved for fixture-only correction. Use `cli/commands/lifecycle.js` read-only and modify production files only when an end-to-end seam is missing.
Architecture rule: use real store/claims/handlers and fake only network, clock, and injected failure boundaries.
[RESTATE: A passing unit suite is insufficient if the producer, dispatcher, handler, and proof ledger do not cooperate end-to-end.]

## DELIVERABLE
Given compatible Core/Enterprise components, When the integration flow runs, Then all three event types deliver in order with one canonical remote proof each.
Given gaps, stale revisions, duplicate workers, or expired claims, When delivery runs, Then state never regresses and remote effects remain single.
Given remote success before ledger failure, When replay runs, Then existing proof is found before mutation.
Given stale or temporarily unreadable artifacts, When delivery validates them, Then stale is terminal and transient I/O is retryable.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Integration harness exercises public CLI/adapter boundaries, not private function calls only.
  - Network, clock, and failure injection are the only doubles; Core store and Enterprise handler collaboration remains real.
  - Assertions cover event IDs, revisions, delivery states, remote call count, marker count, and metadata proof.

Must-not-have:
  - No live GitHub calls, credentials, or acceptance of flaky timing as proof.
  - Do not replace integration verification with more isolated unit tests.

Open question risks:
  - If reliable cross-process concurrency is unavailable on the host, use deterministic lock-owner simulation plus a documented subprocess smoke test and report the limitation as DONE_WITH_CONCERNS.

Rollback note:
  - Integration-only changes are test/harness changes; disable the adapter registration and retain all local state if a remote behavior is exposed.

Red flags:
  - More than one remote effect for one canonical proof → STOP.
  - Core invokes a live `gh` transport in the harness → STOP.

## STOP CONDITIONS
Done when: end-to-end ordering, concurrency, replay, stale-artifact, retry, and zero-Core-remote tests pass plus the full repository suite is green.
Uncertain when: the host cannot provide a deterministic claim race test.
Escalate when: correctness requires weakening marker ownership or Core neutrality.

---

### Task 13: Update user-facing documentation and release guidance [depends: T6, T11, T12] [parallel: T14]

## OBJECTIVE
Document the v4 split, local-first lifecycle contract, installation/compatibility matrix, migration/rollback commands, and Enterprise proof ownership. Keep documentation aligned with the manifest and prevent users from assuming Core performs remote synchronization.

Steps:
1. Write failing test for: documentation matches the v4 role and protocol contract.
   Test file: `test/documentation.test.js`
   Level: integration
   Test intent: Given the current README, changelog, llms file, and named Core/Enterprise skill references, When the documentation contract test reads them, Then it fails until they identify all four roles, package `4.0.0`, `CONTRACT=3`, `PIPELINE=5`, lifecycle schema 1, adapter contract 1, surface manifest 1, lifecycle commands, compatibility warnings, and rollback behavior; it must also reject claims that Core calls `gh`, merges, or closes issues.
   Exercise through: `node --test test/documentation.test.js` reading the exact documentation paths listed in this task.
   Test doubles: none; use real repository files and no network.
   Expected RED: current documentation describes one mixed surface and contract 2, with no v4 lifecycle/rollback contract.
2. Run test — verify FAIL: `node --test test/documentation.test.js`
3. Update `README.md`, `CHANGELOG.md`, `llms.txt`, `skills/pocket-enterprise/SKILL.md`, `skills/pocket-enterprise/references/lifecycle-contract.md`, `skills/pocket-enterprise/references/issue-reconciliation.md`, `skills/pocket-enterprise/references/phase-reconciliation.md`, `skills/pocket-development/SKILL.md`, `skills/pocket-closing/SKILL.md`, and `skills/create-pr/SKILL.md` with the exact v4 role names, contract versions, commands, fail-closed behavior, migration constraints, and rollback steps; rebuild exactly `skills/pocket-development/pocket-development.skill`, `skills/pocket-closing/pocket-closing.skill`, `skills/create-pr/create-pr.skill`, and `skills/pocket-enterprise/pocket-enterprise.skill`; verify PASS, refactor duplicated documentation assertions while green, and commit: `docs(release): document Core Enterprise split and migration`.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — summary, contracts, compatibility matrix, and rollback plan.
- `README.md`, `CHANGELOG.md`, `llms.txt` — current product/release documentation.
- `surfaces.json`, `skills/pocket-enterprise/SKILL.md`, `skills/pocket-enterprise/references/lifecycle-contract.md`, `skills/pocket-enterprise/references/issue-reconciliation.md`, and `skills/pocket-enterprise/references/phase-reconciliation.md` — role and adapter names from T5/T6.
- `test/package.test.js` — documentation citation and package checks.

## WHY THIS APPROACH
Complexity: lightweight
Justification: Documentation is a bounded release deliverable after behavior and compatibility are fixed. A small executable documentation check prevents version/command/role drift without adding runtime dependencies.

## SANDWICH CONTEXT
[CRITICAL: Documentation must state that Core remains local-first, Enterprise is additive/fail-closed, and v3 plans are never silently converted.]
You are updating release and operator guidance for the v4 surfaces.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `README.md`, `CHANGELOG.md`, `llms.txt`, `skills/pocket-enterprise/SKILL.md`, `skills/pocket-enterprise/references/lifecycle-contract.md`, `skills/pocket-enterprise/references/issue-reconciliation.md`, `skills/pocket-enterprise/references/phase-reconciliation.md`, `skills/pocket-development/SKILL.md`, `skills/pocket-development/pocket-development.skill`, `skills/pocket-closing/SKILL.md`, `skills/pocket-closing/pocket-closing.skill`, `skills/create-pr/SKILL.md`, `skills/create-pr/create-pr.skill`, and `test/documentation.test.js`.
Architecture rule: documentation must not promise automatic merge/issue closure or imply Core owns GitHub.
[RESTATE: Release guidance must preserve the local-first and non-destructive rollback contract.]

## DELIVERABLE
Given the v4 release docs, When the documentation test runs, Then role names, protocol versions, commands, compatibility warnings, and rollback behavior match the implementation and spec.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Docs identify all four roles, package `4.0.0`, CLI `CONTRACT=3`, `PIPELINE=5`, lifecycle schema 1, adapter contract 1, and surface manifest 1.
  - Docs show `transition`, `drain`, `repair`, and explicit `migrate --from v3` usage.
  - Docs state no automatic merge/issue close, no Core `gh`, and v3 progress pins to v3.
  - All cited paths resolve in the selected release surface.

Must-not-have:
  - No obsolete contract-2 commands presented as v4-only behavior, no silent migration promise, and no unsupported operator UI.

Open question risks:
  - If host-specific installation wording differs, keep role names/manifest truth authoritative and report the wording discrepancy.

Rollback note:
  - Include the documented adapter disable/pin/replay procedure and v3 compatibility path.

Red flags:
  - Documentation claims a remote side effect in Core → STOP.
  - Documentation instructs `gh issue close` or automatic merge → STOP.

## STOP CONDITIONS
Done when: `node --test test/documentation.test.js` passes with no stale contract or ownership language; the final full package/CLI suite is gated by T14 after package/test script updates.
Uncertain when: release behavior differs between Pi and Claude staging.
Escalate when: documentation requires behavior not represented in the tested contracts.

---

### Task 14: Run final release and regression verification [depends: T6, T11, T12]

## OBJECTIVE
Add the final release rehearsal that verifies the complete v4 package, four-role staging, archive parity, CLI envelope/version changes, compatibility fixtures, and baseline behavior. Refresh existing large-suite expectations without weakening historical v3 regression coverage.

Steps:
1. Write failing test for: the final release rehearsal catches stale package/CLI expectations.
   Test file: `test/release-regression.test.js`
   Level: integration
   Test intent: Given the complete v4 tree, When the rehearsal stages all four roles and packs the package, Then package major/manifest/contract/pipeline values agree, all role constraints pass, every archive matches its manifest-selected role-owned source set, and no Enterprise-only content appears in Core.
   Exercise through: `scripts/build-surfaces.js`, `npm pack`, extracted package inspection, and the public CLI `--version`/`--json` boundaries.
   Test doubles: temporary staging/tarball directories; no registry or GitHub network.
   Expected RED: current package/version tests expect contract 2 and a single mixed `skills/**` surface.
2. Run test — verify FAIL: `node --test test/release-regression.test.js`
3. Implement the rehearsal and update only the existing expectation lines in `test/cli.test.js` and `test/package.test.js`; verify PASS, refactor the release assertions while green, and commit: `test(release): verify v4 surfaces and compatibility regression`.

4. Write failing test for: the npm test script includes every v4 suite and preserves historical coverage.
   Test file: `test/release-regression.test.js`
   Level: integration
   Test intent: Given the completed v4 executable test files, When the release regression test inspects `package.json` and invokes the repository test command contract, Then the script names `test/cli.test.js`, `test/package.test.js`, every lifecycle/surface/Enterprise/compatibility/integration/release suite, and retains no runtime-suite omission; the documentation contract remains an explicit T13 gate because T13 runs in parallel.
   Exercise through: the exact `package.json` `scripts.test` value and a controlled command-list assertion; the full command is run only after the script update in Step 6.
   Test doubles: none for package metadata; no live services.
   Expected RED: the current `npm test` script names only `test/cli.test.js` and `test/package.test.js`.
5. Run test — verify FAIL: `node --test test/release-regression.test.js`
6. Expand `package.json`'s `scripts.test` to list `test/cli.test.js`, `test/package.test.js`, `test/lifecycle-contract.test.js`, `test/lifecycle-store.test.js`, `test/lifecycle-cli.test.js`, `test/lifecycle-dispatch.test.js`, `test/surfaces.test.js`, `test/skill-surfaces.test.js`, `test/enterprise-protocol.test.js`, `test/enterprise-issue.test.js`, `test/enterprise-phase.test.js`, `test/enterprise-closeout.test.js`, `test/compatibility.test.js`, `test/integration/lifecycle-enterprise.test.js`, and `test/release-regression.test.js`; keep `test/documentation.test.js` as T13's separately ordered documentation gate because T13 is parallel; refactor duplicated release assertions while the targeted tests remain green, then run `npm test` and record exact `pass`, `fail`, `skipped`, and `cancelled` counts plus packed-surface evidence; verify PASS and commit: `test(release): keep full CLI and package suite green`. Once T13 merges, append `test/documentation.test.js` to `scripts.test` in a follow-up commit and rerun `npm test` so the final tree runs every suite.

## REFERENCES LOADED
- `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md` — complete acceptance criteria and rollback contract.
- `package.json`, `cli/lib/version.js`, `test/cli.test.js`, `test/package.test.js` — current release/test boundaries.
- `surfaces.json`, `scripts/build-surfaces.js`, `test/surfaces.test.js`, `test/skill-surfaces.test.js` — v4 role verification.
- `test/compatibility.test.js`, `test/integration/lifecycle-enterprise.test.js` — compatibility and cross-unit evidence.

## WHY THIS APPROACH
Complexity: standard
Justification: Final release verification is distinct from feature-unit tests: it proves the assembled package, archives, CLI contract, role constraints, and legacy regression suite agree after all parallel work is merged.

## SANDWICH CONTEXT
[CRITICAL: Do not declare v4 complete until the assembled four-role release, contract versions, archives, and full historical test suite agree; evidence must come from executable commands.]
You are running the final release gate for the Core/Enterprise split.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `test/release-regression.test.js`, `test/cli.test.js`, `test/package.test.js`, `test/lifecycle-contract.test.js`, `test/lifecycle-store.test.js`, `test/lifecycle-cli.test.js`, `test/lifecycle-dispatch.test.js`, `test/surfaces.test.js`, `test/skill-surfaces.test.js`, `test/enterprise-protocol.test.js`, `test/enterprise-issue.test.js`, `test/enterprise-phase.test.js`, `test/enterprise-closeout.test.js`, `test/compatibility.test.js`, `test/integration/lifecycle-enterprise.test.js`, `package.json`, and `test/fixtures/v3-plan/log.json`/`test/fixtures/v3-plan/execution-plan.md`; `test/documentation.test.js` is owned and run only by T13.
Architecture rule: verification may not weaken Core/Enterprise forbidden-content checks or v3 no-destructive-conversion coverage.
[RESTATE: No release claim without a green assembled-package rehearsal and `npm test`.]

## DELIVERABLE
Given the completed implementation, When the release rehearsal and `npm test` run, Then all four roles, versions, archives, compatibility fixtures, and existing behavior pass.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Final evidence records `node --test test/release-regression.test.js`, `npm test`, exact pass/fail/skipped/cancelled counts, and the four packed/staged role paths with forbidden-content results.
  - Historical log/structure/metadata/marker behavior remains covered.
  - No test disables or bypasses a Core forbidden-content, no-duplicate, no-remote, or v3 migration assertion.

Must-not-have:
  - No live GitHub calls, registry publishing, automatic merge, issue closure, or destructive fixture rewrite.

Open question risks:
  - If archive/tool availability differs on a release host, report DONE_WITH_CONCERNS with the exact missing executable and preserve the failing gate.

Rollback note:
  - A failed release rehearsal blocks the release; pin the prior compatible v4 artifact or retain v3 for active legacy plans.

Red flags:
  - A green result obtained by skipping package/surface tests → STOP.
  - Any test invokes real credentials or GitHub → STOP.

## STOP CONDITIONS
Done when: release rehearsal, package/archive checks, compatibility suite, and `npm test` all pass with recorded evidence.
Uncertain when: assembled role output differs by host or archive tool.
Escalate when: satisfying the rehearsal requires weakening a normative acceptance criterion.

---

## Plan Summary

| Task | Name | Depends | Complexity | Key Verification |
|------|------|---------|------------|-----------------|
| T1 | Define v4 neutral lifecycle and adapter contracts | prereq | deep | Allowlisted neutral events, artifact refs, adapter statuses, and independent v4 version constants validate deterministically. |
| T2 | Build atomic lifecycle storage and artifact validation | T1 | deep | Atomic state/event commit, root/hash validation, replay no-op, and integrity conflict behavior pass. |
| T3 | Integrate Core transitions with log state and projection | T2 | deep | `lifecycle transition`, `log update`, and `log close` commit lifecycle first and defer dispatch on projection failure. |
| T4 | Implement lifecycle drain, repair, claims, and opaque adapter dispatch | T3 | deep | Ordered drain, lease claims, bounded retries, repair, and protocol failures are safe. |
| T5 | Build the manifest-driven four-role release surfaces | T2 | standard | All four roles stage explicitly with forbidden paths/content and no Core duplication. |
| T6 | Split Core and Enterprise skill instructions without duplicating Core | T5 | deep | Core has no Enterprise instructions; Enterprise is additive; archives/citations remain valid. |
| T7 | Implement Enterprise adapter registration, protocol, and transport seam | T2 | deep | Atomic registration, fail-closed preflight, safe transport, and secret-free bounded error classes pass. |
| T8 | Reconcile spec-approved issue identity and ownership | T7 | standard | One owned issue is created/reconciled; valid nested succeeded proof replays read-only and invalid proof fails closed. |
| T9 | Reconcile phase-complete PR markers and fingerprints | T7 | deep | Event-bound PR/fingerprint proof; succeeded replay is read-only and reconciling recovery preserves partial-success behavior. |
| T10 | Reconcile plan-closed tasklist and closeout proof | T7 | standard | Succeeded tasklist proof replay is read-only; reconciling repairs ledger/closeout; no merge/issue-close side effect occurs. |
| T11 | Implement v3 migration and mixed-major compatibility | T4, T7 | deep | Pristine migration works; progressed v3 pins; all compatibility rows fail/use local-first as specified. |
| T12 | Verify Core-to-Enterprise lifecycle integration and recovery | T4, T8, T9, T10 | deep | Public end-to-end flow proves ordering, claims, replay, stale artifacts, and exactly-once-by-proof effects. |
| T13 | Update user-facing documentation and release guidance | T6, T11, T12 | lightweight | Documentation executable checks match roles, versions, commands, compatibility, and rollback. |
| T14 | Run final release and regression verification | T6, T11, T12 | standard | Four-role package rehearsal and full `npm test` pass without weakening legacy coverage. |
