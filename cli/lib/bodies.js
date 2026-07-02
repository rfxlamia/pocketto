'use strict';

const { markerFor } = require('./identity');

function bulletList(items) {
  if (!items || items.length === 0) return '';
  return items.map((item) => `- ${item}`).join('\n');
}

// Field aliases: `konteks`, `rencanaTeknis`, and `diLuarScope` are the
// pre-2.5 input names — accepted so older skills keep working on contract 2.
function issueBody(input) {
  const {
    title,
    context = input.konteks,
    technicalApproach = input.rencanaTeknis,
    acceptanceCriteria,
    outOfScope = input.diLuarScope,
    specMarkdown,
  } = input;
  const lines = [
    `# ${title}`,
    '',
    '## Context',
    context || '',
    '',
    '## Technical Approach',
    technicalApproach || '',
    '',
    '## Acceptance Criteria',
    bulletList(acceptanceCriteria),
    '',
    '## Out of Scope',
    bulletList(outOfScope),
    '',
  ];
  if (specMarkdown) {
    lines.push(
      '<details>',
      '<summary>Full specification</summary>',
      '',
      String(specMarkdown).trimEnd(),
      '',
      '</details>',
      '',
    );
  }
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
      `> **Warning:** This phase touches ${fileCount} files. Keep PRs at ≤${FILE_LIMIT} files.`,
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

const TASKLIST_MARKER = '<!-- pocket-tasklist -->';

// Renders the live task checklist for the linked GitHub issue from a parsed
// log.json. Upserted as a single marker-tagged comment (one per issue).
function tasklistBody(log) {
  const header = log.header || {};
  const lines = [
    TASKLIST_MARKER,
    '',
    '## Task Progress',
    '',
    `- **Plan:** \`${header.plan_dir || 'unknown'}\``,
    `- **Status:** ${header.status || 'unknown'}`,
    '',
  ];

  for (const phase of log.phases || []) {
    lines.push(`### ${phase.file} — ${phase.status}`, '');
    const tasks = phase.tasks || [];
    if (tasks.length === 0) {
      lines.push('_No tasks recorded for this phase._', '');
      continue;
    }
    lines.push('| Task | Name | Status | SHA |', '|------|------|--------|-----|');
    for (const t of tasks) {
      const box = t.status === 'DONE' ? '✅' : t.status === 'BLOCKED' ? '🚫' : '⬜';
      const sha = t.done_sha ? `\`${String(t.done_sha).slice(0, 7)}\`` : '—';
      lines.push(`| ${box} ${t.id} | ${t.name} | ${t.status} | ${sha} |`);
    }
    lines.push('');
    const corrections = phase.corrections || [];
    if (corrections.length) {
      lines.push(
        `Corrections: ${corrections.map((c) => `\`${String(c.sha).slice(0, 7)}\`${c.for_task ? ` (${c.for_task})` : ''}`).join(', ')}`,
        '',
      );
    }
  }

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

module.exports = { issueBody, prBody, summaryBody, closeoutBody, tasklistBody, TASKLIST_MARKER, FILE_LIMIT };
