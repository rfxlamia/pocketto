const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const DOCUMENTATION_PATHS = [
	"README.md",
	"CHANGELOG.md",
	"llms.txt",
	"skills/pocket-enterprise/SKILL.md",
	"skills/pocket-enterprise/references/lifecycle-contract.md",
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

test("user-facing documentation describes the v4 Core and Enterprise contract", () => {
	const documentation = readDocumentation();
	const readme = documentation["README.md"];
	const releaseDocs = [
		documentation["README.md"],
		documentation["CHANGELOG.md"],
		documentation["llms.txt"],
	].join("\n");
	const allDocs = Object.values(documentation).join("\n");

	const roles = ["pi/core", "pi/enterprise", "claude/core", "claude/enterprise"];
	const missingRoles = roles.filter((role) => !readme.includes(role));
	assert.deepEqual(missingRoles, [], `README is missing manifest role(s): ${missingRoles.join(", ")}`);

	for (const [label, pattern] of [
		["package version 4.0.0", /\b4\.0\.0\b/],
		["CLI CONTRACT=3", /\bCONTRACT\s*=\s*3\b/],
		["PIPELINE=5", /\bPIPELINE\s*=\s*5\b/],
		["LIFECYCLE_SCHEMA=1", /\bLIFECYCLE_SCHEMA\s*=\s*1\b/],
		["ADAPTER_CONTRACT=1", /\bADAPTER_CONTRACT\s*=\s*1\b/],
		["SURFACE_MANIFEST=1", /\bSURFACE_MANIFEST\s*=\s*1\b/],
	]) {
		assert.match(releaseDocs, pattern, `Release documentation must identify ${label}`);
	}

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
	assert.match(allDocs, /PIN_V3_REQUIRED/, "Progressed v3 plans must remain pinned to v3");
	assert.match(
		allDocs,
		/(?:never|must not|cannot|does not)[^\n.]{0,120}(?:silently|automatic(?:ally)?)[^\n.]{0,80}(?:migrat|convert|rewrit)|(?:silently|automatic(?:ally)?)[^\n.]{0,80}(?:migrat|convert|rewrit)[^\n.]{0,120}(?:never|must not|cannot|does not)/i,
		"Documentation must prohibit silent or automatic v3 conversion",
	);

	assert.match(
		allDocs,
		/(?:disable|remove)[^\n.]{0,100}Enterprise adapter/i,
		"Rollback guidance must explain how to disable or remove the adapter",
	);
	assert.match(allDocs, /pending events?[^\n.]{0,120}(?:retain|preserv|replay|remain)/i, "Rollback must preserve pending events");
	assert.match(allDocs, /lifecycle drain/, "Rollback guidance must provide the lifecycle replay command");
	assert.match(
		allDocs,
		/(?:preserve|retain)[^\n.]{0,100}(?:\.pocket-meta\.json|log\.json|lifecycle\.json)/i,
		"Rollback must preserve local lifecycle and traveling state",
	);

	const unnegatedCoreClaims = sentences(allDocs).filter((sentence) => {
		const mentionsRemoteAction =
			(/\bCore\b/i.test(sentence) &&
				/\b(?:calls?|runs?|invokes?|executes?)\b[^.!?]*\bgh\b/i.test(sentence)) ||
			(/\bCore\b/i.test(sentence) &&
				/\b(?:merges?|merge|closes?|close)\b[^.!?]*\b(?:PRs?|pull requests?|issues?)\b/i.test(sentence));
		const explicitlyNegated =
			/\b(?:not|never|no|without|cannot|can't|doesn't|don't|does not|do not)\b/i.test(sentence);
		return mentionsRemoteAction && !explicitlyNegated;
	});
	assert.deepEqual(
		unnegatedCoreClaims,
		[],
		`Core documentation must not claim GitHub side effects: ${unnegatedCoreClaims.join(" | ")}`,
	);
});
