'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FIXED_NOW, PLAN_ID, PHASE_PATH } = require('./support/constants');
const { createFixture } = require('./support/fixture');
const { initializePlan, transitionApprovedSpec } = require('./support/plan-commands');
const { runCore, assertCliOk } = require('./support/core-cli');
const { readRemote, readLifecycle } = require('./support/lifecycle-state');
const { installRegisteredEnterpriseReadFaultGate } = require('./support/failure-gates');
const { sha256, writeFile } = require('./support/files');
const { commitTransition } = require('../../cli/lib/lifecycle-store');
const { isDeepStrictEqual } = require('node:util');

const {
  assertArtifactStateIsTerminal,
} = require('./lifecycle-stale-spec-artifact.helpers.js');

test('committed artifacts that are missing or changed become terminal without GitHub mutation', async (t) => {
  for (const artifactState of ['missing', 'changed']) {
    await t.test(`${artifactState} spec artifact`, (subtest) => assertArtifactStateIsTerminal(subtest, artifactState));
  }
});

// T12 stale-artifact intent, preserved verbatim and in order:
// Test file: test/integration/lifecycle-enterprise.test.js
// Level: integration
// Intent: “Given a committed artifact is missing or changed before delivery, When the event is drained, Then delivery becomes terminal `STALE_ARTIFACT` and no remote handler is invoked.”
// Exercise through: “end-to-end drain with mutable temporary artifacts.”
// Test doubles: “fake GitHub runner and clock; use real artifact validation.”
// Expected RED: “commit-time versus delivery-time artifact classification is not covered across units.”
// Exact command: `node --test test/integration/lifecycle-enterprise.test.js`.
