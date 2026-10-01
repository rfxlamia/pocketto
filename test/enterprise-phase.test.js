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

// RED cycle 2
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given a valid phase-complete event and PR but no owned issue for the plan, When the handler runs, Then it returns `ISSUE_REQUIRED`, writes no PR comment or metadata proof, and performs no issue creation or other remote mutation.
// Exercise through: the full phase handler using fake issue/PR responses.
// Test doubles: fake `gh issue`/`gh pr` transport; no real network.
// Expected RED: no phase handler enforces the normative existing-issue requirement.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 2: missing owned issue blocks phase reporting without mutation', (t) => {
  const fixture = createFixture(t);
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.github_issue;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.remote.issue = null;
  fixture.remote.issueSearch = [];
  const metaPath = path.join(fixture.specDir, '.pocket-meta.json');
  const beforeMeta = fs.readFileSync(metaPath, 'utf8');
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');

  const response = handler.handlePhaseComplete(fixture.event, {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  });

  assert.equal(response.error && response.error.code, 'ISSUE_REQUIRED', JSON.stringify(response));
  assert.equal(allComments(fixture.remote).length, 0, 'missing issue must not write a PR comment');
  assert.equal(allThreads(fixture.remote).length, 0, 'missing issue must not write review threads');
  assert.equal(fixture.remote.calls.filter(isRemoteMutation).length, 0, 'missing issue must perform no remote mutation');
  assert.equal(fs.readFileSync(metaPath, 'utf8'), beforeMeta, 'missing issue must not write metadata proof');
});

// RED cycle 3
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given positive PR metadata pointing to the wrong origin, closed state, wrong branch, or wrong phase, When metadata-first validation runs, Then the handler rejects it and safely falls back to exact branch/phase search/manual resolution; given missing metadata and zero branch matches, multiple matches, foreign/closed/wrong-branch/wrong-phase PR, or a missing required PR, Then it returns `PR_REQUIRED` or terminal manual resolution, creates no PR, writes no comments/metadata, and preserves the event for retry/manual action.
// Exercise through: the full phase handler using fake repository/PR responses.
// Test doubles: fake `gh pr list/view` and comment APIs; no real network.
// Expected RED: no adapter handler enforces metadata validation, safe fallback, or the no-auto-create-PR rule.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 3: metadata validation falls back safely and ambiguous PRs stay untouched', async (t) => {
  const invalidMetadataCases = [
    ['wrong origin', (pr) => { pr.url = 'https://github.com/foreign/repo/pull/51'; }],
    ['closed state', (pr) => { pr.state = 'CLOSED'; }],
    ['wrong branch', (pr) => { pr.headRefName = 'feature/another-plan'; }],
    ['wrong phase', (pr) => addPhaseMarker(pr, 2, 11)],
  ];
  for (const [name, invalidate] of invalidMetadataCases) {
    await t.test(`invalid metadata with ${name} falls back to the exact open PR`, (t) => {
      const fixture = createFixture(t);
      const invalid = makePr(51);
      invalidate(invalid);
      if (name !== 'wrong phase') addPhaseMarker(invalid, 1, 10);
      const valid = makePr(52);
      addPhaseMarker(valid, 1, 20);
      fixture.remote.prs = [invalid, valid];
      enterpriseMeta.setPrIdentity(fixture.specDir, 'phase-1', { number: invalid.number, url: invalid.url });
      const invalidCommentBefore = JSON.stringify(allComments(fixture.remote, invalid.number));
      const handler = loadPhaseHandler();
      assert.ok(handler && typeof handler.handlePhaseComplete === 'function');

      const response = handler.handlePhaseComplete(fixture.event, {
        projectRoot: fixture.root,
        ghRunner: fakeGh(fixture.remote),
        now: () => new Date(FIXED_CLOCK),
      });

      assert.equal(response.status, 'succeeded', JSON.stringify(response));
      assert.deepEqual(enterpriseMeta.getPrIdentity(fixture.specDir, 'phase-1'), {
        number: valid.number,
        url: valid.url,
      });
      assert.equal(JSON.stringify(allComments(fixture.remote, invalid.number)), invalidCommentBefore,
        'invalid metadata PR must never be mutated');
      assert.equal(allComments(fixture.remote, valid.number).filter((comment) => comment.body.startsWith(identity.markerFor('1'))).length, 1);
      assert.equal(allThreads(fixture.remote, invalid.number).length, 0, 'inline mutations must avoid the invalid PR');
      assert.equal(allThreads(fixture.remote, valid.number).length, 1, 'inline mutations must target the exact branch/phase PR');
    });
  }

  await t.test('missing metadata finds one exact branch/phase PR', (t) => {
    const fixture = createFixture(t);
    addPhaseMarker(fixture.remote.prs[0], 1, 30);
    const meta = enterpriseMeta.readMetaFor(fixture.specDir);
    delete meta.phases['phase-1'].github_pr;
    enterpriseMeta.writeMetaFor(fixture.specDir, meta);
    const handler = loadPhaseHandler();

    const response = handler.handlePhaseComplete(fixture.event, {
      projectRoot: fixture.root,
      ghRunner: fakeGh(fixture.remote),
      now: () => new Date(FIXED_CLOCK),
    });

    assert.equal(response.status, 'succeeded', JSON.stringify(response));
    assert.deepEqual(enterpriseMeta.getPrIdentity(fixture.specDir, 'phase-1'), {
      number: PR_NUMBER,
      url: `https://github.com/${OWNER}/${REPOSITORY}/pull/${PR_NUMBER}`,
    });
    assert.ok(!fixture.remote.calls.some((args) => args[0] === 'pr' && args[1] === 'create'));
  });

  const searchCases = [
    ['zero branch matches', []],
    ['multiple matches', [makePr(61), makePr(62)]],
    ['foreign PR', [makePr(63)]],
    ['closed PR', [makePr(64)]],
    ['wrong-branch PR', [makePr(65)]],
    ['wrong-phase PR', [makePr(66)]],
  ];
  for (const [name, prs] of searchCases) {
    await t.test(`missing metadata with ${name} does not mutate`, (t) => {
      const fixture = createFixture(t);
      fixture.remote.prs = prs;
      for (const pr of prs) addPhaseMarker(pr, 1, pr.number);
      if (name === 'foreign PR') prs[0].url = 'https://github.com/foreign/repo/pull/63';
      if (name === 'closed PR') prs[0].state = 'CLOSED';
      if (name === 'wrong-branch PR') prs[0].headRefName = 'feature/another-plan';
      if (name === 'wrong-phase PR') {
        prs[0].commentPages[1] = [];
        addPhaseMarker(prs[0], 2, 66);
      }
      if (name === 'multiple matches') addPhaseMarker(prs[1], 1, 67);
      const meta = enterpriseMeta.readMetaFor(fixture.specDir);
      delete meta.phases['phase-1'].github_pr;
      enterpriseMeta.writeMetaFor(fixture.specDir, meta);
      const metaPath = path.join(fixture.specDir, '.pocket-meta.json');
      const beforeMeta = fs.readFileSync(metaPath, 'utf8');
      const beforeEvent = JSON.stringify(fixture.event);
      const beforeComments = JSON.stringify(prs.map((pr) => allComments(fixture.remote, pr.number)));
      const handler = loadPhaseHandler();

      const response = handler.handlePhaseComplete(fixture.event, {
        projectRoot: fixture.root,
        ghRunner: fakeGh(fixture.remote),
        now: () => new Date(FIXED_CLOCK),
      });

      assert.ok(response.error && (response.error.code === 'PR_REQUIRED' || response.status === 'terminal'), JSON.stringify(response));
      assert.equal(fixture.remote.calls.filter(isRemoteMutation).length, 0);
      assert.ok(!fixture.remote.calls.some((args) => args[0] === 'pr' && args[1] === 'create'), 'the adapter must never create a PR');
      assert.equal(fs.readFileSync(metaPath, 'utf8'), beforeMeta, 'failed lookup must not write metadata proof');
      assert.equal(JSON.stringify(fixture.event), beforeEvent, 'failed lookup must preserve the event for retry/manual action');
      assert.equal(JSON.stringify(prs.map((pr) => allComments(fixture.remote, pr.number))), beforeComments);
    });
  }
});

// RED cycle 4
// Test file: `test/enterprise-phase.test.js`
// Level: integration
// Test intent: Given prior fingerprints only at `phases.<phase>.fingerprints`, When phase-complete reconciles findings, Then it reads that legacy path once for compatibility, writes the resulting proof only to `phases.<phase>.review.fingerprints`, and does not delete or mutate the legacy field.
// Exercise through: phase handler metadata migration boundary with real `.pocket-meta.json`.
// Test doubles: fake GitHub transport; use real metadata serialization.
// Expected RED: no v4 nested fingerprint path or legacy read-only fallback exists.
// Exact command: `node --test test/enterprise-phase.test.js`

test('RED cycle 4: legacy fingerprints are read-only input to the nested v4 proof', (t) => {
  const fixture = createFixture(t);
  const legacy = [{ fingerprint: '9'.repeat(16), thread: 'PRRT_LEGACY' }];
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  delete meta.phases['phase-1'].review;
  meta.phases['phase-1'].fingerprints = legacy;
  enterpriseMeta.writeMetaFor(fixture.specDir, meta);
  fixture.remote.prs[0].threadPages[1].push({
    id: 'PRRT_LEGACY',
    isResolved: false,
    comments: { nodes: [{ body: 'Legacy finding without a fingerprint tag', path: 'src/old.js', line: 4 }] },
  });
  const handler = loadPhaseHandler();
  assert.ok(handler && typeof handler.handlePhaseComplete === 'function');

  const response = handler.handlePhaseComplete(fixture.event, {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  });

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const resolveCalls = fixture.remote.calls.filter((args) => args[0] === 'api' && args[1] === 'graphql'
    && args.some((arg) => String(arg).includes('resolveReviewThread')));
  assert.equal(resolveCalls.filter((args) => args.some((arg) => arg === 'threadId=PRRT_LEGACY')).length, 1,
    'the legacy thread must be reconciled exactly once');
  const persisted = enterpriseMeta.readMetaFor(fixture.specDir).phases['phase-1'];
  assert.deepEqual(persisted.fingerprints, legacy, 'the legacy field must remain byte-for-byte equivalent as data');
  assert.deepEqual(persisted.review.fingerprints.map((record) => record.fingerprint), [
    identity.fingerprint({
      file: 'src/worker.js',
      ruleId: 'stage-1:spec-compliance',
      message: 'Missing error handling for invalid input',
      occurrence: 0,
    }),
  ]);
  assert.equal(persisted.review.fingerprints.length, 1, 'v4 proof is written only to the nested canonical path');
});

function addPhaseMarker(pr, phase, id) {
  pr.commentPages[1].push({ id, body: `${identity.markerFor(String(phase))}\n\nPrior summary` });
}

function isRemoteMutation(args) {
  if (args[0] !== 'api') return false;
  const methodIndex = args.indexOf('--method');
  if (methodIndex >= 0) return args[methodIndex + 1] !== 'GET';
  return args.some((arg) => arg === 'body=' || arg.startsWith('body='));
}

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
      prs: [makePr(PR_NUMBER, planId)],
      issueSearch: [],
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
      return pr ? json(publicPr(pr)) : failure('pull request not found');
    }
    if (args[0] === 'pr' && args[1] === 'list') return json(remote.prs.map(publicPr));
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = fieldFor('query') || '';
      if (query.includes('resolveReviewThread')) {
        const threadId = fieldFor('threadId');
        const thread = allThreads(remote).find((candidate) => candidate.id === threadId);
        if (!thread) return failure('review thread not found');
        thread.isResolved = true;
        return json({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }
      if (query.includes('reviewThreads')) return json(threadPage(remote, fieldFor('after'), Number(fieldFor('number'))));
      return failure('unexpected GraphQL operation');
    }
    if (args[0] === 'api' && typeof args[1] === 'string') {
      const endpoint = args[1];
      const method = (valueFor('--method') || (fieldFor('body') === null ? 'GET' : 'POST')).toUpperCase();
      const issueComments = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
      const issueComment = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
      const pullComments = endpoint.match(/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/);
      if (issueComments && method === 'GET') return json(allComments(remote, Number(issueComments[1])));
      if (issueComments && method === 'POST') {
        const comment = { id: remote.nextCommentId++, body: fieldFor('body') || '' };
        prState(remote, Number(issueComments[1])).comments.push(comment);
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
        prState(remote, Number(pullComments[1])).threads.push(thread);
        return json({ id: remote.nextThreadId, body });
      }
    }
    return failure(`unexpected fake gh command: ${args.join(' ')}`);
  };
}

function makePr(number, planId = 'demo-plan') {
  return {
    number,
    url: `https://github.com/${OWNER}/${REPOSITORY}/pull/${number}`,
    state: 'OPEN',
    headRefName: BRANCH,
    baseRefName: 'main',
    headRefOid: 'abc123def456',
    title: `Phase 1: ${planId}`,
    body: `Implements ${planId}`,
    commentPages: [[], []],
    comments: [],
    threadPages: [[], []],
    threads: [],
  };
}

function publicPr(pr) {
  const { commentPages, comments, threadPages, threads, ...fields } = pr;
  return fields;
}

function prState(remote, prNumber = PR_NUMBER) {
  return remote.prs.find((pr) => pr.number === prNumber) || {
    commentPages: [[], []], comments: [], threadPages: [[], []], threads: [],
  };
}

function allComments(remote, prNumber = PR_NUMBER) {
  const state = prState(remote, prNumber);
  return [...state.commentPages.flat(), ...state.comments].sort((left, right) => left.id - right.id);
}

function findComment(remote, id) {
  return remote.prs.flatMap((pr) => allComments(remote, pr.number)).find((comment) => comment.id === id) || null;
}

function removeComment(remote, id) {
  for (const pr of remote.prs) {
    for (const page of pr.commentPages) {
      const index = page.findIndex((comment) => comment.id === id);
      if (index >= 0) page.splice(index, 1);
    }
    const index = pr.comments.findIndex((comment) => comment.id === id);
    if (index >= 0) pr.comments.splice(index, 1);
  }
}

function allThreads(remote, prNumber = PR_NUMBER) {
  const state = prState(remote, prNumber);
  return [...state.threadPages.flat(), ...state.threads];
}

function threadPage(remote, after, prNumber) {
  const pageIndex = after && after !== 'null' ? Number(String(after).replace(/^cursor-/, '')) : 0;
  const state = prState(remote, prNumber);
  const pages = state.threadPages.map((page) => page.slice());
  pages[pages.length - 1].push(...state.threads);
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
