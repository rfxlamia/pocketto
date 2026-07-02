'use strict';

// pocketto-pi scaffold github [<dir>] [--dry-run]
//
// Writes the GitHub issue/PR templates that match the bodies `format issue`
// and `format pr` produce, so human-authored issues and PRs follow the same
// shape Pocket generates. Pure file writes — no `gh` calls (labels stay in
// the skill layer). Idempotent: existing files are never overwritten.

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('../lib/envelope');

const ISSUE_TEMPLATE = [
  '---',
  'name: Pocket plan',
  'about: Feature or fix tracked through the Pocket pipeline',
  'labels: pocket-plan',
  '---',
  '',
  '## Context',
  '',
  '<!-- Problem statement and background. -->',
  '',
  '## Technical Approach',
  '',
  '<!-- Design decision / how this will be built. -->',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] <!-- Given/When/Then criteria -->',
  '',
  '## Out of Scope',
  '',
  '- <!-- Explicit non-goals -->',
  '',
].join('\n');

const PR_TEMPLATE = [
  '## What',
  '',
  '<!-- What this PR delivers. -->',
  '',
  '## Why',
  '',
  '<!-- Why this work exists — link the context. -->',
  '',
  '## How to Test',
  '',
  '<!-- Verification steps. -->',
  '',
  '<!-- Link the tracking issue: `refs #N` (non-final phase) or `closes #N` (final phase). Keep PRs at ≤20 files. -->',
  '',
].join('\n');

const TEMPLATES = [
  { relPath: path.join('.github', 'ISSUE_TEMPLATE', 'pocket-plan.md'), content: ISSUE_TEMPLATE },
  { relPath: path.join('.github', 'pull_request_template.md'), content: PR_TEMPLATE },
];

function run({ target, targetDir, dryRun = false } = {}) {
  if (target !== 'github') {
    throw new CliError('USAGE', 'Usage: pocketto-pi scaffold github [<dir>] [--dry-run]');
  }
  const dir = path.resolve(targetDir || process.cwd());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new CliError('NOT_FOUND', `'${dir}' is not a directory.`);
  }

  const wrote = [];
  const skipped = [];
  for (const { relPath, content } of TEMPLATES) {
    const filePath = path.join(dir, relPath);
    if (fs.existsSync(filePath)) {
      skipped.push(relPath);
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    }
    wrote.push(relPath);
  }

  const human = [dryRun ? 'GitHub scaffold (dry run):' : 'GitHub scaffold:'];
  for (const f of wrote) human.push(`  ${dryRun ? 'would write' : 'wrote'}: ${f}`);
  for (const f of skipped) human.push(`  exists, skipped: ${f}`);

  return {
    command: 'scaffold github',
    exit: 0,
    human,
    data: { dir, dryRun, wrote, skipped },
  };
}

module.exports = { run };
