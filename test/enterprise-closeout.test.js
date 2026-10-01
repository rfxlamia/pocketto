'use strict';

// T10 RED cycle 1
// Test file: test/enterprise-closeout.test.js
// Level: integration
// Test intent: Given a valid `plan-closed` event, an owned issue, final plan state, non-null `plan_dir`, and final artifact references, When the handler runs, Then it upserts exactly one `<!-- pocket-tasklist -->` issue comment, records final metadata/proof, writes local `<plan_dir>/closeout.md`, preserves the final plan state/artifact references in the proof, and makes no merge or `gh issue close` call; if the local closeout/ledger write fails after the marker mutation, Then it returns `reconciling` and replay finds the marker before any duplicate mutation.
// Exercise through: `enterprise/closure-handler.js` with fake GitHub transport, real format/tasklist/closeout fixtures, and an injected local-write failure.
// Test doubles: fake `gh` issue/PR runner and filesystem/ledger failure injection; do not mock marker selection or replay lookup.
// Expected RED: current closeout is a skill-level sequence with no event handler, durable proof transaction, or proof-preserving failure path.
// Exact command: `node --test test/enterprise-closeout.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { handlePlanClosed } = require('../enterprise/closure-handler');
const enterpriseMeta = require('../enterprise/meta');
const { TASKLIST_MARKER } = require('../cli/lib/bodies');

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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-closeout-c1-'));
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

function makeFakeGh() {
  const calls = [];
  const comments = [];
  let nextCommentId = 900;
  const runner = (args, options = {}) => {
    calls.push({ args: args.slice(), timeoutMs: options.timeoutMs });
    const joined = args.join(' ');
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ owner: { login: 'acme' }, name: 'pocketto' }), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes(`/issues/${ISSUE_NUMBER}`) && !joined.includes('/comments')) {
      return { exit: 0, stdout: JSON.stringify(ISSUE), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/comments') && args.includes('--paginate')) {
      return { exit: 0, stdout: JSON.stringify([comments.slice(0, 1), comments.slice(1)]), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/comments') && (args.includes('POST') || args.includes('--method=POST'))) {
      const field = args.find((arg) => arg.startsWith('body='));
      const body = field ? field.slice('body='.length) : '';
      comments.push({ id: nextCommentId++, body });
      return { exit: 0, stdout: JSON.stringify(comments.at(-1)), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes('/issues/comments/') && (args.includes('PATCH') || args.includes('--method=PATCH'))) {
      const id = Number(args.find((arg) => /\/issues\/comments\/\d+/.test(arg)).match(/\d+$/)[0]);
      const comment = comments.find((item) => item.id === id);
      const field = args.find((arg) => arg.startsWith('body='));
      if (!comment || !field) return { exit: 1, stdout: '', stderr: 'comment not found' };
      comment.body = field.slice('body='.length);
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

test('CYCLE 1: plan-closed persists canonical tasklist proof and reconciles local write failure', async () => {
  const success = makeFixture();
  const successEvent = makeEvent(success.planDir);
  const successGh = makeFakeGh();
  const result = await handlePlanClosed(successEvent, {
    specDir: success.specDir,
    planDir: success.planDir,
    ghRunner: successGh.runner,
  });

  assert.equal(result.event_id, successEvent.event_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.match(result.proof_hash, /^[0-9a-f]{64}$/);
  assert.equal(successGh.comments.length, 1, 'one canonical tasklist comment must exist');
  assert.ok(successGh.comments[0].body.startsWith(`${TASKLIST_MARKER}\n`));
  assert.match(successGh.comments[0].body, /\*\*Status:\*\* DONE/);
  assert.match(successGh.comments[0].body, /T1/);
  assert.ok(fs.readFileSync(path.join(success.planDir, 'closeout.md'), 'utf8').startsWith('# Closeout — demo-plan\n'));

  const successMeta = enterpriseMeta.readMetaFor(success.specDir);
  assert.equal(successMeta.github_issue.tasklist.event_id, successEvent.event_id);
  assert.equal(successMeta.github_issue.tasklist.marker, TASKLIST_MARKER);
  assert.equal(successMeta.github_issue.tasklist.final_state.status, 'DONE');
  assert.deepEqual(successMeta.github_issue.tasklist.artifact_refs, successEvent.artifact_refs);
  assert.ok(!successGh.calls.some(({ args }) => args.includes('merge') || (args[0] === 'issue' && args[1] === 'close')));

  const retry = makeFixture();
  const retryEvent = makeEvent(retry.planDir);
  const retryGh = makeFakeGh();
  let failLedgerWrite = true;
  const writeMeta = (specDir, metadata) => {
    if (failLedgerWrite) throw new Error('simulated local ledger timeout');
    enterpriseMeta.writeMetaFor(specDir, metadata);
  };
  const first = await handlePlanClosed(retryEvent, {
    specDir: retry.specDir,
    planDir: retry.planDir,
    ghRunner: retryGh.runner,
    writeMeta,
  });
  assert.equal(first.status, 'reconciling', 'remote success plus local ledger failure must remain reconcilable');
  assert.equal(retryGh.comments.length, 1, 'the remote marker is durable before the injected ledger failure');
  assert.equal(fs.existsSync(path.join(retry.planDir, 'closeout.md')), false);

  failLedgerWrite = false;
  const replay = await handlePlanClosed(retryEvent, {
    specDir: retry.specDir,
    planDir: retry.planDir,
    ghRunner: retryGh.runner,
    writeMeta,
  });
  assert.equal(replay.status, 'succeeded');
  assert.equal(retryGh.comments.length, 1, 'replay must update the existing marker, not create a duplicate');
  assert.equal(retryGh.calls.filter(({ args }) => args.includes('POST')).length, 1);
  assert.equal(enterpriseMeta.readMetaFor(retry.specDir).github_issue.tasklist.event_id, retryEvent.event_id);
  assert.equal(fs.existsSync(path.join(retry.planDir, 'closeout.md')), true);
  assert.ok(!retryGh.calls.some(({ args }) => args.includes('merge') || (args[0] === 'issue' && args[1] === 'close')));
});
