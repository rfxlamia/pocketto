'use strict';

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

module.exports = { issueBody, prBody, FILE_LIMIT };
