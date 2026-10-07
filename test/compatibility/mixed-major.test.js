'use strict';

const { test } = require('node:test');
const {
  testCoreOnlyExecution,
  testMajorPairingMatrix,
  testMixedMajorDispatch,
  testSupportedV4Dispatch,
  testUnavailableAdapters,
} = require('./mixed-major-scenarios');

test('RED CYCLE 5: mixed-major preflight fails closed while Core preserves local lifecycle events', async (t) => {
  await t.test('release pairing matrix remains fail-closed and remote-free', testMajorPairingMatrix);
  await t.test('compatible v4 dispatch delivers the original pending event', testSupportedV4Dispatch);
  await t.test('mixed-major dispatch preserves pending local state', testMixedMajorDispatch);
  await t.test('removed and disabled adapters preserve state and replay identity', testUnavailableAdapters);
  await t.test('Core-only drain remains locally available without a remote call', testCoreOnlyExecution);
});
