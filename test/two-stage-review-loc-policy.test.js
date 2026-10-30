const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// Issue #87: LOC heuristics (~300 lines/file, ~50 lines/function, rule of three)
// are inspection prompts, not automatic audit failures. These tests lock the
// evidence-based maintainability review policy and guard the retained contract:
// severity vocabulary, verdict schema, mechanical gate, read-only auditor,
// and the no-implementer-self-report rule.
//
// The ~300 / ~50 / 3+ numbers intentionally REMAIN in the text as diagnostic
// signals — no assertion here may require their absence.

const ROOT = path.join(__dirname, "..");

function read(rel) {
	return readFileSync(path.join(ROOT, rel), "utf8");
}

const TWO_STAGE_REVIEW = read("skills/pocket-development/references/two-stage-review.md");
const CODE_QUALITY_REVIEW = read("skills/pocket-development/references/code-quality-review.md");
const PLAN_TEMPLATE = read("skills/pocket-planning/references/plan-template.md");
const PLANNING_SKILL = read("skills/pocket-planning/SKILL.md");

test("two-stage-review: refactor heuristics are prompts to inspect, not automatic failures", () => {
	// Section identity preserved — phase-level-pass.md cites this heading.
	assert.ok(TWO_STAGE_REVIEW.includes("## Refactor heuristics"), "§ Refactor heuristics must survive");

	// Evidence-based review language replaces the unconditional gate.
	assert.ok(
		TWO_STAGE_REVIEW.includes("prompts to inspect"),
		"heuristics must be framed as prompts to inspect",
	);
	assert.ok(
		TWO_STAGE_REVIEW.includes("concrete maintainability risk"),
		"an Important finding requires a cited concrete maintainability risk",
	);
	assert.ok(
		TWO_STAGE_REVIEW.includes("must not force a correction round"),
		"size alone must not force a correction round",
	);

	// The old unconditional rule is gone.
	assert.doesNotMatch(
		TWO_STAGE_REVIEW,
		/A diff that crosses any threshold SHALL produce an Important/,
		"the unconditional threshold-to-Important rule must be removed",
	);
	assert.doesNotMatch(
		TWO_STAGE_REVIEW,
		/The thresholds are identical logic 3\+ times/,
		"the old threshold-listing sentence must be removed",
	);
	assert.doesNotMatch(
		TWO_STAGE_REVIEW,
		/→ \[Important\]/,
		"no automatic [Important] mapping may remain",
	);

	// An evidence-backed Important still forces a fix/refactor round.
	assert.ok(
		TWO_STAGE_REVIEW.includes("still requires a fix/refactor cycle"),
		"an evidence-backed Important must still force a fix/refactor round",
	);
	assert.ok(
		TWO_STAGE_REVIEW.includes("including an evidence-backed maintainability finding"),
		"the recovery-round consuming event must keep covering maintainability findings",
	);
	// No diff may gate on heuristic signals firing: a signal-free diff can still
	// be judged, and a signal-free diff with no finding proceeds to DONE.
	assert.ok(
		TWO_STAGE_REVIEW.includes(
			"A diff with no evidence-backed maintainability finding — whether or not any heuristic signal fired — proceeds to commit / DONE",
		),
		"DONE must not be gated on heuristic signals firing",
	);
});

test("two-stage-review: audit contract is preserved", () => {
	assert.ok(
		TWO_STAGE_REVIEW.includes("No implementer self-report is required or accepted"),
		"the no-self-report rule must survive",
	);
	assert.ok(
		TWO_STAGE_REVIEW.includes("## Mechanical gate"),
		"the mechanical gate must survive",
	);
	assert.ok(
		TWO_STAGE_REVIEW.includes("SHALL always be a separate read-only subagent"),
		"the read-only auditor boundary must survive",
	);
	for (const severity of ["Critical | Important | Minor"]) {
		assert.ok(TWO_STAGE_REVIEW.includes(severity), `severity vocabulary must survive: ${severity}`);
	}
	for (const verdict of ["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_BLOCKED"]) {
		assert.ok(TWO_STAGE_REVIEW.includes(verdict), `verdict contract must survive: ${verdict}`);
	}
});

test("code-quality-review: size and duplication bullets no longer auto-fail", () => {
	assert.doesNotMatch(
		CODE_QUALITY_REVIEW,
		/File >~300 lines or function >~50 lines left unsplit → \[Important\]/,
		"the size bullet must not map unsplit size to [Important]",
	);
	assert.doesNotMatch(
		CODE_QUALITY_REVIEW,
		/Same logic 3\+ times in scope, or duplicated across files of the same plan → \[Important\]/,
		"the duplication bullet must not map repetition to [Important]",
	);
	assert.doesNotMatch(
		CODE_QUALITY_REVIEW,
		/→ \[Important\]/,
		"no automatic [Important] mapping may remain",
	);

	assert.ok(
		CODE_QUALITY_REVIEW.includes("prompt to inspect"),
		"structure assessment must frame size signals as prompts to inspect",
	);
	assert.ok(
		CODE_QUALITY_REVIEW.includes("**Large file, small change, sound cohesion:**"),
		"edge cases must keep the large-file-small-change case",
	);
	assert.ok(
		CODE_QUALITY_REVIEW.includes("Size alone is not a defect."),
		"edge cases must state that size alone is not a defect",
	);
	// The "spec-compliant but ugly" edge case must not be an evidence-free
	// Important path — it carries the same cited-risk bar as the heuristics.
	assert.ok(
		CODE_QUALITY_REVIEW.includes(
			"Flag as Important only with a cited concrete maintainability risk",
		),
		"the ugly-code edge case must require a cited concrete maintainability risk",
	);
	assert.doesNotMatch(
		CODE_QUALITY_REVIEW,
		/Flag as Important \(maintainability\)/,
		"the ugly-code edge case must not flag Important unconditionally",
	);

	// Severity vocabulary survives the rewrite.
	for (const heading of ["### Critical", "### Important", "### Minor"]) {
		assert.ok(CODE_QUALITY_REVIEW.includes(heading), `severity heading must survive: ${heading}`);
	}
});

test("plan-template: rule-of-three packet default is inspected, not enforced", () => {
	assert.doesNotMatch(
		PLAN_TEMPLATE,
		/Rule of three enforced/,
		"the packet default must not re-hardwire duplication as an automatic gate",
	);
	assert.ok(
		PLAN_TEMPLATE.includes("Rule of three inspected"),
		"the packet default must frame rule of three as inspected",
	);
	assert.ok(
		PLAN_TEMPLATE.includes("not implementer self-report"),
		"the no-self-report clause must survive in the packet default",
	);
});

test("pocket-planning: file mapping no longer mandates extraction by size alone", () => {
	assert.doesNotMatch(
		PLANNING_SKILL,
		/already over ~300 lines \(or pushed past it by this work\) → plan the\s+extraction as part of the task/,
		"the unconditional size-driven extraction rule must be softened",
	);
	assert.ok(
		PLANNING_SKILL.includes("not required merely to satisfy a metric"),
		"planning must weigh trade-offs instead of splitting to satisfy a metric",
	);
});
