'use strict';

// Pinned user-facing installer commands per harness (plan §4, test §5.4).
//
// Each docs file is the contract: the exact command strings below must appear
// in it verbatim, so the documented installer and the test cannot drift apart.
// Adapter names for `npx skills add -a` are pinned exactly as documented in
// §4; verifying the real adapter names against the vercel-labs/skills CLI is
// a sprint-1 spike item (plan §8.1) — if the spike renames one, this table and
// the docs change together.
//
// TDD RED on the baseline: none of the installer docs exist yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const DROP_IN_ADAPTERS = ['cursor', 'cline', 'zed', 'crush', 'kilo', 'junie', 'qwen-code'];

const HARNESS_INSTALLERS = [
  {
    harness: 'copilot',
    docs: 'docs/install-copilot.md',
    commands: [
      'copilot plugin marketplace add rfxlamia/pocketto',
      'copilot plugin install pocketto@pocketto',
    ],
  },
  {
    harness: 'codex',
    docs: 'docs/install-codex.md',
    commands: [
      'codex plugin marketplace add rfxlamia/pocketto',
      'codex plugin add pocketto@pocketto',
    ],
  },
  {
    harness: 'gemini',
    docs: 'docs/install-gemini.md',
    commands: ['gemini extensions install https://github.com/rfxlamia/pocketto'],
  },
  {
    harness: 'agents',
    docs: 'docs/install-agents-drop-in.md',
    commands: DROP_IN_ADAPTERS.map((adapter) => `npx skills add rfxlamia/pocketto -a ${adapter}`),
  },
];

test('installer docs exist and pin the exact user-facing commands per harness', () => {
  for (const { harness, docs, commands } of HARNESS_INSTALLERS) {
    const full = path.join(ROOT, docs);
    assert.ok(fs.existsSync(full), `${harness}: installer doc ${docs} must exist`);
    const text = fs.readFileSync(full, 'utf8');
    for (const command of commands) {
      assert.ok(
        text.includes(command),
        `${harness}: ${docs} must document the pinned command verbatim: ${command}`,
      );
    }
  }
});
