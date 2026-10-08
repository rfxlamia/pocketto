# Task T14 — Run final release and regression verification

**Phase:** 3
**Depends:** T6, T11, T12
**Source plan:** ../../execution-plan.md

---

### Pocket Packet

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
