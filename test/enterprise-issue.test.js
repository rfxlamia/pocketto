'use strict';

// T8 Cycle 1: issue creation from spec-approved with no existing owned issue.
// Given a pending `spec-approved` event with valid spec artifacts, no owned
// issue metadata, and zero open `pocket-plan` issues matching the exact
// normalized plan identity in the current origin repository, When the handler
// runs, Then it creates exactly one issue and records number/URL/ownership
// proof in `.pocket-meta.json`.
// Exercise through `enterprise/issue-handler.js` with a fake `gh` transport
// and real temporary metadata. Fake GitHub responses and clock; do not mock
// reconciliation or metadata storage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const enterpriseMeta = require('../enterprise/meta');
const enterpriseAdapter = require('../enterprise/adapter');
const enterpriseRegistration = require('../enterprise/registration');

const PLAN_ID = 'demo-approved-plan';
const REPOSITORY = 'pocketto/example';
const REPOSITORY_URL = 'https://github.com/pocketto/example';
const ISSUE_URL = `${REPOSITORY_URL}/issues/42`;
const EVENT_ID = `${PLAN_ID}:spec-approved:r1`;
const FIXED_TIME = '2026-09-19T12:00:00.000Z';

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-issue-'));
  const specDir = path.join(projectRoot, 'docs', 'pocket', 'spec', PLAN_ID);
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'approved-spec.md');
  const specMarkdown = [
    '# Approved plan',
    '',
    '## Summary',
    'A plan that needs one owned issue.',
    '',
    '## Acceptance Criteria',
    '- The issue belongs to this exact plan.',
    '',
  ].join('\n');
  fs.writeFileSync(specPath, specMarkdown);
  const specHash = crypto.createHash('sha256').update(specMarkdown).digest('hex');
  const event = {
    event_id: EVENT_ID,
    plan_id: PLAN_ID,
    type: 'spec-approved',
    revision: 1,
    occurred_at: FIXED_TIME,
    artifact_refs: [{ root: 'spec', kind: 'approved-spec', path: 'approved-spec.md', sha256: specHash, revision: 1 }],
    payload_hash: 'a'.repeat(64),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 0 },
  };
  return { projectRoot, specDir, specPath, specMarkdown, event };
}

function makeIssue({
  number = 42,
  url = ISSUE_URL,
  state = 'OPEN',
  title = `Pocket Plan: ${PLAN_ID}`,
  body = `Approved specification: docs/pocket/spec/${PLAN_ID}/approved-spec.md`,
  labels = [{ name: 'pocket-plan' }],
} = {}) {
  return { number, url, state, title, body, labels, createdAt: FIXED_TIME };
}

function makeZeroMatchTransport(issue = makeIssue()) {
  const calls = [];
  const createdBodies = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, url: REPOSITORY_URL }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      const unrelated = makeIssue({
        number: 41,
        url: `${REPOSITORY_URL}/issues/41`,
        title: 'Pocket Plan: another-approved-plan',
        body: 'Approved specification: docs/pocket/spec/another-approved-plan/approved-spec.md',
      });
      // `gh issue list --limit` returns all pages; nested pages keep the fake
      // transport explicit about the pagination boundary.
      return { exit: 0, stdout: JSON.stringify([[unrelated], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const bodyFileIndex = args.indexOf('--body-file');
      if (bodyFileIndex >= 0) createdBodies.push(fs.readFileSync(args[bodyFileIndex + 1], 'utf8'));
      return { exit: 0, stdout: `${issue.url}\n`, stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(issue.number)) {
      return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, createdBodies, runner };
}

function makeSingleMatchTransport(issue) {
  const calls = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, url: REPOSITORY_URL }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return { exit: 0, stdout: JSON.stringify([[issue], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(issue.number)) {
      return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 1, stdout: '', stderr: 'duplicate issue creation is forbidden in this test' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function makeReconciliationTransport({ pages = [[]], issues = {}, repository = { nameWithOwner: REPOSITORY, url: REPOSITORY_URL } } = {}) {
  const calls = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify(repository), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return { exit: 0, stdout: JSON.stringify(pages), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      const issue = issues[Number(args[2])];
      if (issue) return { exit: 0, stdout: JSON.stringify(issue), stderr: '' };
      return { exit: 1, stdout: '', stderr: 'issue not found in fake current repository' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 1, stdout: '', stderr: 'issue creation is forbidden in this test' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function makeNearMatchThenCreateTransport(nearMatch, createdIssue) {
  const calls = [];
  const runner = (args) => {
    calls.push(args.slice());
    if (args[0] === 'repo' && args[1] === 'view') {
      return { exit: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, url: REPOSITORY_URL }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return { exit: 0, stdout: JSON.stringify([[nearMatch], []]), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return { exit: 0, stdout: `${createdIssue.url}\n`, stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(createdIssue.number)) {
      return { exit: 0, stdout: JSON.stringify(createdIssue), stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `Unexpected fake gh command: ${args.join(' ')}` };
  };
  return { calls, runner };
}

function writeIssueMetadata(specDir, issue) {
  const value = enterpriseMeta.readMetaFor(specDir);
  value.github_issue = { ...issue };
  enterpriseMeta.writeMetaFor(specDir, value);
}

function snapshotMetadata(specDir) {
  const target = enterpriseMeta.resolveMetaPath(specDir);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
}

function loadIssueHandler() {
  try {
    return require('../enterprise/issue-handler');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /enterprise\/issue-handler/.test(err.message)) return null;
    throw err;
  }
}

test('CYCLE 1: creates one issue for a pending approved spec with no exact open match', () => {
  const fixture = makeProject();
  const transport = makeZeroMatchTransport();
  const handler = loadIssueHandler();

  // Keep a missing production module as an assertion failure, not a test
  // import/setup error: this is the expected pre-implementation RED.
  assert.ok(handler && typeof handler.handleSpecApproved === 'function',
    'a deterministic spec-approved issue handler must exist');

  const result = handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: transport.runner,
    clock: () => new Date(FIXED_TIME),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, enterpriseMeta.issueProofRef());
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 1,
    'exactly one issue must be created');
  const searches = transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list');
  assert.equal(searches.length, 1, 'search must happen before creation');
  assert.ok(searches[0].includes('--repo') && searches[0].includes(REPOSITORY),
    'search must be scoped to the current origin repository');
  assert.ok(searches[0].includes('--state') && searches[0].includes('open'),
    'search must include only open issues');
  assert.ok(searches[0].includes('--label') && searches[0].includes('pocket-plan'),
    'search must be scoped to the pocket-plan label');

  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 42);
  assert.equal(metadata.github_issue.url, ISSUE_URL);
  assert.equal(metadata.github_issue.ownership.plan_id, PLAN_ID);
  assert.equal(metadata.github_issue.ownership.repository, REPOSITORY);
  assert.equal(metadata.github_issue.ownership.event_id, EVENT_ID);
  assert.equal(metadata.github_issue.ownership.spec_path, 'docs/pocket/spec/demo-approved-plan/approved-spec.md');
  assert.match(metadata.github_issue.ownership.proof_hash, /^[0-9a-f]{64}$/);
  assert.match(transport.createdBodies[0], /docs\/pocket\/spec\/demo-approved-plan\/approved-spec\.md/,
    'the issue body must preserve the full approved-spec path as ownership evidence');
  assert.ok(transport.createdBodies[0].includes(fixture.specMarkdown),
    'the issue body must carry the approved full specification');
});

// T8 Cycle 2: one owned open exact match is reused.
// Given one open `pocket-plan` issue in the current origin repository with
// exact normalized plan identity, When `spec-approved` runs, Then it reuses
// that issue, records proof, and performs no duplicate create.
// Exercise through the handler's metadata/search reconciliation boundary.
// Fake paginated `gh issue list/view` responses; real metadata files.
test('CYCLE 2: reuses one open current-origin exact-plan issue without creating a duplicate', () => {
  const fixture = makeProject();
  const existing = makeIssue({
    number: 52,
    url: `${REPOSITORY_URL}/issues/52`,
  });
  const transport = makeSingleMatchTransport(existing);
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');

  const result = handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: transport.runner,
    clock: () => new Date(FIXED_TIME),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, enterpriseMeta.issueProofRef());
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0,
    'an existing exact issue must not be duplicated');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'view').length, 1,
    'the search candidate must be fetched and validated in the current origin');
  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 52);
  assert.equal(metadata.github_issue.url, existing.url);
  assert.equal(metadata.github_issue.ownership.plan_id, PLAN_ID);
  assert.equal(metadata.github_issue.ownership.event_id, EVENT_ID);
});

// T8 Cycle 3: metadata-first validation and fail-closed ambiguity classification.
// Given positive issue metadata pointing to the wrong origin, a closed issue,
// or a wrong-plan issue, When metadata-first validation runs, Then the handler
// rejects it and safely falls back to exact open `pocket-plan` search/manual
// resolution; given multiple exact matches, a foreign-owned match, or a
// manually conflicting open match, Then it returns terminal/manual resolution
// with no issue or metadata mutation and never reopens or silently selects a
// target.
// Exercise through the handler's metadata-first and complete search/reconcile
// boundary. Fake paginated `gh issue list/view/create` responses; no live GitHub.
test('CYCLE 3: invalid positive metadata falls back to exact current-origin search or manual resolution', () => {
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');

  // Wrong-origin metadata is rejected; exactly one current-origin match is reused.
  {
    const fixture = makeProject();
    const wrongOrigin = makeIssue({ number: 99, url: 'https://github.com/other/repo/issues/99' });
    writeIssueMetadata(fixture.specDir, wrongOrigin);
    const exact = makeIssue({ number: 52, url: `${REPOSITORY_URL}/issues/52` });
    const transport = makeReconciliationTransport({ pages: [[exact], []], issues: { 99: wrongOrigin, 52: exact } });
    const result = handler.handleSpecApproved(fixture.event, {
      projectRoot: fixture.projectRoot,
      ghRunner: transport.runner,
      clock: () => new Date(FIXED_TIME),
    });
    assert.equal(result.status, 'succeeded', 'a unique exact current-origin fallback is safe to reuse');
    assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
    assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 1,
      'invalid metadata must fall back to exact current-origin search');
    const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
    assert.equal(metadata.github_issue.number, 52);
    assert.equal(metadata.github_issue.ownership.repository, REPOSITORY);
  }

  // Closed metadata is inspected, then exact search finds no safe open target.
  {
    const fixture = makeProject();
    const closed = makeIssue({ number: 60, url: `${REPOSITORY_URL}/issues/60`, state: 'CLOSED' });
    writeIssueMetadata(fixture.specDir, closed);
    const before = snapshotMetadata(fixture.specDir);
    const transport = makeReconciliationTransport({ pages: [[]], issues: { 60: closed } });
    const result = handler.handleSpecApproved(fixture.event, {
      projectRoot: fixture.projectRoot,
      ghRunner: transport.runner,
      clock: () => new Date(FIXED_TIME),
    });
    assert.equal(result.status, 'terminal');
    assert.match(result.error.code, /MANUAL|OWNERSHIP|CONFLICT/);
    assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'list'), true,
      'closed metadata must fall back to exact open search');
    assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false);
    assert.equal(snapshotMetadata(fixture.specDir), before, 'closed issue metadata must remain unchanged');
  }

  // Wrong-plan metadata is not adopted; an empty exact search stops manually.
  {
    const fixture = makeProject();
    const wrongPlan = makeIssue({
      number: 61,
      url: `${REPOSITORY_URL}/issues/61`,
      title: 'Pocket Plan: another-approved-plan',
      body: 'docs/pocket/spec/another-approved-plan/approved-spec.md',
    });
    writeIssueMetadata(fixture.specDir, wrongPlan);
    const before = snapshotMetadata(fixture.specDir);
    const transport = makeReconciliationTransport({ pages: [[]], issues: { 61: wrongPlan } });
    const result = handler.handleSpecApproved(fixture.event, {
      projectRoot: fixture.projectRoot,
      ghRunner: transport.runner,
      clock: () => new Date(FIXED_TIME),
    });
    assert.equal(result.status, 'terminal');
    assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'list'), true);
    assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false);
    assert.equal(snapshotMetadata(fixture.specDir), before, 'wrong-plan metadata must remain unchanged');
  }
});

test('CYCLE 3: multiple, foreign, or conflicting open matches stop without issue or metadata mutation', () => {
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');
  const cases = [
    {
      name: 'multiple exact matches',
      pages: [[
        makeIssue({ number: 62, url: `${REPOSITORY_URL}/issues/62` }),
        makeIssue({ number: 63, url: `${REPOSITORY_URL}/issues/63` }),
      ], []],
      issues: {},
    },
    {
      name: 'foreign-owned exact match',
      pages: [[makeIssue({ number: 64, url: 'https://github.com/other/repo/issues/64' })], []],
      issues: {},
    },
    {
      name: 'manually conflicting exact title and full-spec path',
      pages: [[makeIssue({
        number: 65,
        url: `${REPOSITORY_URL}/issues/65`,
        body: 'Approved specification: docs/pocket/spec/some-other-plan/approved-spec.md',
      })], []],
      issues: { 65: makeIssue({
        number: 65,
        url: `${REPOSITORY_URL}/issues/65`,
        body: 'Approved specification: docs/pocket/spec/some-other-plan/approved-spec.md',
      }) },
    },
  ];

  for (const scenario of cases) {
    const fixture = makeProject();
    const before = snapshotMetadata(fixture.specDir);
    const transport = makeReconciliationTransport(scenario);
    const result = handler.handleSpecApproved(fixture.event, {
      projectRoot: fixture.projectRoot,
      ghRunner: transport.runner,
      clock: () => new Date(FIXED_TIME),
    });
    assert.equal(result.status, 'terminal', `${scenario.name} requires manual resolution`);
    assert.match(result.error.code, /MANUAL|OWNERSHIP|CONFLICT/);
    assert.equal(transport.calls.some((args) => args[0] === 'issue' && args[1] === 'create'), false,
      `${scenario.name}: no issue may be created`);
    assert.equal(snapshotMetadata(fixture.specDir), before, `${scenario.name}: metadata must not mutate`);
  }
});

test('CYCLE 3: valid positive metadata is validated before search and reused', () => {
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');
  const fixture = makeProject();
  const existing = makeIssue({ number: 66, url: `${REPOSITORY_URL}/issues/66` });
  writeIssueMetadata(fixture.specDir, existing);
  const transport = makeReconciliationTransport({ pages: [[]], issues: { 66: existing } });
  const result = handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: transport.runner,
    clock: () => new Date(FIXED_TIME),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'view').length, 1);
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'list').length, 0,
    'valid metadata should be reconciled before search');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
});

test('CYCLE 3: a spec-path prefix near-match does not establish exact plan identity', () => {
  const fixture = makeProject();
  const targetPath = `docs/pocket/spec/${PLAN_ID}/approved-spec.md`;
  const nearMatch = makeIssue({
    number: 67,
    url: `${REPOSITORY_URL}/issues/67`,
    title: 'Manual plan context',
    body: `Related artifact: ${targetPath}.backup`,
  });
  const createdIssue = makeIssue({
    number: 68,
    url: `${REPOSITORY_URL}/issues/68`,
  });
  const transport = makeNearMatchThenCreateTransport(nearMatch, createdIssue);
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');
  const result = handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: transport.runner,
    clock: () => new Date(FIXED_TIME),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(transport.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 1,
    'a non-exact path must not suppress creation of the unique exact plan issue');
  const metadata = JSON.parse(fs.readFileSync(enterpriseMeta.resolveMetaPath(fixture.specDir), 'utf8'));
  assert.equal(metadata.github_issue.number, 68, 'ownership must point to the issue with exact identity, not a path-prefix near-match');
});

// T8 Cycle 4: a succeeded event replays from persisted issue proof.
// Given a succeeded event ID and recorded issue proof, When the same event is
// replayed, Then the handler returns the existing proof, performs no
// create/update, and leaves `.pocket-meta.json` semantically unchanged.
// Exercise through adapter dispatch to the issue handler with persisted
// event/metadata fixtures. Recording fake GitHub transport; real metadata files.
test('CYCLE 4: succeeded adapter replay returns persisted proof without GitHub or metadata mutation', () => {
  const fixture = makeProject();
  const initialTransport = makeZeroMatchTransport();
  const handler = loadIssueHandler();
  assert.ok(handler && typeof handler.handleSpecApproved === 'function', 'issue handler must be available');
  const first = handler.handleSpecApproved(fixture.event, {
    projectRoot: fixture.projectRoot,
    ghRunner: initialTransport.runner,
    clock: () => new Date(FIXED_TIME),
  });
  assert.equal(first.status, 'succeeded');

  const registered = enterpriseRegistration.installRegistration(fixture.projectRoot, {
    argv: [process.execPath, 'unused-adapter.js'],
  });
  assert.equal(registered.ok, true, 'adapter dispatch fixture must be registered');
  const succeededEvent = {
    ...fixture.event,
    proof_ref: first.proof_ref,
    proof_hash: first.proof_hash,
    delivery: { status: 'succeeded', attempts: 1 },
  };
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const before = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const replayCalls = [];
  const replay = enterpriseAdapter.dispatchEvent(succeededEvent, {
    projectRoot: fixture.projectRoot,
    coreContract: 3,
    handlers: {
      'spec-approved': (event, context) => handler.handleSpecApproved(event, {
        ...context,
        clock: () => new Date(FIXED_TIME),
      }),
    },
    ghRunner: (args) => {
      replayCalls.push(args.slice());
      return { exit: 1, stdout: '', stderr: 'replay must use persisted issue proof' };
    },
  });

  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.event_id, EVENT_ID);
  assert.equal(replay.proof_ref, first.proof_ref);
  assert.equal(replay.proof_hash, first.proof_hash);
  assert.deepEqual(replayCalls, [], 'persisted proof must be resolved before any GitHub transport call');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), before,
    'replay must leave real metadata semantically unchanged');
});
