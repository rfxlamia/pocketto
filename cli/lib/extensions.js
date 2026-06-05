'use strict';

// Single source of truth for the Pi extensions Pocket's skills depend on.
// Consumed by the `doctor` and `setup-extensions` commands and their tests.
//
//   REQUIRED     Pocket's core pipeline cannot run without these — the skills
//                call advisor()/subagent()/context7_* tools they provide.
//   RECOMMENDED  Quality-of-life; Pocket runs without them.

const path = require('node:path');
const { readFileSync } = require('node:fs');

const REQUIRED = [
  { name: 'pi-mcp-adapter', tier: 'required', unlocks: 'context7 MCP — library-aware code generation' },
  { name: '@gotgenes/pi-subagents', tier: 'required', unlocks: 'subagent delegation + parallel reviews' },
  { name: '@juicesharp/rpiv-advisor', tier: 'required', unlocks: 'advisor — LLM-to-LLM review/escalation gates' },
];

const RECOMMENDED = [
  { name: '@juicesharp/rpiv-ask-user-question', tier: 'recommended', unlocks: 'structured user prompts during interviews' },
  { name: '@tintinweb/pi-tasks', tier: 'recommended', unlocks: 'task tracking + progress visibility' },
  { name: '@aliou/pi-processes', tier: 'recommended', unlocks: 'background process management (dev servers, watchers)' },
];

const ALL = [...REQUIRED, ...RECOMMENDED];

// Normalize a Pi `packages[]` spec down to its bare npm package name, or null
// when the spec cannot be mapped to one. Handles:
//   npm:@scope/name@1.2.3   -> @scope/name   (scheme + trailing version)
//   @scope/name@1.2.3       -> @scope/name
//   name                    -> name
//   alias@npm:@scope/real   -> @scope/real   (alias: recurse on the RHS)
//   git:.../http(s)/ssh/... -> null          (no npm name — out of scope for v1)
function normalizeSpec(spec) {
  if (typeof spec !== 'string') return null;
  let s = spec.trim();
  if (!s) return null;

  // Alias form `<alias>@npm:<realspec>` / `<alias>@git:<realspec>`: the real
  // package lives to the right of the FIRST `@npm:`/`@git:` — recurse on it so
  // a scoped/versioned RHS normalizes correctly.
  const alias = s.match(/@(?:npm|git):/);
  if (alias && alias.index > 0) {
    return normalizeSpec(s.slice(alias.index + 1)); // drop `<alias>@`, keep `npm:...`
  }

  // Scheme prefix.
  if (s.startsWith('npm:')) {
    s = s.slice('npm:'.length);
  } else if (/^(?:git:|https?:\/\/|ssh:\/\/|git@)/.test(s)) {
    return null; // git/url specs carry no npm package name.
  }

  // Strip a trailing `@version` while preserving a leading `@scope`:
  // `@scope/name@1.2.3` -> `@scope/name`; `name@1.2.3` -> `name`.
  const at = s.lastIndexOf('@');
  if (at > 0) s = s.slice(0, at);

  return s || null;
}

// Reduce a Pi settings `packages[]` array to the set of installed package names.
function parseInstalledSpecs(packages) {
  const set = new Set();
  if (!Array.isArray(packages)) return set;
  for (const spec of packages) {
    const name = normalizeSpec(spec);
    if (name) set.add(name);
  }
  return set;
}

// Path to Pi's global settings file, or null when no home dir is resolvable.
function piSettingsPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return null;
  return path.join(home, '.pi', 'agent', 'settings.json');
}

// Read the set of installed extension names from Pi's global settings.
// Absent / unreadable / malformed settings are treated as "none installed"
// rather than an error — callers decide what that means.
function readInstalledSet(env = process.env) {
  const p = piSettingsPath(env);
  if (!p) return new Set();
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return new Set();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  return parseInstalledSpecs(parsed && parsed.packages);
}

// Annotate every known extension with whether it is currently installed.
function classify(env = process.env) {
  const installed = readInstalledSet(env);
  return ALL.map((ext) => ({ ...ext, installed: installed.has(ext.name) }));
}

module.exports = {
  REQUIRED,
  RECOMMENDED,
  ALL,
  normalizeSpec,
  parseInstalledSpecs,
  piSettingsPath,
  readInstalledSet,
  classify,
};
