'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const enterpriseMeta = require('../enterprise/meta');
const { handlePhaseComplete } = require('../enterprise/phase-handler');
const { createLifecycleDelivery } = require('../enterprise/lifecycle-delivery');
const { loadContext, phaseBranchFor } = require('../enterprise/phase-handler-context');
const { resolveRepository, resolvePhasePr } = require('../enterprise/phase-handler-targets');
const { createFixture } = require('../test-support/enterprise-phase/fixture');
const { fakeGh, makePr } = require('../test-support/enterprise-phase/remote');
const { dispatchEvent } = require('../enterprise/adapter');
const { validateAdapterResponse } = require('../cli/lib/lifecycle-contract');
const { buildRegistration, REGISTRATION_DIR, REGISTRATION_FILE } = require('../enterprise/registration-record');

// Guard: any accidental real `gh` resolves to this stub, which refuses to run.
// Tests must reach gh only through the injected fake runner.
const GH_GUARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-closed-gh-guard-'));
fs.writeFileSync(path.join(GH_GUARD_DIR, 'gh'), '#!/bin/sh\necho "real gh is forbidden in phase-closed tests" >&2\nexit 97\n', { mode: 0o755 });
process.env.PATH = `${GH_GUARD_DIR}${path.delimiter}${process.env.PATH}`;
process.on('exit', () => fs.rmSync(GH_GUARD_DIR, { recursive: true, force: true }));

const PLAN_ID = 'demo-plan';
const DEFERRED_PROOF_REF = 'deferred:phase-closed';
const STACKED_PHASES = {
  'phase-1': { branch: 'feature/demo-plan-phase-1', base_branch: 'main' },
  'phase-2': { branch: 'feature/demo-plan-phase-2', base_branch: 'feature/demo-plan-phase-1' },
};

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function handlerOptions(fixture) {
  return { projectRoot: fixture.root, ghRunner: fakeGh(fixture.remote) };
}

// Independent expectation for the deferred proof: literal key order, same hashing style.
function expectedDeferredHash(event) {
  return sha256(JSON.stringify({ event_id: event.event_id, plan_id: event.plan_id, deferred: 'phase-closed' }));
}

// Schema-2 stacked plan: phase 2 has REVIEW evidence and a pending phase-complete event.
// plan.branch is omitted unless the caller asks for it, so the stacked path must not need it.
function stackedFixture(t, { planBranch } = {}) {
  const fixture = createFixture(t);
  const phasePath = 'execution-plan/phase-2.md';
  const phaseText = '# Phase 2\n\nContains tasks: T2\n';
  fs.writeFileSync(path.join(fixture.planDir, phasePath), phaseText);
  fs.writeFileSync(path.join(fixture.planDir, 'log.json'), JSON.stringify({
    header: { plan_dir: fixture.planDir, status: 'IN_PROGRESS', phase_branches: { mode: 'stacked', root_base: 'main' } },
    phases: [{ file: phasePath, status: 'REVIEW', tasks: [{ id: 'T2', name: 'Second phase task', status: 'DONE' }] }],
  }, null, 2) + '\n');
  const event = {
    ...fixture.event,
    artifact_refs: [{
      root: 'plan',
      kind: 'phase-evidence',
      path: phasePath,
      sha256: sha256(phaseText),
      revision: 1,
    }],
  };
  const plan = {
    plan_id: PLAN_ID,
    spec_dir: fixture.specDir,
    plan_dir: fixture.planDir,
    phase_branches: { mode: 'stacked', root_base: 'main' },
    phases: STACKED_PHASES,
    state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE', 'phase-2': 'COMPLETE' }, status: 'IN_PROGRESS' },
    revision: 1,
  };
  if (planBranch !== undefined) plan.branch = planBranch;
  fs.writeFileSync(path.join(fixture.specDir, 'lifecycle.json'), JSON.stringify({
    schema: 2,
    plan,
    events: [event],
  }, null, 2) + '\n');
  return { ...fixture, event };
}

// RED cycle 1
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (handler with fake gh runner and temp project)
// Test intent: Given a schema-2 stacked lifecycle doc and a pending phase-complete event for phase 2, When handlePhaseComplete runs, Then status succeeded, proof_ref deferred:phase-closed, and zero gh calls.
// Exercise through: handlePhaseComplete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: schema 2 rejected (PHASE_PLAN_IDENTITY_MISMATCH)
// Exact command: `node --test --test-name-pattern="stacked phase-complete deferral" test/enterprise-phase-closed.test.js`

test('stacked phase-complete deferral: pending phase-2 event succeeds as deferred with zero gh calls', (t) => {
  const fixture = stackedFixture(t);
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const before = fs.readFileSync(metadataPath, 'utf8');

  const response = handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.equal(response.event_id, fixture.event.event_id);
  assert.equal(response.proof_ref, DEFERRED_PROOF_REF);
  assert.equal(response.proof_hash, expectedDeferredHash(fixture.event));
  assert.deepEqual(fixture.remote.calls, [], 'stacked deferral must make no GitHub call');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'stacked deferral must not write metadata');
});

// Guard (regression): non-stacked plans keep the existing reconciliation path.
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given a schema-1 non-stacked lifecycle doc, When handlePhaseComplete runs, Then its first gh call is `repo view` exactly as before.
// Exercise through: handlePhaseComplete
// Test doubles: fake gh runner recording argv (fixture.remote.calls)
// Expected RED: none (regression guard, green on unchanged code)
// Exact command: `node --test --test-name-pattern="non-stacked unchanged" test/enterprise-phase-closed.test.js`

test('non-stacked unchanged: schema-1 phase-complete still reconciles starting with repo view', (t) => {
  const fixture = createFixture(t);

  const response = handlePhaseComplete(fixture.event, handlerOptions(fixture));

  assert.deepEqual(fixture.remote.calls[0], ['repo', 'view', '--json', 'owner,name,url'],
    'first gh call for a non-stacked plan must be repo view');
  assert.notEqual(response.proof_ref, DEFERRED_PROOF_REF, JSON.stringify(response));
});

// RED cycle 2
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given the same event marked succeeded with the deferred proof, When handlePhaseComplete replays it, Then the same response and zero gh calls. Given a tampered proof hash, Then terminal PHASE_PROOF_MISMATCH.
// Exercise through: handlePhaseComplete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: replay looks for a metadata PR proof that a deferred event never wrote
// Exact command: `node --test --test-name-pattern="deferred replay" test/enterprise-phase-closed.test.js`

test('deferred replay: succeeded deferred event replays identically with zero gh calls', (t) => {
  const fixture = stackedFixture(t);
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const first = handlePhaseComplete(fixture.event, handlerOptions(fixture));
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  const before = fs.readFileSync(metadataPath, 'utf8');
  const succeeded = {
    ...fixture.event,
    delivery: { status: 'succeeded', attempts: 1, proof_ref: first.proof_ref, proof_hash: first.proof_hash },
  };

  const replay = handlePhaseComplete(succeeded, handlerOptions(fixture));

  assert.deepEqual(replay, first);
  assert.deepEqual(fixture.remote.calls, [], 'deferred replay must verify only the hash and make no GitHub call');
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), before, 'deferred replay must not write metadata');
});

test('deferred replay: tampered deferred proof hash is a terminal PHASE_PROOF_MISMATCH', (t) => {
  const fixture = stackedFixture(t);
  const tampered = {
    ...fixture.event,
    delivery: { status: 'succeeded', attempts: 1, proof_ref: DEFERRED_PROOF_REF, proof_hash: '0'.repeat(64) },
  };

  const response = handlePhaseComplete(tampered, handlerOptions(fixture));

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'PHASE_PROOF_MISMATCH');
  assert.match(response.error.message, /deferred proof/, 'must fail on the deferred proof check, not the metadata proof check');
  assert.deepEqual(fixture.remote.calls, [], 'tampered deferred proof must fail before any GitHub call');
});

// RED cycle 5
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (drain completion path: createLifecycleDelivery prepare + handler + complete)
// Test intent: Given a stacked phase-2 pending event, When the handler returns the deferred success and the drain completion path runs, Then delivery completes as succeeded with no error, the watermark advances, and zero gh calls run across both steps.
// Exercise through: createLifecycleDelivery(...).prepare / handlePhaseComplete / .complete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: reconciling / ADAPTER_PROOF_NOT_DURABLE (lookup reads only metadata review.proof)
// Exact command: `node --test --test-name-pattern="stacked deferred completes durably" test/enterprise-phase-closed.test.js`

test('stacked deferred completes durably: deferred success completes delivery with zero gh calls', (t) => {
  const fixture = stackedFixture(t);
  const delivery = createLifecycleDelivery(fixture.root);
  const prepared = delivery.prepare(fixture.event);
  assert.ok(prepared.state, JSON.stringify(prepared.response));

  const response = handlePhaseComplete(prepared.event, handlerOptions(fixture));
  assert.equal(response.proof_ref, DEFERRED_PROOF_REF, JSON.stringify(response));
  const completed = delivery.complete(prepared.event, response, prepared.state);

  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(completed.error, undefined, JSON.stringify(completed));
  assert.equal(completed.proof_ref, DEFERRED_PROOF_REF);
  assert.equal(completed.proof_hash, expectedDeferredHash(fixture.event));
  assert.equal(enterpriseMeta.readLifecycleDelivery(prepared.state.context.specDir, PLAN_ID, prepared.state.context).last_applied_revision, 1,
    'completed deferred delivery must advance the watermark');
  assert.deepEqual(fixture.remote.calls, [], 'deferred drain completion must make no GitHub call');
});

// RED cycle 6
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (drain completion path)
// Test intent: Given a stacked phase-2 deferred success whose proof_hash is altered by one character, When the completion path runs, Then terminal PHASE_PROOF_MISMATCH with the deferred-proof message, no watermark advance, and zero gh calls.
// Exercise through: createLifecycleDelivery(...).prepare / handlePhaseComplete / .complete
// Test doubles: fake gh runner counting calls (fixture.remote.calls)
// Expected RED: reconciling / ADAPTER_PROOF_NOT_DURABLE (tampered hash is not compared against the deferred derivation)
// Exact command: `node --test --test-name-pattern="deferred proof tampered rejected" test/enterprise-phase-closed.test.js`

test('deferred proof tampered rejected: altered deferred proof hash is terminal PHASE_PROOF_MISMATCH', (t) => {
  const fixture = stackedFixture(t);
  const delivery = createLifecycleDelivery(fixture.root);
  const prepared = delivery.prepare(fixture.event);
  const response = handlePhaseComplete(prepared.event, handlerOptions(fixture));
  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  const last = response.proof_hash.slice(-1);
  const tamperedHash = response.proof_hash.slice(0, -1) + (last === '0' ? '1' : '0');
  assert.notEqual(tamperedHash, response.proof_hash);

  const completed = delivery.complete(prepared.event, { ...response, proof_hash: tamperedHash }, prepared.state);

  assert.equal(completed.status, 'terminal', JSON.stringify(completed));
  assert.equal(completed.error.code, 'PHASE_PROOF_MISMATCH', JSON.stringify(completed));
  assert.match(completed.error.message, /deferred proof/, 'must fail on the deferred proof derivation, not a generic durability check');
  assert.equal(enterpriseMeta.readLifecycleDelivery(prepared.state.context.specDir, PLAN_ID, prepared.state.context).last_applied_revision, 0,
    'tampered deferred proof must not advance the watermark');
  assert.deepEqual(fixture.remote.calls, [], 'tampered deferred proof must make no GitHub call');
});

// RED cycle 4
// Test file: `test/enterprise-phase-closed.test.js`
// Level: unit (phaseBranchFor export) plus targets check through resolvePhasePr
// Test intent: Given plan.phases with phase-1 and phase-2 branches and plan.branch equal to phase-2's, When phaseBranchFor(context, 'phase-1'), Then phase-1's branch. Given a missing key, Then PHASE_BRANCH_REQUIRED.
// Exercise through: phaseBranchFor export; resolvePhasePr for the stacked PR lookup
// Test doubles: none for the helper; fake gh runner counting calls for the targets check
// Expected RED: helper missing
// Exact command: `node --test --test-name-pattern="phaseBranchFor" test/enterprise-phase-closed.test.js`

test('phaseBranchFor returns the exact per-phase branch and rejects a missing key', (t) => {
  const fixture = stackedFixture(t, { planBranch: STACKED_PHASES['phase-2'].branch });
  const context = loadContext(fixture.event, { projectRoot: fixture.root });

  assert.equal(phaseBranchFor(context, 'phase-1'), 'feature/demo-plan-phase-1');
  assert.equal(phaseBranchFor(context, 'phase-2'), 'feature/demo-plan-phase-2');
  assert.throws(() => phaseBranchFor(context, 'phase-3'), { code: 'PHASE_BRANCH_REQUIRED' });
});

test('phaseBranchFor drives the stacked PR lookup in resolvePhasePr', (t) => {
  const fixture = stackedFixture(t, { planBranch: STACKED_PHASES['phase-2'].branch });
  const options = handlerOptions(fixture);
  const context = loadContext(fixture.event, { projectRoot: fixture.root });
  const repo = resolveRepository(options);

  // The seeded PR lives on the plan branch, so it must be rejected and the lookup must use phase-1's branch.
  assert.throws(() => resolvePhasePr(context, { key: 'phase-1', number: 1 }, repo, options), { code: 'PR_MANUAL_RESOLUTION' });
  const search = fixture.remote.calls.find((args) => args[0] === 'pr' && args[1] === 'list');
  assert.equal(search[search.indexOf('--head') + 1], 'feature/demo-plan-phase-1');
});

// ---------------------------------------------------------------------------
// T13 phase-closed handler. Integration: real git against a temp bare origin,
// gh is a fake runner (pr create/list/edit here, the rest from test-support).
// ---------------------------------------------------------------------------

const PHASE_CLOSED_CLOCK = '2026-09-19T12:00:00.000Z';
const PC_OWNER = 'pocketto-test';
const PC_REPO = 'phase-closed';
const PC_ISSUE = 31;
const PC_BRANCH = `pocket/${PLAN_ID}/phase-1`;
const PC_PHASE_PATH = 'execution-plan/phase-1.md';
const PC_PHASE_TEXT = '# Phase 1\n\nContains tasks: T1\n';
const PC_SNAPSHOT_PATH = 'reviews/closeout-phase-1.md';
const PC_SNAPSHOT_TEXT = '## Closeout\n\nPhase 1 closed with its evidence.\n';
const PC_CONSENT = Object.freeze({ scope: 'pocket-phase-branches', force: false });

function gitIn(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commitFileIn(cwd, name, text, message) {
  fs.writeFileSync(path.join(cwd, name), text);
  gitIn(cwd, 'add', name);
  gitIn(cwd, 'commit', '-m', message);
}

function remoteHasBranch(fixture, branch) {
  return gitIn(fixture.work, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`) !== '';
}

function phaseClosedEvent() {
  return {
    event_id: `${PLAN_ID}:phase-closed:r1`,
    plan_id: PLAN_ID,
    type: 'phase-closed',
    revision: 1,
    occurred_at: PHASE_CLOSED_CLOCK,
    artifact_refs: [
      { root: 'plan', kind: 'phase-evidence', path: PC_PHASE_PATH, sha256: sha256(PC_PHASE_TEXT), revision: 1 },
      { root: 'plan', kind: 'closeout-snapshot', path: PC_SNAPSHOT_PATH, sha256: sha256(PC_SNAPSHOT_TEXT), revision: 1 },
    ],
    payload_hash: sha256('phase-closed payload'),
    proof_ref: null,
    proof_hash: null,
    delivery: { status: 'pending', attempts: 1 },
  };
}

// Temp work clone with a bare origin. `main` is the root base on origin; the phase-1
// branch is local only, with its durable root-base record. Registration carries durable
// push consent unless `consent` is false. A recorded issue is seeded unless `issueRecorded` is false.
function phaseClosedFixture(t, { stacked = true, consent = true, issueRecorded = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-closed-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  gitIn(root, 'init', '--bare', '-q', origin);
  fs.mkdirSync(work);
  gitIn(work, 'init', '-q', '-b', 'main');
  gitIn(work, 'config', 'user.name', 'Pocket Test');
  gitIn(work, 'config', 'user.email', 'pocket-test@example.com');
  commitFileIn(work, 'README.md', 'root base\n', 'root base');
  gitIn(work, 'remote', 'add', 'origin', origin);
  gitIn(work, 'push', '-q', '-u', 'origin', 'main');
  const rootBaseSha = gitIn(work, 'rev-parse', 'refs/heads/main');
  gitIn(work, 'switch', '-q', '-c', PC_BRANCH);
  commitFileIn(work, 'phase1.txt', 'phase one\n', 'phase one work');
  gitIn(work, 'config', `branch.${PC_BRANCH}.pocketRootBase`, 'main');

  const planDir = path.join(work, 'docs', 'pocket', 'plans', PLAN_ID);
  const specDir = path.join(work, 'docs', 'pocket', 'spec', PLAN_ID);
  fs.mkdirSync(path.join(planDir, 'execution-plan'), { recursive: true });
  fs.mkdirSync(path.join(planDir, 'reviews'), { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, PC_PHASE_PATH), PC_PHASE_TEXT);
  fs.writeFileSync(path.join(planDir, PC_SNAPSHOT_PATH), PC_SNAPSHOT_TEXT);
  fs.writeFileSync(path.join(planDir, 'log.json'), JSON.stringify({
    header: { plan_dir: planDir, status: 'IN_PROGRESS' },
    phases: [{ file: PC_PHASE_PATH, status: 'DONE', tasks: [{ id: 'T1', name: 'Validate input handling', status: 'DONE' }] }],
  }, null, 2) + '\n');

  const plan = {
    plan_id: PLAN_ID,
    spec_dir: specDir,
    plan_dir: planDir,
    state: { approval: 'APPROVED', phase_status: { 'phase-1': 'COMPLETE' }, status: 'IN_PROGRESS' },
    revision: 1,
  };
  if (stacked) {
    plan.phase_branches = { mode: 'stacked', root_base: { branch: 'main', sha: rootBaseSha } };
    plan.phases = { 'phase-1': { branch: PC_BRANCH, base_branch: 'main' } };
  } else {
    plan.branch = PC_BRANCH;
  }
  fs.writeFileSync(path.join(specDir, 'lifecycle.json'), JSON.stringify({
    schema: stacked ? 2 : 1,
    plan,
    events: [phaseClosedEvent()],
  }, null, 2) + '\n');

  const registration = buildRegistration({
    argv: [process.execPath, '-e', '0'],
    pushConsent: consent ? PC_CONSENT : undefined,
  });
  fs.mkdirSync(path.join(work, REGISTRATION_DIR), { recursive: true });
  fs.writeFileSync(path.join(work, REGISTRATION_DIR, REGISTRATION_FILE), `${JSON.stringify(registration, null, 2)}\n`);

  const issueUrl = `https://github.com/${PC_OWNER}/${PC_REPO}/issues/${PC_ISSUE}`;
  if (issueRecorded) {
    enterpriseMeta.setIssueIdentity(specDir, { number: PC_ISSUE, url: issueUrl });
  } else {
    fs.writeFileSync(path.join(specDir, '.pocket-meta.json'), '{}\n');
  }
  const remote = {
    owner: PC_OWNER,
    repository: PC_REPO,
    issue: {
      number: PC_ISSUE,
      url: issueUrl,
      state: 'OPEN',
      title: `[pocket-plan] ${PLAN_ID}`,
      body: `Plan identity: docs/pocket/spec/${PLAN_ID}/core.md`,
      labels: [{ name: 'pocket-plan' }],
    },
    prs: [],
    issueSearch: [],
    calls: [],
    nextCommentId: 1,
    nextThreadId: 1,
    resolveFailuresRemaining: 0,
    successfulResolutions: 0,
  };
  return { root, work, origin, planDir, specDir, remote };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

function ghOk(stdout) {
  return { exit: 0, stdout, stderr: '', timedOut: false };
}

function publicPrFields(pr) {
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    title: pr.title,
    body: pr.body,
    headRefOid: pr.headRefOid,
  };
}

// Records and answers the PR writes and PR lists the phase publisher needs. Every other
// route (repo, issue, comments, review threads) goes through the shared test-support fake.
function phaseClosedGh(fixture) {
  const delegate = fakeGh(fixture.remote);
  return (args) => {
    const [group, verb] = args;
    if (group !== 'pr' || !['create', 'list', 'edit'].includes(verb)) return delegate(args);
    fixture.remote.calls.push(args.slice());
    if (verb === 'list') {
      const head = flagValue(args, '--head');
      const base = flagValue(args, '--base');
      const state = (flagValue(args, '--state') || 'open').toUpperCase();
      const matches = fixture.remote.prs
        .filter((pr) => (head === null || pr.headRefName === head)
          && (base === null || pr.baseRefName === base) && pr.state === state)
        .map(publicPrFields);
      return ghOk(JSON.stringify(matches));
    }
    if (verb === 'create') {
      const number = 100 + fixture.remote.prs.length + 1;
      const url = `https://github.com/${PC_OWNER}/${PC_REPO}/pull/${number}`;
      const head = flagValue(args, '--head');
      fixture.remote.prs.push({
        ...makePr(number, PLAN_ID),
        url,
        state: 'OPEN',
        headRefName: head,
        baseRefName: flagValue(args, '--base'),
        headRefOid: gitIn(fixture.work, 'rev-parse', `refs/heads/${head}`),
        title: flagValue(args, '--title'),
        body: fs.readFileSync(flagValue(args, '--body-file'), 'utf8'),
      });
      return ghOk(`${url}\n`);
    }
    const pr = fixture.remote.prs.find((candidate) => candidate.number === Number(args[2]));
    if (!pr) return { exit: 1, stdout: '', stderr: 'pull request not found', timedOut: false };
    pr.body = fs.readFileSync(flagValue(args, '--body-file'), 'utf8');
    return ghOk('');
  };
}

function dispatchPhaseClosed(fixture, event) {
  return dispatchEvent(event, {
    projectRoot: fixture.work,
    ghRunner: phaseClosedGh(fixture),
    handlers: {
      'phase-closed': (phaseEvent, options) => require('../enterprise/phase-closed-handler').handlePhaseClosed(phaseEvent, options),
    },
  });
}

function prCreateCalls(fixture) {
  return fixture.remote.calls.filter((args) => args[0] === 'pr' && args[1] === 'create');
}

// RED cycle 1
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration (dispatchEvent, real git with bare origin, fake gh)
// Test intent: Given a stacked plan after the phase-1 handoff, durable push consent, and an owned open issue, When dispatchEvent runs the phase-closed event, Then the response validates, status succeeded, one PR_CREATED notice, gh saw `pr create --base main` then the summary comment upsert on that PR, and metadata holds the stack proof.
// Exercise through: enterprise/adapter.js:dispatchEvent
// Test doubles: fake gh runner recording argv (fixture.remote.calls); real git with bare origin
// Expected RED: no handler for phase-closed
// Exact command: `node --test --test-name-pattern="phase-closed publishes" test/enterprise-phase-closed.test.js`

test('phase-closed publishes: stacked phase 1 opens its PR, reconciles the summary, and stores the stack proof', (t) => {
  const fixture = phaseClosedFixture(t);
  const event = phaseClosedEvent();

  const response = dispatchPhaseClosed(fixture, event);

  assert.equal(validateAdapterResponse(response, event.event_id).ok, true, JSON.stringify(response));
  assert.equal(response.status, 'succeeded', JSON.stringify(response));
  assert.deepEqual(response.notices.map((notice) => notice.code), ['PR_CREATED'], JSON.stringify(response));
  assert.equal(prCreateCalls(fixture).length, 1, 'exactly one pr create');
  assert.equal(flagValue(prCreateCalls(fixture)[0], '--base'), 'main', 'phase 1 must target the root base');
  const prNumber = fixture.remote.prs[0].number;
  const createIndex = fixture.remote.calls.indexOf(prCreateCalls(fixture)[0]);
  const summaryUpsert = fixture.remote.calls.findIndex((args, index) => index > createIndex
    && args[0] === 'api' && args[1] === `repos/${PC_OWNER}/${PC_REPO}/issues/${prNumber}/comments`);
  assert.ok(summaryUpsert > createIndex, 'the phase summary must be upserted on the created PR after pr create');
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  const stack = meta.phases['phase-1'].stack;
  assert.ok(stack && stack.proof, 'metadata must hold the stack proof');
  assert.equal(response.proof_hash, stack.proof.proof_hash);
  assert.equal(response.proof_ref, 'meta:phases.phase-1.stack.proof');
  assert.equal(meta.phases['phase-1'].github_pr.number, prNumber);
});


// RED cycle 2
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given the phase-closed event already succeeded with its stored stack proof, When dispatched again as succeeded, Then status succeeded, the same proof, and zero gh calls.
// Exercise through: dispatchEvent
// Test doubles: fake gh counting calls (fixture.remote.calls); real git with bare origin
// Expected RED: the handler re-runs the publisher on replay
// Exact command: `node --test --test-name-pattern="phase-closed replay" test/enterprise-phase-closed.test.js`

test('phase-closed replay: a succeeded event replays its stored stack proof with zero gh calls', (t) => {
  const fixture = phaseClosedFixture(t);
  const pending = phaseClosedEvent();
  const first = dispatchPhaseClosed(fixture, pending);
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  const callsAfterFirst = fixture.remote.calls.length;
  const succeeded = {
    ...pending,
    delivery: { status: 'succeeded', attempts: 1, proof_ref: first.proof_ref, proof_hash: first.proof_hash },
  };

  const replay = dispatchPhaseClosed(fixture, succeeded);

  assert.equal(replay.status, 'succeeded', JSON.stringify(replay));
  assert.equal(replay.proof_ref, first.proof_ref);
  assert.equal(replay.proof_hash, first.proof_hash);
  assert.equal(fixture.remote.calls.length, callsAfterFirst, 'a succeeded replay must make no GitHub call');
});

// RED cycle 3
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given `reviews/closeout-phase-1.md` altered after the event was committed, When the pending event is dispatched, Then terminal STALE_ARTIFACT and zero gh calls.
// Exercise through: dispatchEvent
// Test doubles: fake gh counting calls (fixture.remote.calls); real git with bare origin
// Expected RED: the snapshot ref is not verified before publishing
// Exact command: `node --test --test-name-pattern="phase-closed stale snapshot" test/enterprise-phase-closed.test.js`

test('phase-closed stale snapshot: an altered closeout snapshot is STALE_ARTIFACT with zero gh calls and no push', (t) => {
  const fixture = phaseClosedFixture(t);
  fs.appendFileSync(path.join(fixture.planDir, PC_SNAPSHOT_PATH), 'edited after the event was committed\n');

  const response = dispatchPhaseClosed(fixture, phaseClosedEvent());

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'STALE_ARTIFACT', JSON.stringify(response));
  assert.equal(fixture.remote.calls.length, 0, 'a stale snapshot must stop before any GitHub call');
  assert.equal(remoteHasBranch(fixture, PC_BRANCH), false, 'a stale snapshot must not push the phase branch');
});

// RED cycle 4
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given a registration without push_consent and no approval, When the pending event is dispatched, Then status retryable, error code PUSH_CONSENT_REQUIRED, and zero `pr create` calls.
// Exercise through: dispatchEvent
// Test doubles: fake gh counting calls; real git with bare origin
// Expected RED: the publisher's error is mapped to a generic handler failure
// Exact command: `node --test --test-name-pattern="phase-closed consent error" test/enterprise-phase-closed.test.js`

test('phase-closed consent error: missing push consent is retryable PUSH_CONSENT_REQUIRED with no pr create', (t) => {
  const fixture = phaseClosedFixture(t, { consent: false });

  const response = dispatchPhaseClosed(fixture, phaseClosedEvent());

  assert.equal(response.status, 'retryable', JSON.stringify(response));
  assert.equal(response.error.code, 'PUSH_CONSENT_REQUIRED', JSON.stringify(response));
  assert.equal(prCreateCalls(fixture).length, 0, 'no pr create without consent');
  assert.equal(remoteHasBranch(fixture, PC_BRANCH), false, 'nothing pushed without consent');
});

// RED cycle 5
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given a schema-1 non-stacked lifecycle doc and a phase-closed event, When dispatched, Then terminal PHASE_CLOSED_NOT_STACKED and zero gh calls.
// Exercise through: dispatchEvent
// Test doubles: fake gh counting calls
// Expected RED: the handler proceeds to publish
// Exact command: `node --test --test-name-pattern="phase-closed not stacked" test/enterprise-phase-closed.test.js`

test('phase-closed not stacked: a schema-1 plan is terminal PHASE_CLOSED_NOT_STACKED with no publish', (t) => {
  const fixture = phaseClosedFixture(t, { stacked: false });

  const response = dispatchPhaseClosed(fixture, phaseClosedEvent());

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'PHASE_CLOSED_NOT_STACKED', JSON.stringify(response));
  assert.equal(fixture.remote.calls.length, 0, 'a non-stacked plan must make no GitHub call');
  assert.equal(remoteHasBranch(fixture, PC_BRANCH), false, 'a non-stacked plan must not push');
});

// RED cycle 6
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given origin's phase branch diverged from local (publisher returns terminal PR_BLOCKED), When dispatched, Then status terminal, error code PR_BLOCKED, and no `phases.<key>.stack.proof` is written.
// Exercise through: dispatchEvent
// Test doubles: fake gh; real git with bare origin
// Expected RED: all publisher errors are mapped to retryable
// Exact command: `node --test --test-name-pattern="phase-closed terminal error" test/enterprise-phase-closed.test.js`

test('phase-closed terminal error: a diverged origin phase branch is terminal PR_BLOCKED and stores no proof', (t) => {
  const fixture = phaseClosedFixture(t);
  const other = path.join(fixture.root, 'other');
  gitIn(fixture.root, 'clone', '-q', fixture.origin, other);
  gitIn(other, 'config', 'user.name', 'Pocket Other');
  gitIn(other, 'config', 'user.email', 'pocket-other@example.com');
  gitIn(other, 'switch', '-q', '-c', PC_BRANCH, 'origin/main');
  commitFileIn(other, 'remote-only.txt', 'remote only\n', 'remote-only work');
  gitIn(other, 'push', '-q', 'origin', PC_BRANCH);

  const response = dispatchPhaseClosed(fixture, phaseClosedEvent());

  assert.equal(response.status, 'terminal', JSON.stringify(response));
  assert.equal(response.error.code, 'PR_BLOCKED', JSON.stringify(response));
  assert.equal(prCreateCalls(fixture).length, 0, 'a blocked publish must not create a PR');
  const meta = enterpriseMeta.readMetaFor(fixture.specDir);
  const entry = meta.phases && meta.phases['phase-1'];
  assert.ok(!(entry && entry.stack && entry.stack.proof), 'a terminal publish error must store no stack proof');
});

// RED cycle 7
// Test file: `test/enterprise-phase-closed.test.js`
// Level: integration
// Test intent: Given the fake gh has no owned open plan issue, When dispatched, Then retryable ISSUE_REQUIRED, zero `pr create` calls, nothing pushed.
// Exercise through: dispatchEvent
// Test doubles: fake gh; real git with bare origin
// Expected RED: the PR is published before issue ownership is checked
// Exact command: `node --test --test-name-pattern="phase-closed issue missing" test/enterprise-phase-closed.test.js`

test('phase-closed issue missing: no owned open issue is retryable ISSUE_REQUIRED with no push or pr create', (t) => {
  const fixture = phaseClosedFixture(t, { issueRecorded: false });

  const response = dispatchPhaseClosed(fixture, phaseClosedEvent());

  assert.equal(response.status, 'retryable', JSON.stringify(response));
  assert.equal(response.error.code, 'ISSUE_REQUIRED', JSON.stringify(response));
  assert.equal(prCreateCalls(fixture).length, 0, 'no pr create without an owned issue');
  assert.equal(remoteHasBranch(fixture, PC_BRANCH), false, 'nothing pushed without an owned issue');
});
