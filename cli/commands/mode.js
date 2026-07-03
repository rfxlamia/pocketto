'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('../lib/envelope');
const { FILES, detectMode, locateHeadingSpan, parseConfig, validateInitFields } = require('../lib/mode');
const { getRemoteUrl } = require('../lib/git');

const GITATTRIBUTES = [
  '# Pocket Enterprise — LF-normalized traveling state',
  'log.json text eol=lf',
  'AGENTS.md text eol=lf',
  'CLAUDE.md text eol=lf',
  '*.json text eol=lf',
  'docs/pocket/plans/**/*.md text eol=lf',
  'docs/pocket/spec/**/*.md text eol=lf',
  '',
].join('\n');

function buildEnterpriseBlock({ enterprise, branch_strategy, create_pr, require_approval }) {
  const lines = [`enterprise: ${enterprise}`];
  if (branch_strategy !== null && branch_strategy !== undefined) {
    lines.push(`branch_strategy: ${branch_strategy}`);
  }
  if (create_pr !== null && create_pr !== undefined) {
    lines.push(`create_pr: ${create_pr}`);
  }
  if (require_approval !== null && require_approval !== undefined) {
    lines.push(`require_approval: ${require_approval}`);
  }
  return ['## Pocket Enterprise', '', '```', ...lines, '```', ''].join('\n');
}

function upsertEnterpriseHeading(text, block, source) {
  const normalized = (text || '').replace(/\r\n/g, '\n');
  const blockBody = block.trimEnd();
  const lines = normalized.split('\n');
  const span = locateHeadingSpan(lines, source);

  if (span !== null) {
    const replacedLines = [
      ...lines.slice(0, span.heading),
      ...blockBody.split('\n'),
      ...lines.slice(span.close + 1),
    ];
    const replaced = replacedLines.join('\n');
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }

  if (normalized.trim() === '') return block;
  const prefix = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  return `${prefix}\n${block}`;
}

function checkShadow(dir, targetFile) {
  const idx = FILES.indexOf(targetFile);
  for (let i = idx + 1; i < FILES.length; i++) {
    const other = FILES[i];
    const otherPath = path.join(dir, other);
    if (!fs.existsSync(otherPath)) continue;
    const parsed = parseConfig(fs.readFileSync(otherPath, 'utf8'), other);
    if (parsed) {
      throw new CliError(
        'MODE_FILE_SHADOWED',
        `${other} already defines a ## Pocket Enterprise block and takes precedence over ${targetFile} (mode precedence: ${FILES.join(' > ')}, last wins).`,
        {
          human: `Error: ${other} already has a Pocket Enterprise block and overrides ${targetFile}. Remove/update ${other} first, or run \`mode init --file ${other}\` instead.`,
        },
      );
    }
  }
}

function runInit(targetDir, { enterprise, branchStrategy, createPr, requireApproval, file }) {
  const dir = path.resolve(targetDir || process.cwd());
  const config = validateInitFields({ enterprise, branchStrategy, createPr, requireApproval, file });

  const remoteUrl = getRemoteUrl(dir);
  if (!remoteUrl) {
    throw new CliError(
      'NO_GIT_REMOTE',
      'A git remote is required before enabling Pocket Enterprise.',
      { human: 'Error: No git remote configured. Add a remote (e.g. origin) and retry.' },
    );
  }

  checkShadow(dir, config.file);

  const modePath = path.join(dir, config.file);
  const attrsPath = path.join(dir, '.gitattributes');
  const existing = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8') : '';
  const block = buildEnterpriseBlock({
    enterprise: config.enterprise,
    branch_strategy: config.branch_strategy,
    create_pr: config.create_pr,
    require_approval: config.require_approval,
  });

  fs.writeFileSync(modePath, upsertEnterpriseHeading(existing, block, config.file), 'utf8');
  fs.writeFileSync(attrsPath, GITATTRIBUTES, 'utf8');

  return {
    command: 'mode',
    exit: 0,
    human: [
      'Pocket Enterprise initialized.',
      `Wrote: ${config.file}, .gitattributes`,
      `Remote: ${remoteUrl}`,
    ],
    data: {
      wrote: [config.file, '.gitattributes'],
      enterprise: config.enterprise,
      branch_strategy: config.branch_strategy,
      create_pr: config.create_pr,
      require_approval: config.require_approval,
    },
  };
}

function run({ positionals = [], enterprise = null, branchStrategy = null, createPr = null, requireApproval = null, file = null } = {}) {
  if (positionals[0] === 'init') {
    if (positionals.length > 2) {
      throw new CliError(
        'BAD_USAGE',
        'Usage: pocketto-pi mode init [<dir>] [--enterprise <bool>] [--branch-strategy <strategy>] [--create-pr <bool>] [--require-approval <bool>] [--file <AGENTS.md|CLAUDE.md>]',
      );
    }
    return runInit(positionals[1], { enterprise, branchStrategy, createPr, requireApproval, file });
  }
  if (positionals.length > 1) {
    throw new CliError('BAD_USAGE', 'Usage: pocketto-pi mode [<dir>]');
  }

  const data = detectMode(positionals[0] || process.cwd());
  const human = [
    data.enterprise
      ? `Pocket Enterprise enabled (${data.branch_strategy}, create_pr=${data.create_pr}${data.require_approval ? ', require_approval=true' : ''})`
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
