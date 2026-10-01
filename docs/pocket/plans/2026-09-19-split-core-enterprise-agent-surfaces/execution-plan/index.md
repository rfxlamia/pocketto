# Core and Enterprise Agent Surfaces — Execution Index

**Date:** 2026-09-19
**Spec:** docs/pocket/spec/2026-09-19-split-core-enterprise-agent-surfaces/core-enterprise-agent-surfaces.md
**Source Plan:** ../execution-plan.md
**source-sha256:** 8dc817220dcb63df48218173d03e81fc66df26bf3bed95045c405d4e180bfe83
**Total Tasks:** 14
**Total Phases:** 3

---

## Execution Flow

```
T1→T2→T3,T5,T7(PARALLEL)→T4,T6,T8,T9,T10(PARALLEL)→T11,T12(PARALLEL)→T13,T14(PARALLEL)
```

---

## Phase Summary

- **Phase 1:** [phase-1.md](phase-1.md) — Define v4 neutral lifecycle and adapter contracts (T1, T2, T3, T5, T7)
- **Phase 2:** [phase-2.md](phase-2.md) — Implement lifecycle drain, repair, claims, and opaque adapter dispatch (T4, T6, T8, T9, T10)
- **Phase 3:** [phase-3.md](phase-3.md) — Implement v3 migration and mixed-major compatibility (T11, T12, T13, T14)

---

## Task Index

| Task ID | Name | Phase | Task File | Annotation |
|---|---|---|---|---|
| T1 | Define v4 neutral lifecycle and adapter contracts | Phase 1 | [T1-define-v4-neutral-lifecycle-and-adapter-contracts.md](tasks/T1-define-v4-neutral-lifecycle-and-adapter-contracts.md) | [prereq] |
| T2 | Build atomic lifecycle storage and artifact validation | Phase 1 | [T2-build-atomic-lifecycle-storage-and-artifact-validation.md](tasks/T2-build-atomic-lifecycle-storage-and-artifact-validation.md) | [depends: T1] |
| T3 | Integrate Core transitions with log state and projection | Phase 1 | [T3-integrate-core-transitions-with-log-state-and-projection.md](tasks/T3-integrate-core-transitions-with-log-state-and-projection.md) | [depends: T2] [parallel: T5] |
| T5 | Build the manifest-driven four-role release surfaces | Phase 1 | [T5-build-the-manifest-driven-four-role-release-surfaces.md](tasks/T5-build-the-manifest-driven-four-role-release-surfaces.md) | [depends: T2] |
| T7 | Implement Enterprise adapter registration, protocol, and transport seam | Phase 1 | [T7-implement-enterprise-adapter-registration-protocol-and-transport-seam.md](tasks/T7-implement-enterprise-adapter-registration-protocol-and-transport-seam.md) | [depends: T2] [parallel: T3] [test-risk] |
| T4 | Implement lifecycle drain, repair, claims, and opaque adapter dispatch | Phase 2 | [T4-implement-lifecycle-drain-repair-claims-and-opaque-adapter-dispatch.md](tasks/T4-implement-lifecycle-drain-repair-claims-and-opaque-adapter-dispatch.md) | [depends: T3] [test-risk] |
| T6 | Split Core and Enterprise skill instructions without duplicating Core | Phase 2 | [T6-split-core-and-enterprise-skill-instructions-without-duplicating-core.md](tasks/T6-split-core-and-enterprise-skill-instructions-without-duplicating-core.md) | [depends: T5] |
| T8 | Reconcile spec-approved issue identity and ownership | Phase 2 | [T8-reconcile-spec-approved-issue-identity-and-ownership.md](tasks/T8-reconcile-spec-approved-issue-identity-and-ownership.md) | [depends: T7] [parallel: T9] [test-risk] |
| T9 | Reconcile phase-complete PR markers and fingerprints | Phase 2 | [T9-reconcile-phase-complete-pr-markers-and-fingerprints.md](tasks/T9-reconcile-phase-complete-pr-markers-and-fingerprints.md) | [depends: T7] [test-risk] |
| T10 | Reconcile plan-closed tasklist and closeout proof | Phase 2 | [T10-reconcile-plan-closed-tasklist-and-closeout-proof.md](tasks/T10-reconcile-plan-closed-tasklist-and-closeout-proof.md) | [depends: T7] [parallel: T8] [test-risk] |
| T11 | Implement v3 migration and mixed-major compatibility | Phase 3 | [T11-implement-v3-migration-and-mixed-major-compatibility.md](tasks/T11-implement-v3-migration-and-mixed-major-compatibility.md) | [depends: T4, T7] [test-risk] |
| T12 | Verify Core-to-Enterprise lifecycle integration and recovery | Phase 3 | [T12-verify-core-to-enterprise-lifecycle-integration-and-recovery.md](tasks/T12-verify-core-to-enterprise-lifecycle-integration-and-recovery.md) | [depends: T4, T8, T9, T10] [test-risk] |
| T13 | Update user-facing documentation and release guidance | Phase 3 | [T13-update-user-facing-documentation-and-release-guidance.md](tasks/T13-update-user-facing-documentation-and-release-guidance.md) | [depends: T6, T11, T12] [parallel: T14] |
| T14 | Run final release and regression verification | Phase 3 | [T14-run-final-release-and-regression-verification.md](tasks/T14-run-final-release-and-regression-verification.md) | [depends: T6, T11, T12] |
