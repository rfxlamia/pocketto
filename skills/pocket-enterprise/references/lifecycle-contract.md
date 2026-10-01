# Enterprise Lifecycle Contract

This reference describes the Enterprise consumer of Core's neutral lifecycle journal. The journal and its event schema remain Core-owned; Enterprise is an optional, separately staged consumer.

## Event and artifact boundary

Core emits `spec-approved`, `phase-complete`, and `plan-closed` only after the corresponding local state transition is committed. Events have stable IDs and increasing per-plan revisions. They contain artifact references (`root`, `kind`, relative `path`, SHA-256, and revision), not artifact contents or remote identifiers.

The event types have fixed meanings:

- `spec-approved` references approved spec-root artifacts. It is emitted before the planning handoff.
- `phase-complete` references phase evidence and is emitted when the phase reaches `REVIEW` after the phase-level pass.
- `plan-closed` references final plan state and is emitted by the successful plan-close transition.

The Enterprise adapter stores remote identity and delivery proof only in Enterprise-owned metadata. Core records only opaque proof references.

## Registration and preflight

Enterprise registers an executable argv, an allowlist of event types, adapter contract, and timeout in `<project-root>/.pocket/lifecycle-adapter.json`. Core invokes that registered executable with the event file and `--json --contract 3`; the response must match the event ID and the bounded adapter response schema.

Run preflight before any issue, PR, or comment operation:

```bash
node enterprise/cli.js preflight <project-root> --json
```

Stop unless the result confirms a compatible Core contract, lifecycle schema, registration, adapter contract, and executable. Missing or malformed registration, version mismatch, timeout, malformed response, or non-zero exit never authorizes a fallback writer. Preflight itself is read-only and makes no external call.

## Local-first delivery

Core commits lifecycle state and the event before optional delivery. A missing adapter or failed delivery does not undo local approval, phase completion, or plan closure. Events remain pending or retryable under their original IDs.

Delivery processes events serially in revision order. It claims one event at a time, validates its artifact references, checks existing proof before mutation, and records one of the bounded delivery statuses. Drain replays pending work; it does not create new events. Repair is a separate Core operation for reconciling lifecycle-owned projection fields and never dispatches an event.

## Fail-closed rules

- Do not process an event whose ID, plan identity, event type, revision, artifact root, relative path, or digest fails validation.
- A missing or changed committed artifact is terminal stale evidence; transient reads may be retried.
- A gap, expired or held claim, or already-succeeded event must not permit a later revision to regress remote state.
- A remote result with no safe ownership proof, malformed adapter response, or incompatible contract must not be treated as success.
- Never put credentials or raw remote IDs in Core events, stdout diagnostics, or adapter error text.

For issue ownership rules, load `issue-reconciliation.md`. For phase PR and closeout proof rules, load `phase-reconciliation.md`.
