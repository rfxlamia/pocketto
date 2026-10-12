# Issue Reconciliation

This reference owns issue lookup, creation, and proof for the Enterprise `spec-approved` event. Core supplies only a validated spec-root artifact reference and opaque event identity; Core does not call `gh`, does not read remote issue identity, and does not write remote issue identity.

## Preflight and target resolution

Run the Enterprise preflight before any issue operation. It must confirm a compatible v4 Core installation, lifecycle schema `2`, and registered adapter contract `2`; missing or mismatched components fail closed with no GitHub call. GitHub authentication is checked by the Enterprise adapter, never by Core.

Use the current repository's `origin` and normalized `plan_id` from the event. Read `github_issue.number` and `github_issue.url` from Enterprise-owned `.pocket-meta.json` first when available. A metadata target is reusable only when it belongs to the current `origin`, is open, and is tied to the exact plan identity in its title or embedded full-spec path.

If metadata is absent or unusable, search open issues in the current repository for the `pocket-plan` label and exact plan identity. Do not search or mutate another repository.

## Reconciliation outcomes

| Matches | Action |
|---------|--------|
| No owned open match for `spec-approved` | Create one issue from the approved spec and record its number, URL, and ownership proof after successful reconciliation. |
| Exactly one owned open match | Reuse it and record/reconcile metadata after validation. |
| Multiple matches, foreign ownership, closed issue, or conflicting identity | Stop for manual resolution; do not edit, reopen, close, or create around the ambiguity. |
| No issue for `phase-complete` | Return `ISSUE_REQUIRED`; do not create an issue during phase reporting. |

Issue creation is allowed only for the approved-spec event after successful preflight and authentication checks. It is not a fallback for missing phase or closure state. `plan-closed` uses the linked issue to upsert its tasklist proof; it never closes the GitHub issue.

## Idempotency and proof

Before creating, reconcile the event ID and existing issue identity. A retry of an event with existing valid proof must reuse that proof rather than create a second issue. Persist remote issue identity in Enterprise-owned `.pocket-meta.json`; the lifecycle journal stores only the opaque proof reference.

Keep the full approved spec available as issue context using the existing formatter and marker conventions. Never log credentials, authorization headers, or raw secret values. If ownership cannot be established, stop without mutation and return an actionable manual-resolution state.

## Missing-label consent recovery

For a failed `spec-approved` delivery that reports `GH_UNKNOWN`, do not infer that the `pocket-plan` label is missing or that it caused the failure from that generic result alone. `GH_UNKNOWN` alone is not evidence of label absence. Before considering recovery, verify the current origin host and repository and confirm access to that repository. Diagnose only with an exact read-only GET, using this endpoint and the owner and repository from the verified origin:

```bash
gh api repos/<owner>/<repo>/labels/pocket-plan
```

Only a 404 confirms label absence if `gh repo view` has already succeeded for that exact same host and repository; a 404 without that successful access check is ambiguous and inconclusive.

Describe confirmed label absence only as a missing prerequisite, not as the proven root cause of `GH_UNKNOWN`; the delivery may have another cause. Ask the user for explicit permission to create the label. Do not write the label or retry/drain the lifecycle event before consent.

### Origin verification

Before lookup, run `git remote get-url origin` and verify that its host and repository agree with `gh repo view` for the current repository; confirm repository access. If the origin is missing, ambiguous, differs from `gh repo view`, or access is unconfirmed, do not perform the label lookup and do not offer a label write.

### Exact lookup outcomes

If the exact GET returns 200, the label exists: do not offer or perform creation. Stop and report that the delivery failure needs another diagnosis.

If the exact lookup returns 401/403, a server or transport error, or an ambiguous 404 (one without a successful `gh repo view` for the exact same host and repository), the result is inconclusive. Do not offer or perform label creation; stop and report the lookup failure.

### Approval and creation

Only after the exact lookup confirms absence, the target remains unchanged, and the user gives explicit approval, create the label once with `gh label create pocket-plan --repo <verified-origin>`. Do not add `--force`, color, or description options.

### Target re-verification

After permission and immediately before creation, recheck the origin host and repository identity. If either changes from the verified target used for lookup or consent, stop: do not write to the changed target under stale consent. Verify the new target and obtain fresh consent before any label write.

### Create race recovery

If the single approved create explicitly reports that the label already exists, repeat the exact GET above once against the same verified target. Do not infer this condition from a generic 422 or any other failure status alone. If that one lookup returns 200, treat the label prerequisite as satisfied and continue only with the eligible retry rules below. If it returns anything else, or the response does not explicitly say the label already exists, stop and report the result; do not repeat the lookup or create.

### Refusal or create failure

If the user declines, stop without a label write or lifecycle retry. If the approved label creation fails for any reason other than an explicit “already exists” response, or its result is ambiguous, stop and report it; do not repeat the create, drain the lifecycle event, or run `gh issue create` directly.

### Eligible retry

After successful label creation or successful one-time verification that the label already exists, resume only the same original event if it is active and retryable, its retry is due, and it remains below six total attempts (one initial attempt plus at most five retries). Drain that original event; do not emit a new event or run `gh issue create` directly. This is a documented procedure, not a runtime guarantee that event identity is independently checked here.

### Pending backoff

If `next_attempt_at` is in the future, do not drain early. Tell the user when that timestamp makes the retry eligible, then resume only when the event is due and all other retry conditions remain satisfied.

### Terminal or exhausted event

If the original event is terminal or has exhausted six total attempts, do not drain it and do not edit lifecycle state to revive or replay it. Report that this recovery has reached an unsupported manual-resolution boundary.
