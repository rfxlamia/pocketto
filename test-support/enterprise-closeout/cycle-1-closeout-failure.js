'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handlePlanClosed } = require('../../enterprise/closure-handler');
const { fs, path, makeFixture, makeEvent, makeFakeGh } = require('./fixtures');

test('CYCLE 1: local closeout failure preserves proof and replay does not duplicate the marker', async () => {
  const fixture = makeFixture();
  const event = makeEvent(fixture.planDir);
  const gh = makeFakeGh();
  const initial = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
  });
  fs.unlinkSync(path.join(fixture.planDir, 'closeout.md'));
  const closeoutWriteFailure = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
    writeFile: () => { throw new Error('simulated closeout filesystem timeout'); },
  });

  assert.equal(closeoutWriteFailure.status, 'reconciling');
  assert.equal(closeoutWriteFailure.error.code, 'CLOSEOUT_LOCAL_WRITE_FAILED');
  assert.equal(closeoutWriteFailure.proof_ref, initial.proof_ref);
  assert.equal(closeoutWriteFailure.proof_hash, initial.proof_hash,
    'local closeout failure must preserve the already-committed canonical proof');
  assert.equal(gh.comments.length, 1, 'local retry must not duplicate the remote marker');

  const replay = await handlePlanClosed(event, {
    specDir: fixture.specDir,
    planDir: fixture.planDir,
    ghRunner: gh.runner,
  });
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.proof_hash, initial.proof_hash);
  assert.equal(gh.comments.length, 1, 'replay must retain exactly one canonical marker');
  assert.equal(gh.calls.filter(({ args }) => args.includes('POST')).length, 1);
  assert.equal(fs.existsSync(path.join(fixture.planDir, 'closeout.md')), true);
});
