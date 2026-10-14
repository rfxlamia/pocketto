'use strict';

// Shared constants for the wave-1 multi-harness surface tests.
//
// Wave 1 adds one Core role per installer archetype (plan §3.2):
//   copilot/core  host=copilot  — staged: core skill set + reuse .claude-plugin/marketplace.json
//   codex/core    host=codex    — staged: core skill set + .codex-plugin/{marketplace,plugin}.json
//   gemini/core   host=gemini   — staged: core skill set + gemini-extension.json + GEMINI.md
//   agents/core   host=agents   — staged: core skill set only (no manifest;
//                                serves every .agents/skills/-native harness:
//                                Cursor, Cline, Zed, Crush, Kilo Code, Junie, Qwen Code)
//
// Enterprise overlays (copilot/enterprise, …) are wave 2. The requires-pair
// invariant in role-naming.js already covers them generically, so no new
// constant is needed when they land.

const NEW_CORE_ROLES = ['copilot/core', 'codex/core', 'gemini/core', 'agents/core'];

const PLANNED_ROLES = [
  'pi/core',
  'pi/enterprise',
  'claude/core',
  'claude/enterprise',
  ...NEW_CORE_ROLES,
];

// Pi-runtime CLI modules that must never leak into a harness Core staging.
// Harness roles ship markdown skills; they have no npm runtime and no
// Pi-specific CLI commands (plan §3.4, §5.3). Extend this list if the
// implementation identifies more Pi-only modules.
const PI_ONLY_PATHS = [
  'cli/commands/setup-extensions.js',
];

module.exports = { NEW_CORE_ROLES, PI_ONLY_PATHS, PLANNED_ROLES };
