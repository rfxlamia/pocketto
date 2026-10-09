# Phase and Closure Reconciliation

This reference owns Enterprise proof for `phase-complete` and `plan-closed`. It does not redefine Core transitions or the local close gate. Core commits neutral lifecycle state and events locally. Core does not call `gh`, does not merge a pull request, and does not close an issue.

## Phase-complete PR proof

Run the Enterprise preflight before remote work. Continue only with matching v4 Core, lifecycle schema `1`, and adapter contract `1`; mixed-major or missing installations fail closed and preserve pending events.

Resolve the phase PR from `phases.<phase_key>.github_pr.number/url` in Enterprise-owned `.pocket-meta.json` first. Validate that it belongs to the current `origin`, is open, matches the plan's captured branch, and has the expected phase identity.

If metadata is absent, search the current repository for the exact branch and phase identity:

- No match → return `PR_REQUIRED`. Do not auto-create a PR.
- Exactly one owned, open match → reconcile it.
- Multiple, foreign-owned, closed, branch-mismatched, or phase-mismatched matches → stop for manual resolution without mutation.

The explicit `create-pr` recorder may create or discover the PR only after the user invokes it. It records the PR identity only. The registered lifecycle adapter is the sole phase-reporting writer: it upserts the summary and reconciles inline findings when a `phase-complete` event is drained. The adapter never auto-creates a PR.

## Summary and findings proof

Use the canonical `<!-- pocket-phase-<N>-summary -->` marker to upsert one phase summary comment. On replay, update the existing marker rather than creating a duplicate. If multiple copies exist, preserve the earliest and reconcile the rest deterministically.

For inline review findings, reconcile prior fingerprints against the current verdict artifacts. Post only new findings, retain unchanged threads, and resolve findings that are no longer present. Persist canonical fingerprints under `phases.<phase>.review.fingerprints`. The legacy v3 `phases.<phase>.fingerprints` path is read-only compatibility input. If a thread or target cannot be tied to the current PR and phase, stop instead of guessing.

## Plan-closed proof

For `plan-closed`, use the linked issue from Enterprise metadata and upsert exactly one `<!-- pocket-tasklist -->` comment from the final plan log. The marker is the idempotency key: update the existing comment on replay, keep the earliest duplicate, and remove later duplicates when safe.

The local `closeout.md` and the unmarked closeout body are informational, not canonical idempotency proof. Closure sync does not require a remote closeout comment. Never merge a PR or close an issue automatically; a human remains responsible for those actions. Core's local plan-close transition does not wait for this optional adapter.

## Recovery

A remote marker written before a local proof update must be found and reconciled before retrying a mutation. Use bounded retries for transient transport failures. Authentication, permission, integrity, or ownership conflicts stop for an actionable manual fix. Never advance proof to a later lifecycle revision while an earlier revision is unresolved. Disabling or removing Enterprise leaves Core and the lifecycle journal intact; pending event IDs remain available for replay after a compatible adapter is restored.
