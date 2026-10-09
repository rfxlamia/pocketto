# Enterprise Phase Reporting

This legacy reference is retained as a routing notice for existing links. Do not run its former direct-`gh` procedure: it conflicts with the registered lifecycle adapter and can create duplicate or inconsistently owned GitHub comments.

The registered Enterprise lifecycle adapter is the sole writer for `phase-complete` reporting. It runs only when a lifecycle event is drained, after a successful Enterprise preflight, and owns the phase summary marker and review-finding reconciliation. Core `pocket-development` does not perform Enterprise reporting.

For the current contract, see `skills/pocket-enterprise/references/phase-reconciliation.md` and `skills/pocket-enterprise/references/lifecycle-contract.md`. The explicit `create-pr` recorder may create or discover a PR and record its identity; it does not post phase verdicts. A missing PR remains `PR_REQUIRED` until the user invokes that recorder.
