'use strict';

// Cross-harness frontmatter lint for every skills/*/SKILL.md (plan §5.2).
//
// Hard rules (fail the test):
//  - `name` and `description` must be present (progressive disclosure reads
//    them first on every harness);
//  - `name` <= 64 chars, `description` <= 1024 chars — Kiro's hard limits,
//    applied here as the universal ceiling so one lint covers all harnesses.
//    (Codex officially reads only name+description; staying within Kiro's
//    limits keeps every skill portable.)
//
// Warning-level (reported, does not fail — plan §5.2):
//  - frontmatter keys outside {name, description} are ignored by Codex.
//    Baseline warning: skills/validate-plan/SKILL.md declares `category`.
//
// Node built-ins only, like the rest of the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, walkFiles } = require('../surface-test-utils');

const ALLOWED_KEYS = new Set(['name', 'description']);
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function parseFrontmatter(text, rel) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${rel}: SKILL.md must start with a YAML frontmatter block`);
  const fields = new Map();
  let current = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      current = kv[1];
      fields.set(current, kv[2]);
    } else if (current && line.trim() !== '') {
      // Lenient continuation: folded or plain multi-line values are appended.
      fields.set(current, `${fields.get(current)} ${line.trim()}`);
    }
  }
  return fields;
}

function stripQuotes(value) {
  return value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function lintSkillFrontmatter() {
  const errors = [];
  const warnings = [];
  const files = walkFiles(path.join(ROOT, 'skills'))
    .filter((file) => path.basename(file) === 'SKILL.md')
    .sort();
  assert.ok(files.length > 0, 'expected skill entrypoints under skills/');
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const fields = parseFrontmatter(fs.readFileSync(file, 'utf8'), rel);
    for (const key of fields.keys()) {
      if (!ALLOWED_KEYS.has(key)) {
        warnings.push(`${rel}: extra frontmatter key '${key}' (warning-level: ignored by Codex)`);
      }
    }
    const name = fields.has('name') ? stripQuotes(fields.get('name')).trim() : '';
    const description = fields.has('description') ? stripQuotes(fields.get('description')).trim() : '';
    if (!name) {
      errors.push(`${rel}: frontmatter 'name' is required`);
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.push(`${rel}: frontmatter 'name' is ${name.length} chars (max ${MAX_NAME_LENGTH})`);
    }
    if (!description) {
      errors.push(`${rel}: frontmatter 'description' is required`);
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`${rel}: frontmatter 'description' is ${description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`);
    }
  }
  return { errors, warnings, count: files.length };
}

test('skill frontmatter passes the cross-harness lint (name/description limits)', () => {
  const { errors, warnings, count } = lintSkillFrontmatter();
  for (const warning of warnings) {
    // Warning-level per plan §5.2: visible in the TAP output, not a failure.
    console.warn(`frontmatter lint warning: ${warning}`);
  }
  assert.deepEqual(errors, [], 'skill frontmatter must satisfy the cross-harness lint');
  assert.ok(count >= 14, `expected at least 14 skill entrypoints (found ${count})`);
});

module.exports = { lintSkillFrontmatter };
