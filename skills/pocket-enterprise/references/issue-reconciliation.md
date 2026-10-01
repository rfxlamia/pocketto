# Issue Reconciliation

This reference owns issue lookup, creation, and proof for the Enterprise `spec-approved` event. Core supplies only a validated spec-root artifact reference and an opaque event identity.

## Resolve the target

Use the current repository's `origin` and the normalized `plan_id` from the event. Read `github_issue.number` and `github_issue.url` from `.pocket-meta.json` first when available. A metadata target is reusable only when it belongs to the current `origin`, is open, and is tied to the exact plan identity in its title or embedded full-spec path.

If metadata is absent or unusable, search open issues in the current repository for the `pocket-plan` label and exact plan identity. Do not search or mutate another repository.

## Reconciliation outcomes

| Matches | Action |
|---------|--------|
| No owned open match for `spec-approved` | Create one issue from the approved spec and record its number, URL, and ownership proof after successful reconciliation. |
| Exactly one owned open match | Reuse it and record/reconcile metadata after validation. |
| Multiple matches, foreign ownership, closed issue, or conflicting identity | Stop for manual resolution; do not edit, reopen, or create around the ambiguity. |
| No issue for `phase-complete` | Return `ISSUE_REQUIRED`; do not create an issue during phase reporting. |

Issue creation is allowed only for the approved-spec event after preflight and authentication checks. It is not a fallback for missing phase or closure state.

## Idempotency and proof

Before creating, reconcile the event ID and existing issue identity. A retry of an event with existing valid proof must reuse that proof rather than create a second issue. Persist remote issue identity in Enterprise-owned `.pocket-meta.json`; the lifecycle journal stores only the opaque proof reference.

Keep the full approved spec available as issue context using the existing formatter and marker conventions. Never log credentials, authorization headers, or raw secret values. If ownership cannot be established, stop without mutation and return an actionable manual-resolution state.
