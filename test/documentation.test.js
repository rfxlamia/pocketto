const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { assertRollbackGuidance } = require("../test-support/documentation/enterprise-label-recovery");

const DOCUMENTATION_PATHS = [
	"README.md",
	"CHANGELOG.md",
	"llms.txt",
	"skills/pocket-enterprise/SKILL.md",
	"skills/pocket-enterprise/references/lifecycle-contract.md",
	"skills/pocket-enterprise/references/onboarding.md",
	"skills/pocket-enterprise/references/issue-reconciliation.md",
	"skills/pocket-enterprise/references/phase-reconciliation.md",
	"skills/pocket-development/SKILL.md",
	"skills/pocket-closing/SKILL.md",
	"skills/create-pr/SKILL.md",
];

function readDocumentation() {
	return Object.fromEntries(
		DOCUMENTATION_PATHS.map((relativePath) => [
			relativePath,
			readFileSync(path.join(__dirname, "..", relativePath), "utf8"),
		]),
	);
}

function sentences(text) {
	return text
		.split(/\n|(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

function unnegatedCoreRemoteClaims(text) {
	const remoteActionPatterns = [
		/\b(?:calls?|runs?|invokes?|executes?)\b[^.!?;:]*?\bgh\b/gi,
		/\b(?:merges?|merge|closes?|close)\b[^.!?;:]*?\b(?:PRs?|pull requests?|issues?)\b/gi,
	];
	const negatedActionPrefix =
		/(?:\b(?:do|does|did|can|could|will|would|should|must)\s+not|\b(?:never|cannot|can't|doesn't|don't)|\bnot\s+(?:allowed|supposed|authorized|permitted)\s+to)\s*$/i;

	return sentences(text).filter((sentence) => {
		if (!/\bCore\b/i.test(sentence)) return false;

		const actionMatches = remoteActionPatterns
			.flatMap((pattern) => [...sentence.matchAll(pattern)])
			.sort((left, right) => left.index - right.index);
		let previousAction;

		for (const action of actionMatches) {
			const textSincePreviousAction = previousAction
				? sentence.slice(previousAction.index + previousAction[0].length, action.index)
				: sentence.slice(0, action.index);
			const directlyNegated = negatedActionPrefix.test(textSincePreviousAction);
			if (!directlyNegated) return true;

			previousAction = action;
		}
		return false;
	});
}

test("Core remote-action guard rejects a gh claim despite a negated merge claim", () => {
	const claim = "Core calls gh but does not merge pull requests.";

	assert.deepEqual(unnegatedCoreRemoteClaims(claim), [claim]);
});

test("Core remote-action guard rejects an issue-close claim despite a negated gh claim", () => {
	const claim = "Core closes issues but never calls gh.";

	assert.deepEqual(unnegatedCoreRemoteClaims(claim), [claim]);
});

test("Core remote-action guard rejects a merge claim after a negated gh claim separated by a comma", () => {
	const claim = "Core does not call gh, merges pull requests.";

	assert.deepEqual(unnegatedCoreRemoteClaims(claim), [claim]);
});

test("Core remote-action guard rejects a gh claim after a negated issue-close claim separated by a comma", () => {
	const claim = "Core does not close issues, calls gh.";

	assert.deepEqual(unnegatedCoreRemoteClaims(claim), [claim]);
});

test("Core remote-action guard rejects a merge claim after a negated gh claim joined by and", () => {
	const claim = "Core never calls gh and merges pull requests.";

	assert.deepEqual(unnegatedCoreRemoteClaims(claim), [claim]);
});

test("Core remote-action guard rejects a merge claim after a negated gh claim joined by or", () => {
	const claim = "Core never calls gh or merges pull requests.";

	assert.deepEqual(unnegatedCoreRemoteClaims(claim), [claim]);
});

test("Core remote-action guard accepts explicit negations for each prohibited action", () => {
	const explicitlyNegatedClaims = [
		"Core does not call gh.",
		"Core never merges pull requests.",
		"Core does not close issues.",
		"Core does not call gh, does not merge pull requests, and does not close issues.",
	];

	for (const claim of explicitlyNegatedClaims) {
		assert.deepEqual(unnegatedCoreRemoteClaims(claim), [], `Unexpected remote-action claim: ${claim}`);
	}
});

function assertManifestRoles(readme) {
	const roles = ["pi/core", "pi/enterprise", "claude/core", "claude/enterprise"];
	const missingRoles = roles.filter((role) => !readme.includes(role));
	assert.deepEqual(missingRoles, [], `README is missing manifest role(s): ${missingRoles.join(", ")}`);
}

function assertReleaseIdentifiers(releaseDocs) {
	for (const [label, pattern] of [
		["package version 4.2.0", /\b4\.2\.0\b/],
		["CLI CONTRACT=3", /\bCONTRACT\s*=\s*3\b/],
		["PIPELINE=5", /\bPIPELINE\s*=\s*5\b/],
		["LIFECYCLE_SCHEMA=2", /\bLIFECYCLE_SCHEMA\s*=\s*2\b/],
		["ADAPTER_CONTRACT=2", /\bADAPTER_CONTRACT\s*=\s*2\b/],
		["SURFACE_MANIFEST=1", /\bSURFACE_MANIFEST\s*=\s*1\b/],
	]) {
		assert.match(releaseDocs, pattern, `Release documentation must identify ${label}`);
	}
}

function assertLifecycleCommands(allDocs) {
	for (const command of [
		"lifecycle transition",
		"lifecycle drain",
		"lifecycle repair",
	]) {
		assert.ok(allDocs.includes(command), `Documentation must include the ${command} command`);
	}
	assert.match(
		allDocs,
		/lifecycle migrate <spec_dir> --from v3/,
		"Documentation must show the explicit v3 migration command",
	);
	assert.match(allDocs, /--json --contract 3/, "Lifecycle commands must use CLI contract 3");
}

function assertEnterpriseOnboardingCliContract(onboarding) {
	const cliCommands = [...onboarding.matchAll(/^npx -y pocketto-pi .+$/gm)].map(
		([command]) => command,
	);
	assert.ok(cliCommands.length > 0, "Enterprise onboarding must include Pocketto CLI commands");
	for (const command of cliCommands) {
		assert.match(
			command,
			/--json --contract 3$/,
			`Enterprise onboarding commands must use CLI contract 3: ${command}`,
		);
	}
}

function assertCompatibilityMatrix(readme) {
	const compatibilityRows = [
		[/v3 Core\s*\+\s*v3 Enterprise[^\n]*(?:operational|usable)[^\n]*warning/i, "v3 Core + v3 Enterprise remains usable with a warning"],
		[/v4 Core\s*\+\s*v4 Enterprise[^\n]*supported/i, "v4 Core + v4 Enterprise is supported"],
		[/v4 Core\s*\+\s*(?:absent|none)[^\n]*local-first/i, "v4 Core without Enterprise remains local-first"],
		[/v3 Core\s*\+\s*v4 Enterprise[^\n]*fail(?:s|-) closed/i, "v3 Core + v4 Enterprise fails closed"],
		[/v4 Core\s*\+\s*v3 Enterprise[^\n]*fail(?:s|-) closed/i, "v4 Core + v3 Enterprise fails closed"],
	];
	for (const [pattern, description] of compatibilityRows) {
		assert.match(readme, pattern, `Compatibility matrix must state that ${description}`);
	}
}

function assertMigrationPolicy(allDocs) {
	assert.match(allDocs, /PIN_V3_REQUIRED/, "Progressed v3 plans must remain pinned to v3");
	assert.match(
		allDocs,
		/(?:never|must not|cannot|does not)[^\n.]{0,120}(?:silently|automatic(?:ally)?)[^\n.]{0,80}(?:migrat|convert|rewrit)|(?:silently|automatic(?:ally)?)[^\n.]{0,80}(?:migrat|convert|rewrit)[^\n.]{0,120}(?:never|must not|cannot|does not)/i,
		"Documentation must prohibit silent or automatic v3 conversion",
	);
}

function bashFences(text) {
	return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function assertNoUnnegatedCoreRemoteClaims(allDocs) {
	const unnegatedCoreClaims = unnegatedCoreRemoteClaims(allDocs);
	assert.deepEqual(
		unnegatedCoreClaims,
		[],
		`Core documentation must not claim GitHub side effects: ${unnegatedCoreClaims.join(" | ")}`,
	);
}

test("user-facing documentation describes the v4 Core and Enterprise contract", () => {
	const documentation = readDocumentation();
	const readme = documentation["README.md"];
	const releaseDocs = [
		documentation["README.md"],
		documentation["CHANGELOG.md"],
		documentation["llms.txt"],
	].join("\n");
	const allDocs = Object.values(documentation).join("\n");

	assertManifestRoles(readme);
	assertReleaseIdentifiers(releaseDocs);
	assertLifecycleCommands(allDocs);
	assertEnterpriseOnboardingCliContract(
		documentation["skills/pocket-enterprise/references/onboarding.md"],
	);
	for (const rel of [
		"skills/pocket-enterprise/references/onboarding.md",
		"skills/pocket-enterprise/references/lifecycle-contract.md",
	]) {
		const text = documentation[rel];
		for (const [pattern, label] of [
			[/lifecycle-adapter\.json/, "registration path"],
			[/@pocketto-runtime-argv-v1/, "runtime argv descriptor"],
			[/@pocketto-node/, "Node runtime token"],
			[/@pocketto-install-root/, "installation-root runtime token"],
			[/installation root/i, "shared installation root"],
			[/reserved/i, "reserved-token policy"],
			[/commit/i, "commit policy"],
			[/reinstall/i, "migration guidance"],
		]) {
			assert.match(text, pattern, `${rel} must document the portable registration contract: missing ${label}`);
		}
	}
	assertCompatibilityMatrix(readme);
	assertMigrationPolicy(allDocs);
	assertRollbackGuidance(allDocs, documentation);
	assertNoUnnegatedCoreRemoteClaims(allDocs);
});

test("stacked skill contract: Core development and closing route handoff and drain", () => {
	const read = (rel) => readFileSync(path.join(__dirname, "..", rel), "utf8");
	const closing = read("skills/pocket-closing/SKILL.md");
	const development = read("skills/pocket-development/SKILL.md");
	const entryGate = read("skills/pocket-development/references/entry-gate.md");

	for (const needle of ["log handoff", "next_actions", "Lifecycle delivery:", "Branch:", "Notices:", "Warnings:"]) {
		assert.ok(closing.includes(needle), `pocket-closing must contain ${needle}`);
	}
	const gate = `${development}\n${entryGate}`;
	for (const needle of ["phases[N].branch", "git switch", "lifecycle drain", "data.phase_branches", "data.branch"]) {
		assert.ok(gate.includes(needle), `pocket-development must contain ${needle}`);
	}
	for (const [name, text] of [["pocket-closing", closing], ["pocket-development", development], ["entry-gate", entryGate]]) {
		assert.ok(!text.includes("Pocket Enterprise"), `${name} must stay neutral`);
	}
});

test("stacked skill contract: pocket-closing runs last-phase handoff before log close", () => {
	const closing = readFileSync(path.join(__dirname, "..", "skills/pocket-closing/SKILL.md"), "utf8");
	const start = closing.indexOf("## Stacked Handoff");
	assert.ok(start >= 0, "Stacked Handoff section must exist");
	const next = closing.indexOf("\n## ", start + 1);
	const section = closing.slice(start, next < 0 ? undefined : next);

	assert.match(section, /`log handoff`[^.\n]*before `log close`/, "handoff must be stated to run before `log close`");
	assert.match(section, /LIFECYCLE_BAD_STATE/, "section must warn that handoff after close fails");
	assert.doesNotMatch(closing, /and `log close`, when it applies\)/, "must not order handoff after `log close`");
	assert.match(closing, /Close[\s\S]*?Stacked plans: .*Stacked Handoff/, "Close section must point final-phase handoff to Stacked Handoff");
});

test("stacked enterprise skill contract", () => {
	const read = (rel) => readFileSync(path.join(__dirname, "..", rel), "utf8");
	const createPr = read("skills/create-pr/SKILL.md");
	const onboarding = read("skills/pocket-enterprise/references/onboarding.md");
	const lifecycleContract = read("skills/pocket-enterprise/references/lifecycle-contract.md");

	assert.ok(createPr.includes("publish-phase"), "create-pr must route stacked plans through publish-phase");
	assert.ok(createPr.includes("Warnings:"), "create-pr must report preflight Warnings verbatim");
	assert.ok(!createPr.includes("--force"), "create-pr must never reference --force");

	for (const needle of ["--phase-branches", "--push-consent", "adapter contract 2"]) {
		assert.ok(onboarding.includes(needle), `onboarding must contain ${needle}`);
	}

	for (const needle of ["phase-closed", "notices"]) {
		assert.ok(lifecycleContract.includes(needle), `lifecycle-contract must contain ${needle}`);
	}
});

