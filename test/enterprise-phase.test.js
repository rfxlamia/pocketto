'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../enterprise/meta');
const identity = require('../cli/lib/identity');
const { summaryBody } = require('../cli/lib/bodies');

const FIXED_CLOCK = '2026-09-19T12:00:00.000Z';
const ISSUE_NUMBER = 31;
const PR_NUMBER = 42;
const OWNER = 'pocketto-test';
const REPOSITORY = 'phase-fixtures';
const BRANCH = 'feature/demo-plan';

// Keep the five behavioral RED cycles verbatim and in source order.
//
// RED cycle 1
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given phase evidence, a valid open PR identified by metadata or exact branch/phase search, and new findings, When the handler runs, Then it updates or creates exactly one `pocket-phase-<N>-summary` marker, reconciles inline findings by the shared fingerprint algorithm, and persists fingerprints at `phases.<phase>.review.fingerprints`.
// Exercise through: `enterprise/phase-handler.js` with fake paginated comments/review-thread APIs and real metadata.
// Test doubles: fake `gh` transport and fixed clock; do not mock marker selection or fingerprint computation.
// Expected RED: current reporting is manual skill prose and no v4 handler owns the complete PR reconciliation transaction.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 1: phase-complete upserts one marker and canonical fingerprints', (t) => {
  const fixture = createFixture(t);
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function',
    'Expected enterprise/phase-handler.js to own the complete v4 PR reconciliation transaction');

  const response = handler.handlePhaseComplete(fixture.event, {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  });

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(response.event_id, fixture.event.event_id);

  const marker = identity.markerFor('1');
  const markerComments = allComments(fixture.remote).filter((comment) => comment.body.startsWith(marker));
  assert.equal(markerComments.length, 1, 'exactly one canonical phase marker must remain');
  assert.equal(markerComments[0].body, summaryBody({
    phase: 1,
    verdicts: [{ task: 'T1', verdict: 'FAIL' }],
    prLinked: true,
  }));

  const expectedFingerprint = identity.fingerprint({
    file: 'src/worker.js',
    ruleId: 'stage-1:spec-compliance',
    message: 'Missing error handling for invalid input',
    occurrence: 0,
  });
  const threads = allThreads(fixture.remote);
  assert.equal(threads.length, 1, 'one new inline finding thread must be posted');
  assert.match(threads[0].comments.nodes[0].body, new RegExp(`<!-- pocket-fp:${expectedFingerprint} -->`));
  assert.deepEqual(enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'].review.fingerprints, [
    { fingerprint: expectedFingerprint, thread: threads[0].id },
  ]);
  assert.ok(fixture.remote.calls.some((args) => args.includes('--paginate')),
    'PR comments must be fetched through the paginated API');
});

function loadPhaseHandler() {
  try {
    return require('../enterprise/phase-handler');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('enterprise/phase-handler')) {
      return null;
    }
    throw error;
  }
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planId = 'demo-plan';
  const specDir = path.join(root, 'docs', 'pocket', 'spec', planId);
  const planDir = path.join(root, 'docs', 'pocket', 'plans', planId);
  const phasePath = 'execution-plan/phase-1.md';
  const phaseText = '# Phase 1\n\nContains tasks: T1\n';
  fs.mkdirSync(path.join(planDir, 'execution-plan'), { recursive: true });
  fs.mkdirSync(path.join(planDir, 'reviews'), { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, phasePath), phaseText);
  fs.writeFileSync(path.join(planDir, 'log.json'), JSON.stringify({
    header: { plan_dir: planDir, status: 'IN_PROGRESS' },
    phases: [{
      file: phasePath,
      status: 'REVIEW',
      tasks: [{ id: 'T1', name: 'Validate input handling', status: 'DONE' }],
    }],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(planDir, 'reviews', 'T1-review.json'), JSON.stringify({
    task_id: 'T1',
    overall: 'REVIEW_FAIL',
    stage_1: {
      issues: [{
        type: 'spec-compliance',
        location: 'src/worker.js:18',
        description: 'Missing error handling for invalid input',
      }],
    },
    stage_2: { issues: [] },
  }, null, 2) + '\n');

  const event = {
    event_id: `${planId}:phase-complete:r1`,
    plan_id: planId,
    type: 'phase-complete',
    revision: 1,
    occurred_at: FIXED_CLOCK,
    artifact_refs: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: phasePath,
      sha256: crypto.createHash('sha256').update(phaseText).digest('hex'),
      revision: 1,
    }],
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 1 },
  };
  fs.writeFileSync(path.join(specDir, 'lifecycle.json'), JSON.stringify({
    schema: 1,
    plan: {
      plan_id: planId,
      spec_dir: specDir,
      plan_dir: planDir,
      branch: BRANCH,
      state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'IN_PROGRESS' },
      revision: 1,
    },
    events: [event],
  }, null, 2) + '\n');
  enterpriseMeta.setIssueIdentity(specDir, {
    number: ISSUE_NUMBER,
    url: `https://github.com/${OWNER}/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
  });
  enterpriseMeta.setPrIdentity(specDir, 'phase-1', {
    number: PR_NUMBER,
    url: `https://github.com/${OWNER}/${REPOSITORY}/pull/${PR_NUMBER}`,
  });

  return {
    root,
    specDir,
    planDir,
    event,
    remote: {
      owner: OWNER,
      repository: REPOSITORY,
      issue: {
        number: ISSUE_NUMBER,
        url: `https://github.com/${OWNER}/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
        state: 'OPEN',
        title: `[pocket-plan] ${planId}`,
        body: `Plan identity: docs/pocket/spec/${planId}/core.md`,
      },
      prs: [{
        number: PR_NUMBER,
        url: `https://github.com/${OWNER}/${REPOSITORY}/pull/${PR_NUMBER}`,
        state: 'OPEN',
        headRefName: BRANCH,
        baseRefName: 'main',
        headRefOid: 'abc123def456',
        title: `Phase 1: ${planId}`,
        body: `Implements ${planId}`,
      }],
      issueSearch: [],
      commentPages: [[], []],
      comments: [],
      threadPages: [[], []],
      threads: [],
      calls: [],
      nextCommentId: 1,
      nextThreadId: 1,
    },
  };
}

function fakeGh(remote) {
  return (args) => {
    remote.calls.push(args.slice());
    const json = (value) => ({ exit: 0, stdout: JSON.stringify(value), stderr: '' });
    const failure = (message) => ({ exit: 1, stdout: '', stderr: message });
    const valueFor = (flag) => {
      const index = args.indexOf(flag);
      return index < 0 ? null : args[index + 1];
    };
    const fieldFor = (name) => {
      const entry = args.find((arg) => arg.startsWith(`-f ${name}=`) || arg.startsWith(`-F ${name}=`));
      if (entry) return entry.slice(entry.indexOf('=') + 1);
      for (let index = 0; index < args.length - 1; index += 1) {
        if ((args[index] === '-f' || args[index] === '-F') && args[index + 1].startsWith(`${name}=`)) {
          return args[index + 1].slice(name.length + 1);
        }
      }
      return null;
    };

    if (args[0] === 'repo' && args[1] === 'view') {
      return json({ owner: { login: remote.owner }, name: remote.repository, nameWithOwner: `${remote.owner}/${remote.repository}` });
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      const issue = remote.issue && remote.issue.number === Number(args[2]) ? remote.issue : null;
      return issue ? json(issue) : failure('issue not found');
    }
    if (args[0] === 'issue' && args[1] === 'list') return json(remote.issueSearch);
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = remote.prs.find((candidate) => candidate.number === Number(args[2]));
      return pr ? json(pr) : failure('pull request not found');
    }
    if (args[0] === 'pr' && args[1] === 'list') return json(remote.prs);
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = fieldFor('query') || '';
      if (query.includes('resolveReviewThread')) {
        const threadId = fieldFor('threadId');
        const thread = allThreads(remote).find((candidate) => candidate.id === threadId);
        if (!thread) return failure('review thread not found');
        thread.isResolved = true;
        return json({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }
      if (query.includes('reviewThreads')) return json(threadPage(remote, fieldFor('after')));
      return failure('unexpected GraphQL operation');
    }
    if (args[0] === 'api' && typeof args[1] === 'string') {
      const endpoint = args[1];
      const method = (valueFor('--method') || (fieldFor('body') === null ? 'GET' : 'POST')).toUpperCase();
      const issueComments = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
      const issueComment = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
      const pullComments = endpoint.match(/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/);
      if (issueComments && method === 'GET') return json(allComments(remote));
      if (issueComments && method === 'POST') {
        const comment = { id: remote.nextCommentId++, body: fieldFor('body') || '' };
        remote.comments.push(comment);
        return json(comment);
      }
      if (issueComment && method === 'PATCH') {
        const comment = findComment(remote, Number(issueComment[1]));
        if (!comment) return failure('comment not found');
        comment.body = fieldFor('body') || '';
        return json(comment);
      }
      if (issueComment && method === 'DELETE') {
        removeComment(remote, Number(issueComment[1]));
        return json({});
      }
      if (pullComments && method === 'POST') {
        const body = fieldFor('body') || '';
        const thread = {
          id: `PRRT_${remote.nextThreadId++}`,
          isResolved: false,
          comments: { nodes: [{
            body,
            path: fieldFor('path'),
            line: Number(fieldFor('line')),
            side: fieldFor('side'),
          }] },
        };
        remote.threads.push(thread);
        return json({ id: remote.nextThreadId, body });
      }
    }
    return failure(`unexpected fake gh command: ${args.join(' ')}`);
  };
}

function allComments(remote) {
  return [...remote.commentPages.flat(), ...remote.comments].sort((left, right) => left.id - right.id);
}

function findComment(remote, id) {
  return allComments(remote).find((comment) => comment.id === id) || null;
}

function removeComment(remote, id) {
  for (const page of remote.commentPages) {
    const index = page.findIndex((comment) => comment.id === id);
    if (index >= 0) page.splice(index, 1);
  }
  const index = remote.comments.findIndex((comment) => comment.id === id);
  if (index >= 0) remote.comments.splice(index, 1);
}

function allThreads(remote) {
  return [...remote.threadPages.flat(), ...remote.threads];
}

function threadPage(remote, after) {
  const pageIndex = after && after !== 'null' ? Number(String(after).replace(/^cursor-/, '')) : 0;
  const pages = remote.threadPages.map((page) => page.slice());
  pages[pages.length - 1].push(...remote.threads);
  const nodes = pages[pageIndex] || [];
  const hasNextPage = pageIndex + 1 < pages.length;
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes,
            pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${pageIndex + 1}` : null },
          },
        },
      },
    },
  };
}
