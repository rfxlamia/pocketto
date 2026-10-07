'use strict';

// T10 RED cycle 4
// Test file: test/enterprise-closeout.test.js
// Level: unit
// Test intent: Given two closeout bodies with the same plan but different informational wording, When closure proof is evaluated, Then only the tasklist marker and metadata determine idempotency; the unmarked closeout comment cannot cause a duplicate-proof decision.
// Exercise through: closure proof helper and marker selector.
// Test doubles: none; use pure body/marker inputs.
// Expected RED: no helper distinguishes canonical tasklist proof from informational closeout content.
// Exact command: `node --test test/enterprise-closeout.test.js`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasCanonicalTasklistProof, selectTasklistComments } = require('../../enterprise/closure-handler');
const { closeoutBody, TASKLIST_MARKER } = require('../../cli/lib/bodies');
const { ISSUE_NUMBER, PLAN_ID } = require('./fixtures');

test('CYCLE 4: only a selected tasklist marker plus matching metadata proves closure', () => {
  const event = { event_id: `${PLAN_ID}:plan-closed:r9` };
  const metadata = {
    github_issue: {
      tasklist: {
        event_id: event.event_id,
        marker: TASKLIST_MARKER,
        comment_id: 99,
        proof_ref: 'meta:github_issue|marker:issue-tasklist',
        proof_hash: 'c'.repeat(64),
      },
    },
  };
  const closeoutA = `${closeoutBody({ slug: PLAN_ID, issue: ISSUE_NUMBER, phases: 1 })}\nNote: informational wording A`;
  const closeoutB = `${closeoutBody({ slug: PLAN_ID, issue: ISSUE_NUMBER, phases: 1 })}\nNote: informational wording B`;
  const unmarkedA = selectTasklistComments([
    { id: 1, body: closeoutA },
    { id: 2, body: closeoutB },
  ]);
  const unmarkedB = selectTasklistComments([
    { id: 1, body: closeoutB },
    { id: 2, body: closeoutA },
  ]);

  assert.deepEqual(unmarkedA, []);
  assert.deepEqual(unmarkedB, []);
  assert.equal(hasCanonicalTasklistProof({ event, marker: null, metadata }), false,
    'informational closeout text cannot establish canonical proof');
  assert.equal(hasCanonicalTasklistProof({ event, marker: TASKLIST_MARKER, metadata }), true,
    'the tasklist marker and matching metadata establish the proof');
  const selected = selectTasklistComments([
    { id: 1, body: closeoutA },
    { id: 99, body: `${TASKLIST_MARKER}\nfinal tasklist` },
    { id: 2, body: closeoutB },
  ]);
  assert.deepEqual(selected.map((comment) => comment.id), [99]);
  assert.equal(hasCanonicalTasklistProof({ event, marker: TASKLIST_MARKER, metadata }), true,
    'changing unmarked closeout wording cannot alter marker identity');
});
