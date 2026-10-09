// Smoke tests for the published tarball. Skills are the product; a pack
// that drops a moved reference or retains a deleted skill entry point can
// still pass the CLI suite. These assertions lock the 3.0.1 layout.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
	CITATION_RE,
	assertArchiveMatchesSource,
	resolveCitation,
	walkFiles,
} = require("../test-support/surface-test-utils");
const { packedPaths, withPackedPackage } = require("../test-support/package/fixture");
const { T10_CLOSURE_RUNTIME_FILES } = require("./surface-support/shared");

const ROOT = path.join(__dirname, "..");

require('../test-support/package/education');

const MOVED_REVIEW_FILES = [
	"skills/pocket-development/references/spec-compliance-review.md",
	"skills/pocket-development/references/code-quality-review.md",
	"skills/pocket-development/references/review-report-template.md",
];

const DELETED_SKILL_PREFIXES = [
	"skills/pocket-review/",
	"skills/pocket-correction/",
];

const DEPRECATED_SKILL_NAMES = ["pocket-review", "pocket-correction"];
const PIPELINE_DIAGRAM_LABELS = [
	"pitching",
	"grinding",
	"planning",
	"structuring",
	"development",
	"closing",
];
const STANDALONE_DIAGRAM_LABELS = [
	"pocket-help",
	"pocket-init",
	"bug-hunting",
	"hotfix",
	"brand-design",
	"structured-research",
	"validate-plan",
	"create-pr",
	"pocket-education",
];
const ALL_DIAGRAM_LABELS = [...PIPELINE_DIAGRAM_LABELS, ...STANDALONE_DIAGRAM_LABELS];



function assertPackedPackageLayout(extracted) {
	const files = packedPaths(extracted);

	for (const rel of MOVED_REVIEW_FILES) {
		assert.ok(files.has(rel), `missing packed file: ${rel}`);
	}

	const leaked = [...files].filter((rel) =>
		DELETED_SKILL_PREFIXES.some((prefix) => rel.startsWith(prefix)),
	);
	assert.deepEqual(leaked, [], "deprecated skill paths must not be packed");

	const missing = [];
	const deprecatedMentions = [];
	for (const rel of [...files].sort()) {
		if (!rel.endsWith(".md")) continue;
		const text = readFileSync(path.join(extracted, rel), "utf8");
		for (const name of DEPRECATED_SKILL_NAMES) {
			if (text.includes(name)) {
				deprecatedMentions.push(`${rel} mentions ${name}`);
			}
		}
		if (!rel.startsWith("skills/")) continue;
		const citations = text.match(CITATION_RE) || [];
		for (const citation of citations) {
			const resolved = resolveCitation(citation, rel);
			if (!files.has(resolved)) {
				missing.push(`${rel} → ${citation} (${resolved})`);
			}
		}
	}
	assert.deepEqual(missing, [], "active skill citations must resolve in the pack");
	assert.deepEqual(
		deprecatedMentions,
		[],
		"published Markdown must not mention deprecated skills",
	);

	const phasePass = readFileSync(
		path.join(extracted, "skills/pocket-development/references/phase-level-pass.md"),
		"utf8",
	);
	assert.doesNotMatch(
		phasePass,
		/pocket-correction enforces today/,
		"phase-level-pass.md must not claim a deleted skill still enforces a rule",
	);
}

test("packed package keeps moved review files and drops deprecated skills", () =>
	withPackedPackage(ROOT, assertPackedPackageLayout),
);

test("T10 closure runtime modules are explicitly allowlisted and shipped", () => {
	withPackedPackage(ROOT, (extracted) => {
		const files = packedPaths(extracted);
		for (const rel of T10_CLOSURE_RUNTIME_FILES) {
			assert.ok(files.has(rel), `npm package must include ${rel}`);
		}
	});

	const packageFiles = JSON.parse(
		readFileSync(path.join(ROOT, "package.json"), "utf8"),
	).files;
	for (const rel of T10_CLOSURE_RUNTIME_FILES) {
		assert.ok(packageFiles.includes(rel), `package.json files must explicitly include ${rel}`);
	}
});

test("bundled .skill archive members match their role-owned source sets", () => {
	const archives = walkFiles(path.join(ROOT, "skills"))
		.filter((full) => full.endsWith(".skill"))
		.sort();
	assert.ok(archives.length > 0, "expected at least one bundled .skill archive");
	for (const archive of archives) assertArchiveMatchesSource(archive, ROOT);
});

test("pipeline diagram inventory stays aligned across published assets", () => {
	const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
	const svg = readFileSync(path.join(ROOT, "assets/pipeline.svg"), "utf8");
	const drawing = JSON.parse(
		readFileSync(path.join(ROOT, "assets/pipeline.excalidraw"), "utf8"),
	);

	const svgLabels = [...svg.matchAll(/<text class="lbl"[^>]*>([^<]+)<\/text>/g)]
		.map((match) => match[1])
		.sort();
	assert.deepEqual(svgLabels, [...ALL_DIAGRAM_LABELS].sort(), "SVG skill inventory differs");
	assert.match(svg, />15 skills total[^<]*<\/text>/, "SVG total must be 15");

	const activeElements = drawing.elements.filter((element) => !element.isDeleted);
	const drawingIds = new Set(activeElements.map((element) => element.id));
	const drawingLabels = activeElements
		.filter((element) => element.type === "text" && element.containerId)
		.map((element) => element.text.split("\n")[0].replace(/^\d+\.\s*/, ""))
		.sort();
	assert.deepEqual(
		drawingLabels,
		[...ALL_DIAGRAM_LABELS].sort(),
		"Excalidraw skill inventory differs",
	);
	assert.ok(
		activeElements.some(
		(element) => element.type === "text" && element.text.startsWith("15 skills total"),
		),
		"Excalidraw total must be 14",
	);

	for (const element of activeElements) {
		for (const id of [
			element.containerId,
			element.frameId,
			element.startBinding?.elementId,
			element.endBinding?.elementId,
			...(element.boundElements || []).map((bound) => bound.id),
		].filter(Boolean)) {
			assert.ok(drawingIds.has(id), `${element.id} references missing element ${id}`);
		}
	}

	const alt = readme.match(/<img src="assets\/pipeline\.svg" alt="([^"]+)"/)?.[1];
	assert.ok(alt, "README pipeline image must have alt text");
	for (const label of ALL_DIAGRAM_LABELS) {
		assert.ok(alt.includes(label), `README pipeline alt text missing ${label}`);
	}
});

function readReviewReportTemplate() {
	return readFileSync(
		path.join(
			ROOT,
			"skills/pocket-development/references/review-report-template.md",
		),
		"utf8",
	);
}

test("review report introduction names the canonical per-task artifact", () => {
	const template = readReviewReportTemplate();
	const introduction = template.slice(0, template.indexOf("## Schema"));
	assert.match(introduction, /reviews\/<task_id>-review\.json/);
	assert.doesNotMatch(introduction, /reviews\/<task_id>-cycle-<N>\.json/);
});

test("REVIEW_BLOCKED schema and example require blocked_category", () => {
	const template = readReviewReportTemplate();
	const schemaSource = template.match(/## Schema\s+```json\n([\s\S]*?)\n```/)?.[1];
	assert.ok(schemaSource, "review report template must embed a JSON Schema");
	const schema = JSON.parse(schemaSource);
	assert.deepEqual(schema.properties.blocked_category, {
		type: "string",
		enum: ["audit-failed", "auditor-unavailable"],
	});
	assert.ok(
		(schema.allOf || []).some(
			(rule) =>
				rule.if?.properties?.overall?.const === "REVIEW_BLOCKED" &&
				rule.if?.required?.includes("overall") &&
				rule.then?.required?.includes("blocked_category"),
		),
		"REVIEW_BLOCKED artifacts must require blocked_category",
	);

	const blockedExample = template.match(
		/## Example: REVIEW_BLOCKED\s+```json\n([\s\S]*?)\n```/,
	)?.[1];
	assert.ok(blockedExample, "review report template must include a REVIEW_BLOCKED example");
	assert.ok(JSON.parse(blockedExample).blocked_category, "blocked example needs its category");
});

test("empty-diff skip stub is attributed to the main agent", () => {
	const template = readReviewReportTemplate();
	assert.match(
		template,
		/Written by the main agent during the in-loop empty-diff path/,
	);
});

require("../test-support/package/role-archives");
