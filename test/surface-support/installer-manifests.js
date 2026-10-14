'use strict';

// Installer-manifest assertions for wave-1 harness glue (plan §5.1).
//
//  - Codex: .codex-plugin/marketplace.json + .codex-plugin/plugin.json must
//    exist and mirror the .claude-plugin/ conventions — the marketplace
//    plugin entry carries name/source/description/category/tags, the plugin
//    manifest carries name/description/surfaces like its Claude counterpart.
//    (TDD RED: neither file exists on the baseline.)
//  - Gemini: gemini-extension.json must be valid JSON with the expected
//    fields, alongside GEMINI.md. (TDD RED on the baseline.)
//  - Copilot: NO forked manifest may ever exist — Copilot reuses
//    .claude-plugin/marketplace.json as the single source of truth. This is a
//    GREEN-on-baseline guard: it must stay green after implementation, and it
//    is deleted/replaced only if the §3.5.2 fallback (a dedicated
//    .github/plugin/plugin.json) is ever adopted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./shared');

function readJson(rel) {
  const full = path.join(ROOT, rel);
  assert.ok(fs.existsSync(full), `${rel} must exist`);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

test('codex installer manifests exist and mirror the claude-plugin conventions', () => {
  const marketplace = readJson('.codex-plugin/marketplace.json');
  const plugin = readJson('.codex-plugin/plugin.json');

  // Marketplace shape mirrors .claude-plugin/marketplace.json.
  assert.equal(typeof marketplace.name, 'string', 'codex marketplace.json must declare a name');
  assert.ok(
    Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0,
    'codex marketplace.json must declare at least one plugin',
  );
  const entry = marketplace.plugins[0];
  for (const field of ['name', 'source', 'description', 'category', 'tags']) {
    assert.ok(entry[field] !== undefined, `codex marketplace plugin entry must define ${field}`);
  }
  assert.equal(entry.name, 'pocketto', 'codex marketplace plugin entry must be named pocketto');
  assert.equal(
    marketplace.surfaces && marketplace.surfaces.core,
    'codex/core',
    'codex marketplace must map its core surface to codex/core',
  );

  // plugin.json shape mirrors .claude-plugin/plugin.json.
  assert.equal(plugin.name, 'pocketto', 'codex plugin.json must be named pocketto');
  assert.equal(typeof plugin.description, 'string', 'codex plugin.json must declare a description');
  assert.equal(
    plugin.surfaces && plugin.surfaces.core,
    'codex/core',
    'codex plugin.json must map its core surface to codex/core',
  );
});

test('gemini extension manifest is valid JSON with the expected fields', () => {
  const ext = readJson('gemini-extension.json');
  assert.equal(typeof ext.name, 'string', 'gemini-extension.json must declare a name');
  assert.equal(typeof ext.description, 'string', 'gemini-extension.json must declare a description');
  assert.ok(
    fs.existsSync(path.join(ROOT, 'GEMINI.md')),
    'GEMINI.md must exist at the repo root alongside gemini-extension.json',
  );
});

test('copilot reuses the claude marketplace manifest — no forked copilot manifest may exist', () => {
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
