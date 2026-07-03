// Behavior tests for the pocketto-pi CLI. Self-contained (no Python): they
// lock in the parity that was verified against the original scripts during
// the v2.0 migration — phase-file format, log.json schema, SHA tracking,
// structure thresholds, and the --json envelope.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "cli", "index.js");

// In-process modules for the extension-setup unit tests (no child process).
const identity = require("../cli/lib/identity");
const extensions = require("../cli/lib/extensions");
const setupExtensions = require("../cli/commands/setup-extensions");
const gitlib = require("../cli/lib/git");

function run(args, { expectFail = false, env } = {}) {
	// Merge env overrides onto process.env so PATH (needed to spawn `node`) survives.
	const childEnv = env ? { ...process.env, ...env } : process.env;
	try {
		const stdout = execFileSync("node", [CLI, ...args], {
			encoding: "utf8",
			env: childEnv,
		});
		assert.ok(
			!expectFail,
			`expected failure but command succeeded: ${args.join(" ")}`,
		);
		return { stdout, code: 0 };
	} catch (err) {
		assert.ok(
			expectFail,
			`command failed unexpectedly: ${args.join(" ")}\n${err.stdout || ""}${err.stderr || ""}`,
		);
		return {
			stdout: err.stdout || "",
			stderr: err.stderr || "",
			code: err.status,
		};
	}
}

function json(args, opts) {
	return JSON.parse(run(args, opts).stdout.trim());
}

function tmp() {
	return mkdtempSync(path.join(tmpdir(), "pocketto-"));
}

function writeModeConfig(dir, file, body) {
	writeFileSync(path.join(dir, file), body);
}

function enterpriseBlock(lines, eol = "\n") {
	return [
		"# Local Agent Notes",
		"",
		"## Pocket Enterprise",
		"",
		"```",
		...lines,
		"```",
		"",
	].join(eol);
}

test("fingerprint ignores line numbers for the same finding identity", () => {
	const base = {
		file: "cli/index.js",
		ruleId: "review/no-raw-bytes",
		message: "Hash normalized strings only.",
		occurrence: 0,
	};

	const line12 = identity.fingerprint({ ...base, line: 12 });
	const line47 = identity.fingerprint({ ...base, line: 47 });

	assert.equal(line12, line47);
	assert.match(line12, /^[0-9a-f]{16}$/);
});

test("fingerprint includes occurrence indexes for duplicate findings", () => {
	const base = {
		file: "cli/index.js",
		ruleId: "review/no-raw-bytes",
		message: "Hash normalized strings only.",
	};

	assert.notEqual(
		identity.fingerprint({ ...base, occurrence: 0 }),
		identity.fingerprint({ ...base, occurrence: 1 }),
	);
});

test("fingerprint normalizes CRLF messages to LF before hashing", () => {
	const base = {
		file: "cli/lib/identity.js",
		ruleId: "review/eol-normalized",
		occurrence: 0,
	};

	assert.equal(
		identity.fingerprint({ ...base, message: "First line\nSecond line\n" }),
		identity.fingerprint({ ...base, message: "First line\r\nSecond line\r\n" }),
	);
});

test("markerFor and parseMarker use canonical phase summary comments", () => {
	const marker = identity.markerFor(3);

	assert.equal(marker, "<!-- pocket-phase-3-summary -->");
	assert.equal(identity.parseMarker(marker), 3);
	assert.equal(identity.parseMarker("<!-- other comment -->"), null);
});

test("mode defaults to local mode when no Pocket Enterprise heading exists", () => {
	const dir = tmp();
	writeModeConfig(dir, "AGENTS.md", "# Notes\n\nNo enterprise config here.\n");

	const env = json(["mode", dir, "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "mode");
	assert.deepEqual(env.data, {
		enterprise: false,
		branch_strategy: null,
		create_pr: null,
		require_approval: null,
		source: null,
	});
});

test("mode uses CLAUDE.md as a whole-heading override over AGENTS.md", () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"AGENTS.md",
		enterpriseBlock([
			"enterprise: true",
			"branch_strategy: branch",
			"create_pr: true",
		]),
	);
	writeModeConfig(
		dir,
		"CLAUDE.md",
		enterpriseBlock([
			"enterprise: false",
			"branch_strategy: main-local",
			"create_pr: false",
		]),
	);

	const env = json(["mode", dir, "--json"]);
	assert.deepEqual(env.data, {
		enterprise: false,
		branch_strategy: "main-local",
		create_pr: false,
		require_approval: null,
		source: "CLAUDE.md",
	});
});

test("mode errors when enterprise true is missing a required field", () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"AGENTS.md",
		enterpriseBlock(["enterprise: true", "branch_strategy: branch"]),
	);

	const res = run(["mode", dir, "--json"], { expectFail: true });
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "MODE_CONFIG_INVALID");
	assert.match(env.error.message, /create_pr/);
	assert.equal(res.code, 1);
});

test("mode errors on unknown enum values in active config", () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"AGENTS.md",
		enterpriseBlock([
			"enterprise: true",
			"branch_strategy: feature",
			"create_pr: true",
		]),
	);

	const res = run(["mode", dir, "--json"], { expectFail: true });
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.error.code, "MODE_CONFIG_INVALID");
	assert.match(env.error.message, /branch_strategy/);
});

test("mode does not fall back to AGENTS.md when CLAUDE.md override is malformed", () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"AGENTS.md",
		enterpriseBlock([
			"enterprise: true",
			"branch_strategy: branch",
			"create_pr: true",
		]),
	);
	writeModeConfig(
		dir,
		"CLAUDE.md",
		[
			"# Local Agent Notes",
			"",
			"## Pocket Enterprise",
			"",
			"```",
			"enterprise: true",
			"branch_strategy: main-local",
		].join("\n"),
	);

	const res = run(["mode", dir, "--json"], { expectFail: true });
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.error.code, "MODE_CONFIG_INVALID");
	assert.match(env.error.message, /fenced block/i);
});

test("mode parses CRLF config the same as LF config", () => {
	const lfDir = tmp();
	const crlfDir = tmp();
	const lines = [
		"enterprise: true",
		"branch_strategy: branch # inline comments are ignored",
		"create_pr: false",
	];
	writeModeConfig(lfDir, "AGENTS.md", enterpriseBlock(lines, "\n"));
	writeModeConfig(crlfDir, "AGENTS.md", enterpriseBlock(lines, "\r\n"));

	const lf = json(["mode", lfDir, "--json"]);
	const crlf = json(["mode", crlfDir, "--json"]);
	assert.deepEqual(lf.data, {
		enterprise: true,
		branch_strategy: "branch",
		create_pr: false,
		require_approval: false,
		source: "AGENTS.md",
	});
	assert.deepEqual(crlf.data, lf.data);
});

function gitInitRepoWithRemote(
	dir,
	remoteUrl = "https://github.com/example/repo.git",
) {
	gitInitRepo(dir);
	git(dir, ["remote", "add", "origin", remoteUrl]);
}

test("mode init writes AGENTS.md and .gitattributes when a git remote exists", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(dir, "AGENTS.md", "# Existing notes\n\nKeep this.\n");
	gitInitRepoWithRemote(dir);

	const env = json([
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--json",
	]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "mode");
	assert.deepEqual(env.data.wrote, ["AGENTS.md", ".gitattributes"]);
	assert.equal(env.data.enterprise, true);
	assert.equal(env.data.branch_strategy, "branch");
	assert.equal(env.data.create_pr, true);

	const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.match(agents, /# Existing notes/);
	assert.match(agents, /Keep this\./);
	assert.match(agents, /## Pocket Enterprise/);
	assert.equal((agents.match(/## Pocket Enterprise/g) || []).length, 1);
	assert.ok(!agents.includes("\r"), "AGENTS.md must be LF-only");

	const attrs = readFileSync(path.join(dir, ".gitattributes"), "utf8");
	assert.match(attrs, /log\.json/);
	assert.match(attrs, /AGENTS\.md/);
	assert.match(attrs, /\*\.json/);
	assert.match(attrs, /docs\/pocket\/plans/);
	assert.match(attrs, /docs\/pocket\/spec/);
	assert.ok(!attrs.includes("\r"), ".gitattributes must be LF-only");

	const read = json(["mode", dir, "--json"]);
	assert.equal(read.data.enterprise, true);
	assert.equal(read.data.branch_strategy, "branch");
	assert.equal(read.data.create_pr, true);
});

test("mode init preserves existing .gitattributes content", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(dir, "AGENTS.md", "# Existing notes\n");
	gitInitRepoWithRemote(dir);

	// Write custom .gitattributes before running mode init
	const customAttrs = "*.md text eol=lf\n*.sh text eol=lf\n";
	writeFileSync(path.join(dir, ".gitattributes"), customAttrs, "utf8");

	const env = json([
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--json",
	]);
	assert.equal(env.ok, true);

	const attrs = readFileSync(path.join(dir, ".gitattributes"), "utf8");

	// Custom content must be preserved
	assert.match(attrs, /\*\.md text eol=lf/);
	assert.match(attrs, /\*\.sh text eol=lf/);

	// Pocket section must be appended
	assert.match(attrs, /log\.json/);
	assert.match(attrs, /AGENTS\.md/);
	assert.match(attrs, /docs\/pocket\/plans/);
	assert.match(attrs, /docs\/pocket\/spec/);

	// Pocket section should appear after custom content
	const customIdx = attrs.indexOf("*.sh text eol=lf");
	const pocketIdx = attrs.indexOf("log.json");
	assert.ok(
		customIdx < pocketIdx,
		"Pocket section should be appended after existing content",
	);

	assert.ok(!attrs.includes("\r"), ".gitattributes must be LF-only");
});

test("mode init is idempotent on .gitattributes re-run", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(dir, "AGENTS.md", "# Existing notes\n");
	gitInitRepoWithRemote(dir);

	// Write custom .gitattributes
	const customAttrs = "*.md text eol=lf\n";
	writeFileSync(path.join(dir, ".gitattributes"), customAttrs, "utf8");

	// Run mode init twice
	const args = [
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--json",
	];
	json(args);
	json(args);

	const attrs = readFileSync(path.join(dir, ".gitattributes"), "utf8");

	// Pocket marker should appear exactly once
	assert.equal((attrs.match(/# Pocket Enterprise/g) || []).length, 1);

	// Custom content still preserved
	assert.match(attrs, /\*\.md text eol=lf/);
});

test("mode init fails without a git remote and writes nothing", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(dir, "AGENTS.md", "# Notes\n");
	gitInitRepo(dir);

	const before = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	const res = run(
		[
			"mode",
			"init",
			dir,
			"--enterprise",
			"true",
			"--branch-strategy",
			"branch",
			"--create-pr",
			"true",
			"--json",
		],
		{ expectFail: true },
	);
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "NO_GIT_REMOTE");
	assert.equal(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), before);
	assert.equal(existsSync(path.join(dir, ".gitattributes")), false);
});

test("mode init is idempotent on re-run", { skip: !hasGit() }, () => {
	const dir = tmp();
	gitInitRepoWithRemote(dir);
	const args = [
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"false",
		"--json",
	];
	json(args);
	const first = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	json(args);
	const second = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.equal(first, second);
	assert.equal((second.match(/## Pocket Enterprise/g) || []).length, 1);
});

test("mode init rejects missing required flags", { skip: !hasGit() }, () => {
	const dir = tmp();
	gitInitRepoWithRemote(dir);

	const res = run(["mode", "init", dir, "--enterprise", "true", "--json"], {
		expectFail: true,
	});
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "MODE_CONFIG_INVALID");
	assert.match(env.error.message, /branch_strategy|create_pr/);
});

test("mode init rejects invalid enum values", { skip: !hasGit() }, () => {
	const dir = tmp();
	gitInitRepoWithRemote(dir);

	const res = run(
		[
			"mode",
			"init",
			dir,
			"--enterprise",
			"true",
			"--branch-strategy",
			"feature",
			"--create-pr",
			"true",
			"--json",
		],
		{ expectFail: true },
	);
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "MODE_CONFIG_INVALID");
	assert.match(env.error.message, /branch_strategy/);
	assert.equal(existsSync(path.join(dir, "AGENTS.md")), false);
});

test("mode init --file CLAUDE.md writes the block to CLAUDE.md, not AGENTS.md", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	gitInitRepoWithRemote(dir);

	const env = json([
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--file",
		"CLAUDE.md",
		"--json",
	]);
	assert.deepEqual(env.data.wrote, ["CLAUDE.md", ".gitattributes"]);
	assert.equal(existsSync(path.join(dir, "AGENTS.md")), false);

	const claude = readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
	assert.match(claude, /## Pocket Enterprise/);

	const read = json(["mode", dir, "--json"]);
	assert.equal(read.data.enterprise, true);
	assert.equal(read.data.source, "CLAUDE.md");
});

test("mode init appends a new block when the heading only appears in prose (no false no-op)", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"CLAUDE.md",
		"Some doc without a `## Pocket Enterprise` block yet.\n",
	);
	gitInitRepoWithRemote(dir);

	const env = json([
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--file",
		"CLAUDE.md",
		"--json",
	]);
	assert.equal(env.ok, true);

	const claude = readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
	assert.match(claude, /Some doc without a `## Pocket Enterprise` block yet\./);
	assert.equal((claude.match(/## Pocket Enterprise/g) || []).length, 2);

	const read = json(["mode", dir, "--json"]);
	assert.equal(read.data.enterprise, true);
});

test("mode init replaces an existing block with no blank line before the fence (no duplicate block)", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"CLAUDE.md",
		"## Pocket Enterprise\n```\nenterprise: false\n```\n",
	);
	gitInitRepoWithRemote(dir);

	const env = json([
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--file",
		"CLAUDE.md",
		"--json",
	]);
	assert.equal(env.ok, true);

	const claude = readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
	assert.equal((claude.match(/## Pocket Enterprise/g) || []).length, 1);

	const read = json(["mode", dir, "--json"]);
	assert.equal(read.data.enterprise, true);
});

test("mode init rejects writing AGENTS.md when CLAUDE.md already shadows it", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeModeConfig(dir, "CLAUDE.md", enterpriseBlock(["enterprise: false"]));
	gitInitRepoWithRemote(dir);

	const res = run(
		[
			"mode",
			"init",
			dir,
			"--enterprise",
			"true",
			"--branch-strategy",
			"branch",
			"--create-pr",
			"true",
			"--file",
			"AGENTS.md",
			"--json",
		],
		{ expectFail: true },
	);
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "MODE_FILE_SHADOWED");
	assert.equal(existsSync(path.join(dir, "AGENTS.md")), false);
});

test("mode init rejects a --file outside AGENTS.md/CLAUDE.md", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	gitInitRepoWithRemote(dir);

	const res = run(
		[
			"mode",
			"init",
			dir,
			"--enterprise",
			"true",
			"--branch-strategy",
			"branch",
			"--create-pr",
			"true",
			"--file",
			"README.md",
			"--json",
		],
		{ expectFail: true },
	);
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.error.code, "MODE_CONFIG_INVALID");
	assert.match(env.error.message, /file must be one of/);
});

test("mode init --require-approval persists and mode reads it back", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	gitInitRepoWithRemote(dir);

	json([
		"mode",
		"init",
		dir,
		"--enterprise",
		"true",
		"--branch-strategy",
		"branch",
		"--create-pr",
		"true",
		"--require-approval",
		"true",
		"--json",
	]);
	const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
	assert.match(agents, /require_approval: true/);

	const read = json(["mode", dir, "--json"]);
	assert.equal(read.data.enterprise, true);
	assert.equal(read.data.require_approval, true);
});

test("mode treats an absent require_approval as false when enterprise is on", () => {
	const dir = tmp();
	writeModeConfig(
		dir,
		"AGENTS.md",
		enterpriseBlock([
			"enterprise: true",
			"branch_strategy: branch",
			"create_pr: true",
		]),
	);

	const env = json(["mode", dir, "--json"]);
	assert.equal(env.data.require_approval, false);
});

test("scaffold github writes issue and PR templates, then no-ops on re-run", () => {
	const dir = tmp();

	const first = json(["scaffold", "github", dir, "--json"]);
	assert.equal(first.ok, true);
	assert.deepEqual(first.data.wrote, [
		path.join(".github", "ISSUE_TEMPLATE", "pocket-plan.md"),
		path.join(".github", "pull_request_template.md"),
	]);
	assert.deepEqual(first.data.skipped, []);

	const issueTpl = readFileSync(
		path.join(dir, ".github", "ISSUE_TEMPLATE", "pocket-plan.md"),
		"utf8",
	);
	assert.match(issueTpl, /## Context/);
	assert.match(issueTpl, /## Technical Approach/);
	assert.match(issueTpl, /## Acceptance Criteria/);
	assert.match(issueTpl, /## Out of Scope/);
	assert.match(issueTpl, /labels: pocket-plan/);

	const prTpl = readFileSync(
		path.join(dir, ".github", "pull_request_template.md"),
		"utf8",
	);
	assert.match(prTpl, /## What/);
	assert.match(prTpl, /## Why/);
	assert.match(prTpl, /## How to Test/);

	const second = json(["scaffold", "github", dir, "--json"]);
	assert.deepEqual(second.data.wrote, []);
	assert.equal(second.data.skipped.length, 2);
	assert.equal(
		readFileSync(
			path.join(dir, ".github", "ISSUE_TEMPLATE", "pocket-plan.md"),
			"utf8",
		),
		issueTpl,
	);
});

test("scaffold github --dry-run reports without writing", () => {
	const dir = tmp();

	const env = json(["scaffold", "github", dir, "--dry-run", "--json"]);
	assert.equal(env.data.dryRun, true);
	assert.equal(env.data.wrote.length, 2);
	assert.equal(existsSync(path.join(dir, ".github")), false);
});

const NINE_TASK_PLAN = `# EXECUTION PLAN — Auth refactor

**Date:** 2026-05-08
**Spec:** docs/pocket/specs/auth.md

## Pocket Packets

---

### Task 1: Scaffold auth module [prereq]

Create the skeleton.

---

### Task 2: Extract token logic [depends: T1]

Move token code.

---

### Task 3: Extract session logic [parallel: T2]

Move session code.

---

### Task 4: Wire config loader [depends: T1]

Config.

---

### Task 5: Add middleware [depends: T2, T3]

Middleware.

---

### Task 6: Add guards [depends: T4]

Guards.

---

### Task 7: Refactor callers [depends: T5, T6]

Callers.

---

### Task 8: Integration tests [depends: T7]

Tests.

---

### Task 9: Docs [depends: T8]

Docs.

## Plan Summary

Done.
`;

const SMALL_PLAN = `# EXECUTION PLAN — Tiny

**Date:** 2026-06-01
**Spec:** x.md

## Pocket Packets

---

### Task 1: A [prereq]
body
---
### Task 2: B [depends: T1]
body

## Plan Summary
`;

function writePlan(dir, content) {
	const p = path.join(dir, "execution-plan.md");
	writeFileSync(p, content);
	return p;
}

test("structure splits a 9-task plan into 3 phases (human + JSON)", () => {
	const dir = tmp();
	const plan = writePlan(dir, NINE_TASK_PLAN);

	const human = run(["structure", plan]).stdout;
	assert.match(human, /STRUCTURING COMPLETE/);

	const phaseFiles = readdirSync(dir)
		.filter((f) => /^execution-plan-phase-\d+\.md$/.test(f))
		.sort();
	assert.deepEqual(phaseFiles, [
		"execution-plan-phase-1.md",
		"execution-plan-phase-2.md",
		"execution-plan-phase-3.md",
	]);

	// Phase file format invariants.
	const p1 = readFileSync(path.join(dir, "execution-plan-phase-1.md"), "utf8");
	assert.match(
		p1,
		/^# Auth refactor — Scaffold auth module \(Phase 1 of 3\)$/m,
	);
	assert.match(p1, /\*\*Contains tasks:\*\* \{T1, T2, T3, T4\}/);
	assert.match(p1, /## Phase Completion Gate/);

	const env = json(["structure", plan, "--dry-run", "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "structure");
	assert.equal(env.contract, 2);
	assert.equal(env.data.action, "split");
	assert.equal(env.data.taskCount, 9);
	assert.deepEqual(
		env.data.phases.map((p) => p.tasks),
		[
			["T1", "T2", "T3", "T4"],
			["T5", "T6", "T7"],
			["T8", "T9"],
		],
	);
});

test("structure passes through plans below the threshold", () => {
	const dir = tmp();
	const plan = writePlan(dir, SMALL_PLAN);

	const env = json(["structure", plan, "--json"]);
	assert.equal(env.data.action, "passthrough");
	assert.equal(env.data.taskCount, 2);
	// No phase files written.
	assert.equal(
		readdirSync(dir).some((f) => /phase-\d+/.test(f)),
		false,
	);
});

test("structure --dry-run surfaces an execution flow for passthrough plans (no files)", () => {
	const dir = tmp();
	const plan = writePlan(dir, SMALL_PLAN);

	const env = json(["structure", plan, "--dry-run", "--json"]);
	assert.equal(env.data.action, "passthrough");
	assert.equal(env.data.executionFlow, "T1→T2");
	// Validation is side-effect-free — no phase files written.
	assert.equal(
		readdirSync(dir).some((f) => /phase-\d+/.test(f)),
		false,
	);
});

test("structure exposes the depth-based execution flow for split plans", () => {
	const dir = tmp();
	const plan = writePlan(dir, NINE_TASK_PLAN);

	const env = json(["structure", plan, "--dry-run", "--json"]);
	assert.equal(env.data.action, "split");
	assert.equal(
		env.data.executionFlow,
		"T1→T2,T3,T4(PARALLEL)→T5,T6(PARALLEL)→T7→T8→T9",
	);
});

test("structure validates passthrough plans: a dangling dependency errors early", () => {
	const dir = tmp();
	// 2 tasks (passthrough) but T2 depends on a task that does not exist.
	const broken = `# EXECUTION PLAN — Broken

**Date:** 2026-06-01
**Spec:** x.md

## Pocket Packets

---

### Task 1: A [prereq]
body
---
### Task 2: B [depends: T9]
body

## Plan Summary
`;
	const plan = writePlan(dir, broken);
	const res = run(["structure", plan, "--json"], { expectFail: true });
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "UNKNOWN_TASK_REF");
	assert.equal(res.code, 1);
});

test("structure errors on a plan with no tasks (envelope + exit 1)", () => {
	const dir = tmp();
	const plan = writePlan(
		dir,
		"# EXECUTION PLAN — Empty\n\n## Pocket Packets\n\n## Plan Summary\n",
	);
	const res = run(["structure", plan, "--json"], { expectFail: true });
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "NO_TASKS");
	assert.equal(res.code, 1);
});

test("log init creates a phased log.json with tasks + SHA tracking field", () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);

	run(["log", "init", dir]);
	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	assert.equal(log.header.plan_type, "phased");
	assert.equal(log.header.status, "IN_PROGRESS");
	assert.ok("baseline_sha" in log.header);
	assert.equal(log.phases.length, 3);
	assert.deepEqual(
		log.phases[0].tasks.map((t) => t.id),
		["T1", "T2", "T3", "T4"],
	);
	assert.equal(log.phases[0].tasks[0].status, "WAITING");
});

test("log init migrates tasks into an existing task-less log.json, preserving status", () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);

	// Hand-craft an old-style log.json: phases without tasks, phase 1 already DONE.
	const legacy = {
		header: {
			plan_dir: dir,
			plan_type: "phased",
			status: "IN_PROGRESS",
			date_started: "2026-01-01",
			date_completed: null,
		},
		phases: [
			{ order: 1, file: "execution-plan-phase-1.md", status: "DONE" },
			{ order: 2, file: "execution-plan-phase-2.md", status: "WAITING" },
			{ order: 3, file: "execution-plan-phase-3.md", status: "WAITING" },
		],
	};
	writeFileSync(
		path.join(dir, "log.json"),
		JSON.stringify(legacy, null, 2) + "\n",
	);

	run(["log", "init", dir]);
	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	// DONE phase -> its injected tasks inherit DONE; WAITING phase -> WAITING.
	assert.equal(log.phases[0].status, "DONE");
	assert.equal(
		log.phases[0].tasks.every((t) => t.status === "DONE"),
		true,
	);
	assert.equal(
		log.phases[1].tasks.every((t) => t.status === "WAITING"),
		true,
	);
});

test("log update changes phase + task status and reports via --json", () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);
	run(["log", "init", dir]);

	const env = json([
		"log",
		"update",
		dir,
		"execution-plan-phase-1.md",
		"DONE",
		"--task",
		"T1",
		"--json",
	]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "log update");
	assert.equal(env.data.level, "task");
	assert.equal(env.data.newStatus, "DONE");

	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	assert.equal(log.phases[0].tasks.find((t) => t.id === "T1").status, "DONE");
});

test("log update rejects an invalid status", () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);
	run(["log", "init", dir]);
	const res = run(
		["log", "update", dir, "execution-plan-phase-1.md", "NOPE", "--json"],
		{ expectFail: true },
	);
	assert.equal(JSON.parse(res.stdout.trim()).error.code, "BAD_STATUS");
});

function hasGit() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function git(dir, args) {
	return execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function gitInitRepo(dir) {
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["commit", "--allow-empty", "-q", "-m", "init"]);
}

// Issue #28: when a parallel group is merged in a batch and logged afterwards,
// every `log update --task` captures the same HEAD (one merge commit), so the
// 2nd+ task reuses a sibling's done_sha. The CLI must surface that collision.
test("log update warns when a task reuses a sibling done_sha (collapsed parallel merge)", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);
	gitInitRepo(dir); // done_sha is only captured inside a real repo
	run(["log", "init", dir]);

	const phase = "execution-plan-phase-1.md"; // contains T1..T4

	// T2 DONE → captures the current commit; first writer, so no collision.
	const t2 = json([
		"log",
		"update",
		dir,
		phase,
		"DONE",
		"--task",
		"T2",
		"--json",
	]);
	assert.ok(t2.data.doneSha, "expected a real done_sha inside a git repo");
	assert.equal(t2.data.shaCollision, null);

	// T3 DONE with NO new commit → same HEAD → same done_sha → collision on T2.
	const t3 = json([
		"log",
		"update",
		dir,
		phase,
		"DONE",
		"--task",
		"T3",
		"--json",
	]);
	assert.equal(t3.data.doneSha, t2.data.doneSha);
	assert.deepEqual(t3.data.shaCollision, ["T2"]);

	// Advance HEAD, then T4 DONE → distinct done_sha → no collision.
	git(dir, ["commit", "--allow-empty", "-q", "-m", "advance"]);
	const t4 = json([
		"log",
		"update",
		dir,
		phase,
		"DONE",
		"--task",
		"T4",
		"--json",
	]);
	assert.notEqual(t4.data.doneSha, t2.data.doneSha);
	assert.equal(t4.data.shaCollision, null);

	// The human (non-JSON) path surfaces the warning too.
	const human = run([
		"log",
		"update",
		dir,
		phase,
		"DONE",
		"--task",
		"T3",
	]).stdout;
	assert.match(human, /done_sha .* is already recorded for/);
});

test("log update refreshes done_sha when an already-DONE last task is re-marked DONE", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);
	gitInitRepo(dir);
	run(["log", "init", dir]);

	const phase = "execution-plan-phase-1.md";
	const first = json([
		"log",
		"update",
		dir,
		phase,
		"DONE",
		"--task",
		"T4",
		"--json",
	]);
	assert.ok(first.data.doneSha, "expected initial done_sha");

	git(dir, ["commit", "--allow-empty", "-q", "-m", "fix T4"]);
	const refreshed = json([
		"log",
		"update",
		dir,
		phase,
		"DONE",
		"--task",
		"T4",
		"--json",
	]);
	assert.equal(refreshed.data.oldStatus, "DONE");
	assert.equal(refreshed.data.newStatus, "DONE");
	assert.notEqual(refreshed.data.doneSha, first.data.doneSha);

	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	assert.equal(
		log.phases[0].tasks.find((t) => t.id === "T4").done_sha,
		refreshed.data.doneSha,
	);
});

test("log close refuses while phases are not DONE, then finalizes when all DONE", () => {
	const dir = tmp();
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);
	run(["log", "init", dir]);

	// Premature close fails.
	const early = run(["log", "close", dir, "--json"], { expectFail: true });
	assert.equal(JSON.parse(early.stdout.trim()).error.code, "PHASES_NOT_DONE");

	// Mark all phases DONE.
	for (const f of [
		"execution-plan-phase-1.md",
		"execution-plan-phase-2.md",
		"execution-plan-phase-3.md",
	]) {
		run(["log", "update", dir, f, "DONE"]);
	}
	const env = json(["log", "close", dir, "--json"]);
	assert.equal(env.ok, true);
	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	assert.equal(log.header.status, "DONE");
	assert.ok(log.header.date_completed);
});

test("contract handshake fails loudly on mismatch", () => {
	const dir = tmp();
	const plan = writePlan(dir, SMALL_PLAN);
	const res = run(["structure", plan, "--contract", "99", "--json"], {
		expectFail: true,
	});
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.error.code, "CONTRACT_MISMATCH");
	// Matching contract passes.
	assert.equal(json(["structure", plan, "--contract", "2", "--json"]).ok, true);
});

test("a value-taking flag as the last arg fails instead of being silently dropped", () => {
	const dir = tmp();
	const plan = writePlan(dir, SMALL_PLAN);
	// --contract with no value must NOT silently skip the handshake.
	const c = run(["structure", plan, "--json", "--contract"], {
		expectFail: true,
	});
	assert.equal(JSON.parse(c.stdout.trim()).error.code, "MISSING_VALUE");

	// --task with no value must NOT silently fall back to a phase-level update.
	writePlan(dir, NINE_TASK_PLAN);
	run(["structure", path.join(dir, "execution-plan.md")]);
	run(["log", "init", dir]);
	const t = run(
		[
			"log",
			"update",
			dir,
			"execution-plan-phase-1.md",
			"DONE",
			"--json",
			"--task",
		],
		{ expectFail: true },
	);
	assert.equal(JSON.parse(t.stdout.trim()).error.code, "MISSING_VALUE");
});

test("structure reports a clean error on circular dependencies (no stack overflow)", () => {
	const dir = tmp();
	// Needs >= 7 tasks so the splitter (and computeDepths) actually runs;
	// T6 <-> T7 form the cycle.
	const cyclic = `# EXECUTION PLAN — Cyclic

**Date:** 2026-06-01
**Spec:** x.md

## Pocket Packets

---

### Task 1: A [prereq]
body
---
### Task 2: B [depends: T1]
body
---
### Task 3: C [depends: T1]
body
---
### Task 4: D [depends: T2]
body
---
### Task 5: E [depends: T3]
body
---
### Task 6: F [depends: T7]
body
---
### Task 7: G [depends: T6]
body

## Plan Summary
`;
	const plan = writePlan(dir, cyclic);
	const res = run(["structure", plan, "--json"], { expectFail: true });
	assert.equal(JSON.parse(res.stdout.trim()).error.code, "CYCLE_DETECTED");
});

test("log update/close accept a plan file argument, not just the directory", () => {
	const dir = tmp();
	const planFile = writePlan(dir, NINE_TASK_PLAN);
	run(["structure", planFile]);
	run(["log", "init", dir]);

	// Pass the plan FILE (not the dir) — should resolve to the directory's log.json.
	const upd = json([
		"log",
		"update",
		planFile,
		"execution-plan-phase-1.md",
		"DONE",
		"--task",
		"T1",
		"--json",
	]);
	assert.equal(upd.ok, true);
	assert.equal(upd.data.newStatus, "DONE");

	for (const f of [
		"execution-plan-phase-1.md",
		"execution-plan-phase-2.md",
		"execution-plan-phase-3.md",
	]) {
		run(["log", "update", planFile, f, "DONE"]);
	}
	assert.equal(json(["log", "close", planFile, "--json"]).ok, true);
});

test("meta set creates .pocket-meta.json with stable direct-write serialization", () => {
	const dir = tmp();

	const env = json(["meta", "set", dir, "github_issue.number", "42", "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "meta set");
	assert.equal(env.data.field, "github_issue.number");
	assert.equal(env.data.value, 42);

	const metaPath = path.join(dir, ".pocket-meta.json");
	const content = readFileSync(metaPath, "utf8");
	assert.match(content, /\n$/);
	assert.match(content, /^ {2}"github_issue":/m);

	const parsed = JSON.parse(content);
	assert.equal(parsed.github_issue.number, 42);
	assert.equal(content, JSON.stringify(parsed, null, 2) + "\n");
});

test("meta get round-trips values from .pocket-meta.json", () => {
	const dir = tmp();
	json([
		"meta",
		"set",
		dir,
		"github_issue.url",
		"https://github.com/acme/project/issues/42",
		"--json",
	]);

	const env = json(["meta", "get", dir, "github_issue.url", "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "meta get");
	assert.equal(env.data.field, "github_issue.url");
	assert.equal(env.data.value, "https://github.com/acme/project/issues/42");
});

test("meta successive writes preserve earlier values and nested phase data", () => {
	const dir = tmp();
	json(["meta", "set", dir, "github_issue.number", "42", "--json"]);
	json([
		"meta",
		"set",
		dir,
		"github_issue.created_at",
		"2026-06-09T00:00:00Z",
		"--json",
	]);
	json(["meta", "set", dir, "phases.phase-1.github_pr.number", "7", "--json"]);
	json([
		"meta",
		"set",
		dir,
		"phases.phase-1.fingerprints",
		'["a","b"]',
		"--json",
	]);
	json(["meta", "set", dir, "external_tracker", "JIRA-123", "--json"]);

	const meta = JSON.parse(
		readFileSync(path.join(dir, ".pocket-meta.json"), "utf8"),
	);
	assert.equal(meta.github_issue.number, 42);
	assert.equal(meta.github_issue.created_at, "2026-06-09T00:00:00Z");
	assert.equal(meta.phases["phase-1"].github_pr.number, 7);
	assert.deepEqual(meta.phases["phase-1"].fingerprints, ["a", "b"]);
	assert.equal(meta.external_tracker, "JIRA-123");
});

test("meta read normalizes CRLF before JSON parse", () => {
	const dir = tmp();
	const metaPath = path.join(dir, ".pocket-meta.json");
	writeFileSync(
		metaPath,
		'{\r\n  "github_issue": {\r\n    "number": 42\r\n  }\r\n}\r\n',
	);

	const env = json(["meta", "get", dir, "github_issue.number", "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.data.value, 42);
});

test("meta direct-write content equals JSON.stringify(parsed, null, 2) plus newline", () => {
	const dir = tmp();
	json([
		"meta",
		"set",
		dir,
		"phases.phase-2.github_pr.url",
		"https://github.com/acme/project/pull/8",
		"--json",
	]);

	const content = readFileSync(path.join(dir, ".pocket-meta.json"), "utf8");
	const parsed = JSON.parse(content);
	assert.equal(content, JSON.stringify(parsed, null, 2) + "\n");
});

// ─── extensions: registry + spec normalization (in-process unit) ──────────────

test("normalizeSpec maps every Pi packages[] spec shape to a bare package name", () => {
	const { normalizeSpec } = extensions;
	assert.equal(normalizeSpec("pi-mcp-adapter"), "pi-mcp-adapter");
	assert.equal(normalizeSpec("npm:pi-mcp-adapter"), "pi-mcp-adapter");
	assert.equal(normalizeSpec("pi-mcp-adapter@2.9.0"), "pi-mcp-adapter");
	assert.equal(
		normalizeSpec("npm:@gotgenes/pi-subagents"),
		"@gotgenes/pi-subagents",
	);
	assert.equal(
		normalizeSpec("npm:@gotgenes/pi-subagents@14"),
		"@gotgenes/pi-subagents",
	);
	assert.equal(
		normalizeSpec("@juicesharp/rpiv-advisor@1.18.2"),
		"@juicesharp/rpiv-advisor",
	);
	// Alias form: resolve to the real package on the RHS of the first @npm:/@git:.
	assert.equal(normalizeSpec("foo@npm:@scope/bar@1.2.3"), "@scope/bar");
	// git/url specs carry no npm name → out of scope (null).
	assert.equal(normalizeSpec("git:github.com/org/repo"), null);
	assert.equal(normalizeSpec("https://github.com/org/repo"), null);
	assert.equal(normalizeSpec(""), null);
	assert.equal(normalizeSpec(undefined), null);
});

test("parseInstalledSpecs dedupes to a name set and ignores unmappable specs", () => {
	const set = extensions.parseInstalledSpecs([
		"npm:pi-mcp-adapter@2.9.0",
		"npm:@gotgenes/pi-subagents",
		"git:github.com/org/fork", // unmappable → ignored
		"not-an-array-friend",
	]);
	assert.equal(set.has("pi-mcp-adapter"), true);
	assert.equal(set.has("@gotgenes/pi-subagents"), true);
	assert.equal(set.has("not-an-array-friend"), true);
	assert.equal(set.size, 3);
	assert.equal(extensions.parseInstalledSpecs(null).size, 0);
});

// ─── setup-extensions (in-process, injected runner — real `pi` never spawned) ─

// A fake runner recording its calls. `--version` reports pi present unless
// piMissing; installs succeed unless the spec matches a failPkgs substring.
function fakeRunner({ piMissing = false, failPkgs = [] } = {}) {
	const calls = [];
	const runner = (...args) => {
		calls.push(args);
		if (args[0] === "--version")
			return { status: piMissing ? 127 : 0, stdout: "pi", stderr: "" };
		const spec = args[1] || "";
		const fail = failPkgs.some((f) => spec.includes(f));
		return {
			status: fail ? 1 : 0,
			stdout: "",
			stderr: fail ? "install failed" : "",
		};
	};
	runner.calls = calls;
	return runner;
}

// A tmp HOME with an optional Pi settings.json (packages[] = given specs).
function piHome(packages) {
	const home = tmp();
	if (packages !== undefined) {
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ packages }, null, 2),
		);
	}
	return home;
}

test("setup-extensions installs the 3 required extensions when none are present", () => {
	const home = piHome([]); // settings exist but no packages
	const runner = fakeRunner();
	const res = setupExtensions.run({ env: { HOME: home }, runner });

	assert.equal(res.command, "setup-extensions");
	assert.equal(res.exit, 0);
	assert.deepEqual(res.data.installed, [
		"pi-mcp-adapter",
		"@gotgenes/pi-subagents",
		"@juicesharp/rpiv-advisor",
	]);
	assert.deepEqual(res.data.skipped, []);
	// Precheck + 3 installs, with the npm: scheme on each spec.
	assert.deepEqual(runner.calls[0], ["--version"]);
	assert.deepEqual(runner.calls.slice(1), [
		["install", "npm:pi-mcp-adapter"],
		["install", "npm:@gotgenes/pi-subagents"],
		["install", "npm:@juicesharp/rpiv-advisor"],
	]);
	// Fake runner never writes settings, so the re-read can't confirm — non-fatal.
	assert.deepEqual(res.data.unconfirmed, res.data.installed);
});

test("setup-extensions --all also installs the recommended extensions", () => {
	const home = piHome([]);
	const runner = fakeRunner();
	const res = setupExtensions.run({ env: { HOME: home }, runner, all: true });
	assert.equal(res.data.installed.length, 6);
	assert.equal(res.data.installed.includes("@tintinweb/pi-tasks"), true);
});

test("setup-extensions skips already-installed extensions (idempotent)", () => {
	const home = piHome(["npm:pi-mcp-adapter@2.9.0"]);
	const runner = fakeRunner();
	const res = setupExtensions.run({ env: { HOME: home }, runner });
	assert.deepEqual(res.data.skipped, ["pi-mcp-adapter"]);
	assert.deepEqual(res.data.installed, [
		"@gotgenes/pi-subagents",
		"@juicesharp/rpiv-advisor",
	]);
	// No install call for the already-present package.
	assert.equal(
		runner.calls.some((c) => c[1] === "npm:pi-mcp-adapter"),
		false,
	);
});

test("setup-extensions errors cleanly when `pi` is not on PATH", () => {
	const home = piHome([]);
	const runner = fakeRunner({ piMissing: true });
	assert.throws(
		() => setupExtensions.run({ env: { HOME: home }, runner }),
		(err) => err.code === "PI_NOT_FOUND",
	);
});

test("setup-extensions reports a failed install and exits nonzero, finishing the rest", () => {
	const home = piHome([]);
	const runner = fakeRunner({ failPkgs: ["pi-subagents"] });
	const res = setupExtensions.run({ env: { HOME: home }, runner });
	assert.equal(res.exit, 1);
	assert.equal(res.data.ok, false);
	assert.deepEqual(res.data.failed, ["@gotgenes/pi-subagents"]);
	// The failure did not abort the remaining install.
	assert.equal(res.data.installed.includes("@juicesharp/rpiv-advisor"), true);
});

// ─── doctor (child process, env-overridden HOME — read-only, no `pi`) ─────────

const ALL_SIX = [
	"npm:pi-mcp-adapter",
	"npm:@gotgenes/pi-subagents",
	"npm:@juicesharp/rpiv-advisor",
	"npm:@juicesharp/rpiv-ask-user-question",
	"npm:@tintinweb/pi-tasks",
	"npm:@aliou/pi-processes",
];

test("doctor reports all-installed (exit 0, --json data.ok true)", () => {
	const home = piHome(ALL_SIX);
	const env = json(["doctor", "--json"], {
		env: { HOME: home, USERPROFILE: home },
	});
	assert.equal(env.ok, true);
	assert.equal(env.command, "doctor");
	assert.equal(env.contract, 2);
	assert.equal(env.data.ok, true);
	assert.deepEqual(env.data.missingRequired, []);
	assert.deepEqual(env.data.missingRecommended, []);
});

test("doctor flags missing extensions but stays exit 0 by default", () => {
	const home = piHome(["npm:pi-mcp-adapter"]); // 2 required + all recommended missing
	const res = run(["doctor", "--json"], {
		env: { HOME: home, USERPROFILE: home },
	});
	assert.equal(res.code, 0);
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.data.ok, false);
	assert.deepEqual(env.data.missingRequired, [
		"@gotgenes/pi-subagents",
		"@juicesharp/rpiv-advisor",
	]);
});

test("doctor --strict exits nonzero when a required extension is missing", () => {
	const home = piHome(["npm:pi-mcp-adapter"]);
	const res = run(["doctor", "--strict", "--json"], {
		env: { HOME: home, USERPROFILE: home },
		expectFail: true,
	});
	assert.equal(res.code, 1);
	assert.equal(JSON.parse(res.stdout.trim()).data.ok, false);
	// --strict with everything present exits 0.
	const okHome = piHome(ALL_SIX);
	assert.equal(
		run(["doctor", "--strict", "--json"], {
			env: { HOME: okHome, USERPROFILE: okHome },
		}).code,
		0,
	);
});

test("doctor treats absent or malformed settings.json as none-installed (no crash)", () => {
	// Absent: tmp HOME with no .pi/ at all.
	const empty = tmp();
	const a = JSON.parse(
		run(["doctor", "--json"], {
			env: { HOME: empty, USERPROFILE: empty },
		}).stdout.trim(),
	);
	assert.equal(a.data.ok, false);
	assert.equal(a.data.missingRequired.length, 3);

	// Malformed JSON.
	const home = tmp();
	mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		"{ not valid json",
	);
	const m = run(["doctor", "--json"], {
		env: { HOME: home, USERPROFILE: home },
	});
	assert.equal(m.code, 0);
	assert.equal(JSON.parse(m.stdout.trim()).data.missingRequired.length, 3);
});

test("the new --strict/--all flags are accepted; unknown flags still rejected", () => {
	const home = piHome(ALL_SIX);
	// --all is a known flag (no UNKNOWN_FLAG even though doctor ignores it).
	assert.equal(
		run(["doctor", "--all", "--json"], {
			env: { HOME: home, USERPROFILE: home },
		}).code,
		0,
	);
	// A genuinely unknown flag still throws.
	const bad = run(["doctor", "--nope", "--json"], { expectFail: true });
	assert.equal(JSON.parse(bad.stdout.trim()).error.code, "UNKNOWN_FLAG");
});

// ─── format issue|pr (child process; structured input via --input <json>) ───
// The formatter reads a structured-input JSON file and WRITES the rendered
// body to a temp file, returning its path in data.bodyFile. Tests write the
// input into a tmp() dir, then read data.bodyFile back to assert content.
// Assert only the spec-named contract: the 4 issue sections, the
// refs/closes keyword, data.fileWarning — not exact prose/spacing.

function writeInput(dir, name, obj) {
	const p = path.join(dir, name);
	writeFileSync(p, JSON.stringify(obj));
	return p;
}

test("format issue writes a temp body file with the 4 sections in order", () => {
	const dir = tmp();
	const input = writeInput(dir, "issue.json", {
		title: "GitHub Trace Loop",
		context: "why this work exists",
		technicalApproach: "the technical plan",
		acceptanceCriteria: ["AC1", "AC2"],
		outOfScope: ["team coordination"],
	});
	const env = json(["format", "issue", "--input", input, "--json"]);
	assert.equal(env.ok, true);
	assert.ok(env.data.bodyFile, "expected data.bodyFile path");

	const body = readFileSync(env.data.bodyFile, "utf8");
	// The four sections appear in order (English labels).
	const iContext = body.indexOf("## Context");
	const iApproach = body.indexOf("## Technical Approach");
	const iAC = body.indexOf("## Acceptance Criteria");
	const iScope = body.indexOf("## Out of Scope");
	assert.ok(
		iContext >= 0 && iApproach > iContext && iAC > iApproach && iScope > iAC,
		"all four sections present and in order",
	);
	assert.equal(body.includes("\r"), false); // LF-only
});

test("format issue accepts the pre-2.5 field aliases (konteks/rencanaTeknis/diLuarScope)", () => {
	const dir = tmp();
	const input = writeInput(dir, "issue-legacy.json", {
		title: "GitHub Trace Loop",
		konteks: "why this work exists",
		rencanaTeknis: "the technical plan",
		acceptanceCriteria: ["AC1"],
		diLuarScope: ["team coordination"],
	});
	const env = json(["format", "issue", "--input", input, "--json"]);
	const body = readFileSync(env.data.bodyFile, "utf8");
	assert.match(body, /## Context\nwhy this work exists/);
	assert.match(body, /## Technical Approach\nthe technical plan/);
	assert.match(body, /## Out of Scope\n- team coordination/);
});

test("format issue embeds the full spec in a collapsible details block", () => {
	const dir = tmp();
	const spec = "# Spec Title\n\nFull GWT scenarios here.\n";
	const input = writeInput(dir, "issue-spec.json", {
		title: "GitHub Trace Loop",
		context: "ctx",
		technicalApproach: "plan",
		acceptanceCriteria: ["AC1"],
		outOfScope: [],
		specMarkdown: spec,
	});
	const env = json(["format", "issue", "--input", input, "--json"]);
	const body = readFileSync(env.data.bodyFile, "utf8");
	const iDetails = body.indexOf("<details>");
	assert.ok(
		iDetails > body.indexOf("## Out of Scope"),
		"details block follows the summary sections",
	);
	assert.match(body, /<summary>Full specification<\/summary>/);
	assert.ok(body.includes("Full GWT scenarios here."));
	assert.ok(body.indexOf("</details>") > iDetails);

	// Without specMarkdown, no details block is emitted.
	const plain = json([
		"format",
		"issue",
		"--input",
		writeInput(dir, "issue-plain.json", {
			title: "t",
			context: "c",
			technicalApproach: "p",
			acceptanceCriteria: [],
			outOfScope: [],
		}),
		"--json",
	]);
	assert.equal(
		readFileSync(plain.data.bodyFile, "utf8").includes("<details>"),
		false,
	);
});

test("format pr selects closes vs refs from the (input-driven) phase position", () => {
	const dir = tmp();
	// Final/sole phase → closes #N.
	const finalInput = writeInput(dir, "pr-final.json", {
		issue: 42,
		finalPhase: true,
		fileCount: 3,
		what: "w",
		why: "y",
		howToTest: "h",
	});
	const fin = json(["format", "pr", "--input", finalInput, "--json"]);
	assert.equal(fin.data.linkKeyword, "closes");
	assert.match(readFileSync(fin.data.bodyFile, "utf8"), /closes #42/);

	// Non-final phase → refs #N (no premature close).
	const midInput = writeInput(dir, "pr-mid.json", {
		issue: 42,
		finalPhase: false,
		fileCount: 3,
		what: "w",
		why: "y",
		howToTest: "h",
	});
	const mid = json(["format", "pr", "--input", midInput, "--json"]);
	assert.equal(mid.data.linkKeyword, "refs");
	const midBody = readFileSync(mid.data.bodyFile, "utf8");
	assert.match(midBody, /refs #42/);
	assert.equal(/closes #42/.test(midBody), false);
});

test("format pr surfaces a non-blocking >20-file warning but still produces the body", () => {
	const dir = tmp();
	const input = writeInput(dir, "pr-big.json", {
		issue: 42,
		finalPhase: true,
		fileCount: 23,
		what: "w",
		why: "y",
		howToTest: "h",
	});
	const env = json(["format", "pr", "--input", input, "--json"]);
	assert.equal(env.ok, true); // non-blocking
	assert.equal(env.data.fileWarning, true);
	// The body is still produced.
	assert.ok(readFileSync(env.data.bodyFile, "utf8").length > 0);
});

// ─── format comment|closeout (child process; same --input + bodyFile contract) ─
// Reuses the writeInput() helper from T5's block. Assert the spec-named
// contract: marker first line (exactly once), per-task verdict rows, the
// Action Required block gated on FAIL/BLOCKED, and the DoD auto/manual split.

test("format comment renders marker + verdict table + Action Required + DoD (mixed verdicts)", () => {
	const dir = tmp();
	const input = writeInput(dir, "comment.json", {
		phase: 2,
		verdicts: [
			{ task: "T1", verdict: "PASS" },
			{ task: "T2", verdict: "PASS" },
			{ task: "T3", verdict: "FAIL" },
		],
		prLinked: true,
	});
	const env = json(["format", "comment", "--input", input, "--json"]);
	assert.equal(env.ok, true);
	const body = readFileSync(env.data.bodyFile, "utf8");

	// Marker is the first line and appears exactly once (re-runs update, not duplicate).
	assert.match(body, /^<!-- pocket-phase-2-summary -->/);
	assert.equal(
		(body.match(/<!-- pocket-phase-2-summary -->/g) || []).length,
		1,
	);

	// Task→verdict rows for every task.
	for (const t of ["T1", "T2", "T3"])
		assert.ok(body.includes(t), `row for ${t}`);
	// Action Required is present and names the failing task.
	assert.match(body, /Action Required/);
	assert.match(body, /T3/);

	// DoD: a Pocket-verifiable item is auto-checked; CI/tsc/secrets stay manual.
	assert.match(body, /\[x\]/i); // at least one auto-checked item
	assert.match(body, /\[ \]/); // CI/tsc/secrets left unchecked

	assert.equal(body.includes("\r"), false); // LF-only
});

test("format comment escapes pipe chars in task/verdict table cells", () => {
	const dir = tmp();
	const input = writeInput(dir, "comment-pipe.json", {
		phase: 3,
		verdicts: [{ task: "Parse key|value pairs", verdict: "FAIL" }],
		prLinked: true,
	});
	const env = json(["format", "comment", "--input", input, "--json"]);
	assert.equal(env.ok, true);
	const body = readFileSync(env.data.bodyFile, "utf8");
	assert.match(body, /\| Parse key\\\|value pairs \| FAIL \|/);
});

test("format comment omits the Action Required block when all verdicts PASS", () => {
	const dir = tmp();
	const input = writeInput(dir, "comment-pass.json", {
		phase: 1,
		verdicts: [
			{ task: "T1", verdict: "PASS" },
			{ task: "T2", verdict: "PASS" },
		],
		prLinked: true,
	});
	const env = json(["format", "comment", "--input", input, "--json"]);
	const body = readFileSync(env.data.bodyFile, "utf8");
	assert.match(body, /^<!-- pocket-phase-1-summary -->/);
	assert.equal(/Action Required/.test(body), false);
});

test("format closeout writes a closeout summary body", () => {
	const dir = tmp();
	const input = writeInput(dir, "closeout.json", {
		slug: "pocket-enterprise",
		issue: 42,
		phases: 2,
	});
	const env = json(["format", "closeout", "--input", input, "--json"]);
	assert.equal(env.ok, true);
	const body = readFileSync(env.data.bodyFile, "utf8");
	assert.ok(body.length > 0);
	assert.equal(body.includes("\r"), false); // LF-only
});

// ─── format tasklist (child process; reads log.json directly, no --input) ───

test("format tasklist renders a marker-tagged per-phase task table from log.json", () => {
	const dir = tmp();
	writeFileSync(
		path.join(dir, "log.json"),
		JSON.stringify({
			header: { plan_dir: dir, plan_type: "phased", status: "IN_PROGRESS" },
			phases: [
				{
					order: 1,
					file: "execution-plan-phase-1.md",
					status: "DONE",
					tasks: [
						{
							id: "T1",
							name: "Wire the parser",
							status: "DONE",
							done_sha: "abcdef0123456789",
						},
						{
							id: "T2",
							name: "Add the gate",
							status: "DONE",
							done_sha: "123456789abcdef0",
						},
					],
					corrections: [
						{ sha: "fedcba9876543210", files: ["a.js"], for_task: "T1" },
					],
				},
				{
					order: 2,
					file: "execution-plan-phase-2.md",
					status: "WAITING",
					tasks: [{ id: "T3", name: "Docs pass", status: "WAITING" }],
				},
			],
		}),
	);

	const env = json(["format", "tasklist", dir, "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.data.marker, "<!-- pocket-tasklist -->");

	const body = readFileSync(env.data.bodyFile, "utf8");
	assert.match(body, /^<!-- pocket-tasklist -->/);
	assert.match(body, /execution-plan-phase-1\.md — DONE/);
	assert.match(body, /✅ T1 \| Wire the parser \| DONE \| `abcdef0`/);
	assert.match(body, /⬜ T3 \| Docs pass \| WAITING \| —/);
	assert.match(body, /Corrections: `fedcba9` \(T1\)/);
	assert.equal(body.includes("\r"), false); // LF-only
});

test("format tasklist escapes pipe chars in task name/id/status and backticks in plan_dir", () => {
	const dir = tmp();
	writeFileSync(
		path.join(dir, "log.json"),
		JSON.stringify({
			header: {
				plan_dir: "docs/pocket/plans/x`y",
				plan_type: "flat",
				status: "IN_PROGRESS",
			},
			phases: [
				{
					order: 1,
					file: "execution-plan.md",
					status: "DONE",
					tasks: [
						{
							id: "T1",
							name: "Parse key|value pairs",
							status: "DONE",
							done_sha: "abcdef0123456789",
						},
					],
				},
			],
		}),
	);

	const env = json(["format", "tasklist", dir, "--json"]);
	assert.equal(env.ok, true);

	const body = readFileSync(env.data.bodyFile, "utf8");
	assert.match(body, /\*\*Plan:\*\* `docs\/pocket\/plans\/x'y`/);
	assert.match(body, /✅ T1 \| Parse key\\\|value pairs \| DONE \| `abcdef0`/);
});

test("format tasklist fails with NO_LOG when log.json is missing", () => {
	const dir = tmp();
	const res = run(["format", "tasklist", dir, "--json"], { expectFail: true });
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "NO_LOG");
});

// ─── reconcile set-diff (child process; --prior/--new <json> file inputs) ───
// Inputs are JSON arrays of fingerprint records (each at least { fingerprint,
// ...metadata }). Reuses writeInput() from T5's block. data.resolve/post/keep
// are partitioned by `fingerprint`. Assert the partition by the fingerprint
// key set, plus deterministic ordering.

function fps(env) {
	// Map a partition of records back to its fingerprint key set (order-preserving).
	return {
		resolve: env.data.resolve.map((r) => r.fingerprint),
		post: env.data.post.map((r) => r.fingerprint),
		keep: env.data.keep.map((r) => r.fingerprint),
	};
}

test("reconcile partitions prior/new into resolve/post/keep by fingerprint", () => {
	const dir = tmp();
	const prior = writeInput(dir, "prior.json", [
		{ fingerprint: "fpA", thread: "t1" },
		{ fingerprint: "fpB", thread: "t2" },
	]);
	const next = writeInput(dir, "new.json", [
		{ fingerprint: "fpB" },
		{ fingerprint: "fpC" },
	]);
	const env = json(["reconcile", "--prior", prior, "--new", next, "--json"]);
	assert.equal(env.ok, true);
	assert.equal(env.command, "reconcile");
	const out = fps(env);
	assert.deepEqual(out.resolve, ["fpA"]); // prior \ new
	assert.deepEqual(out.post, ["fpC"]); // new \ prior
	assert.deepEqual(out.keep, ["fpB"]); // intersection
	// resolve records carry their prior metadata so the skill can act on the thread.
	assert.equal(env.data.resolve[0].thread, "t1");
});

test("reconcile with empty prior posts everything new", () => {
	const dir = tmp();
	const prior = writeInput(dir, "prior.json", []);
	const next = writeInput(dir, "new.json", [{ fingerprint: "fpA" }]);
	const out = fps(
		json(["reconcile", "--prior", prior, "--new", next, "--json"]),
	);
	assert.deepEqual(out.post, ["fpA"]);
	assert.deepEqual(out.resolve, []);
});

test("reconcile with empty new resolves all prior", () => {
	const dir = tmp();
	const prior = writeInput(dir, "prior.json", [{ fingerprint: "fpA" }]);
	const next = writeInput(dir, "new.json", []);
	const out = fps(
		json(["reconcile", "--prior", prior, "--new", next, "--json"]),
	);
	assert.deepEqual(out.resolve, ["fpA"]);
	assert.deepEqual(out.post, []);
});

test("reconcile output ordering is deterministic across runs", () => {
	const dir = tmp();
	const prior = writeInput(dir, "prior.json", [
		{ fingerprint: "fpB" },
		{ fingerprint: "fpA" },
		{ fingerprint: "fpD" },
	]);
	const next = writeInput(dir, "new.json", [
		{ fingerprint: "fpC" },
		{ fingerprint: "fpA" },
	]);
	const first = fps(
		json(["reconcile", "--prior", prior, "--new", next, "--json"]),
	);
	const second = fps(
		json(["reconcile", "--prior", prior, "--new", next, "--json"]),
	);
	assert.deepEqual(first, second); // reproducible
});

test("getCommitFiles lists files changed in a single commit (incl. root)", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "t@e.com"]);
	git(dir, ["config", "user.name", "T"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	writeFileSync(path.join(dir, "a.txt"), "a");
	git(dir, ["add", "a.txt"]);
	git(dir, ["commit", "-q", "-m", "root"]); // root commit (no parent)
	const rootSha = git(dir, ["rev-parse", "HEAD"]).trim();
	assert.deepEqual(gitlib.getCommitFiles(dir, rootSha), ["a.txt"]);

	writeFileSync(path.join(dir, "b.txt"), "b");
	git(dir, ["add", "b.txt"]);
	git(dir, ["commit", "-q", "-m", "second"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	assert.deepEqual(gitlib.getCommitFiles(dir, sha), ["b.txt"]);
});

test("getRangeFiles lists files changed across a base..head range", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	gitInitRepo(dir);
	const base = git(dir, ["rev-parse", "HEAD"]).trim();
	writeFileSync(path.join(dir, "x.txt"), "x");
	git(dir, ["add", "x.txt"]);
	git(dir, ["commit", "-q", "-m", "x"]);
	const head = git(dir, ["rev-parse", "HEAD"]).trim();
	assert.deepEqual(gitlib.getRangeFiles(dir, base, head), ["x.txt"]);
});

test("getCommitFiles / getRangeFiles return [] on git failure", () => {
	const nodir = path.join(tmp(), "not-a-repo");
	assert.deepEqual(gitlib.getCommitFiles(nodir, "deadbeef"), []);
	assert.deepEqual(gitlib.getRangeFiles(nodir, "a", "b"), []);
});

const PLAN_4 = [
	"# Plan",
	"",
	"## Pocket Packets",
	"",
	"### Task 1: alpha [prereq]",
	"### Task 2: beta [depends: T1]",
	"### Task 3: gamma [depends: T2]",
	"",
].join("\n");

function setupPhasedDone(dir) {
	// Build a 3-task flat plan, structure it, init log, and mark T1..T3 DONE
	// each on its own commit so they have distinct done_sha boundaries.
	writeFileSync(path.join(dir, "execution-plan.md"), PLAN_4);
	run(["structure", path.join(dir, "execution-plan.md")]);
	gitInitRepo(dir);
	run(["log", "init", dir]);
	const phase = "execution-plan.md";
	for (const t of ["T1", "T2", "T3"]) {
		writeFileSync(path.join(dir, `${t.toLowerCase()}.txt`), t);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", `${t} work`]);
		run(["log", "update", dir, phase, "DONE", "--task", t, "--json"]);
		// Commit log.json after each update so the working tree stays clean;
		// otherwise the dirty log.json bleeds into the next correction commit.
		git(dir, ["add", "log.json"]);
		git(dir, ["commit", "-q", "-m", `log: ${t} DONE`]);
	}
	return phase;
}

test("log update --correction appends to phase.corrections with files", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);

	// A correction to T1 that only touches t1.txt.
	writeFileSync(path.join(dir, "t1.txt"), "T1 fixed");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fix T1"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();

	const env = json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
		"--json",
	]);
	assert.equal(env.command, "log update");
	assert.equal(env.data.level, "correction");
	assert.equal(env.data.correction.sha, sha);
	assert.deepEqual(env.data.correction.files, ["t1.txt"]);
	assert.deepEqual(env.data.correction.affectedTasks, ["T1"]);
	assert.deepEqual(env.data.correction.bleed, []);

	// Persisted under the phase, done_sha untouched.
	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	const ph = log.phases.find((p) => p.file === phase);
	assert.equal(ph.corrections.length, 1);
	assert.equal(ph.corrections[0].sha, sha);
	assert.deepEqual(ph.corrections[0].files, ["t1.txt"]);
	assert.equal(ph.corrections[0].for_task, "T1");
});

test("log update --correction warns on cross-task file bleed", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);

	// A "T1" correction that also edits t2.txt (owned by T2) → bleed.
	writeFileSync(path.join(dir, "t1.txt"), "T1 fixed");
	writeFileSync(path.join(dir, "t2.txt"), "T2 touched");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fix T1 bleeding into T2"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();

	// First (human-mode) recording — must print the bleed warning.
	const firstHuman = run([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
	]).stdout;
	assert.match(firstHuman, /also touches files owned by/); // bleed warning on fresh record

	// JSON re-run confirms affectedTasks/bleed fields (already recorded = idempotent).
	const env = json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
		"--json",
	]);
	assert.deepEqual(env.data.correction.affectedTasks.sort(), ["T1", "T2"]);
	assert.deepEqual(env.data.correction.bleed, ["T2"]);

	// Human-mode re-run hits the idempotent path.
	const human = run([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
	]).stdout;
	assert.match(human, /already recorded/); // idempotent re-record warns (see next test)
});

test("log update --correction rejects an unknown --for-task id", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);

	// A valid correction commit so we hit the task-guard before getCommitFiles.
	writeFileSync(path.join(dir, "t1.txt"), "fix");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fix T1"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();

	const { stdout, stderr } = run(
		[
			"log",
			"update",
			dir,
			phase,
			"--correction",
			sha,
			"--for-task",
			"T99",
			"--json",
		],
		{ expectFail: true },
	);
	const combined = stdout + stderr;
	assert.match(combined, /T99/); // error mentions the unknown task id
	assert.match(combined, /not found/);
});

test("log update --correction is idempotent on a duplicate sha (no-op + warn)", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);
	writeFileSync(path.join(dir, "t3.txt"), "T3 fixed");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fix T3"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();

	json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T3",
		"--json",
	]);
	const again = json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T3",
		"--json",
	]);
	assert.equal(again.data.correction.idempotent, true);

	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	const ph = log.phases.find((p) => p.file === phase);
	assert.equal(ph.corrections.length, 1); // not appended twice
});

test("log update --correction preserves the byte-parity writer + additive schema", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);
	writeFileSync(path.join(dir, "t1.txt"), "fix");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fix"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
		"--json",
	]);

	const raw = readFileSync(path.join(dir, "log.json"), "utf8");
	assert.ok(raw.endsWith("\n")); // trailing newline
	assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2) + "\n"); // 2-space indent, round-trips
});

// DISCRIMINATING TEST (advisor): a correction for T1 that touches a file whose
// LAST writer in original order is T2 must still attribute to T1 (via for_task).
// Owner-only attribution would strand T1's REVIEW_FAIL forever. setupPhasedDone
// uses disjoint files and structurally cannot catch this — build a shared file.
test("log update --correction attributes to for_task even when owner is another task", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	writeFileSync(path.join(dir, "execution-plan.md"), PLAN_4);
	run(["structure", path.join(dir, "execution-plan.md")]);
	gitInitRepo(dir);
	run(["log", "init", dir]);
	const phase = "execution-plan.md";

	// T1 creates shared.txt; T2 LAST-edits shared.txt → owner[shared.txt] = T2.
	writeFileSync(path.join(dir, "shared.txt"), "v1 by T1");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "T1 work"]);
	run(["log", "update", dir, phase, "DONE", "--task", "T1", "--json"]);
	git(dir, ["add", "log.json"]);
	git(dir, ["commit", "-q", "-m", "log: T1 DONE"]);
	writeFileSync(path.join(dir, "shared.txt"), "v2 by T2");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "T2 work"]);
	run(["log", "update", dir, phase, "DONE", "--task", "T2", "--json"]);
	git(dir, ["add", "log.json"]);
	git(dir, ["commit", "-q", "-m", "log: T2 DONE"]);
	writeFileSync(path.join(dir, "t3.txt"), "T3");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "T3 work"]);
	run(["log", "update", dir, phase, "DONE", "--task", "T3", "--json"]);
	git(dir, ["add", "log.json"]);
	git(dir, ["commit", "-q", "-m", "log: T3 DONE"]);

	// Correction FOR T1 that edits shared.txt (owned/last-written by T2).
	writeFileSync(path.join(dir, "shared.txt"), "v3 fix for T1");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "fix T1 in shared.txt"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();

	const env = json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
		"--json",
	]);
	// The invariant: for_task is first-class — T1 is attributed even though
	// owner[shared.txt] = T2. (Skill-level trigger/closing consume this set.)
	assert.ok(
		env.data.correction.affectedTasks.includes("T1"),
		"for_task T1 must be attributed",
	);
	assert.deepEqual(env.data.correction.affectedTasks.sort(), ["T1", "T2"]);
	assert.deepEqual(env.data.correction.bleed, ["T2"]);
});

test("log update --correction rejects a bogus (unresolvable) sha with UNKNOWN_SHA", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);

	const bogusSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
	const res = run(
		[
			"log",
			"update",
			dir,
			phase,
			"--correction",
			bogusSha,
			"--for-task",
			"T1",
			"--json",
		],
		{ expectFail: true },
	);
	const env = JSON.parse(res.stdout.trim());
	assert.equal(env.ok, false);
	assert.equal(env.error.code, "UNKNOWN_SHA");
	assert.match(env.error.message, /not a commit/);
});

test("log update --correction skips an empty-diff commit (nothing to attribute)", {
	skip: !hasGit(),
}, () => {
	const dir = tmp();
	const phase = setupPhasedDone(dir);
	git(dir, ["commit", "--allow-empty", "-q", "-m", "no-op"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	const env = json([
		"log",
		"update",
		dir,
		phase,
		"--correction",
		sha,
		"--for-task",
		"T1",
		"--json",
	]);
	assert.equal(env.data.correction.skipped, true);
	const log = JSON.parse(readFileSync(path.join(dir, "log.json"), "utf8"));
	const ph = log.phases.find((p) => p.file === phase);
	assert.ok(!ph.corrections || ph.corrections.length === 0); // not recorded
});
