'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { handlePlanClosed } = require('../../enterprise/closure-handler');
const { enterpriseMeta, makeFixture, makeEvent, makeFakeGh } = require('./fixtures');

// T10 correction: a Core-succeeded event is a read-only proof replay.
test('CYCLE 5: succeeded closure replay returns event-bound proof without remote or local writes', async (t) => {
  const fixture = makeFixture();
  cleanupFixture(t, fixture);
  const state = await seedSucceededProof(fixture);
  const closeoutPath = state.closeoutPath;
  fs.writeFileSync(closeoutPath, '# Existing closeout sentinel\n', 'utf8');
  const metadataBefore = fs.readFileSync(state.metadataPath, 'utf8');
  const closeoutBefore = fs.readFileSync(closeoutPath, 'utf8');
  state.gh.calls.length = 0;
  state.writes.meta = 0;
  state.writes.closeout = 0;

  const replay = await handlePlanClosed(state.event, state.options);

  assert.equal(replay.status, 'succeeded', JSON.stringify(replay));
  assert.equal(replay.proof_ref, state.first.proof_ref);
  assert.equal(replay.proof_hash, state.first.proof_hash);
  assert.deepEqual(state.gh.calls, [], 'succeeded proof must return before repository, issue, or tasklist lookups');
  assert.equal(state.writes.meta, 0, 'succeeded replay must not write metadata');
  assert.equal(state.writes.closeout, 0, 'succeeded replay must not write or replace closeout.md');
  assert.equal(fs.readFileSync(state.metadataPath, 'utf8'), metadataBefore,
    'succeeded replay must leave metadata bytes unchanged');
  assert.equal(fs.readFileSync(closeoutPath, 'utf8'), closeoutBefore,
    'succeeded replay must leave closeout.md bytes unchanged');
});

test('CYCLE 5: missing or mismatched nested closure proof fails closed without fallback', async (t) => {
  for (const scenario of ['missing', 'mismatched']) {
    await t.test(`${scenario} delivery proof is terminal and read-only`, async (t) => {
      const fixture = makeFixture();
      cleanupFixture(t, fixture);
      const state = await seedSucceededProof(fixture);
      const closeoutPath = state.closeoutPath;
      fs.writeFileSync(closeoutPath, '# Existing closeout sentinel\n', 'utf8');
      const metadataBefore = fs.readFileSync(state.metadataPath, 'utf8');
      const closeoutBefore = fs.readFileSync(closeoutPath, 'utf8');
      state.event.proof_ref = state.first.proof_ref;
      state.event.proof_hash = state.first.proof_hash;
      state.event.delivery = { status: 'succeeded', attempts: 1 };
      if (scenario === 'mismatched') {
        state.event.delivery.proof_ref = state.first.proof_ref;
        state.event.delivery.proof_hash = '0'.repeat(64);
      }
      state.gh.calls.length = 0;
      state.writes.meta = 0;
      state.writes.closeout = 0;

      const replay = await handlePlanClosed(state.event, state.options);

      assert.equal(replay.status, 'terminal', JSON.stringify(replay));
      assert.equal(replay.error.code, 'CLOSEOUT_PROOF_MISMATCH');
      assert.deepEqual(state.gh.calls, [], 'bad succeeded proof must not fall through to tasklist reconciliation');
      assert.equal(state.writes.meta, 0, 'bad succeeded proof must not write metadata');
      assert.equal(state.writes.closeout, 0, 'bad succeeded proof must not write closeout.md');
      assert.equal(fs.readFileSync(state.metadataPath, 'utf8'), metadataBefore);
      assert.equal(fs.readFileSync(closeoutPath, 'utf8'), closeoutBefore);
    });
  }
});

test('CYCLE 5: claimed closure delivery is ineligible for reconciliation', async (t) => {
  const fixture = makeFixture();
  cleanupFixture(t, fixture);
  const event = makeEvent(fixture.planDir);
  event.delivery.status = 'claimed';
  const metadataPath = enterpriseMeta.resolveMetaPath(fixture.specDir);
  const metadataBefore = fs.readFileSync(metadataPath, 'utf8');
  const gh = makeFakeGh([]);
  let metaWrites = 0;
  let closeoutWrites = 0;
  const replay = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeMeta: (...args) => {
      metaWrites += 1;
      return enterpriseMeta.writeMetaFor(...args);
    },
    writeFile: (...args) => {
      closeoutWrites += 1;
      return fs.writeFileSync(...args);
    },
  });

  assert.equal(replay.status, 'terminal', JSON.stringify(replay));
  assert.equal(replay.error.code, 'CLOSEOUT_DELIVERY_INELIGIBLE');
  assert.deepEqual(gh.calls, [], 'claimed delivery must not enter the remote-write path');
  assert.equal(metaWrites, 0);
  assert.equal(closeoutWrites, 0);
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), metadataBefore);
});

async function seedSucceededProof(fixture) {
  const event = makeEvent(fixture.planDir);
  const gh = makeFakeGh([]);
  const writes = { meta: 0, closeout: 0 };
  const options = {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeMeta: (...args) => {
      writes.meta += 1;
      return enterpriseMeta.writeMetaFor(...args);
    },
    writeFile: (...args) => {
      writes.closeout += 1;
      return fs.writeFileSync(...args);
    },
  };
  const first = await handlePlanClosed(event, options);
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  event.delivery = {
    status: 'succeeded',
    attempts: 1,
    proof_ref: first.proof_ref,
    proof_hash: first.proof_hash,
  };
  return {
    fixture,
    event,
    gh,
    first,
    options,
    writes,
    metadataPath: enterpriseMeta.resolveMetaPath(fixture.specDir),
    closeoutPath: path.join(fixture.planDir, 'closeout.md'),
  };
}

function cleanupFixture(t, fixture) {
  const root = path.dirname(path.dirname(fixture.specDir));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
}
