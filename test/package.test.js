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
		for (const rel of [...files].sort()) {
			if (!rel.startsWith("skills/") || !rel.endsWith(".md")) continue;
			const text = readFileSync(path.join(extracted, rel), "utf8");
			const citations = text.match(CITATION_RE) || [];
			for (const citation of citations) {
				const resolved = resolveCitation(citation, rel);
				if (!files.has(resolved)) {
					missing.push(`${rel} → ${citation} (${resolved})`);
				}
			}
		}
		assert.deepEqual(missing, [], "active skill citations must resolve in the pack");

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
