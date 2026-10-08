'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handlePlanClosed } = require('../../enterprise/closure-handler');
const { fs, path, enterpriseMeta, makeFixture, makeEvent, makeFakeGh } = require('./fixtures');

test('CYCLE 1: ledger failure after marker mutation reconciles on replay', async (t) => {
  const retry = makeFixture(t);
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
