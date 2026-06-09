'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('../lib/envelope');
const { detectMode, validateInitFields } = require('../lib/mode');
const { getRemoteUrl } = require('../lib/git');

const GITATTRIBUTES = [
  '# Pocket Enterprise — LF-normalized traveling state',
  'log.json text eol=lf',
  'AGENTS.md text eol=lf',
  '*.json text eol=lf',
  'docs/pocket/plans/**/*.md text eol=lf',
  'docs/pocket/spec/**/*.md text eol=lf',
  '',
].join('\n');

function buildEnterpriseBlock({ enterprise, branch_strategy, create_pr }) {
  const lines = [`enterprise: ${enterprise}`];
  if (branch_strategy !== null && branch_strategy !== undefined) {
    lines.push(`branch_strategy: ${branch_strategy}`);
  }
  if (create_pr !== null && create_pr !== undefined) {
    lines.push(`create_pr: ${create_pr}`);
  }
  return ['## Pocket Enterprise', '', '```', ...lines, '```', ''].join('\n');
}

function upsertEnterpriseHeading(text, block) {
  const normalized = (text || '').replace(/\r\n/g, '\n');
  const heading = '## Pocket Enterprise';
  const blockBody = block.trimEnd();

  if (normalized.includes(heading)) {
    const replaced = normalized
      .replace(/\n## Pocket Enterprise\n\n```[\s\S]*?```\n?/, `\n${blockBody}\n`)
      .replace(/^## Pocket Enterprise\n\n```[\s\S]*?```\n?/, `${blockBody}\n`);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }

  if (normalized.trim() === '') return block;
  const prefix = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  return `${prefix}\n${block}`;
}

function runInit(targetDir, { enterprise, branchStrategy, createPr }) {
  const dir = path.resolve(targetDir || process.cwd());
  const config = validateInitFields({ enterprise, branchStrategy, createPr });

  const remoteUrl = getRemoteUrl(dir);
  if (!remoteUrl) {
    throw new CliError(
      'NO_GIT_REMOTE',
      'A git remote is required before enabling Pocket Enterprise.',
      { human: 'Error: No git remote configured. Add a remote (e.g. origin) and retry.' },
    );
  }

  const agentsPath = path.join(dir, 'AGENTS.md');
  const attrsPath = path.join(dir, '.gitattributes');
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const block = buildEnterpriseBlock({
    enterprise: config.enterprise,
    branch_strategy: config.branch_strategy,
    create_pr: config.create_pr,
  });

  fs.writeFileSync(agentsPath, upsertEnterpriseHeading(existing, block), 'utf8');
  fs.writeFileSync(attrsPath, GITATTRIBUTES, 'utf8');

  return {
    command: 'mode',
    exit: 0,
    human: [
      'Pocket Enterprise initialized.',
      `Wrote: AGENTS.md, .gitattributes`,
      `Remote: ${remoteUrl}`,
    ],
    data: {
      wrote: ['AGENTS.md', '.gitattributes'],
      enterprise: config.enterprise,
      branch_strategy: config.branch_strategy,
      create_pr: config.create_pr,
    },
  };
}

function run({ positionals = [], enterprise = null, branchStrategy = null, createPr = null } = {}) {
  if (positionals[0] === 'init') {
    if (positionals.length > 2) {
      throw new CliError(
        'BAD_USAGE',
        'Usage: pocketto-pi mode init [<dir>] [--enterprise <bool>] [--branch-strategy <strategy>] [--create-pr <bool>]',
      );
    }
    return runInit(positionals[1], { enterprise, branchStrategy, createPr });
  }
  if (positionals.length > 1) {
    throw new CliError('BAD_USAGE', 'Usage: pocketto-pi mode [<dir>]');
  }

  const data = detectMode(positionals[0] || process.cwd());
  const human = [
    data.enterprise
      ? `Pocket Enterprise enabled (${data.branch_strategy}, create_pr=${data.create_pr})`
      : 'Pocket Enterprise disabled',
  ];
  if (data.source) human.push(`Source: ${data.source}`);

  return {
    command: 'mode',
    exit: 0,
    human,
    data,
  };
}

module.exports = { run };
