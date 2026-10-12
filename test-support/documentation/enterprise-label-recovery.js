const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

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

function documentationSection(text, heading) {
	const level = heading.match(/^(#{1,6})\s/)?.[1].length;
	assert.ok(level, `Invalid documentation heading: ${heading}`);

	const lines = text.split("\n");
	const start = lines.findIndex((line) => line === heading);
	assert.ok(start >= 0, `Missing documentation heading: ${heading}`);

	const nextHeading = /^ {0,3}(#{1,6})(?:\s|$)/;
	const end = lines.findIndex((line, index) => {
		if (index <= start) return false;
		const match = line.match(nextHeading);
		return match !== null && match[1].length <= level;
	});
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

test("enterprise label recovery: route and confirmed absence", () => {
	const skill = readFileSync(path.join(ROOT, "skills/pocket-enterprise/SKILL.md"), "utf8");
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const section = documentationSection(reconciliation, "## Missing-label consent recovery");

	assert.ok(skill.includes("[Missing-label consent recovery](references/issue-reconciliation.md#missing-label-consent-recovery)"), "Enterprise skill must route to the recovery procedure");
	assert.match(section, /origin[\s\S]{0,120}access/i, "Recovery must verify origin and repository access");
	assert.match(section, /exact read-only GET[\s\S]{0,240}404/i, "Recovery must require an exact-label 404");
	assert.match(section, /gh api repos\/<owner>\/<repo>\/labels\/pocket-plan/, "Recovery must provide the exact label lookup command");
	assert.match(section, /explicit permission to create/i, "Confirmed absence must be followed by an explicit ask");
	assert.match(section, /only as a missing prerequisite, not as the proven root cause/i, "Absence must not be described as the proven cause");
	assert.match(section, /Do not write the label[^.]*before consent/i, "No label write may precede consent");
	assert.match(section, /Do not[^.]*retry\/drain[^.]*before consent/i, "No lifecycle retry may precede consent");
});

test("enterprise label recovery: issue #70 is discoverable from README and changelog", () => {
	const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
	const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

	assert.match(readme, /\[#70\]\(https:\/\/github\.com\/rfxlamia\/pocketto\/issues\/70\)/, "README troubleshooting must link issue #70");
	assert.match(readme, /\[missing-label consent recovery procedure\]\(skills\/pocket-enterprise\/references\/issue-reconciliation\.md#missing-label-consent-recovery\)/, "README troubleshooting must link the recovery procedure");
	assert.match(changelog, /\[issue #70\]\(https:\/\/github\.com\/rfxlamia\/pocketto\/issues\/70\)[\s\S]*\[the procedure\]\(skills\/pocket-enterprise\/references\/issue-reconciliation\.md#missing-label-consent-recovery\)/i, "Changelog must link issue #70 and the recovery procedure");
	assert.match(changelog, /not a runtime fix or a claim that #70 is closed/i, "Changelog must not claim issue #70 is fixed or closed");
});

test("enterprise label recovery: GH_UNKNOWN requires read-only diagnosis", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const section = documentationSection(reconciliation, "## Missing-label consent recovery");

	assert.match(section, /GH_UNKNOWN` alone is not evidence of label absence/i, "GH_UNKNOWN alone must not be treated as proof the label is missing");
	assert.match(section, /only with an exact read-only GET/i, "Diagnosis must use only an exact read-only label lookup");
});

test("enterprise label recovery: existing label stops creation offer", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Exact lookup outcomes");

	assert.match(branch, /200[^.]*label exists/i, "Exact GET 200 must identify the existing label");
	assert.match(branch, /do not offer[^.]*creation/i, "Existing label must stop any creation offer");
	assert.match(branch, /another diagnosis/i, "Existing label requires another diagnosis for the delivery failure");
});

test("enterprise label recovery: origin identity and access gate lookup", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Origin verification");

	assert.match(branch, /git remote get-url origin/i, "Recovery must verify the configured origin URL");
	assert.match(branch, /gh repo view/i, "Recovery must cross-check the repository identity");
	assert.match(branch, /agree|match/i, "Origin and gh repository identities must agree");
	assert.match(branch, /Before lookup[^.]*confirm repository access/i, "Repository access must be confirmed before label lookup");
	assert.match(branch, /do not perform the label lookup/i, "Unverified origin/access must stop the label lookup");
	assert.match(branch, /do not offer a label write/i, "Unverified origin/access must stop any write offer");
	assert.doesNotMatch(branch, /If the exact GET returns 200/i, "Origin verification must exclude the sibling lookup-outcomes branch");
});

test("enterprise label recovery: inconclusive exact lookup stops creation", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const outcomes = documentationSection(recovery, "### Exact lookup outcomes");

	assert.match(outcomes, /401.{0,10}403/i, "401/403 lookup results must be handled as inconclusive");
	assert.match(outcomes, /server or transport error/i, "Server and transport errors must be handled as inconclusive");
	assert.match(outcomes, /ambiguous 404/i, "An ambiguous 404 must be handled as inconclusive");
	assert.match(outcomes, /ambiguous 404[^.]*gh repo view[^.]*same host and repository/i, "An ambiguous 404 must lack successful access verification for the same host and repository");
	assert.match(outcomes, /inconclusive/i, "Lookup failure must be classified as inconclusive");
	assert.match(outcomes, /Do not offer or perform label creation/i, "Inconclusive lookup must stop creation offers");
	assert.match(outcomes, /report[^.]*lookup failure/i, "Inconclusive lookup failure must be reported");
	assert.doesNotMatch(outcomes, /Only after the exact lookup confirms absence/i, "Lookup outcomes must exclude the sibling approval-and-creation branch");
});

test("enterprise label recovery: explicit approval precedes exact label creation", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
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
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Target re-verification");

	assert.match(branch, /recheck[^.]*host and repository/i, "Host and repository identity must be rechecked before creation");
	assert.match(branch, /after[^.]*permission[^.]*before[^.]*creation/i, "Identity must be checked after permission and before creation");
	assert.match(branch, /if[^.]*changes[^.]*stop/i, "A changed target must stop the pending write");
	assert.match(branch, /fresh[^.]*consent/i, "A changed target requires new consent");
});

test("enterprise label recovery: explicit already-exists response gets one verification lookup", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Create race recovery");

	assert.match(branch, /explicitly reports[^.]*already exists/i, "Only an explicit already-exists response enables the recovery lookup");
	assert.match(branch, /not[^.]*422/i, "A generic 422 must not be treated as proof that the label exists");
	assert.match(branch, /exact GET[^.]*once/i, "The race recovery must repeat the exact GET only once");
	assert.match(branch, /same verified target/i, "The recovery lookup must stay on the verified repository");
	assert.match(branch, /200[^.]*label[^.]*satisfied/i, "A verified 200 treats the label prerequisite as satisfied");
	assert.match(branch, /anything else[^.]*stop/i, "Any unconfirmed result must stop recovery");
});

test("enterprise label recovery: refusal and failed create stop recovery", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Refusal or create failure");

	assert.match(branch, /if the user declines/i, "User refusal must be a stop branch");
	assert.match(branch, /creation[^.]*fails|failed[^.]*creation|ambiguous result/i, "Failed or ambiguous creation must be a stop branch");
	assert.match(branch, /do not repeat[^.]*create/i, "Recovery must not repeat label creation");
	assert.match(branch, /do not[^.]*drain/i, "Recovery must not drain after refusal or failed creation");
	assert.match(branch, /do not[^.]*gh issue create/i, "Recovery must not create an issue directly");
});

test("enterprise label recovery: retry only original eligible event within attempt budget", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
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
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Pending backoff");

	assert.match(branch, /next_attempt_at/i, "Pending retry must use next_attempt_at");
	assert.match(branch, /future/i, "Future retry timestamp must be recognized");
	assert.match(branch, /do not drain early/i, "Recovery must prohibit draining before backoff expires");
	assert.match(branch, /tell[^.]*when[^.]*eligible/i, "User must be told when retry becomes eligible");
});

test("enterprise label recovery: terminal or exhausted delivery is not replayed", () => {
	const reconciliation = readFileSync(path.join(ROOT, "skills/pocket-enterprise/references/issue-reconciliation.md"), "utf8");
	const recovery = documentationSection(reconciliation, "## Missing-label consent recovery");
	const branch = documentationSection(recovery, "### Terminal or exhausted event");

	assert.match(branch, /terminal/i, "Terminal events must be identified as unsupported for replay");
	assert.match(branch, /six total attempts/i, "Exhausted six-attempt events must be identified");
	assert.match(branch, /do not drain/i, "Terminal or exhausted events must not be drained");
	assert.match(branch, /do not[^.]*edit[^.]*lifecycle state/i, "Recovery must not mutate lifecycle state");
	assert.match(branch, /manual-resolution/i, "The unsupported case must report the manual-resolution boundary");
});

module.exports = { assertRollbackGuidance };
