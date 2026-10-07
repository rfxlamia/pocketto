'use strict';

const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

module.exports = {
  REPO_ROOT,
  CORE_CLI: path.join(REPO_ROOT, 'cli/index.js'),
  ENTERPRISE_CLI: path.join(REPO_ROOT, 'enterprise/cli.js'),
  PLAN_ID: 'lifecycle-enterprise-integration',
  FIXED_NOW: '2026-09-19T12:00:00.000Z',
  REPOSITORY: 'acme/pocketto',
  REPOSITORY_URL: 'https://github.com/acme/pocketto',
  ISSUE_NUMBER: 73,
  PR_NUMBER: 84,
  PHASE_PATH: 'execution-plan/phase-1.md',
  ISSUE_MARKER: '<!-- pocket-tasklist -->',
  PHASE_MARKER: '<!-- pocket-phase-1-summary -->',
};
