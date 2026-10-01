'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CLI, FIXED_CLOCK, mkdtempSync, parseJson, path, readFileSync, rmSync, spawn, tmpdir,
  waitForFile, writeFileSync,
} = require('./common');
const { createRepairFixture, gitRunner } = require('./repair-projection');

function createRepairRaceHook(root) {
  const hookPath = path.join(root, 'repair-race-hook.js');
  writeFileSync(hookPath, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const options = JSON.parse(process.env.PROJECTION_REPAIR_BARRIER);
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalExistsSync = fs.existsSync;
let paused = false;
fs.readFileSync = function(file, ...args) {
  const content = originalReadFileSync.call(this, file, ...args);
  if (!paused && process.argv.includes('repair') && path.resolve(String(file)) === options.logPath) {
    paused = true;
    originalWriteFileSync(options.readMarker, 'snapshot-read');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!originalExistsSync(options.releaseMarker)) Atomics.wait(wait, 0, 0, 10);
  }
  return content;
};
`);
  return hookPath;
}

function startPublicCli(hookPath, args, { cwd, barrier, env = {} }) {
  const child = spawn(process.execPath, ['--require', hookPath, CLI, ...args], {
    cwd,
    env: { ...process.env, PROJECTION_REPAIR_BARRIER: JSON.stringify(barrier), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.once('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: err.message }));
  });
  return { child, done };
}

function commitRaceFile(git, planDir, filename, content, message) {
  writeFileSync(path.join(planDir, filename), content);
  git(['add', filename]);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

function prepareRepairRace(root) {
  const fixture = createRepairFixture(root);
  const stale = parseJson(readFileSync(fixture.logPath, 'utf8'), 'initial race projection');
  stale.phases[0].status = 'WAITING';
  stale.phases[0].tasks[0].status = 'WAITING';
  delete stale.phases[0].tasks[0].done_sha;
  stale.phases[0].corrections = [];
  writeFileSync(fixture.logPath, `${JSON.stringify(stale, null, 2)}\n`);

  const git = gitRunner(fixture.planDir);
  const newerDoneSha = commitRaceFile(
    git, fixture.planDir, 'race-task-output.md', 'new task progress after repair snapshot\n', 'concurrent task progress',
  );
  const newerCorrectionSha = commitRaceFile(
    git, fixture.planDir, 'race-correction-output.md', 'new correction after repair snapshot\n', 'concurrent correction',
  );
  const readMarker = path.join(root, 'repair-snapshot-read');
  const releaseMarker = path.join(root, 'release-repair');
  const barrier = { logPath: fixture.logPath, readMarker, releaseMarker };
  return {
    fixture,
    lifecycleBefore: readFileSync(fixture.lifecyclePath, 'utf8'),
    newerDoneSha,
    newerCorrectionSha,
    barrier,
    releaseMarker,
    hookPath: createRepairRaceHook(root),
  };
}

async function assertSuccessfulCli(worker, description) {
  const result = await worker.done;
  assert.equal(result.code, 0, `${description}: ${result.stdout}${result.stderr}`);
  assert.equal(parseJson(result.stdout.trim(), `${description} response`).ok, true);
}

async function persistConcurrentProgress(setup, workers) {
  const { fixture, hookPath, barrier, newerDoneSha, newerCorrectionSha } = setup;
  const taskUpdate = startPublicCli(
    hookPath,
    ['log', 'update', fixture.planDir, fixture.phaseFile, 'DONE', '--task', 'T1', '--sha', newerDoneSha, '--json', '--contract', '3'],
    { cwd: fixture.planDir, barrier },
  );
  workers.push(taskUpdate);
  await assertSuccessfulCli(taskUpdate, 'concurrent public task update');

  const correction = startPublicCli(
    hookPath,
    ['log', 'update', fixture.planDir, fixture.phaseFile, '--correction', newerCorrectionSha, '--for-task', 'T1', '--json', '--contract', '3'],
    { cwd: fixture.planDir, barrier },
  );
  workers.push(correction);
  await assertSuccessfulCli(correction, 'concurrent public correction');
}

function assertProgressWasPersisted(setup) {
  const { fixture, newerDoneSha, newerCorrectionSha } = setup;
  const projection = parseJson(readFileSync(fixture.logPath, 'utf8'), 'projection with concurrent updates');
  assert.equal(projection.phases[0].tasks[0].status, 'DONE');
  assert.equal(projection.phases[0].tasks[0].done_sha, newerDoneSha);
  assert.ok(projection.phases[0].corrections.some((entry) => entry.sha === newerCorrectionSha));
}

async function assertRepairPreservedProgress(setup, repair) {
  const { fixture, lifecycleBefore, newerDoneSha, newerCorrectionSha } = setup;
  const result = await repair.done;
  assert.equal(result.code, 0, `public repair should succeed: ${result.stdout}${result.stderr}`);
  assert.equal(parseJson(result.stdout.trim(), 'concurrent repair response').ok, true);

  const latest = parseJson(readFileSync(fixture.logPath, 'utf8'), 'projection after concurrent repair');
  assert.equal(latest.phases[0].status, 'REVIEW');
  assert.equal(latest.phases[0].tasks[0].status, 'DONE', 'repair must not overwrite newer task status');
  assert.equal(latest.phases[0].tasks[0].done_sha, newerDoneSha, 'repair must not overwrite newer done_sha');
  assert.ok(latest.phases[0].corrections.some((entry) => entry.sha === newerCorrectionSha), 'repair must not overwrite a newer correction');
  assert.equal(readFileSync(fixture.lifecyclePath, 'utf8'), lifecycleBefore, 'repair and task writers must not mutate lifecycle bytes');
  assert.equal(readFileSync(fixture.adapterCallsPath, 'utf8'), '', 'repair must not dispatch an adapter');
}

async function runRepairRace(setup) {
  const { fixture, hookPath, barrier, releaseMarker } = setup;
  const workers = [];
  try {
    const repair = startPublicCli(
      hookPath,
      ['lifecycle', 'repair', fixture.planDir, '--json', '--contract', '3'],
      { cwd: fixture.planDir, barrier, env: { POCKETTO_LIFECYCLE_NOW: FIXED_CLOCK, ADAPTER_CALLS: fixture.adapterCallsPath } },
    );
    workers.push(repair);
    assert.equal(await waitForFile(barrier.readMarker, 5000), true, 'repair must pause after reading its initial valid projection snapshot');
    await persistConcurrentProgress(setup, workers);
    assertProgressWasPersisted(setup);

    writeFileSync(releaseMarker, 'continue');
    await assertRepairPreservedProgress(setup, repair);
  } finally {
    try { writeFileSync(releaseMarker, 'continue'); } catch {}
    await Promise.all(workers.map((worker) => worker.done));
  }
}

test('lifecycle repair rebases on task and correction writes committed after its initial read', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lifecycle-repair-race-'));
  const originalClock = process.env.POCKETTO_LIFECYCLE_NOW;
  try {
    await runRepairRace(prepareRepairRace(root));
  } finally {
    if (originalClock === undefined) delete process.env.POCKETTO_LIFECYCLE_NOW;
    else process.env.POCKETTO_LIFECYCLE_NOW = originalClock;
    rmSync(root, { recursive: true, force: true });
  }
});
