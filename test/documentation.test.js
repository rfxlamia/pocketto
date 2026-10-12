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

function assertSeparateRollbackRecipes(text, label) {
	const fences = bashFences(text);
	const mixed = fences.filter((fence) => fence.includes("lifecycle-adapter.json") && fence.includes("lifecycle drain"));
	assert.deepEqual(mixed, [], `${label}: registration removal and drain replay must be separate command blocks`);
	assert.ok(
		fences.some((fence) => fence.includes("rm <project-root>/.pocket/lifecycle-adapter.json") && !fence.includes("lifecycle drain")),
		`${label}: disable block removes the registration without draining`,
	);
	assert.ok(
		fences.some((fence) => fence.includes("npx pocketto-pi lifecycle drain <spec_dir> --json --contract 3") && !fence.includes("lifecycle-adapter.json")),
		`${label}: replay block drains only after the adapter is restored`,
	);
}

function assertRollbackGuidance(allDocs, documentation) {
	assert.match(
		allDocs,
		/(?:disable|remove)[^\n.]{0,160}(?:Enterprise|registration|adapter)/i,
		"Rollback guidance must explain how to disable or remove the adapter",
	);
	assert.match(allDocs, /pending events?[^\n.]{0,120}(?:retain|preserv|replay|remain)/i, "Rollback must preserve pending events");
	assert.match(allDocs, /lifecycle drain/, "Rollback guidance must provide the lifecycle replay command");
	assert.match(allDocs, /adapter-unavailable/, "Rollback must say a drain without registration stays pending");
	assert.match(allDocs, /node enterprise\/cli\.js preflight <project-root> --json/, "Rollback must name the checkout preflight command");
	assert.match(
		allDocs,
		/node node_modules\/pocketto-pi\/enterprise\/cli\.js preflight <project-root> --json/,
		"Rollback must name the installed-package preflight command",
	);
	assert.match(allDocs, /rm <project-root>\/\.pocket\/lifecycle-adapter\.json/, "Rollback must name the registration file to remove");
	assert.match(
		allDocs,
		/npx pocketto-pi lifecycle drain <spec_dir> --json --contract 3/,
		"Rollback must name the exact drain replay command",
	);
	assert.match(
		allDocs,
		/(?:preserve|retain|keep)[^\n.]{0,140}(?:\.pocket-meta\.json|log\.json|lifecycle\.json)/i,
		"Rollback must preserve local lifecycle and traveling state",
	);
	assert.match(
		documentation["CHANGELOG.md"],
		/Lifecycle commands, migration, and rollback/,
		"Changelog rollback must point at the README command lists",
	);
	assertSeparateRollbackRecipes(documentation["README.md"], "README");
	assertSeparateRollbackRecipes(
		documentation["skills/pocket-enterprise/references/lifecycle-contract.md"],
		"lifecycle contract",
	);
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

function documentationSection(text, heading) {
	const start = text.indexOf(heading);
	assert.ok(start >= 0, `Missing documentation heading: ${heading}`);
	const end = text.indexOf("\n## ", start + heading.length);
	return text.slice(start, end < 0 ? undefined : end);
}

test("enterprise label recovery: route and confirmed absence", () => {
	const skill = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/SKILL.md"), "utf8");
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const section = documentationSection(reconciliation, "## Missing-label consent recovery");

	assert.ok(skill.includes("[Missing-label consent recovery](references/issue-reconciliation.md#missing-label-consent-recovery)"), "Enterprise skill must route to the recovery procedure");
	assert.match(section, /origin[\s\S]{0,120}access/i, "Recovery must verify origin and repository access");
	assert.match(section, /exact read-only GET[\s\S]{0,120}404/i, "Recovery must require an exact-label 404");
	assert.match(section, /explicit permission to create/i, "Confirmed absence must be followed by an explicit ask");
	assert.match(section, /only as a missing prerequisite, not as the proven root cause/i, "Absence must not be described as the proven cause");
	assert.match(section, /Do not write the label[^.]*before consent/i, "No label write may precede consent");
	assert.match(section, /Do not[^.]*retry\/drain[^.]*before consent/i, "No lifecycle retry may precede consent");
});

test("enterprise label recovery: GH_UNKNOWN requires read-only diagnosis", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const section = documentationSection(reconciliation, "## Missing-label consent recovery");

	assert.match(section, /GH_UNKNOWN` alone is not evidence of label absence/i, "GH_UNKNOWN alone must not be treated as proof the label is missing");
	assert.match(section, /only with an exact read-only GET/i, "Diagnosis must use only an exact read-only label lookup");
});

test("enterprise label recovery: existing label stops creation offer", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Exact lookup outcomes");

	assert.match(branch, /200[^.]*label exists/i, "Exact GET 200 must identify the existing label");
	assert.match(branch, /do not offer[^.]*creation/i, "Existing label must stop any creation offer");
	assert.match(branch, /another diagnosis/i, "Existing label requires another diagnosis for the delivery failure");
});

test("enterprise label recovery: origin identity and access gate lookup", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Origin verification");

	assert.match(branch, /git remote get-url origin/i, "Recovery must verify the configured origin URL");
	assert.match(branch, /gh repo view/i, "Recovery must cross-check the repository identity");
	assert.match(branch, /agree|match/i, "Origin and gh repository identities must agree");
	assert.match(branch, /Before lookup[^.]*confirm repository access/i, "Repository access must be confirmed before label lookup");
	assert.match(branch, /do not perform the label lookup/i, "Unverified origin/access must stop the label lookup");
	assert.match(branch, /do not offer a label write/i, "Unverified origin/access must stop any write offer");
});

test("enterprise label recovery: inconclusive exact lookup stops creation", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const outcomes = documentationSection(recovery, "### Exact lookup outcomes");

	assert.match(outcomes, /401.{0,10}403/i, "401/403 lookup results must be handled as inconclusive");
	assert.match(outcomes, /server or transport error/i, "Server and transport errors must be handled as inconclusive");
	assert.match(outcomes, /ambiguous 404/i, "An ambiguous 404 must be handled as inconclusive");
	assert.match(outcomes, /inconclusive/i, "Lookup failure must be classified as inconclusive");
	assert.match(outcomes, /Do not offer or perform label creation/i, "Inconclusive lookup must stop creation offers");
	assert.match(outcomes, /report[^.]*lookup failure/i, "Inconclusive lookup failure must be reported");
});

test("enterprise label recovery: explicit approval precedes exact label creation", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Approval and creation");

	const approval = branch.indexOf("explicit approval");
	const create = branch.indexOf("gh label create pocket-plan --repo <verified-origin>");
	assert.ok(approval >= 0 && create > approval, "Creation requires explicit approval before the exact write");
	const command = branch.match(/`(gh label create[^`]+)`/)?.[1] ?? "";
	assert.ok(command, "The approved create command must be documented");
	assert.doesNotMatch(command, /--force|--color|--description/i, "The create command must not force or set color/description");
	assert.match(branch, /Do not add `--force`, color, or description options/i, "Documentation must prohibit additional write options");
	assert.match(branch, /once/i, "The approved label create must occur once");
});

test("enterprise label recovery: target change invalidates prior consent", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Target re-verification");

	assert.match(branch, /recheck[^.]*host and repository/i, "Host and repository identity must be rechecked before creation");
	assert.match(branch, /after[^.]*permission[^.]*before[^.]*creation/i, "Identity must be checked after permission and before creation");
	assert.match(branch, /if[^.]*changes[^.]*stop/i, "A changed target must stop the pending write");
	assert.match(branch, /fresh[^.]*consent/i, "A changed target requires new consent");
});

test("enterprise label recovery: refusal and failed create stop recovery", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Refusal or create failure");

	assert.match(branch, /if the user declines/i, "User refusal must be a stop branch");
	assert.match(branch, /creation[^.]*fails|failed[^.]*creation|ambiguous result/i, "Failed or ambiguous creation must be a stop branch");
	assert.match(branch, /do not repeat[^.]*create/i, "Recovery must not repeat label creation");
	assert.match(branch, /do not[^.]*drain/i, "Recovery must not drain after refusal or failed creation");
	assert.match(branch, /do not[^.]*gh issue create/i, "Recovery must not create an issue directly");
});

test("enterprise label recovery: retry only original eligible event within attempt budget", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Eligible retry");

	assert.match(branch, /same original event/i, "Retry must resume the same original event");
	assert.match(branch, /active[^.]*retryable/i, "Only active, retryable events may be drained");
	assert.match(branch, /due/i, "Retry must be due before draining");
	assert.match(branch, /six total attempts/i, "Retry must stay below six total attempts");
	assert.match(branch, /one initial attempt[^.]*five retries/i, "Attempt budget must define initial plus retries");
	assert.match(branch, /do not emit[^.]*new event/i, "Recovery must not emit a replacement event");
	assert.match(branch, /do not[^.]*gh issue create/i, "Retry must not bypass lifecycle with direct issue creation");
});

test("enterprise label recovery: pending retry backoff is respected", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Pending backoff");

	assert.match(branch, /next_attempt_at/i, "Pending retry must use next_attempt_at");
	assert.match(branch, /future/i, "Future retry timestamp must be recognized");
	assert.match(branch, /do not drain early/i, "Recovery must prohibit draining before backoff expires");
	assert.match(branch, /tell[^.]*when[^.]*eligible/i, "User must be told when retry becomes eligible");
});

test("enterprise label recovery: terminal or exhausted delivery is not replayed", () => {
	const reconciliation = readFileSync(path.join(__dirname, "..", "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Terminal or exhausted event");

	assert.match(branch, /terminal/i, "Terminal events must be identified as unsupported for replay");
	assert.match(branch, /six total attempts/i, "Exhausted six-attempt events must be identified");
	assert.match(branch, /do not drain/i, "Terminal or exhausted events must not be drained");
	assert.match(branch, /do not[^.]*edit[^.]*lifecycle state/i, "Recovery must not mutate lifecycle state");
	assert.match(branch, /manual-resolution/i, "The unsupported case must report the manual-resolution boundary");
});
