'use strict';

// T10 RED cycle 1
// Test file: test/enterprise-closeout.test.js
// Level: integration
// Test intent: Given a valid `plan-closed` event, an owned issue, final plan state, non-null `plan_dir`, and final artifact references, When the handler runs, Then it upserts exactly one `<!-- pocket-tasklist -->` issue comment, records final metadata/proof, writes local `<plan_dir>/closeout.md`, preserves the final plan state/artifact references in the proof, and makes no merge or `gh issue close` call; if the local closeout/ledger write fails after the marker mutation, Then it returns `reconciling` and replay finds the marker before any duplicate mutation.
// Exercise through: `enterprise/closure-handler.js` with fake GitHub transport, real format/tasklist/closeout fixtures, and an injected local-write failure.
// Test doubles: fake `gh` issue/PR runner and filesystem/ledger failure injection; do not mock marker selection or replay lookup.
// Expected RED: current closeout is a skill-level sequence with no event handler, durable proof transaction, or proof-preserving failure path.
// Exact command: `node --test test/enterprise-closeout.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handlePlanClosed } = require('../../enterprise/closure-handler');
const { TASKLIST_MARKER } = require('../../cli/lib/bodies');
const { fs, path, enterpriseMeta, makeFixture, makeEvent, makeFakeGh } = require('./fixtures');

test('CYCLE 1: plan-closed persists canonical tasklist proof and reconciles local write failure', async (t) => {
  const success = makeFixture(t);
  const successEvent = makeEvent(success.planDir);
  const successGh = makeFakeGh();
  const result = await handlePlanClosed(successEvent, {
    specDir: success.specDir,
    planDir: success.planDir,
    ghRunner: successGh.runner,
  });

  assert.equal(result.event_id, successEvent.event_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.proof_ref, 'meta:github_issue|marker:issue-tasklist');
  assert.match(result.proof_hash, /^[0-9a-f]{64}$/);
  assert.equal(successGh.comments.length, 1, 'one canonical tasklist comment must exist');
  assert.ok(successGh.comments[0].body.startsWith(`${TASKLIST_MARKER}\n`));
  assert.match(successGh.comments[0].body, /\*\*Status:\*\* DONE/);
  assert.match(successGh.comments[0].body, /T1/);
  assert.ok(fs.readFileSync(path.join(success.planDir, 'closeout.md'), 'utf8')
    .startsWith('<!-- pocket-closeout:plan-closed -->\n\n## Plan closed — demo-plan\n'));
  const successMeta = enterpriseMeta.readMetaFor(success.specDir);
  assert.equal(successMeta.github_issue.tasklist.event_id, successEvent.event_id);
  assert.equal(successMeta.github_issue.tasklist.marker, TASKLIST_MARKER);
  assert.equal(successMeta.github_issue.tasklist.final_state.status, 'DONE');
  assert.deepEqual(successMeta.github_issue.tasklist.artifact_refs, successEvent.artifact_refs);
  assert.ok(!successGh.calls.some(({ args }) => args.includes('merge') || (args[0] === 'issue' && args[1] === 'close')));
});
