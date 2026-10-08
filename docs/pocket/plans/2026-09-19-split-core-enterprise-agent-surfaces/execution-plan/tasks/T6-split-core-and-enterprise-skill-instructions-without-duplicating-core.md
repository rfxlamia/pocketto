# Task T6 — Split Core and Enterprise skill instructions without duplicating Core

**Phase:** 2
**Depends:** T5
**Source plan:** ../../execution-plan.md

---

### Pocket Packet

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
