# Pitch Exploration: split-core-enterprise-agent-surfaces
Date: 2026-09-19 | Project: pocketto | Status: pitch-only

---

## Problem Statement
Pocket currently shares one agent-facing skill surface while Enterprise behavior is interleaved across Core workflows. This makes Core agents see Enterprise procedures unnecessarily and makes active Enterprise execution depend on the model remembering scattered GitHub, metadata, PR, review, approval, and closeout steps.

The implementation must create structurally distinct Core and Enterprise installation surfaces from one canonical repository, move deterministic lifecycle work toward CLI/handlers, and preserve local-first behavior plus compatibility with existing Enterprise configuration.

## Root Tension
Pocket needs shared source, state, and versioning to avoid drift, but agent context and side-effect policy must be isolated so Core cannot accidentally expose or execute Enterprise behavior.

## Key Constraints
- Keep one source repository and source tree; do not fork Core and Enterprise maintenance.
- Support both Pi packages and Claude Code plugins.
- Core execution remains local-first, fail-closed, and makes zero GitHub calls.
- Preserve the existing `enterprise`, `branch_strategy`, `create_pr`, and `require_approval` configuration during migration.
- Preserve the CLI JSON envelope, contract compatibility, `log.json`, phase identity, and `.pocket-meta.json` state model.
- Keep Node.js >=18 and the current built-in-only CLI approach unless a justified boundary requires otherwise.
- Move deterministic operations incrementally; do not introduce a generic plugin/event framework before lifecycle contracts are validated.
- Verify packed Core and Enterprise artifacts rather than relying only on prose or consumer configuration.
- Existing implementation evidence: `package.json` exposes one `./skills` root, `.claude-plugin/marketplace.json` registers one plugin, and Enterprise procedure is spread across `pocket-grinding`, `pocket-development`, `pocket-closing`, `pocket-init`, and `create-pr`.

---

## Brainstorming Methods Used

### Question Storming — deep
Key insights:
- Define exactly what must be absent from a Core agent: Enterprise skill text, references, CLI commands, or all GitHub vocabulary.
- Identify the minimum lifecycle vocabulary and separate agent judgment from deterministic execution.
- Treat idempotency, resume, partial failure, and proof of zero GitHub calls as first-class questions.

### First Principles Thinking — creative
Key insights:
- Skills are the product, so context exposure is a behavioral boundary, not merely a directory refactor.
- Core and Enterprise can share workflow state while separating integration policy and side-effect execution.
- The agent should identify an event and inputs; deterministic tooling should own ordering, formatting, reconciliation, and repeatability.

### Constraint Mapping — deep
Key insights:
- Real constraints include one repository, two hosts, Node-only CLI, stable contract/state files, fail-closed Core behavior, and legacy config.
- The package/plugin name and exact distribution shape are open; not every GitHub operation must move into the CLI.
- The existing CLI primitives (`mode`, `meta`, `format`, and `reconcile`) are seams to reuse, while the low-cohesion reconciliation/scaffolding area should not become one oversized module.

### Solution Matrix — structured
Key insights:
- Compare surface selection, skill boundary, lifecycle orchestration, GitHub execution, config migration, state ownership, and verification independently.
- The matrix shows that distribution isolation and deterministic lifecycle execution are complementary boundaries, not substitutes.
- Candidate directions should be evaluated by structural Core safety, migration cost, host portability, and artifact-level testability.

---

## Advisor Synthesis
Advisor curation identified two independent boundaries: what instructions are exposed to the agent and how lifecycle side effects execute. The strongest pattern is shared domain state plus an additive Enterprise adapter, using a small typed lifecycle vocabulary such as `spec-approved`, `phase-complete`, and `plan-closed`. Config-only separation, CLI-only refactoring, duplicated wrapper workflows, and a premature generic framework were discarded because they either leave the original reliability problem intact or add unnecessary abstraction.

---

## Spike Results

**Unknown resolved:** Can one repository produce distinct Core and Enterprise install surfaces for both Pi and Claude Code without maintaining checked-in copies?

**Finding:** Yes, but the current manifests do not provide the separation. Pi supports explicit skill paths, glob exclusions, and package-level filtering. Claude Code marketplaces support multiple plugin entries with relative sources from one repository, and plugin manifests support custom skill paths. The repository currently has one Pi skill root, one Claude plugin, and a release script that already stages per-skill archives but not Core/Enterprise distributions.

Sources:
- [Claude Code plugin marketplaces](https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces)
- [Pi packages documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)

**Implication:** Release-time staging/filtering from a canonical source is the most portable path. It avoids checked-in copies and provides a place for packed-artifact tests. Consumer settings alone are weaker because the current default package exposes the entire `skills/` root; arbitrary paths outside a Claude plugin root should not be assumed without validation.

---

## Approach Directions

### Direction A: Dual Release Surfaces + Lifecycle Handlers
Keep one canonical source, but generate separate Core and Enterprise artifacts for Pi and Claude Code. Skills identify lifecycle events while deterministic handlers own formatting, GitHub synchronization, idempotency, and reconciliation.

+ Strongest structural guarantee for agent-context isolation and Enterprise reliability.
− Requires source taxonomy, release-time staging, migration work, and new contract tests.

### Direction B: Single Package + Declarative Resource Filtering
Keep one package/plugin and use manifest globs, exclusions, or consumer settings to load Core by default and Enterprise explicitly.

+ Smallest packaging change and one artifact to publish.
− Host-specific filters can leak Enterprise instructions or be configured incorrectly, weakening the safety boundary.

### Direction C: Enterprise Companion Plugin
Keep Core as the primary package and add an Enterprise companion plugin with wrapper skills/hooks, while retaining legacy branches during migration.

+ Incremental and friendly to existing installations.
− Until the legacy branches disappear, the agent still has to choose the right wrapper; this reduces but does not fully remove attention-based reliability risk.

---

## Open Questions for pocket-grinding
- [ ] Which skills and references are Core-only, Enterprise-only, or shared with a new boundary?
- [ ] What is the minimum payload and ownership contract for `spec-approved`, `phase-complete`, and `plan-closed`?
- [ ] Which operations belong in the CLI/handler, and which still require agent or human judgment?
- [ ] How should handlers report retries, resume, partial failure, and non-deterministic `gh` results?
- [ ] How should Pi and Claude release-time staging be made reproducible and validated without checked-in copies?
- [ ] How should legacy mixed installations and `enterprise: true` migrate without interrupting active plans?

---

## Recommended Direction
Direction A — it is the only direction that directly satisfies both acceptance-critical boundaries: structurally separate agent surfaces and deterministic Enterprise execution, while retaining one canonical source and shared Core state. Direction C can be used as the migration strategy toward Direction A.

---

## Handoff Context (for pocket-grinding)
When pocket-grinding reads this doc:
- Start with the Problem Statement as Phase 1 context.
- Use Direction A as the working hypothesis for Phase 5 design proposals.
- Use the Open Questions as Phase 3 discovery targets.
- Treat the Approach Directions as directional hypotheses, not final architecture; validate them through concrete scenarios and migration constraints.
