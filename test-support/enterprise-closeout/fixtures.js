'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const enterpriseMeta = require('../../enterprise/meta');

const PLAN_ID = 'demo-plan';
const ISSUE_NUMBER = 73;
const REPO = 'acme/pocketto';
const ISSUE_URL = `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`;
const ISSUE = {
  number: ISSUE_NUMBER,
  state: 'open',
  title: `pocket-plan: ${PLAN_ID}`,
  body: `Full spec: docs/pocket/spec/${PLAN_ID}/core.md`,
  html_url: ISSUE_URL,
  repository: { full_name: REPO },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-closeout-c1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'spec', PLAN_ID);
  const planDir = path.join(root, 'plans', PLAN_ID);
  fs.mkdirSync(specDir, { recursive: true });
  fs.mkdirSync(planDir, { recursive: true });
  const log = {
    header: {
      plan_dir: 'docs/pocket/plans/demo-plan',
      plan_type: 'phased',
      status: 'DONE',
      date_started: '2026-09-19',
      date_completed: '2026-09-20',
    },
    phases: [{
      order: 1,
      file: 'execution-plan/phase-1.md',
      status: 'DONE',
      tasks: [{ id: 'T1', name: 'Closeout proof', status: 'DONE', done_sha: '1234567890abcdef' }],
    }],
  };
  const logText = `${JSON.stringify(log, null, 2)}\n`;
  fs.writeFileSync(path.join(planDir, 'log.json'), logText, 'utf8');
  fs.writeFileSync(path.join(planDir, 'execution-plan.md'), '# Final plan\n', 'utf8');
  enterpriseMeta.setIssueIdentity(specDir, { number: ISSUE_NUMBER, url: ISSUE_URL });
  return { specDir, planDir, log };
}

function makeEvent(planDir) {
  const artifacts = [
    ['log', 'log.json'],
    ['execution-plan', 'execution-plan.md'],
  ].map(([kind, relativePath]) => ({
    root: 'plan',
    kind,
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(planDir, relativePath))),
    revision: 9,
  }));
  return {
    event_id: `${PLAN_ID}:plan-closed:r9`,
    plan_id: PLAN_ID,
    type: 'plan-closed',
    revision: 9,
    occurred_at: '2026-09-20T12:00:00.000Z',
    artifact_refs: artifacts,
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  };
}

function bodyFromArgs(args) {
  const field = args.find((arg) => arg.startsWith('body=') || arg.startsWith('body=@'));
  if (!field) return null;
  const value = field.slice('body='.length);
  if (field.startsWith('body=@')) return fs.readFileSync(value.slice(1), 'utf8');
  return value;
}

function makeFakeGh(initialComments = [], issueRecord = ISSUE) {
  const calls = [];
  const comments = initialComments.map((comment) => ({ ...comment }));
  let nextCommentId = 900;
  const runner = (args, options = {}) => {
    calls.push({ args: args.slice(), timeoutMs: options.timeoutMs });
    const joined = args.join(' ');
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPO, url: `https://github.com/${REPO}` }), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes(`/issues/${ISSUE_NUMBER}`) && !joined.includes('/comments')) {
      return { exit: 0, stdout: JSON.stringify(issueRecord), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/comments') && args.includes('--paginate')) {
      return { exit: 0, stdout: JSON.stringify([comments.slice(0, 1), comments.slice(1)]), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/comments') && (args.includes('POST') || args.includes('--method=POST'))) {
      const body = bodyFromArgs(args);
      comments.push({ id: nextCommentId++, body });
      return { exit: 0, stdout: JSON.stringify(comments.at(-1)), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/issues/comments/') && (args.includes('PATCH') || args.includes('--method=PATCH'))) {
      const id = Number(args.find((arg) => /\/issues\/comments\/\d+/.test(arg)).match(/\d+$/)[0]);
      const comment = comments.find((item) => item.id === id);
      const body = bodyFromArgs(args);
      if (!comment || body === null) return { exit: 1, stdout: '', stderr: 'comment not found' };
      comment.body = body;
      return { exit: 0, stdout: JSON.stringify(comment), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/issues/comments/') && (args.includes('DELETE') || args.includes('--method=DELETE'))) {
      const id = Number(args.find((arg) => /\/issues\/comments\/\d+/.test(arg)).match(/\d+$/)[0]);
      const index = comments.findIndex((item) => item.id === id);
      if (index >= 0) comments.splice(index, 1);
      return { exit: 0, stdout: '', stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `unexpected fake gh invocation: ${joined}` };
  };
  return { runner, calls, comments };
}

module.exports = {
  fs,
  path,
  enterpriseMeta,
  PLAN_ID,
  ISSUE_NUMBER,
  ISSUE,
  makeFixture,
  makeEvent,
  makeFakeGh,
};
