'use strict';

const { markerFor } = require('./identity');

function bulletList(items) {
  if (!items || items.length === 0) return '';
  return items.map((item) => `- ${item}`).join('\n');
}

function issueBody({ title, konteks, rencanaTeknis, acceptanceCriteria, diLuarScope }) {
  const lines = [
    `# ${title}`,
    '',
    '## Konteks',
    konteks || '',
    '',
    '## Rencana Teknis',
    rencanaTeknis || '',
    '',
    '## Acceptance Criteria',
    bulletList(acceptanceCriteria),
    '',
    '## Di Luar Scope',
    bulletList(diLuarScope),
    '',
  ];
  return lines.join('\n');
}

const FILE_LIMIT = 20;

function prBody({ issue, finalPhase, fileCount, what, why, howToTest }) {
  const linkKeyword = finalPhase ? 'closes' : 'refs';
  const lines = [
    '## What',
    what || '',
    '',
    '## Why',
    why || '',
    '',
    '## How to Test',
    howToTest || '',
    '',
    `${linkKeyword} #${issue}`,
  ];

  if (fileCount > FILE_LIMIT) {
    lines.push(
      '',
      `> **Warning:** This phase touches ${fileCount} files. FSTrack recommends ≤${FILE_LIMIT} files per PR.`,
    );
  }

  lines.push('');
  return { body: lines.join('\n'), linkKeyword, fileWarning: fileCount > FILE_LIMIT };
}

const DOD_MANUAL = [
  'Issue approved',
  'TypeScript compiles clean (`tsc`)',
  'CI passes',
  'No secrets committed',
  'Error handling in place',
  'Rollback path documented',
  'Tests added or updated',
  'README updated (if applicable)',
  'Supervisor approval',
];

function summaryBody({ phase, verdicts = [], prLinked = false }) {
  const lines = [markerFor(phase), '', '## Phase Review Summary', '', '| Task | Verdict |', '|------|---------|'];

  for (const { task, verdict } of verdicts) {
    lines.push(`| ${task} | ${verdict} |`);
  }
  lines.push('');

  const actionItems = verdicts.filter(
    ({ verdict }) => verdict === 'FAIL' || verdict === 'BLOCKED',
  );
  if (actionItems.length > 0) {
    lines.push('## Action Required', '');
    for (const { task, verdict } of actionItems) {
      lines.push(`- **${task}**: ${verdict}`);
    }
    lines.push('');
  }

  const hasVerdicts = verdicts.length > 0 && verdicts.every(({ verdict }) => Boolean(verdict));
  lines.push('## Definition of Done (advisory)', '');
  lines.push(`- [${prLinked ? 'x' : ' '}] PR references issue`);
  lines.push(`- [${hasVerdicts ? 'x' : ' '}] Review verdicts recorded`);
  for (const item of DOD_MANUAL) {
    lines.push(`- [ ] ${item}`);
  }
  lines.push('');

  return lines.join('\n');
}

function closeoutBody({ slug, issue, phases }) {
  const lines = [
    `# Closeout — ${slug}`,
    '',
    `- **Issue:** #${issue}`,
    `- **Phases:** ${phases}`,
    '- **Result:** CLOSED — all phases DONE, all reviewable tasks REVIEW_PASS',
    '',
  ];
  return lines.join('\n');
}

module.exports = { issueBody, prBody, summaryBody, closeoutBody, FILE_LIMIT };
