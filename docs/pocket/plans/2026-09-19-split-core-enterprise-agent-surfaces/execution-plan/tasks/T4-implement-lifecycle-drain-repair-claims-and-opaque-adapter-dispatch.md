# Task T4 — Implement lifecycle drain, repair, claims, and opaque adapter dispatch

**Phase:** 2
**Depends:** T3
**Source plan:** ../../execution-plan.md

---

### Pocket Packet

### Task 4: Implement lifecycle drain, repair, claims, and opaque adapter dispatch [depends: T3] [test-risk]

## OBJECTIVE
Add deterministic replay operations that process pending lifecycle events without creating new events. Implement `drain` ordering, per-plan claims and lease recovery, registered-adapter invocation, bounded retry classification, and `repair` from losslessly available task-projection state while keeping the adapter opaque to Core.

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

7. Preserve the original repair intent verbatim for traceability; it is historical and superseded where its unconditional missing-projection rebuild conflicts with the amended fail-closed contract:
   ```text
   Test file: `test/lifecycle-dispatch.test.js`
   Level: integration
   Test intent: Given committed lifecycle state and event revision 4 with a damaged or missing `log.json`, When `lifecycle repair <spec_dir> --json --contract 3` runs, Then `log.json` is rebuilt, revision and journal length remain unchanged, and no adapter dispatch or new event occurs.
   Exercise through: public `lifecycle repair` and real temporary projection files.
   Test doubles: injected projection writer failure only; use real lifecycle state.
   Expected RED: no repair command or projection rebuild exists.
   Exact command: `node --test test/lifecycle-dispatch.test.js`
   ```
8. Current repair test contract — keep two distinct cases in `test/lifecycle-dispatch.test.js` at integration level:
   - (a) Given committed lifecycle state/event revision 4 and a stale but structurally valid `log.json` containing task progress, When public `lifecycle repair <spec_dir> --json --contract 3` runs, Then lifecycle-owned projection fields are reconciled while task statuses, `done_sha` values, corrections, baseline metadata, lifecycle revision, journal, and delivery state remain unchanged, with no new event or adapter dispatch.
   - (b) Given committed lifecycle state/event revision 4 and a missing or structurally untrusted `log.json` with no verified trusted backup, When public `lifecycle repair <spec_dir> --json --contract 3` runs, Then it returns `LIFECYCLE_REPAIR_STATE_UNRECOVERABLE`, leaves the projection and all lifecycle/task/event/delivery state unchanged, emits no event, and dispatches no adapter.
   Exercise through: public `lifecycle repair` and real temporary lifecycle/projection files.
   Test doubles: inject projection writer failure only; use real lifecycle state. A local-only adapter recorder may observe dispatch absence; never invoke network or `gh`.
   Current expected result: these are contract-alignment/characterization cases and must PASS against unchanged production code. The prior missing-log success-oriented test already failed with `LIFECYCLE_REPAIR_STATE_UNRECOVERABLE` before this contract decision; do not introduce production code to force a new RED.
   Exact command: `node --test test/lifecycle-dispatch.test.js`
9. Run the exact characterization command above and verify PASS. Change production code only if direct evidence demonstrates a violation of the amended contract; no production change is expected for the current audited behavior.

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
[CRITICAL: Repair requires a lossless task-projection source; missing/untrusted `log.json` without a verified trusted backup fails closed without mutation or dispatch. `drain` never creates events, processes one plan serially in ascending revision, and Core treats the adapter as opaque.]
You are implementing replay and recovery for the Core lifecycle journal.
Spec: `docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md`
Files in scope: `cli/commands/lifecycle.js`, `cli/lib/lifecycle-dispatch.js`, `cli/lib/lifecycle-store.js`, `test/lifecycle-dispatch.test.js`, `test-support/lifecycle-dispatch/repair-projection.js`.
Architecture rule: claims use a 60-second UUID-owned lease; retries are bounded; no GitHub policy enters Core.
[RESTATE: Never dispatch a pending event out of order or turn a protocol failure into a remote mutation. Never reconstruct missing/untrusted task-projection state without a verified trusted backup; fail closed without lifecycle/task/event/delivery changes or adapter dispatch.]

## DELIVERABLE
Given revisions with no gap, When drain runs, Then events process serially in ascending revision and no event is created.
Given a revision gap, When a later event arrives, Then it remains pending with an actionable diagnostic.
Given duplicate workers, When they claim one event, Then only one can invoke the adapter.
Given an expired claim, When a later worker retries, Then the event is reclaimable.
Given a stale but structurally valid projection, When repair runs, Then lifecycle-owned fields are reconciled and task progress/revision/journal/delivery remain unchanged with no event or dispatch.
Given a missing or untrusted projection without a verified trusted backup, When repair runs, Then `LIFECYCLE_REPAIR_STATE_UNRECOVERABLE` is returned and all lifecycle/task/event/delivery state remains unchanged with no event or dispatch.
Given protocol/timeout/non-zero failures, When dispatch runs, Then delivery is retryable or terminal according to the bounded policy and no credentials enter output.
Format: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

## QUALITY BAR
Must-have:
  - Delivery attempts increment before invocation and distinguish `pending`, `claimed`, `succeeded`, `retryable`, `terminal`, and `reconciling`.
  - A stale lower revision is a no-op, while a missing predecessor leaves a gap pending.
  - The adapter command receives an event file plus `--json --contract 3`; Core validates only the neutral response envelope.
  - Repair is idempotent and succeeds only when task-projection state remains losslessly available from an existing structurally valid projection (stale is allowed) or a verified trusted backup; it preserves task statuses, `done_sha` values, corrections, baseline metadata, lifecycle revision, journal, and delivery state and emits/dispatches nothing.
  - Missing or untrusted `log.json` without a verified trusted backup returns `LIFECYCLE_REPAIR_STATE_UNRECOVERABLE` and leaves all lifecycle/task/event/delivery state unchanged.
  - Preserve the existing structurally damaged-projection fail-closed scenario.

Must-not-have:
  - No unbounded retry loop, concurrent per-plan remote delivery, event creation from drain, or GitHub call in Core.
  - Do not use a generic queue/event framework.

Open question risks:
  - If platform-specific locking cannot provide the lease semantics, report NEEDS_CONTEXT and keep the event pending rather than allowing concurrent delivery.

Rollback note:
  - Disable/remove the adapter registration; retain lifecycle journal and replay original event IDs after a corrected adapter is installed.

Red flags:
  - A retryable protocol error mutates remote state → STOP.
  - Repair reconstructs task statuses or other task-progress fields from `lifecycle.json`, Git history, commit messages, or plan files when no lossless source exists → STOP.
  - A repair command increments revision, changes delivery state, writes a new event, or dispatches an adapter → STOP.

## STOP CONDITIONS
Done when: drain/repair tests pass, claim/retry behavior is bounded and deterministic, and the baseline CLI suite remains green.
Uncertain when: a filesystem lock race cannot be reproduced or classified.
Escalate when: safe ordering requires a remote queue or a Core-to-GitHub dependency.
