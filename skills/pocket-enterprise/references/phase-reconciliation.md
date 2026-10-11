# Phase and Closure Reconciliation

This reference owns Enterprise proof for `phase-complete`, `phase-closed`, and `plan-closed`. It does not redefine Core transitions or the local close gate. Core commits neutral lifecycle state and events locally. Core does not call `gh`, does not merge a pull request, and does not close an issue.

## Phase-complete PR proof (non-stacked)

Run the Enterprise preflight before remote work. Continue only with matching v4 Core, lifecycle schema `2`, and adapter contract `2`; mixed-major or missing installations fail closed and preserve pending events.

Resolve the phase PR from `phases.<phase_key>.github_pr.number/url` in Enterprise-owned `.pocket-meta.json` first. Validate that it belongs to the current `origin`, is open, matches the plan's captured branch, and has the expected phase identity.

If metadata is absent, search the current repository for the exact branch and phase identity:

- No match → return `PR_REQUIRED`. Do not auto-create a PR.
- Exactly one owned, open match → reconcile it.
- Multiple, foreign-owned, closed, branch-mismatched, or phase-mismatched matches → stop for manual resolution without mutation.

The explicit `create-pr` recorder may create or discover the PR only after the user invokes it. It records the PR identity only. The registered lifecycle adapter is the sole phase-reporting writer: it upserts the summary and reconciles inline findings when a `phase-complete` event is drained. The adapter never auto-creates a PR.

## Stacked phase-complete deferral

For a stacked plan, `phase-complete` does no remote work. The handler validates the event and its lifecycle context, then answers `succeeded` with the deferred proof reference `deferred:phase-closed`. The deferred proof hash is a SHA-256 over the event ID, the plan ID, and the fixed deferred marker. This also applies to a reconcilable `phase-complete` retry, so the drain never reconciles a stacked PR from `phase-complete`.

Replay of a succeeded deferred event recomputes that hash. A mismatch is terminal `PHASE_PROOF_MISMATCH`, which must be resolved manually before replay.

The phase summary and inline findings for a stacked phase are written when its `phase-closed` event is delivered, not at `phase-complete`.

## Phase-closed publication (stacked)

`log handoff`, run through pocket-closing's Stacked Handoff after the phase is `DONE`, commits one `phase-closed` event for that phase with its closeout snapshot. The drain delivers it to the `phase-closed` handler only after successful Enterprise preflight. The handler then does the following, in order:

1. Verifies every artifact reference, including the closeout snapshot and the phase evidence, against its recorded hash. An edited snapshot or evidence file is terminal `STALE_ARTIFACT`; nothing is pushed or published.
2. Checks consent: either durable `push_consent` from install, or a per-SHA approval that matches the local phase head. Without either it answers retryable `PUSH_CONSENT_REQUIRED` and waits for the user to approve that exact commit with `consent-push`.
3. Pushes the phase branch only when the remote branch is absent or an ancestor of the local head. A divergent remote is terminal and blocked. The handler never forces, rebases, or merges.
4. Creates the PR for the exact head and base, or reuses the PR already recorded for that identity. It records the PR identity under `phases.<phase_key>.github_pr` (number, URL, head, base, parent PR, and head SHA) in `.pocket-meta.json`.
5. Upserts the stack-context block in the PR body, reconciles the phase summary and inline findings through the shared seam, and stores the stack proof at `phases.<phase_key>.stack.proof` for local replay.

Replay of a succeeded `phase-closed` event answers from the stored stack proof and makes no GitHub call. A later repair that overwrites the PR identity does not invalidate that proof.

`publish-phase` is the explicit manual repair entry point for the same publisher. It follows the same consent rules, applies the same base checks, writes no lifecycle event, and never forces. `create-pr` runs it for stacked plans.

## Explicit bases

- Phase 1 targets the root base recorded at `log init --phase-branches stacked`, at `lifecycle.plan.phase_branches.root_base.branch`. Its PR is created with that base passed explicitly.
- Phase N targets the phase N-1 branch. Its PR body links the parent PR number recorded in its stack identity.
- The PR body ends with `closes #N` only for a one-phase plan, whose base is the root base. Multi-phase PRs end with `refs #N`. GitHub closes an issue only on a merge into the default branch, and the adapter never closes an issue, so a multi-phase plan's issue is closed by hand.
- Every PR lookup filters on both the exact phase head and the expected base.
- A missing root base or an unpublished parent branch blocks publication with `PR_BLOCKED` until the user publishes it and reruns. Pocket does not publish a parent phase on the user's behalf.

## Retarget detection

- A recorded PR for the exact head whose base differs from the expected base is blocked as `base retargeted` (terminal). Pocket does not retarget it. Fix the base on GitHub, then rerun.
- A phase-1 base that differs from the recorded root base is blocked as `base mismatch` (terminal). A missing recorded root base is blocked as `root base unrecorded` (terminal).
- A recorded PR that is closed, or not open for the exact head and base, is not reused.
- A child whose parent PR is closed without a merge is blocked before any push as `parent PR closed` (terminal). Lifecycle drain never redelivers a terminal event, so that case needs a manual decision that Pocket does not yet provide.
- A child whose parent PR is merged is the normal stacked flow. Pocket reuses an open child PR (recorded or listed) that already targets the base the parent merged into, which is where GitHub retargets it. It never creates a PR on a merged parent, and never retargets or rebases. With no such PR it is blocked before any push as `parent PR merged` (retryable): open or retarget the child PR against that base on GitHub, then rerun the drain or `publish-phase`, and Pocket reuses it. A recorded child PR still on the old parent base is blocked as `base retargeted` until the user fixes the base.
- A PR from a fork, which reuses the phase head name, is never adopted or edited. Pocket ignores it, reports a `FORK_PR_IGNORED` notice, and creates or reuses only a PR from this repository.
- When `pr create` is refused because a PR for the head already exists, Pocket re-lists once. It reuses the PR if exactly one own PR is found; otherwise the refusal is blocked as `existing PR for head` (terminal).
- More than one open PR for the same head and base is blocked as `PR_BLOCKED`. The user closes the duplicate by hand, then reruns.

## Summary and findings proof

Use the canonical `<!-- pocket-phase-<N>-summary -->` marker to upsert one phase summary comment. On replay, update the existing marker rather than creating a duplicate. If multiple copies exist, preserve the earliest and reconcile the rest deterministically.

For inline review findings, reconcile prior fingerprints against the current verdict artifacts. Post only new findings, retain unchanged threads, and resolve findings that are no longer present. Persist canonical fingerprints under `phases.<phase>.review.fingerprints`. The legacy v3 `phases.<phase>.fingerprints` path is read-only compatibility input. If a thread or target cannot be tied to the current PR and phase, stop instead of guessing.

## Plan-closed proof

For `plan-closed`, use the linked issue from Enterprise metadata and upsert exactly one `<!-- pocket-tasklist -->` comment from the final plan log. The marker is the idempotency key: update the existing comment on replay, keep the earliest duplicate, and remove later duplicates when safe.

The local `closeout.md` and the unmarked closeout body are informational, not canonical idempotency proof. Closure sync does not require a remote closeout comment. Never merge a PR or close an issue automatically; a human remains responsible for those actions. Core's local plan-close transition does not wait for this optional adapter.

## Recovery

A remote marker written before a local proof update must be found and reconciled before retrying a mutation. Use bounded retries for transient transport failures. Authentication, permission, integrity, or ownership conflicts stop for an actionable manual fix. Never advance proof to a later lifecycle revision while an earlier revision is unresolved. A stacked `phase-closed` blocked by `PUSH_CONSENT_REQUIRED`, `PUSH_FAILED`, `REMOTE_UNAVAILABLE`, or `GIT_UNAVAILABLE` stays retryable; the user resolves the blocker and drains again. `PR_BLOCKED` is retryable only for the reasons `parent PR not recorded`, `parent branch not published`, and `root base not published`; the user publishes or records the parent, then drains again. Every other `PR_BLOCKED` reason is terminal, including `base retargeted`, `base mismatch`, `root base unrecorded`, `parent PR merged`, `parent PR closed`, `remote branch diverged`, `foreign PR in list`, `ambiguous PR identity`, `existing PR for head`, and `STACK_BLOCK_MALFORMED`; the user resolves it on GitHub or in the repository first. A direct `publish-phase` rerun is possible. Lifecycle drain never redelivers a terminal event, so a terminal lifecycle case stays blocked until a manual resolution exists. Disabling or removing Enterprise leaves Core and the lifecycle journal intact; pending event IDs remain available for replay after a compatible adapter is restored.
