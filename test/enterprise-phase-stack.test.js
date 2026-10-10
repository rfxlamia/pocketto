'use strict';

// Integration tests for enterprise/phase-stack.js (T11).
// Real git against a temp bare origin; gh is a fake runner that records argv,
// reads --body-file contents at call time, and answers from in-memory PR state.
// Each test title carries its RED-cycle pattern so
// `node --test --test-name-pattern="<pattern>"` selects that cycle.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const enterpriseMeta = require('../enterprise/meta');
const { stackBlock, phasePrBody, upsertStackBlock } = require('../enterprise/stack-body');
const { publishPhase } = require('../enterprise/phase-stack');

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

  function createPr(args) {
    if (state.failures.create) return state.failures.create;
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
  return publishPhase({
    projectRoot: env.work,
    specDir: env.specDir,
    planId: PLAN_ID,
    phase: overrides.phase || phase1(),
    closeoutSnapshot: CLOSEOUT,
    registration: 'registration' in overrides ? overrides.registration : { push_consent: CONSENT },
    options: { ghRunner: gh.run },
  });
}

function readMeta(specDir) {
  return JSON.parse(fs.readFileSync(path.join(specDir, '.pocket-meta.json'), 'utf8'));
}

function callsOf(gh, verb) {
  return gh.state.calls.filter((args) => args[0] === 'pr' && args[1] === verb);
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
    issueLink: { issue: ISSUE_NUMBER, finalPhase: true },
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

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'remote branch diverged');
    assert.equal(error.retryable, false);
    assert.match(error.message, /diverged/);
    return true;
  });
  assert.equal(remoteRef(env, 'pocket/p/phase-1'), remoteTip, 'origin tip unchanged');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create call');
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

  assert.throws(() => publish(env, gh), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'ambiguous PR identity');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on ambiguous identity');
  assert.equal(callsOf(gh, 'create').length, 0, 'no pr create on ambiguous identity');
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

  assert.throws(() => publish(env, gh, { phase: phase2() }), (error) => {
    assert.equal(error.code, 'PR_BLOCKED');
    assert.equal(error.reason, 'base retargeted');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(callsOf(gh, 'edit').length, 0, 'no pr edit on a retargeted PR');
  assert.equal(callsOf(gh, 'create').length, createsBefore, 'no pr create on a retargeted PR');
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
