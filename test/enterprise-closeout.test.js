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

const { handlePlanClosed, selectTasklistComments, hasCanonicalTasklistProof } = require('../enterprise/closure-handler');
const enterpriseMeta = require('../enterprise/meta');
const { TASKLIST_MARKER, tasklistBody, closeoutBody } = require('../cli/lib/bodies');

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

function makeFakeGh(initialComments = [], issueRecord = ISSUE) {
  const calls = [];
  const comments = initialComments.map((comment) => ({ ...comment }));
  let nextCommentId = 900;
  const runner = (args, options = {}) => {
    calls.push({ args: args.slice(), timeoutMs: options.timeoutMs });
    const joined = args.join(' ');
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ owner: { login: 'acme' }, name: 'pocketto' }), stderr: '' };
    }
    if (args[0] === 'api' && joined.includes(`/issues/${ISSUE_NUMBER}`) && !joined.includes('/comments')) {
      return { exit: 0, stdout: JSON.stringify(issueRecord), stderr: '' };
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

  fs.unlinkSync(path.join(success.planDir, 'closeout.md'));
  const closeoutWriteFailure = await handlePlanClosed(successEvent, {
    specDir: success.specDir,
    planDir: success.planDir,
    ghRunner: successGh.runner,
    writeFile: () => { throw new Error('simulated closeout filesystem timeout'); },
  });
  assert.equal(closeoutWriteFailure.status, 'reconciling');
  assert.equal(closeoutWriteFailure.error.code, 'CLOSEOUT_LOCAL_WRITE_FAILED');
  assert.equal(closeoutWriteFailure.proof_ref, result.proof_ref);
  assert.equal(closeoutWriteFailure.proof_hash, result.proof_hash,
    'local closeout failure must preserve the already-committed canonical proof');
  assert.equal(successGh.comments.length, 1, 'local retry must not duplicate the remote marker');

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

// T10 RED cycle 2
// Test file: test/enterprise-closeout.test.js
// Level: integration
// Test intent: Given a tasklist marker was updated before a local ledger timeout, When the same event is drained, Then the handler finds and updates the existing marker without duplication and returns the existing proof.
// Exercise through: closure handler replay with fake paginated issue comments and persisted metadata.
// Test doubles: fake GitHub transport and ledger writer failure; no live GitHub.
// Expected RED: no canonical closure marker replay or reconciling path exists.
// Exact command: `node --test test/enterprise-closeout.test.js`

test('CYCLE 2: paginated marker replay returns proof after a local ledger timeout', async () => {
  const fixture = makeFixture();
  const event = makeEvent(fixture.planDir);
  const canonicalTasklist = tasklistBody(fixture.log);
  const informational = '# Closeout — demo-plan\n\n- **Result:** CLOSED — informational only';
  const gh = makeFakeGh([
    { id: 812, body: canonicalTasklist },
    { id: 813, body: informational },
  ]);
  let failLedgerWrite = true;
  const writeMeta = (specDir, metadata) => {
    if (failLedgerWrite) throw new Error('simulated ledger timeout after marker update');
    enterpriseMeta.writeMetaFor(specDir, metadata);
  };

  const first = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeMeta,
  });
  assert.equal(first.status, 'reconciling');
  assert.equal(first.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.match(first.proof_hash, /^[0-9a-f]{64}$/, 'remote success must retain its proof across the local timeout');

  failLedgerWrite = false;
  const replay = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeMeta,
  });

  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.proof_ref, first.proof_ref);
  assert.equal(replay.proof_hash, first.proof_hash, 'replay must return the original remote proof');
  assert.equal(gh.comments.filter((comment) => comment.body.startsWith(`${TASKLIST_MARKER}\n`)).length, 1);
  assert.equal(gh.comments.find((comment) => comment.id === 813).body, informational);
  assert.equal(gh.calls.filter(({ args }) => args.includes('POST')).length, 0,
    'replay must update the existing marker rather than creating a duplicate');
  assert.equal(gh.calls.filter(({ args }) => args.includes('PATCH')).length, 2);
  assert.equal(gh.calls.filter(({ args }) => args.includes('--paginate') && args.includes('--slurp')).length, 2,
    'each attempt must inspect all issue-comment pages before mutation');
  const persisted = enterpriseMeta.readMetaFor(fixture.specDir).github_issue.tasklist;
  assert.equal(persisted.event_id, event.event_id);
  assert.equal(persisted.proof_hash, replay.proof_hash);
});

// T10 RED cycle 3
// Test file: test/enterprise-closeout.test.js
// Level: integration
// Test intent: Given the issue is absent, foreign, closed, or ownership is ambiguous, When `plan-closed` runs, Then it returns `ISSUE_REQUIRED` or terminal manual resolution, writes no tasklist/closeout remote mutation, and leaves local state safe.
// Exercise through: closure handler issue lookup boundary.
// Test doubles: fake paginated issue comments/metadata; no live GitHub.
// Expected RED: no closure issue prerequisite or no-mutation failure path exists.
// Exact command: `node --test test/enterprise-closeout.test.js`

test('CYCLE 3: missing, foreign, closed, or ambiguous issue ownership fails without mutation', async () => {
  const cases = [
    {
      name: 'missing issue metadata',
      prepare: (fixture) => {
        const metadata = enterpriseMeta.readMetaFor(fixture.specDir);
        metadata.github_issue = {};
        enterpriseMeta.writeMetaFor(fixture.specDir, metadata);
      },
      issue: ISSUE,
      expectedCode: 'ISSUE_REQUIRED',
    },
    {
      name: 'foreign metadata URL',
      prepare: (fixture) => {
        const metadata = enterpriseMeta.readMetaFor(fixture.specDir);
        metadata.github_issue.url = 'https://github.com/foreign/repo/issues/73';
        enterpriseMeta.writeMetaFor(fixture.specDir, metadata);
      },
      issue: ISSUE,
      expectedCode: 'ISSUE_OWNERSHIP_AMBIGUOUS',
    },
    {
      name: 'closed issue',
      prepare: () => {},
      issue: { ...ISSUE, state: 'closed' },
      expectedCode: 'ISSUE_CLOSED',
    },
    {
      name: 'issue response points to a foreign repository',
      prepare: () => {},
      issue: {
        number: ISSUE_NUMBER,
        state: 'open',
        title: `pocket-plan: ${PLAN_ID}`,
        body: `docs/pocket/spec/${PLAN_ID}/core.md`,
        html_url: 'https://github.com/foreign/repo/issues/73',
      },
      expectedCode: 'ISSUE_OWNERSHIP_AMBIGUOUS',
    },
  ];

  for (const scenario of cases) {
    const fixture = makeFixture();
    scenario.prepare(fixture);
    const event = makeEvent(fixture.planDir);
    const metadataPath = path.join(fixture.specDir, '.pocket-meta.json');
    const beforeMetadata = fs.readFileSync(metadataPath, 'utf8');
    const gh = makeFakeGh([], scenario.issue);
    const result = await handlePlanClosed(event, {
      specDir: fixture.specDir,
      planDir: fixture.planDir,
      ghRunner: gh.runner,
    });

    assert.equal(result.status, 'terminal', `${scenario.name} must require safe manual resolution`);
    assert.equal(result.error.code, scenario.expectedCode, `${scenario.name} must return a stable prerequisite code`);
    assert.equal(gh.comments.length, 0, `${scenario.name}: no remote marker may be written`);
    assert.equal(gh.calls.filter(({ args }) => ['POST', 'PATCH', 'DELETE'].some((method) => args.includes(method))).length, 0,
      `${scenario.name}: no GitHub mutation may run`);
    assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), false,
      `${scenario.name}: no local closeout may be written`);
    assert.equal(fs.readFileSync(metadataPath, 'utf8'), beforeMetadata,
      `${scenario.name}: ownership failure must leave local metadata unchanged`);
  }
});

// T10 RED cycle 4
// Test file: test/enterprise-closeout.test.js
// Level: unit
// Test intent: Given two closeout bodies with the same plan but different informational wording, When closure proof is evaluated, Then only the tasklist marker and metadata determine idempotency; the unmarked closeout comment cannot cause a duplicate-proof decision.
// Exercise through: closure proof helper and marker selector.
// Test doubles: none; use pure body/marker inputs.
// Expected RED: no helper distinguishes canonical tasklist proof from informational closeout content.
// Exact command: `node --test test/enterprise-closeout.test.js`

test('CYCLE 4: only a selected tasklist marker plus matching metadata proves closure', () => {
  const event = { event_id: `${PLAN_ID}:plan-closed:r9` };
  const metadata = {
    github_issue: {
      tasklist: {
        event_id: event.event_id,
        marker: TASKLIST_MARKER,
        comment_id: 99,
        proof_ref: 'meta:github_issue|marker:issue-tasklist',
        proof_hash: 'c'.repeat(64),
      },
    },
  };
  const closeoutA = `${closeoutBody({ slug: PLAN_ID, issue: ISSUE_NUMBER, phases: 1 })}\nNote: informational wording A`;
  const closeoutB = `${closeoutBody({ slug: PLAN_ID, issue: ISSUE_NUMBER, phases: 1 })}\nNote: informational wording B`;
  const unmarkedA = selectTasklistComments([
    { id: 1, body: closeoutA },
    { id: 2, body: closeoutB },
  ]);
  const unmarkedB = selectTasklistComments([
    { id: 1, body: closeoutB },
    { id: 2, body: closeoutA },
  ]);

  assert.deepEqual(unmarkedA, []);
  assert.deepEqual(unmarkedB, []);
  assert.equal(hasCanonicalTasklistProof({ event, marker: null, metadata }), false,
    'informational closeout text cannot establish canonical proof');
  assert.equal(hasCanonicalTasklistProof({ event, marker: TASKLIST_MARKER, metadata }), true,
    'the tasklist marker and matching metadata establish the proof');
  const selected = selectTasklistComments([
    { id: 1, body: closeoutA },
    { id: 99, body: `${TASKLIST_MARKER}\nfinal tasklist` },
    { id: 2, body: closeoutB },
  ]);
  assert.deepEqual(selected.map((comment) => comment.id), [99]);
  assert.equal(hasCanonicalTasklistProof({ event, marker: TASKLIST_MARKER, metadata }), true,
    'changing unmarked closeout wording cannot alter marker identity');
});
