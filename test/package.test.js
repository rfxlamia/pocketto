// Smoke tests for the published tarball. Skills are the product; a pack
// that drops a moved reference or retains a deleted skill entry point can
// still pass the CLI suite. These assertions lock the 3.0.1 layout.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

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
const IGNORED_SKILL_SOURCE_NAMES = new Set([".DS_Store", "Thumbs.db"]);
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
	"create-pr",
];
const ALL_DIAGRAM_LABELS = [...PIPELINE_DIAGRAM_LABELS, ...STANDALONE_DIAGRAM_LABELS];

// Path citations agents are told to load. Line suffixes (`:96-111`) are
// stripped before lookup. `<skills_root>/…` is the parent of a skill dir.
const CITATION_RE =
	/(?:<skills_root>\/|(?:skills|references|cli)\/)[A-Za-z0-9._/-]+\.(?:md|js)(?::\d+(?:-\d+)?)?/g;

function posix(rel) {
	return rel.split(path.sep).join("/");
}

function walkFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...walkFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

function skillSourcePaths(skillDir) {
	return walkFiles(skillDir)
		.map((full) => posix(path.relative(skillDir, full)))
		.filter((rel) => !rel.endsWith(".skill"))
		.filter((rel) =>
			rel.split("/").every((part) =>
				!IGNORED_SKILL_SOURCE_NAMES.has(part) && part !== "__MACOSX"
			),
		)
		.sort();
}

function skillArchivePaths(archive) {
	let output;
	try {
		output = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
	} catch (error) {
		if (error.code === "ENOENT") {
			assert.fail("unzip executable is required to validate .skill archives");
		}
		throw error;
	}

	const entries = output.split(/\r?\n/).filter(Boolean);
	const seen = new Set();
	for (const entry of entries) {
		assert.equal(path.posix.isAbsolute(entry), false, `${archive}: absolute ZIP entry ${entry}`);
		assert.equal(entry.includes("\\"), false, `${archive}: backslash in ZIP entry ${entry}`);
		assert.equal(
			entry.split("/").includes(".."),
			false,
			`${archive}: parent traversal in ZIP entry ${entry}`,
		);
		assert.equal(seen.has(entry), false, `${archive}: duplicate ZIP entry ${entry}`);
		seen.add(entry);
	}
	return entries.sort();
}

function packAndExtract() {
	const dir = mkdtempSync(path.join(tmpdir(), "pocketto-pack-"));
	execFileSync("npm", ["pack", "--pack-destination", dir], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const tgz = readdirSync(dir).filter((f) => f.endsWith(".tgz"));
	assert.equal(tgz.length, 1, `expected one tarball, got ${tgz.join(", ")}`);
	execFileSync("tar", ["-xzf", tgz[0], "-C", dir], { cwd: dir });
	return { dir, extracted: path.join(dir, "package") };
}

function packedPaths(extracted) {
	const files = new Set();
	for (const full of walkFiles(extracted)) {
		files.add(posix(path.relative(extracted, full)));
	}
	return files;
}

function resolveCitation(citation, fromFile) {
	const filePart = citation.replace(/:\d+(?:-\d+)?$/, "");
	if (filePart.startsWith("<skills_root>/")) {
		return `skills/${filePart.slice("<skills_root>/".length)}`;
	}
	if (filePart.startsWith("references/")) {
		const parts = fromFile.split("/");
		return `${parts[0]}/${parts[1]}/${filePart}`;
	}
	return filePart;
}

test("packed package keeps moved review files and drops deprecated skills", () => {
	const { dir, extracted } = packAndExtract();
	try {
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
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bundled .skill archives match their source directories", () => {
	const archives = walkFiles(path.join(ROOT, "skills"))
		.filter((full) => full.endsWith(".skill"))
		.sort();
	assert.ok(archives.length > 0, "expected at least one bundled .skill archive");

	for (const archive of archives) {
		const skillDir = path.dirname(archive);
		const expected = skillSourcePaths(skillDir);
		const actual = skillArchivePaths(archive);
		assert.deepEqual(actual, expected, `${archive}: ZIP file manifest differs from source`);

		for (const rel of expected) {
			const archived = execFileSync("unzip", ["-p", archive, rel]);
			const source = readFileSync(path.join(skillDir, rel));
			assert.equal(
				archived.equals(source),
				true,
				`${archive}: stale content for ${rel}`,
			);
		}
	}
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
	assert.match(svg, />13 skills total[^<]*<\/text>/, "SVG total must be 13");

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
			(element) => element.type === "text" && element.text.startsWith("13 skills total"),
		),
		"Excalidraw total must be 13",
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
