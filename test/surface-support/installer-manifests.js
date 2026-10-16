'use strict';

// Installer-manifest assertions for native harness formats.
// Codex uses its documented marketplace catalog and portable plugin manifest.
// Gemini discovers skills from the extension root; its context file must not eagerly import them.
// Copilot officially supports Claude-compatible marketplace locations.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./shared');
const { walkFiles } = require('../../test-support/surface-test-utils');

function readJson(rel) {
  const full = path.join(ROOT, rel);
  assert.ok(fs.existsSync(full), `${rel} must exist`);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

test('codex marketplace uses the documented path and local plugin source shape', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');
  const plugin = readJson('plugin.json');
  const skillEntrypoints = walkFiles(path.join(ROOT, 'skills'))
    .filter((file) => path.basename(file) === 'SKILL.md')
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));

  assert.equal(skillEntrypoints.length, 16, 'the repository-root plugin currently exposes 16 skill files');
  assert.ok(skillEntrypoints.includes('skills/pocket-enterprise/SKILL.md'));
  assert.ok(skillEntrypoints.includes('skills/create-pr/SKILL.md'));
  assert.equal(typeof marketplace.name, 'string', 'Codex marketplace must declare a name');
  assert.ok(Array.isArray(marketplace.plugins), 'Codex marketplace must declare plugins');
  assert.equal(marketplace.plugins.length, 1, 'Codex marketplace must expose one plugin');
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, 'pocketto');
  assert.deepEqual(entry.source, { source: 'local', path: './' });
  assert.equal(typeof entry.category, 'string');
  assert.ok(!('surface_manifest' in marketplace), 'Pocketto-specific fields are not marketplace fields');
  assert.ok(!('surfaces' in marketplace), 'Pocketto-specific fields are not marketplace fields');

  const allowedPluginFields = new Set([
    '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository',
    'license', 'keywords', 'extensions',
  ]);
  for (const field of Object.keys(plugin)) {
    assert.ok(allowedPluginFields.has(field), `plugin.json field ${field} is outside Agent Plugins 1.0`);
  }
  for (const field of ['$schema', 'name']) {
    assert.ok(Object.hasOwn(plugin, field), `Agent Plugins 1.0 requires ${field}`);
  }
  assert.equal(
    plugin.$schema,
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    'Codex and Copilot use the documented portable Agent Plugins manifest',
  );
  assert.match(plugin.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.ok(plugin.name.length <= 64);
  assert.equal(typeof plugin.description, 'string');
  assert.equal(typeof plugin.version, 'string');
  assert.equal(typeof plugin.repository, 'string');
  assert.equal(typeof plugin.license, 'string');
  assert.deepEqual(Object.keys(plugin.author).sort(), ['name', 'url']);
  assert.ok(!('surface_manifest' in plugin), 'surface_manifest is not an Agent Plugins field');
  assert.ok(!('surfaces' in plugin), 'surfaces is not an Agent Plugins field');

  const pluginRoot = path.resolve(ROOT, entry.source.path);
  assert.equal(pluginRoot, ROOT, 'marketplace plugin source must resolve to repository root');
  assert.ok(fs.existsSync(path.join(pluginRoot, 'plugin.json')), 'marketplace source must contain plugin.json');
  const packagedSkillEntrypoints = walkFiles(path.join(pluginRoot, 'skills'))
    .filter((file) => path.basename(file) === 'SKILL.md');
  assert.equal(packagedSkillEntrypoints.length, 16, 'portable plugin must expose 16 SKILL.md entrypoints');
  assert.ok(
    packagedSkillEntrypoints.some((file) => file.endsWith(path.join('pocket-enterprise', 'SKILL.md'))),
    'portable plugin must include the Enterprise skill because it packages repository-root skills',
  );
  assert.ok(
    packagedSkillEntrypoints.some((file) => file.endsWith(path.join('create-pr', 'SKILL.md'))),
    'portable plugin must include the create-pr Enterprise skill',
  );
});

test('Gemini extension uses a concise context file instead of eagerly importing skill bodies', () => {
  const ext = readJson('gemini-extension.json');
  const context = fs.readFileSync(path.join(ROOT, 'GEMINI.md'), 'utf8');
  assert.equal(typeof ext.name, 'string', 'gemini-extension.json must declare a name');
  assert.equal(typeof ext.description, 'string', 'gemini-extension.json must declare a description');
  assert.ok(fs.existsSync(path.join(ROOT, 'GEMINI.md')));
  assert.ok(!context.includes('@./skills/'), 'GEMINI.md must not eagerly import skill bodies');
});

test('copilot reuses the documented claude-compatible marketplace location', () => {
  assert.ok(
    !fs.existsSync(path.join(ROOT, '.copilot-plugin')),
    '.copilot-plugin/ must not exist: Copilot reuses .claude-plugin/ as the single source of truth',
  );
  assert.ok(
    !fs.existsSync(path.join(ROOT, '.github', 'plugin')),
    '.github/plugin/ must not exist: Copilot reuses .claude-plugin/ as the single source of truth',
  );
  // The reuse target itself must keep pointing at the claude roles.
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.surfaces.core, 'claude/core', 'claude marketplace core surface must stay claude/core');
  assert.equal(
    marketplace.plugins[0].name,
    'pocketto',
    'claude marketplace must keep exposing the pocketto plugin Copilot reuses',
  );
});
