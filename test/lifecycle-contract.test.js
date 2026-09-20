'use strict';

// T1 CYCLE 1: lifecycle protocol constants are independently versioned.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const version = require('../cli/lib/version');

test('v4 protocol constants are independently versioned', () => {
  assert.equal(version.CONTRACT, 3, 'CONTRACT must be 3');
  assert.equal(version.PIPELINE, 5, 'PIPELINE must be 5');
  assert.equal(version.LIFECYCLE_SCHEMA, 1, 'LIFECYCLE_SCHEMA must be 1');
  assert.equal(version.ADAPTER_CONTRACT, 1, 'ADAPTER_CONTRACT must be 1');
  assert.equal(version.SURFACE_MANIFEST, 1, 'SURFACE_MANIFEST must be 1');
});
