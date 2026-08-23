# Changelog

All notable changes to Pocketto are documented here, newest first. Dates are the tag's commit date.

## 3.1.2 — 2026-08-23

`pocket-planning` replaces test-architect codegen with test-intent planning (auditor-judged, not self-reported). GATE 4 is now anchored to the approval gate instead of the plan-write step. `pocket-development` unblocks single-task plans and fixes parallel test execution; closes QC findings on the state-machine contracts.

## 3.1.1 — 2026-08-23

Docs-only: backfills the 3.1.0 changelog entry for `index.md` task-index ordering. No functional change.

## 3.1.0 — 2026-08-23

`pocket-structuring` now decomposes every plan into `execution-plan/index.md` + per-task files (phase manifests only when `phaseCount > 1`), instead of passthrough below 7 tasks. `structure` gains `--reset` to rebuild layout and replace `log.json` when execution progress exists (explicit, discards state); `--force` now only rebuilds + reconciles when there is no execution progress, refusing otherwise, and always refreshes the log's pipeline marker when it rebuilds. A `log.json` that exists but fails to parse is now refused (`LOG_JSON_UNPARSEABLE`) instead of being silently treated as absent — `--reset` is the explicit way to discard it. `index.md`'s Task Index table now renders in phase-group (execution) order instead of numeric task ID, matching `phase-N.md`; for single-phase plans this is also the order `log init` uses to seed dispatch state, so a plan authored out of numeric sequence now dispatches in the order it's written, not by ID.

**Migrating to 3.1.0:** this release bumps the pipeline generation (`PIPELINE` 3 → 4): `pocket-structuring` now always writes `execution-plan/index.md` + per-task files, where before it only split into phases at 7+ tasks. Plans that already have a `log.json` are unaffected until you next run `structure` against them — a plain run repairs/no-ops without touching state; a source-plan change with execution progress still requires `--force` or `--reset` as before.

If you interrupt `structure` while it's writing `execution-plan/` or `log.json` (killed process, crashed machine), re-run `structure --reset` on that plan before continuing — it rebuilds both from scratch and is the only way to guarantee they're back in sync. Don't hand-edit `log.json` to try to fix a partial write.

If a plan's `log.json` reports `PIPELINE_TOO_OLD` with a numeric (not absent) pipeline marker, pin `npx -y pocketto-pi@3.0.1` to finish it under the old pipeline, then update once it's closed — same recovery pattern as 3.0.0's migration below, but for this newer boundary.

## 3.0.1 — 2026-08-18

Removes lingering references to the deprecated `pocket-review` and `pocket-correction` skills.

## 3.0.0 — 2026-08-17

**Breaking.** Introduces the in-loop build cycle: `pocket-development` now runs an audit per task and a phase-level pass before handoff, and — as part of that — plans started under an older pipeline are refused, not repaired. `log.json` gains a pipeline-version marker; a log without one (or with a lower one) makes any state-changing CLI command exit non-zero rather than silently continuing on stale assumptions. `pocket-review` and `pocket-correction` are deprecated (superseded by the in-loop audits) and removed in 3.0.1.

**Migrating to 3.0.0:** close any in-flight plan before updating. A plan that has an open `log.json` from before 3.0.0 will be refused by the new CLI the next time a state-changing command runs against it — the refusal writes nothing, so nothing is lost, but the plan is stuck until you act.

If you're already updated and stuck mid-plan, recover by pinning:

- **CLI:** run the plan out with `npx -y pocketto-pi@2.4.4 …` instead of an unpinned `npx -y pocketto-pi …` until the plan closes.
- **Plugin (Claude Code):** the marketplace entry installs via `source: url` with no version field, so it always tracks the latest commit — there is no version to roll back to. Do not run `/plugin update` (or reinstall) until the in-flight plan closes; simply leave the currently installed plugin in place.

Once the plan is closed under the pinned CLI, drop the pin and update normally — new plans initialize with the current pipeline marker and are unaffected.

## 2.4.4 — 2026-07-05

- `fix(cli)`: refuse duplicate `done_sha` in `log update` instead of warning
- `fix(skills)`: close structural tech-debt and dependency-blindness gaps across the pocket pipeline

## 2.4.2 — 2026-07-03

- `feat(brand-design)`: add opt-in token export step

## 2.4.1 — 2026-07-03

- `feat(cli)`: enterprise integration groundwork — English issue body + `specMarkdown`, `format tasklist`, `mode --file/--require-approval`, `scaffold github`
- `feat(skills)`: add `pocket-init` — brownfield onboarding, enterprise opt-in, GitHub scaffolding
- `feat(skills)`: enterprise team layer — issue task-checklist sync + PR approval gate
- `feat(pocket-grinding)`: upload the full approved spec inside the GitHub issue

## 2.4.0 — 2026-06-14

- `feat(skills)`: add `pocket-correction` — REVIEW_FAIL correction cycle with cross-task attribution (#34)
- `feat(cli)`: add `getCommitFiles`/`getRangeFiles` git helpers
- `feat(pocket-review)`: attribute corrections per-file, union review range
- `feat(pocket-closing)`: anchor freshness to the latest owned correction SHA

## 2.3.1 — 2026-06-14

- `fix(pocket-review)`: document safe SHA refresh path
- `fix`: separate `PHASE_BLOCKED` from `REVIEW_FAIL` in chain-to-closing guidance

## 2.3.0 — 2026-06-10

- `feat(cli)`: add `mode` command + Pocket Enterprise heading parser
- `feat(cli)`: add `.pocket-meta.json` model + `meta` command
- `feat(cli)`: add issue/PR body formatters (`--body-file`), `reconcile` set-diff command, closeout formatters
- `feat(pocket-grinding, create-pr, pocket-review, pocket-closing)`: enterprise issue/PR integration hooks (issue-creation, PR offer, verdict posting, closeout comment)

## 2.2.3 — 2026-06-06

- `fix(pocket-development)`: stop parallel tasks collapsing onto one `done_sha` (#28)
- `fix(pocket-development)`: correct step-numbering gap in Sample Flow

## 2.2.2 — 2026-06-06

- `feat(pocket-review)`: auto-chain to `pocket-closing` on all-pass phase
- `fix(pocket-review)`: write `REVIEW_PASS` stub for empty-diff DONE tasks

## 2.2.1 — 2026-06-05

- `feat(skills)`: add `structured-research` standalone skill (#19)
- `feat(pocket-grinding)`: add advisory triviality off-ramp to hotfix
- `fix(pocket-grinding)`: make edge-case hunter a hard gate (#24)

## 2.2.0 — 2026-06-05

- `feat(cli)`: add `doctor` + `setup-extensions` commands (#17)
- `docs(pocket-help)`: add Context7 MCP setup (API key + `mcp.json`)

## 2.1.1 — 2026-06-05

- `feat(brand-design)`: enforce creative brief via `SessionStart` hook (#15)

## 2.1.0 — 2026-06-04

- `feat(structure)`: surface execution flow + validate passthrough plans (#13)
- `feat(pocket-planning)`: validate + route in Phase 7 via `structure --dry-run`

## 2.0.4 — 2026-06-04

- `feat(skills)`: add `pocket-closing` terminal stage (#11)
- `fix(pocket-closing)`: close stale-verdict gate hole + review nits

## 2.0.3 — 2026-06-04

- `feat(skills)`: add `pocket-help` onboarding skill; rename `pocket-branding` → `brand-design`

## 2.0.2 — 2026-06-04

- `fix(skills)`: slim `pocket-planning` → `pocket-structuring` handoff (#7)
- `fix(pocket-structuring)`: resolve ≤6-task routing policy conflict

## 2.0.1 — 2026-06-02

First tagged release. `feat`: replace the Python `pocket-*` scripts with a cross-platform `npx` CLI (v2.0). `fix`: handle dual annotations in the `structure` command parser; harden `parseAnnotation` against empty values and duplicate tags.

Untagged history folded into this release (1.1.0–1.2.2): initial Pi package + npm publish setup, `pocket-review` reworked into a standalone post-phase parallel-subagent model, `pocket-branding` skill added, parallel group execution support.
