'use strict';

// Keep documented installer examples synchronized with their compatibility tests.
// These string checks verify documentation consistency only; they do not prove
// that a command works in a live harness.

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
      "npx skills add rfxlamia/pocketto --skill '*' -a github-copilot -y",
    ],
  },
  {
    harness: 'codex',
    docs: 'docs/install-codex.md',
    commands: [
      'codex plugin marketplace add rfxlamia/pocketto',
      "npx skills add rfxlamia/pocketto --skill '*' -a codex -y",
    ],
  },
  {
    harness: 'gemini',
    docs: 'docs/install-gemini.md',
    commands: [
      'gemini extensions install https://github.com/rfxlamia/pocketto',
      "npx skills add rfxlamia/pocketto --skill '*' -a gemini-cli -y",
    ],
  },
  {
    harness: 'agents',
    docs: 'docs/install-agents-drop-in.md',
    commands: DROP_IN_ADAPTERS.map(
      (adapter) => `npx skills add rfxlamia/pocketto --skill '*' -a ${adapter} -y`,
    ),
  },
];

test('installer docs exist and pin supported user-facing commands per harness', () => {
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

  const codex = fs.readFileSync(path.join(ROOT, 'docs/install-codex.md'), 'utf8');
  assert.match(codex, /\/plugins/i, 'Codex docs must direct users to its documented plugin browser');
  assert.doesNotMatch(codex, /codex plugin add\b/, 'Do not document an unsupported Codex install command');

  const copilot = fs.readFileSync(path.join(ROOT, 'docs/install-copilot.md'), 'utf8');
  assert.match(copilot, /docs\.github\.com[^\s)]*cli-plugin-reference/i);

  const dropIn = fs.readFileSync(path.join(ROOT, 'docs/install-agents-drop-in.md'), 'utf8');
  assert.match(dropIn, /Verified adapters/i);
  assert.match(dropIn, /Supported adapters/i);
  assert.match(dropIn, /Pocketto installation and skill discovery have not been individually tested/i);
});
