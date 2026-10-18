'use strict';

// Integration tests for enterprise/phase-stack.js (T11).
// Real git against a temp bare origin; gh is a fake runner that records argv,
// reads --body-file contents at call time, and answers from in-memory PR state.
// Each test title carries its RED-cycle pattern so
// `node --test --test-name-pattern="<pattern>"` selects that cycle.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const enterpriseMeta = require('../enterprise/meta');
const { stackBlock, phasePrBody, upsertStackBlock } = require('../enterprise/stack-body');
const { publishPhase } = require('../enterprise/phase-stack');
const { resolvePhasePr, resolveRepository } = require('../enterprise/phase-handler-targets');
const { installFakeGitHub, createEnvironment } = require('./integration/support/fixture');
const { ENTERPRISE_CLI, CORE_CLI } = require('./integration/support/constants');

// Guard: any accidental real `gh` resolves to this stub, which refuses to run.
// Tests must reach gh only through the injected fake runner.
const GH_GUARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-stack-gh-guard-'));
fs.writeFileSync(path.join(GH_GUARD_DIR, 'gh'), '#!/bin/sh\necho "real gh is forbidden in phase-stack tests" >&2\nexit 97\n', { mode: 0o755 });
process.env.PATH = `${GH_GUARD_DIR}${path.delimiter}${process.env.PATH}`;
process.on('exit', () => fs.rmSync(GH_GUARD_DIR, { recursive: true, force: true }));

const PLAN_ID = 'p';
const OWNER = 'pocketto-test';
const REPO = 'phase-stack';
const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
const ISSUE_NUMBER = 31;
const ROOT_BASE = 'feature/x';
const CONSENT = Object.freeze({ scope: 'pocket-phase-branches', force: false });
const CLOSEOUT = '## Closeout\n\nPhase closed with its evidence.\n';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd, name, text, message) {
  fs.writeFileSync(path.join(cwd, name), text);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', message);
}

// Temp bare origin plus a work clone. feature/x is pushed to origin; the
// phase-1 branch exists locally with one commit and is NOT pushed.
function setupRepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-stack-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-q', origin);
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', ROOT_BASE);
  git(work, 'config', 'user.name', 'Pocket Test');
  git(work, 'config', 'user.email', 'pocket-test@example.com');
  commitFile(work, 'README.md', 'root base\n', 'root base');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '-u', 'origin', ROOT_BASE);
  git(work, 'switch', '-q', '-c', 'pocket/p/phase-1');
  commitFile(work, 'phase1.txt', 'phase one\n', 'phase one work');
  // The durable root-base record that `log init --phase-branches stacked` writes (see cli/lib/phase-branches.js).
  git(work, 'config', 'branch.pocket/p/phase-1.pocketRootBase', ROOT_BASE);
  const specDir = path.join(work, 'docs', 'pocket', 'spec', PLAN_ID);
  fs.mkdirSync(specDir, { recursive: true });
  enterpriseMeta.setIssueIdentity(specDir, {
    number: ISSUE_NUMBER,
    url: `${REPO_URL}/issues/${ISSUE_NUMBER}`,
  });
  return {
    root,
    origin,
    work,
    specDir,
    phase1Head: git(work, 'rev-parse', '--verify', 'refs/heads/pocket/p/phase-1'),
  };
}

// Fake gh: records argv, reads --body-file at call time (the publisher deletes it
// after the call returns), and answers pr view/list/create/edit from PR state.
function fakeGh(options = {}) {
  const state = {
    calls: [],
    prs: [],
    nextNumber: options.firstPrNumber || 100,
    failures: Object.assign({}, options.failures || {}),
  };

  function json(value) {
    return { exit: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false };
  }

  function fail(stderr) {
    return { exit: 1, stdout: '', stderr, timedOut: false };
  }

  function publicPr(pr) {
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      title: pr.title,
      body: pr.body,
      headRefOid: null,
      isCrossRepository: pr.isCrossRepository === true,
    };
  }

  function run(args) {
    state.calls.push(args.slice());
    const [group, verb] = args;
    if (group === 'repo' && verb === 'view') {
      return json({ owner: { login: OWNER }, name: REPO, url: REPO_URL });
    }
    if (group === 'pr' && verb === 'view') return viewPr(Number(args[2]));
    if (group === 'pr' && verb === 'list') return listPrs(args);
    if (group === 'pr' && verb === 'create') return createPr(args);
    if (group === 'pr' && verb === 'edit') return editPr(args);
    return fail(`unexpected fake gh call: ${args.join(' ')}`);
  }

  function viewPr(number) {
    if (state.failures.view && state.failures.view[number]) return state.failures.view[number];
    const pr = state.prs.find((candidate) => candidate.number === number);
    if (!pr) return fail(`GraphQL: Could not resolve to a PullRequest with the number of ${number}.`);
    return json(publicPr(pr));
  }

  function listPrs(args) {
    if (state.failures.list) return state.failures.list;
    const head = valueFor(args, '--head');
    const base = valueFor(args, '--base');
    const stateFilter = (valueFor(args, '--state') || 'open').toUpperCase();
    const matches = state.prs.filter((pr) => (
      (head === null || pr.headRefName === head)
      && (base === null || pr.baseRefName === base)
      && pr.state === stateFilter
    ));
    return json(matches.map(publicPr));
  }

  // GitHub cannot open a PR for a head branch that is not on origin. `state.originDir` is set by
  // `publish`; a test that never publishes keeps the check off.
  function headOnOrigin(branch) {
    if (!state.originDir) return true;
    const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: state.originDir, encoding: 'utf8' });
    return res.status === 0;
  }

  function createPr(args) {
    if (state.failures.create) return state.failures.create;
    if (!headOnOrigin(valueFor(args, '--head'))) {
      return fail(`GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between base and head, Head ref must be a branch (createPullRequest)`);
    }
    const number = state.nextNumber;
    state.nextNumber += 1;
    const pr = {
      number,
      url: `${REPO_URL}/pull/${number}`,
      state: 'OPEN',
      headRefName: valueFor(args, '--head'),
      baseRefName: valueFor(args, '--base'),
      title: valueFor(args, '--title'),
      body: readBodyFile(args),
    };
    state.prs.push(pr);
    return { exit: 0, stdout: `${pr.url}\n`, stderr: '', timedOut: false };
  }

  function editPr(args) {
    if (state.failures.edit) return state.failures.edit;
    const number = Number(args[2]);
    const pr = state.prs.find((candidate) => candidate.number === number);
    if (!pr) return fail(`pull request ${number} not found`);
    pr.body = readBodyFile(args);
    return { exit: 0, stdout: `${pr.url}\n`, stderr: '', timedOut: false };
  }

  return { run, state };
}

function valueFor(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

function readBodyFile(args) {
  const file = valueFor(args, '--body-file');
  return file === null ? null : fs.readFileSync(file, 'utf8');
}

function phase1() {
  return { key: 'phase-1', order: 1, count: 2, branch: 'pocket/p/phase-1', baseBranch: ROOT_BASE, parentKey: null };
}

function phase2() {
  return { key: 'phase-2', order: 2, count: 2, branch: 'pocket/p/phase-2', baseBranch: 'pocket/p/phase-1', parentKey: 'phase-1' };
}

function publish(env, gh, overrides = {}) {
  gh.state.originDir = env.origin;
  return publishPhase({
    projectRoot: env.work,
    specDir: env.specDir,
    planId: PLAN_ID,
    phase: overrides.phase || phase1(),
    closeoutSnapshot: CLOSEOUT,
    registration: 'registration' in overrides ? overrides.registration : { push_consent: CONSENT },
    options: { ghRunner: gh.run, gitRunner: overrides.gitRunner },
  });
}

function readMeta(specDir) {
  return JSON.parse(fs.readFileSync(path.join(specDir, '.pocket-meta.json'), 'utf8'));
}

function callsOf(gh, verb) {
  return gh.state.calls.filter((args) => args[0] === 'pr' && args[1] === verb);
}

// Git seam recorder: records every argv. A subcommand named in `failOn` returns its
// canned result instead of running; every other call runs real git against the temp repo.
function recordingGit(failOn = {}) {
  const calls = [];
  function run(args, opts = {}) {
    calls.push(args.slice());
    if (failOn[args[0]]) return failOn[args[0]];
    const res = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeoutMs || 30000 });
    return {
      exit: typeof res.status === 'number' ? res.status : 1,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      stderr: typeof res.stderr === 'string' ? res.stderr : '',
    };
  }
  return { run, calls };
}

function pushCalls(git) {
  return git.calls.filter((args) => args[0] === 'push');
}

test('publish root: pushes phase 1 without force and creates a PR based on root_base', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();

  const result = publish(env, gh);

  assert.equal(git(env.origin, 'rev-parse', '--verify', 'refs/heads/pocket/p/phase-1'), env.phase1Head);
  const creates = callsOf(gh, 'create');
  assert.equal(creates.length, 1, 'exactly one pr create call');
  assert.equal(valueFor(creates[0], '--base'), ROOT_BASE);
  assert.equal(valueFor(creates[0], '--head'), 'pocket/p/phase-1');
  const expectedBody = phasePrBody({
    closeoutSnapshot: CLOSEOUT,
    block: stackBlock({
      planId: PLAN_ID,
      phaseKey: 'phase-1',
      phaseOrder: 1,
      phaseCount: 2,
      baseBranch: ROOT_BASE,
      parentPr: null,
    }),
    issueLink: { issue: ISSUE_NUMBER, finalPhase: false },
  });
  assert.equal(gh.state.prs[0].body, expectedBody);
  assert.equal(result.created, true);

  const identity = readMeta(env.specDir).phases['phase-1'].github_pr;
  assert.equal(identity.number, gh.state.prs[0].number);
  assert.equal(identity.head, 'pocket/p/phase-1');
  assert.equal(identity.base, ROOT_BASE);
  assert.equal(identity.head_sha, env.phase1Head);
});

test('publish single phase: a one-phase plan targets the root base and closes its issue', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const single = { key: 'phase-1', order: 1, count: 1, branch: 'pocket/p/phase-1', baseBranch: ROOT_BASE, parentKey: null };

  publish(env, gh, { phase: single });

  const body = gh.state.prs[0].body;
  assert.equal(body.trimEnd().split('\n').pop(), `closes #${ISSUE_NUMBER}`, 'the only phase is the final phase, so closes is used');
});

test('publish child: phase 2 PR targets the phase 1 branch and records parent_pr', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const parent = publish(env, gh);
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');

  publish(env, gh, { phase: phase2() });

  const creates = callsOf(gh, 'create');
  assert.equal(creates.length, 2, 'one create per phase');
  assert.equal(valueFor(creates[1], '--base'), 'pocket/p/phase-1');
  assert.equal(valueFor(creates[1], '--head'), 'pocket/p/phase-2');
  const expectedBody = phasePrBody({
    closeoutSnapshot: CLOSEOUT,
    block: stackBlock({
      planId: PLAN_ID,
      phaseKey: 'phase-2',
      phaseOrder: 2,
      phaseCount: 2,
      baseBranch: 'pocket/p/phase-1',
      parentPr: parent.pr.number,
    }),
    issueLink: { issue: ISSUE_NUMBER, finalPhase: false },
  });
  assert.equal(gh.state.prs[1].body, expectedBody);
  assert.equal(readMeta(env.specDir).phases['phase-2'].github_pr.parent_pr, parent.pr.number);
});

function remoteRef(env, branch) {
  try {
    return git(env.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

test('publish consent missing: blocks the push with a retryable PUSH_CONSENT_REQUIRED', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();

  assert.throws(() => publish(env, gh, { registration: {} }), (error) => {
    assert.equal(error.code, 'PUSH_CONSENT_REQUIRED');
    assert.equal(error.retryable, true);
    assert.match(error.message, /pocket\/p\/phase-1/);
    assert.ok(error.message.includes(env.phase1Head), 'message carries the local SHA');
    assert.match(error.message, /absent/, 'message carries the remote SHA or "absent"');
    assert.match(error.message, /consent-push/);
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'nothing pushed to origin');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

test('publish stale approval: an approval bound to an older SHA does not authorize the push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const olderSha = git(env.work, 'rev-parse', 'HEAD~1');
  enterpriseMeta.setPushApproval(env.specDir, 'phase-1', { sha: olderSha });

  assert.throws(() => publish(env, gh, { registration: {} }), (error) => {
    assert.equal(error.code, 'PUSH_CONSENT_REQUIRED');
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'nothing pushed for a stale approval');
  assert.equal(callsOf(gh, 'create').length, 0);

  enterpriseMeta.setPushApproval(env.specDir, 'phase-1', { sha: env.phase1Head });
  const result = publish(env, gh, { registration: {} });

  assert.equal(remoteRef(env, 'pocket/p/phase-1'), env.phase1Head, 'pushed once approval matches local head');
  assert.equal(result.created, true);
});

test('publish diverged: a remote phase branch tip absent locally blocks with PR_BLOCKED and no force', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const other = path.join(env.root, 'other');
  git(env.root, 'clone', '-q', '-b', ROOT_BASE, env.origin, other);
  git(other, 'config', 'user.name', 'Pocket Test');
  git(other, 'config', 'user.email', 'pocket-test@example.com');
  git(other, 'switch', '-q', '-c', 'pocket/p/phase-1');
  commitFile(other, 'remote-only.txt', 'pushed from elsewhere\n', 'remote only work');
  git(other, 'push', '-q', 'origin', 'pocket/p/phase-1');
  const remoteTip = remoteRef(env, 'pocket/p/phase-1');
  assert.notEqual(remoteTip, env.phase1Head);
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'remote branch diverged');
    assert.equal(error.retryable, false);
    assert.match(error.message, /diverged/);
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), remoteTip, 'origin tip unchanged');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('publish parent missing: a child whose parent branch is not on origin is blocked before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-1', { number: 100, url: `${REPO_URL}/pull/100` });
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');

  assert.throws(() => publish(env, gh, { phase: phase2() }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'parent branch not published');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-2'), null, 'child branch not pushed');
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'parent branch not pushed by the child publish');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

test('publish reuse upsert: an existing PR keeps its human body and gains one stack block', (t) => {
  const env = setupRepo(t);
  const human = 'Human notes that must survive.\n\nKeep this exactly.\n';
  const gh = fakeGh({ firstPrNumber: 77 });
  gh.state.prs.push({
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: human,
  });

  const result = publish(env, gh);

  assert.equal(callsOf(gh, 'create').length, 0, 'no duplicate pr create');
  const edits = callsOf(gh, 'edit');
  assert.equal(edits.length, 1, 'pr edit called once');
  assert.equal(edits[0][2], '77');
  const block = stackBlock({
    planId: PLAN_ID,
    phaseKey: 'phase-1',
    phaseOrder: 1,
    phaseCount: 2,
    baseBranch: ROOT_BASE,
    parentPr: null,
  });
  const edited = gh.state.prs[0].body;
  assert.ok(edited.startsWith(human), 'human text kept byte-for-byte');
  assert.equal(edited, `${human}\n${block}`);
  assert.equal(result.created, false);
  assert.equal(result.notice.code, 'PR_REUSED');
});

test('publish rerun noop: a body that already holds the current block is not edited or recreated', (t) => {
  const env = setupRepo(t);
  const block = stackBlock({
    planId: PLAN_ID,
    phaseKey: 'phase-1',
    phaseOrder: 1,
    phaseCount: 2,
    baseBranch: ROOT_BASE,
    parentPr: null,
  });
  const current = upsertStackBlock('Human notes.\n', block);
  const gh = fakeGh({ firstPrNumber: 77 });
  gh.state.prs.push({
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: current,
  });

  const result = publish(env, gh);

  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a rerun');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create on a rerun');
  assert.equal(gh.state.prs[0].body, current);
  assert.equal(result.notice.code, 'PR_REUSED');
});

test('publish ambiguous: two open PRs for the same head block with a terminal PR_BLOCKED', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  for (const number of [77, 78]) {
    gh.state.prs.push({
      number,
      url: `${REPO_URL}/pull/${number}`,
      state: 'OPEN',
      headRefName: 'pocket/p/phase-1',
      baseRefName: ROOT_BASE,
      title: 'p phase 1',
      body: 'Human text.\n',
    });
  }
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'ambiguous PR identity');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on ambiguous identity');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create on ambiguous identity');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('publish retargeted: a recorded PR whose base was changed on GitHub is blocked, never reused', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh({ firstPrNumber: 100 });
  publish(env, gh);
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');
  gh.state.prs.push({
    number: 101,
    url: `${REPO_URL}/pull/101`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-2',
    baseRefName: 'main',
    title: 'p phase 2',
    body: 'Human text.\n',
  });
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-2', { number: 101, url: `${REPO_URL}/pull/101` });
  const createsBefore = callsOf(gh, 'create').length;
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh, { phase: phase2() }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'base retargeted');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a retargeted PR');
  assert.equal(callsOf(gh, 'create').length, createsBefore, 'no pr create on a retargeted PR');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('publish malformed block: a reusable body with an unmatched start marker blocks without edit or metadata change', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh({ firstPrNumber: 77 });
  gh.state.prs.push({
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: 'Human text.\n<!-- pocket-stack-context:start -->\nno end marker here\n',
  });
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'STACK_BLOCK_MALFORMED');
    assert.match(error.message, /STACK_BLOCK_MALFORMED/);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a malformed body');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('publish root base missing: phase 1 with root_base only local is blocked before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  git(env.origin, 'update-ref', '-d', `refs/heads/${ROOT_BASE}`);
  assert.equal(remoteRef(env, ROOT_BASE), null, 'root base is local-only');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'root base not published');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'nothing pushed');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

test('publish notice hygiene: notice has no URL and unrelated metadata keys survive the PR identity write', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const metaPath = path.join(env.specDir, '.pocket-meta.json');
  const seeded = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  seeded.phases = { 'phase-1': { review: { fingerprints: ['abc123'] } } };
  fs.writeFileSync(metaPath, `${JSON.stringify(seeded, null, 2)}\n`);
  const before = readMeta(env.specDir);

  const result = publish(env, gh);

  assert.equal(result.notice.code, 'PR_CREATED');
  assert.ok(!result.notice.message.includes('http'), 'notice carries no URL');
  const after = readMeta(env.specDir);
  assert.deepEqual(after.github_issue, before.github_issue, 'issue identity unchanged');
  assert.deepEqual(after.phases['phase-1'].review, before.phases['phase-1'].review, 'review key unchanged');
  assert.equal(after.external_tracker, before.external_tracker);
  assert.equal(after.phases['phase-1'].github_pr.number, result.pr.number);
});

test('publish stale pr number: a not-found recorded PR falls back to the filtered list and is reused', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh({ firstPrNumber: 200 });
  gh.state.prs.push({
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: 'Human text.\n',
  });
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-1', { number: 999, url: `${REPO_URL}/pull/999` });

  const result = publish(env, gh);

  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
  assert.equal(result.pr.number, 77);
  assert.equal(result.notice.code, 'PR_REUSED');
  assert.equal(readMeta(env.specDir).phases['phase-1'].github_pr.number, 77, 'metadata updated to the found number');
});

test('publish pr view retryable: a timed-out recorded PR view is retryable and never falls back to the list', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh({ firstPrNumber: 200, failures: { view: { 500: { exit: 1, stdout: '', stderr: 'request timed out', timedOut: true } } } });
  gh.state.prs.push({
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: 'Human text.\n',
  });
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-1', { number: 500, url: `${REPO_URL}/pull/500` });

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'GH_TIMEOUT');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(callsOf(gh, 'list').length, 0, 'no pr list fallback on a transient view failure');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

test('publish existing pr rejected: pr create refused because a PR for the head already exists is terminal PR_BLOCKED', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh({
    failures: {
      create: {
        exit: 1,
        stdout: '',
        stderr: 'a pull request for branch "pocket/p/phase-1" into branch "feature/x" already exists: https://github.com/pocketto-test/phase-stack/pull/5',
        timedOut: false,
      },
    },
  });
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'existing PR for head');
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes('http'), 'remote-controlled text and URLs never reach the message');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('harden issue required: no recorded plan issue blocks with ISSUE_REQUIRED before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git = recordingGit();
  fs.rmSync(path.join(env.specDir, '.pocket-meta.json'));

  assert.throws(() => publish(env, gh, { gitRunner: git.run }), (error) => {
    assert.equal(error.code, 'ISSUE_REQUIRED');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(pushCalls(git).length, 0, 'no git push before the issue check');
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'nothing pushed to origin');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

test('harden base mismatch child: phase 2 whose base is not the parent phase branch is blocked before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  publish(env, gh);
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');
  const git2 = recordingGit();
  const createsBefore = callsOf(gh, 'create').length;
  const wrongBase = Object.assign(phase2(), { baseBranch: ROOT_BASE });

  assert.throws(() => publish(env, gh, { phase: wrongBase, gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'base mismatch');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(pushCalls(git2).length, 0, 'no push for a mismatched base');
  assert.equal(remoteRef(env, 'pocket/p/phase-2'), null, 'child branch not pushed');
  assert.equal(callsOf(gh, 'create').length, createsBefore, 'no pr create for a mismatched base');
});

test('harden root record mismatch: phase 1 whose base differs from the recorded root base is blocked before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  git(env.work, 'config', 'branch.pocket/p/phase-1.pocketRootBase', 'main');
  const git2 = recordingGit();

  assert.throws(() => publish(env, gh, { gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'base mismatch');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(pushCalls(git2).length, 0, 'no push for a mismatched root base');
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'phase branch not pushed');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create for a mismatched root base');
});

test('harden root record unrecorded: phase 1 without a recorded root base is blocked before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  git(env.work, 'config', '--unset', 'branch.pocket/p/phase-1.pocketRootBase');
  const git2 = recordingGit();

  assert.throws(() => publish(env, gh, { gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'root base unrecorded');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(pushCalls(git2).length, 0, 'no push without a recorded root base');
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'phase branch not pushed');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create without a recorded root base');
});

test('harden foreign list candidate: a listed PR on another base blocks without any edit', (t) => {
  const env = setupRepo(t);
  const foreign = {
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: 'main',
    title: 'p phase 1',
    body: 'Human text.\n',
  };
  const gh = fakeGh({ failures: { list: { exit: 0, stdout: JSON.stringify([foreign]), stderr: '', timedOut: false } } });
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'foreign PR in list');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a foreign candidate');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create on a foreign candidate');
  const listed = callsOf(gh, 'list');
  assert.equal(listed.length, 1);
  assert.match(valueFor(listed[0], '--json'), /(^|,)state(,|$)/, 'the list requests state so OPEN can be verified');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('harden open state filter: a listed CLOSED PR for this exact head and base is terminal PR_BLOCKED with no edit or create', (t) => {
  const env = setupRepo(t);
  const closed = {
    number: 78,
    url: `${REPO_URL}/pull/78`,
    state: 'CLOSED',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: 'Human text.\n',
  };
  const gh = fakeGh({ failures: { list: { exit: 0, stdout: JSON.stringify([closed]), stderr: '', timedOut: false } } });
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'foreign PR in list');
    assert.equal(error.retryable, false);
    assert.equal(error.status, 'terminal');
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a CLOSED candidate');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create on a CLOSED candidate');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('harden head ref filter: a listed OPEN PR on this base but another head is terminal PR_BLOCKED with no edit or create', (t) => {
  const env = setupRepo(t);
  const otherHead = {
    number: 79,
    url: `${REPO_URL}/pull/79`,
    state: 'OPEN',
    headRefName: 'pocket/other/phase-1',
    baseRefName: ROOT_BASE,
    title: 'other phase 1',
    body: 'Human text.\n',
  };
  const gh = fakeGh({ failures: { list: { exit: 0, stdout: JSON.stringify([otherHead]), stderr: '', timedOut: false } } });
  const metaBefore = fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8');

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'foreign PR in list');
    assert.equal(error.retryable, false);
    assert.equal(error.status, 'terminal');
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a foreign head candidate');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create on a foreign head candidate');
  assert.equal(fs.readFileSync(path.join(env.specDir, '.pocket-meta.json'), 'utf8'), metaBefore, 'metadata unchanged');
});

test('harden list not array: a non-array pr list is retryable GH_MALFORMED_OUTPUT with no create', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh({ failures: { list: { exit: 0, stdout: '{}', stderr: '', timedOut: false } } });

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'GH_MALFORMED_OUTPUT');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create when the list is malformed');
});

test('harden push argv: push is exactly -u origin branch and no argv on any path carries force', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git = recordingGit();

  publish(env, gh, { gitRunner: git.run });

  assert.deepEqual(pushCalls(git), [['push', '-u', 'origin', 'pocket/p/phase-1']]);
  assert.ok(git.calls.length > 0 && gh.state.calls.length > 0);
  for (const argv of git.calls) {
    assert.ok(!argv.some((arg) => arg.includes('force')), `force in git argv: ${argv.join(' ')}`);
  }
  // gh argv carries the random --body-file path, so only flag tokens are compared there.
  for (const argv of gh.state.calls) {
    assert.ok(!argv.some((arg) => /^--force|^-f$/.test(arg)), `force flag in gh argv: ${argv.join(' ')}`);
  }
});

test('harden push failed: a rejected git push is retryable PUSH_FAILED and creates no PR', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git = recordingGit({ push: { exit: 1, stdout: '', stderr: 'rejected by remote' } });

  assert.throws(() => publish(env, gh, { gitRunner: git.run }), (error) => {
    assert.equal(error.code, 'PUSH_FAILED');
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes('rejected by remote'), 'git stderr never reaches the message');
    return true;
  });
  assert.equal(pushCalls(git).length, 1, 'the push was attempted once');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create after a failed push');
});

test('harden remote unavailable: an unreadable origin is retryable REMOTE_UNAVAILABLE with no push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git = recordingGit({ 'ls-remote': { exit: 128, stdout: '', stderr: 'fatal: unable to access origin' } });

  assert.throws(() => publish(env, gh, { gitRunner: git.run }), (error) => {
    assert.equal(error.code, 'REMOTE_UNAVAILABLE');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(pushCalls(git).length, 0, 'no push when origin cannot be read');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create when origin cannot be read');
});

test('harden git unavailable: an undecidable ancestry check is retryable GIT_UNAVAILABLE and does not push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  git(env.work, 'push', '-q', 'origin', 'pocket/p/phase-1');
  const remoteTip = remoteRef(env, 'pocket/p/phase-1');
  commitFile(env.work, 'phase1-more.txt', 'more phase one\n', 'more phase one work');
  const git2 = recordingGit({ 'merge-base': { exit: 128, stdout: '', stderr: 'fatal: broken ancestry' } });

  assert.throws(() => publish(env, gh, { gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'GIT_UNAVAILABLE');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), remoteTip, 'origin tip unchanged');
  assert.equal(pushCalls(git2).length, 0, 'no push while ancestry is undecidable');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create while ancestry is undecidable');
});

test('harden branch missing: an absent local phase branch is PHASE_BRANCH_MISSING with no push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git2 = recordingGit();
  const missing = Object.assign(phase1(), { branch: 'pocket/p/phase-9' });

  assert.throws(() => publish(env, gh, { phase: missing, gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'PHASE_BRANCH_MISSING');
    return true;
  });
  assert.equal(pushCalls(git2).length, 0, 'no push for a missing local branch');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create for a missing local branch');
});

test('harden parent unrecorded: a child whose parent PR is not recorded is blocked before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  git(env.work, 'push', '-q', 'origin', 'pocket/p/phase-1');
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');
  const git2 = recordingGit();

  assert.throws(() => publish(env, gh, { phase: phase2(), gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'parent PR not recorded');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(pushCalls(git2).length, 0, 'no push without a recorded parent PR');
  assert.equal(remoteRef(env, 'pocket/p/phase-2'), null, 'child branch not pushed');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create without a recorded parent PR');
});

test('harden foreign view: a recorded PR from another repository is never reused and the list decides', (t) => {
  const env = setupRepo(t);
  const foreignUrl = 'https://github.com/other-owner/other-repo/pull/500';
  const foreignView = {
    number: 500,
    url: foreignUrl,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'p phase 1',
    body: 'Foreign text.\n',
  };
  const gh = fakeGh({
    firstPrNumber: 200,
    failures: { view: { 500: { exit: 0, stdout: JSON.stringify(foreignView), stderr: '', timedOut: false } } },
  });
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-1', { number: 500, url: foreignUrl });

  const result = publish(env, gh);

  assert.equal(result.created, true, 'the list found nothing, so a PR is created');
  assert.equal(result.pr.number, 200);
  assert.equal(callsOf(gh, 'edit').length, 0, 'the foreign PR is never edited');
  assert.equal(readMeta(env.specDir).phases['phase-1'].github_pr.number, 200, 'metadata points at the created PR');
});

test('harden list limit: pr list passes an explicit --limit above the gh default of 30', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();

  publish(env, gh);

  const limit = Number(valueFor(callsOf(gh, 'list')[0], '--limit'));
  assert.ok(limit > 30, `explicit --limit above the gh default, got ${limit}`);
});

test('harden root record unreadable: a failing config read is retryable GIT_UNAVAILABLE with no push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git = recordingGit({ config: { exit: 128, stdout: '', stderr: 'fatal: bad config' } });

  assert.throws(() => publish(env, gh, { gitRunner: git.run }), (error) => {
    assert.equal(error.code, 'GIT_UNAVAILABLE');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(pushCalls(git).length, 0, 'no push when the root base cannot be read');
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'nothing pushed to origin');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

test('harden closeout invalid: a PR body that cannot be built throws before any push', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const git = recordingGit();

  assert.throws(() => publishPhase({
    projectRoot: env.work,
    specDir: env.specDir,
    planId: PLAN_ID,
    phase: phase1(),
    closeoutSnapshot: undefined,
    registration: { push_consent: CONSENT },
    options: { ghRunner: gh.run, gitRunner: git.run },
  }));
  assert.equal(pushCalls(git).length, 0, 'no push when the PR body cannot be built');
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), null, 'nothing pushed to origin');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
});

// T15: the PATH-injected fake gh binary used by the publish-phase CLI tests.
test('fake gh stacked operations: pr create, filtered pr list, and pr edit record PRs like GitHub', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = installFakeGitHub(root);
  const env = createEnvironment(fake);
  const gh = (...args) => spawnSync(fake.fakeGhPath, args, { env, encoding: 'utf8' });
  const stateOf = () => JSON.parse(fs.readFileSync(fake.remotePath, 'utf8'));
  const bodyFile = path.join(root, 'body.md');
  fs.writeFileSync(bodyFile, 'first body\n');

  const created = gh('pr', 'create', '--head', 'pocket/p/phase-1', '--base', 'feature/x', '--title', 't', '--body-file', bodyFile);
  assert.equal(created.status, 0, created.stderr);
  const url = created.stdout.trim();
  assert.match(url, /\/pull\/\d+$/);
  const number = Number(url.split('/').pop());

  const listed = gh('pr', 'list', '--head', 'pocket/p/phase-1', '--base', 'feature/x', '--state', 'open', '--json', 'number,url,headRefName,baseRefName,body');
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.equal(rows.length, 1, 'the filtered list excludes the default feature PR');
  assert.equal(rows[0].number, number);
  assert.equal(rows[0].headRefName, 'pocket/p/phase-1');
  assert.equal(rows[0].baseRefName, 'feature/x');
  assert.equal(rows[0].body, 'first body\n');
  assert.equal(stateOf().pullRequests.find((pr) => pr.number === number).state, 'OPEN');

  const secondBody = path.join(root, 'body2.md');
  fs.writeFileSync(secondBody, 'second body\n');
  assert.equal(gh('pr', 'edit', String(number), '--body-file', secondBody).status, 0);
  const after = stateOf();
  assert.equal(after.pullRequests.find((pr) => pr.number === number).body, 'second body\n');
  assert.equal(after.calls.length, 3, 'every invocation is recorded');
});

// T15: publish-phase CLI process tests. A real handed-off stacked plan (Core CLI), a real
// bare origin, and the PATH-injected fake gh. No runner is injected into the CLI.
function runNode(cwd, env, args) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function okNode(cwd, env, args) {
  const result = runNode(cwd, env, args);
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
  return result;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Plan `p` with two phases; phase 1 is DONE and handed off, so HEAD sits on pocket/p/phase-2.
function handedOffPlan(t, { stacked = true, consent = true, lifecycle = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-phase-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = installFakeGitHub(root);
  const env = { ...createEnvironment(fake), POCKETTO_LIFECYCLE_NOW: '2026-10-10T00:00:00.000Z' };
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-q', origin);
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', ROOT_BASE);
  git(work, 'config', 'user.name', 'Pocket Test');
  git(work, 'config', 'user.email', 'pocket-test@example.com');
  git(work, 'config', 'commit.gpgsign', 'false');
  writeText(path.join(work, 'README.md'), 'root base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'root base');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '-u', 'origin', ROOT_BASE);

  const planDir = path.join(work, 'docs', 'pocket', 'plans', PLAN_ID);
  const specDir = path.join(work, 'docs', 'pocket', 'spec', PLAN_ID);
  const specBody = '# Approved spec\n';
  writeText(path.join(specDir, 'approved-spec.md'), specBody);
  writeText(path.join(planDir, 'execution-plan', 'index.md'), '# Plan Index\n\n**Spec:** ../../spec/p/approved-spec.md\n');
  for (const order of [1, 2]) {
    writeText(path.join(planDir, 'execution-plan', `phase-${order}.md`), `# Phase ${order}: Fixture\n\n### Task ${order}: Behavior ${order}\n\nBody.\n`);
  }
  const envelopes = {};
  const core = (...args) => JSON.parse(okNode(work, env, [CORE_CLI, ...args, '--json', '--contract', '3']).stdout);
  envelopes.init = core('log', 'init', planDir, '--phase-branches', stacked ? 'stacked' : 'none');
  if (lifecycle) {
    const specHash = require('node:crypto').createHash('sha256').update(specBody).digest('hex');
    core('lifecycle', 'transition', specDir, 'spec-approved', '--artifact', `spec:spec-doc:approved-spec.md:${specHash}`);
  }
  envelopes.review = core('log', 'update', planDir, 'execution-plan/phase-1.md', 'REVIEW');
  envelopes.done = core('log', 'update', planDir, 'execution-plan/phase-1.md', 'DONE');
  if (stacked) {
    writeText(path.join(planDir, 'closeout.md'), [
      '# Pocket Closeout - Fixture', '',
      '## Phase 1 of 2 - Fixture phase 1', '<!-- pocket-closeout:phase-1 -->', '',
      '**Status:** Complete', '', '### What was completed', '', '- T1 done', '',
    ].join('\n'));
    envelopes.handoff = core('log', 'handoff', planDir, 'execution-plan/phase-1.md');
  }
  const installArgs = [ENTERPRISE_CLI, 'install', work, '--phase-branches', stacked ? 'stacked' : 'none'];
  if (consent) installArgs.push('--push-consent', 'phase-branches');
  okNode(work, env, [...installArgs, '--json']);
  enterpriseMeta.setIssueIdentity(specDir, { number: 73, url: 'https://github.com/acme/pocketto/issues/73' });
  return { root, work, origin, planDir, specDir, env, fake, envelopes };
}

function publishCli(plan, phaseKey = 'phase-1') {
  const result = runNode(plan.work, plan.env, [ENTERPRISE_CLI, 'publish-phase', plan.work, plan.specDir, phaseKey, '--json']);
  let envelope = null;
  try { envelope = JSON.parse(result.stdout); } catch { envelope = null; }
  return { ...result, envelope };
}

function fakeState(plan) {
  return JSON.parse(fs.readFileSync(plan.fake.remotePath, 'utf8'));
}

function prsForHead(plan, head) {
  return fakeState(plan).pullRequests.filter((pr) => pr.headRefName === head);
}

function originHas(plan, branch) {
  return execFileSync('git', ['ls-remote', '--heads', plan.origin, branch], { encoding: 'utf8' }).trim().length > 0;
}

test('publish-phase creates: a handed-off phase 1 with consent opens its PR against the root base', (t) => {
  const plan = handedOffPlan(t);

  const { envelope, stderr } = publishCli(plan);

  assert.ok(envelope && envelope.ok === true, JSON.stringify(envelope) + stderr);
  assert.equal(envelope.command, 'enterprise-publish-phase');
  assert.equal(envelope.data.phase_key, 'phase-1');
  assert.equal(envelope.data.created, true);
  assert.ok(Number.isInteger(envelope.data.pr_number) && envelope.data.pr_url.endsWith(`/pull/${envelope.data.pr_number}`));
  assert.ok(Array.isArray(envelope.data.notices) && envelope.data.notices[0].code === 'PR_CREATED');
  const prs = prsForHead(plan, 'pocket/p/phase-1');
  assert.equal(prs.length, 1);
  assert.equal(prs[0].baseRefName, ROOT_BASE);
  assert.ok(originHas(plan, 'pocket/p/phase-1'), 'the phase branch is pushed to origin');
});

test('publish-phase rerun: a second run reuses the PR instead of creating another', (t) => {
  const plan = handedOffPlan(t);
  assert.equal(publishCli(plan).envelope.data.created, true);

  const { envelope } = publishCli(plan);

  assert.ok(envelope && envelope.ok === true, JSON.stringify(envelope));
  assert.equal(envelope.data.created, false);
  assert.equal(prsForHead(plan, 'pocket/p/phase-1').length, 1);
});

test('publish-phase no consent: without push_consent or approval nothing is pushed', (t) => {
  const plan = handedOffPlan(t, { consent: false });

  const { envelope } = publishCli(plan);

  assert.ok(envelope && envelope.ok === false, JSON.stringify(envelope));
  assert.equal(envelope.error.code, 'PUSH_CONSENT_REQUIRED');
  assert.equal(originHas(plan, 'pocket/p/phase-1'), false, 'origin has no phase branch');
  assert.equal(prsForHead(plan, 'pocket/p/phase-1').length, 0);
});

test('publish-phase no lifecycle writes: lifecycle.json is byte-identical after a successful run', (t) => {
  const plan = handedOffPlan(t);
  const lifecycle = path.join(plan.specDir, 'lifecycle.json');
  const before = fs.readFileSync(lifecycle);

  assert.equal(publishCli(plan).envelope.ok, true);

  assert.deepEqual(fs.readFileSync(lifecycle), before);
});

test('publish-phase not stacked: a non-stacked plan is refused with zero gh calls', (t) => {
  const plan = handedOffPlan(t, { stacked: false });

  const { envelope } = publishCli(plan);

  assert.ok(envelope && envelope.ok === false, JSON.stringify(envelope));
  assert.equal(envelope.error.code, 'PHASE_CLOSED_NOT_STACKED');
  assert.equal(fakeState(plan).calls.length, 0);
});

// Issue #84: a stacked plan whose spec never went through spec-approved has no lifecycle.json.
test('publish-phase missing lifecycle: reports PHASE_LIFECYCLE_MISSING with the recovery command, not a path violation', (t) => {
  const plan = handedOffPlan(t, { lifecycle: false });
  assert.equal(fs.existsSync(path.join(plan.specDir, 'lifecycle.json')), false);

  for (const projectRoot of [plan.work, path.relative(plan.work, plan.work) || '.']) {
    const result = runNode(plan.work, plan.env, [ENTERPRISE_CLI, 'publish-phase', projectRoot, plan.specDir, 'phase-1', '--json']);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, 'enterprise-publish-phase');
    assert.equal(envelope.error.code, 'PHASE_LIFECYCLE_MISSING', JSON.stringify(envelope));
    assert.match(envelope.error.message, /docs\/pocket\/spec\/p\/lifecycle\.json not found/);
    assert.match(envelope.error.message, /pocketto-pi lifecycle transition docs\/pocket\/spec\/p spec-approved/);
    assert.doesNotMatch(envelope.error.message, /Lifecycle lifecycle/i);
  }
  assert.equal(fakeState(plan).calls.length, 0);
  assert.equal(originHas(plan, 'pocket/p/phase-1'), false);
});

// Issue #84: Core surfaces the missing lifecycle document at init, on every phase-level
// update, and when handoff could not record phase-closed, instead of reporting clean success.
test('core missing lifecycle: stacked init, update, and handoff warn LIFECYCLE_DOCUMENT_MISSING', (t) => {
  const plan = handedOffPlan(t, { lifecycle: false });
  const expectedPath = path.join(plan.specDir, 'lifecycle.json');
  for (const step of ['init', 'review', 'done', 'handoff']) {
    const envelope = plan.envelopes[step];
    assert.equal(envelope.ok, true, step);
    const warnings = envelope.data.warnings.filter((warning) => warning.code === 'LIFECYCLE_DOCUMENT_MISSING');
    assert.equal(warnings.length, 1, `${step}: ${JSON.stringify(envelope.data.warnings)}`);
    assert.equal(warnings[0].path, expectedPath);
    assert.match(warnings[0].fix, /pocketto-pi lifecycle transition '.+' spec-approved --artifact spec:/);
  }
  assert.equal(plan.envelopes.handoff.data.steps.event, 'skipped');
  assert.deepEqual(plan.envelopes.handoff.data.next_actions, [],
    'approving a spec is the user decision, so the recovery is never a required next action');
});

test('lifecycle context: a dangling lifecycle.json symlink stays PHASE_LIFECYCLE_PATH_INVALID without a doubled label', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-dangling-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specDir = path.join(root, 'docs', 'pocket', 'spec', PLAN_ID);
  fs.mkdirSync(specDir, { recursive: true });
  const { loadContext } = require('../enterprise/phase-handler-context');

  assert.throws(() => loadContext({ plan_id: PLAN_ID }, { projectRoot: root }),
    (error) => error.code === 'PHASE_LIFECYCLE_MISSING');

  fs.symlinkSync(path.join(root, 'missing-target.json'), path.join(specDir, 'lifecycle.json'), 'file');
  assert.throws(() => loadContext({ plan_id: PLAN_ID }, { projectRoot: root }), (error) => {
    assert.equal(error.code, 'PHASE_LIFECYCLE_PATH_INVALID');
    assert.equal(error.message, 'Lifecycle document must resolve inside the registered project root.');
    return true;
  });
});

test('core with lifecycle: a stacked plan with lifecycle.json gets no LIFECYCLE_DOCUMENT_MISSING warning after approval', (t) => {
  const plan = handedOffPlan(t);
  for (const step of ['review', 'done', 'handoff']) {
    const codes = plan.envelopes[step].data.warnings.map((warning) => warning.code);
    assert.equal(codes.includes('LIFECYCLE_DOCUMENT_MISSING'), false, `${step}: ${codes}`);
  }
});

test('publish-phase stale snapshot: a snapshot edited after its event is STALE_ARTIFACT with nothing pushed', (t) => {
  const plan = handedOffPlan(t);
  const snapshot = path.join(plan.planDir, 'reviews', 'closeout-phase-1.md');
  fs.appendFileSync(snapshot, '\ntampered after the event\n');

  const { envelope } = publishCli(plan);

  assert.ok(envelope && envelope.ok === false, JSON.stringify(envelope));
  assert.equal(envelope.error.code, 'STALE_ARTIFACT');
  assert.equal(originHas(plan, 'pocket/p/phase-1'), false, 'nothing pushed');
  assert.equal(fakeState(plan).calls.filter((args) => args[0] === 'pr').length, 0, 'zero pr calls');
});

function forkPr(number, overrides = {}) {
  return {
    number,
    url: `${REPO_URL}/pull/${number}`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'fork',
    body: 'attacker body',
    isCrossRepository: true,
    ...overrides,
  };
}

test('fork hijack list: an open PR from a fork with our phase head is ignored, never edited or adopted', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  gh.state.prs.push(forkPr(50));

  const result = publish(env, gh);

  assert.equal(result.created, true, 'a fresh PR is created instead of adopting the fork PR');
  assert.equal(result.pr.number, 100);
  assert.deepEqual(result.notices.map((notice) => notice.code), ['PR_CREATED', 'FORK_PR_IGNORED'], 'the dropped fork PR is surfaced');
  assert.ok(!result.notices[1].message.includes('attacker'), 'the notice never echoes remote text');
  assert.equal(callsOf(gh, 'edit').length, 0, 'the fork PR body is never edited');
  assert.equal(gh.state.prs[0].body, 'attacker body');
});

test('fork hijack recorded: a recorded PR number that resolves to a fork PR is never reused', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  gh.state.prs.push(forkPr(50));
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-1', { number: 50, url: `${REPO_URL}/pull/50` });

  const result = publish(env, gh);

  assert.equal(result.created, true);
  assert.equal(result.pr.number, 100);
  assert.equal(callsOf(gh, 'edit').length, 0, 'the fork PR body is never edited');
  assert.equal(gh.state.prs[0].body, 'attacker body');
});

function parentEndedScenario(t, { parentState, reason, deleteParentBranch, retryable = false, pushes = 0 }) {
  const env = setupRepo(t);
  const gh = fakeGh();
  const parent = publish(env, gh);
  gh.state.prs[0].state = parentState;
  if (deleteParentBranch) git(env.origin, 'update-ref', '-d', `refs/heads/${phase1().branch}`);
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');
  const git2 = recordingGit();

  assert.throws(() => publish(env, gh, { phase: phase2(), gitRunner: git2.run }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, reason);
    assert.equal(error.retryable, retryable, retryable ? 'retryable: the operator can resolve it and rerun' : 'terminal: a rerun fails the same way');
    assert.ok(error.message.includes(`#${parent.pr.number}`), 'message names the parent PR');
    assert.ok(!error.message.includes('fix the base on GitHub'), 'no false base-fix advice');
    if (retryable) {
      assert.ok(error.message.includes('is on origin'), 'message says the branch is already pushed');
      assert.ok(error.message.includes('6 delivery attempts'), 'message names the drain attempt limit');
      assert.ok(error.message.length <= 500, 'message fits the adapter notice bound');
    }
    return true;
  });
  assert.equal(pushCalls(git2).length, pushes, pushes ? 'the child head is pushed so the operator can open its PR' : 'no push');
  for (const args of pushCalls(git2)) assert.ok(!args.some((arg) => /^--force|^-f$|^\+/.test(arg)), 'the push is never forced');
  assert.equal(originHasBranch(env, phase2().branch), pushes > 0, 'child head on origin only when pushed');
  assert.equal(callsOf(gh, 'create').length, 1, 'only the parent PR was created');
}

function originHasBranch(env, branch) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: env.origin }).status === 0;
}

test('parent merged: a child with no PR on the parent base pushes its head, then is a retryable PR_BLOCKED with no create', (t) => {
  parentEndedScenario(t, { parentState: 'MERGED', reason: 'parent PR merged', deleteParentBranch: false, retryable: true, pushes: 1 });
});

test('parent merged and deleted: a child whose parent branch was removed is told to open the PR, not to publish the parent', (t) => {
  parentEndedScenario(t, { parentState: 'MERGED', reason: 'parent PR merged', deleteParentBranch: true, retryable: true, pushes: 1 });
});

// A merged parent is the normal stacked flow. GitHub retargets the child PR to the parent's base,
// and Pocket reuses that PR instead of blocking. It never creates a PR on top of a merged parent.
function mergedParentEnv(t, { childBase, childOpen = true } = {}) {
  const env = setupRepo(t);
  const gh = fakeGh();
  const parent = publish(env, gh);
  git(env.work, 'switch', '-q', '-c', 'pocket/p/phase-2');
  commitFile(env.work, 'phase2.txt', 'phase two\n', 'phase two work');
  let child = null;
  if (childBase) {
    child = {
      number: 200,
      url: `${REPO_URL}/pull/200`,
      state: childOpen ? 'OPEN' : 'CLOSED',
      headRefName: 'pocket/p/phase-2',
      baseRefName: childBase,
      title: 'p phase 2',
      body: 'Human text.\n',
    };
    gh.state.prs.push(child);
  }
  gh.state.prs[0].state = 'MERGED';
  git(env.origin, 'update-ref', '-d', `refs/heads/${phase1().branch}`);
  return { env, gh, parent, child };
}

test('parent merged, child retargeted to the root: the existing child PR is reused, never created or retargeted', (t) => {
  const { env, gh, parent, child } = mergedParentEnv(t, { childBase: ROOT_BASE });

  const result = publish(env, gh, { phase: phase2() });

  assert.equal(result.created, false);
  assert.equal(result.pr.number, child.number);
  assert.equal(result.notice.code, 'PR_REUSED');
  assert.equal(result.base, ROOT_BASE, 'the published base is the retargeted base');
  assert.equal(callsOf(gh, 'create').length, 1, 'only the parent PR was ever created');
  assert.ok(child.body.includes(`Parent PR: #${parent.pr.number}`), 'the stack block still names the merged parent');
  assert.ok(child.body.includes(`Base branch: \`${ROOT_BASE}\``), 'the stack block names the real base');
  assert.ok(child.body.startsWith('Human text.'), 'human text is kept');
  const identity = enterpriseMeta.getPrIdentity(env.specDir, 'phase-2');
  assert.equal(identity.number, child.number);
});

test('parent merged, recorded child PR retargeted to the root: reused through metadata', (t) => {
  const { env, gh, child } = mergedParentEnv(t, { childBase: ROOT_BASE });
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-2', { number: child.number, url: child.url });

  const result = publish(env, gh, { phase: phase2() });

  assert.equal(result.created, false);
  assert.equal(result.pr.number, child.number);
  assert.equal(callsOf(gh, 'create').length, 1);
});

test('parent merged, recorded child PR still on the old base: blocked with the base advice', (t) => {
  const { env, gh, child } = mergedParentEnv(t, { childBase: 'pocket/p/phase-1' });
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-2', { number: child.number, url: child.url });

  assert.throws(() => publish(env, gh, { phase: phase2() }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'base retargeted');
    assert.ok(error.message.includes(ROOT_BASE), 'the message names the base the PR must target');
    return true;
  });
  assert.equal(callsOf(gh, 'create').length, 1);
  assert.equal(callsOf(gh, 'edit').length, 0);
});

test('parent merged, child PR closed: not reused and not recreated', (t) => {
  const { env, gh } = mergedParentEnv(t, { childBase: ROOT_BASE, childOpen: false });

  assert.throws(() => publish(env, gh, { phase: phase2() }), (error) => {
    assert.equal(error.reason, 'parent PR merged');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(callsOf(gh, 'create').length, 1);
});

test('parent closed: a child whose parent PR was closed without merge is terminal PR_BLOCKED with no push', (t) => {
  parentEndedScenario(t, { parentState: 'CLOSED', reason: 'parent PR closed', deleteParentBranch: false });
});

test('publish race: a create refused as already existing reuses the PR the re-list finds', (t) => {
  const env = setupRepo(t);
  const gh = fakeGh();
  const realRun = gh.run;
  let listCalls = 0;
  gh.state.prs.push({
    number: 77,
    url: `${REPO_URL}/pull/77`,
    state: 'OPEN',
    headRefName: 'pocket/p/phase-1',
    baseRefName: ROOT_BASE,
    title: 'racer',
    body: 'human body',
  });
  gh.run = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      listCalls += 1;
      if (listCalls === 1) {
        gh.state.calls.push(args.slice());
        return { exit: 0, stdout: '[]', stderr: '', timedOut: false };
      }
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      gh.state.calls.push(args.slice());
      return {
        exit: 1,
        stdout: '',
        stderr: 'a pull request for branch "pocket/p/phase-1" into branch "feature/x" already exists: https://github.com/pocketto-test/phase-stack/pull/77',
        timedOut: false,
      };
    }
    return realRun(args);
  };

  const result = publish(env, gh);

  assert.equal(result.created, false);
  assert.equal(result.pr.number, 77, 'the racing PR is reused');
  assert.equal(callsOf(gh, 'create').length, 1, 'create ran once and was refused');
  assert.equal(listCalls, 2, 'the list ran once before create and once after the refusal');
  assert.ok(gh.state.prs[0].body.includes('<!-- pocket-stack-context:start -->'), 'stack block upserted onto the reused PR');
});

// Phase-closed lookups (resolvePhasePr) share the fork rule with the publisher: a fork PR
// that reuses the head name is never selected, whether it came from metadata or from search.
function lookupGh(prs, commentsByNumber) {
  const ok = (stdout) => ({ exit: 0, stdout, stderr: '', timedOut: false });
  return (args) => {
    if (args[0] === 'repo' && args[1] === 'view') {
      return ok(JSON.stringify({ owner: { login: OWNER }, name: REPO, url: REPO_URL }));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = prs.find((candidate) => candidate.number === Number(args[2]));
      return pr ? ok(JSON.stringify(pr)) : { exit: 1, stdout: '', stderr: 'pull request not found', timedOut: false };
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = valueFor(args, '--head');
      return ok(JSON.stringify(prs.filter((pr) => pr.headRefName === head && pr.state === 'OPEN')));
    }
    if (args[0] === 'api') {
      const number = Number(/issues\/(\d+)\/comments/.exec(args[1])[1]);
      return ok(JSON.stringify([commentsByNumber[number] || []]));
    }
    return { exit: 1, stdout: '', stderr: `unexpected lookup call: ${args.join(' ')}`, timedOut: false };
  };
}

function phaseOneSummaryComments() {
  return [{ body: '<!-- pocket-phase-1-summary -->\nSummary.' }];
}

test('phase lookup fork search: an own PR and a fork PR on the same head select the own PR without manual resolution', (t) => {
  const env = setupRepo(t);
  const ownPr = { number: 10, url: `${REPO_URL}/pull/10`, state: 'OPEN', headRefName: 'pocket/p/phase-1', baseRefName: ROOT_BASE, isCrossRepository: false, headRefOid: 'abc' };
  const fork = forkPr(20);
  const gh = lookupGh([fork, ownPr], { 10: phaseOneSummaryComments() });
  const repo = resolveRepository({ ghRunner: gh });
  const context = { specDir: env.specDir, stacked: true, phases: { 'phase-1': { branch: 'pocket/p/phase-1' } } };

  const selected = resolvePhasePr(context, { key: 'phase-1', number: 1 }, repo, { ghRunner: gh });

  assert.equal(selected.pr.number, 10, 'the own PR is selected');
});

test('phase lookup fork metadata: a recorded fork PR is never selected and search picks the own PR', (t) => {
  const env = setupRepo(t);
  const ownPr = { number: 10, url: `${REPO_URL}/pull/10`, state: 'OPEN', headRefName: 'pocket/p/phase-1', baseRefName: ROOT_BASE, isCrossRepository: false, headRefOid: 'abc' };
  const fork = forkPr(20);
  enterpriseMeta.setPrIdentity(env.specDir, 'phase-1', { number: 20, url: `${REPO_URL}/pull/20` });
  const gh = lookupGh([fork, ownPr], { 10: phaseOneSummaryComments(), 20: phaseOneSummaryComments() });
  const repo = resolveRepository({ ghRunner: gh });
  const context = { specDir: env.specDir, stacked: true, phases: { 'phase-1': { branch: 'pocket/p/phase-1' } } };

  const selected = resolvePhasePr(context, { key: 'phase-1', number: 1 }, repo, { ghRunner: gh });

  assert.equal(selected.pr.number, 10, 'the fork PR recorded in metadata is not selected');
});
