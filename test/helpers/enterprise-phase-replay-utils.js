'use strict';

const { FIXED_CLOCK } = require('./enterprise-phase-fixture');
const { fakeGh } = require('./enterprise-phase-remote');

function handlerOptions(fixture) {
  return {
    projectRoot: fixture.root,
    ghRunner: fakeGh(fixture.remote),
    now: () => new Date(FIXED_CLOCK),
  };
}

function inlinePostCount(remote) {
  return remote.calls.filter((args) => args[0] === 'api'
    && String(args[1]).includes('/pulls/')
    && String(args[1]).endsWith('/comments')
    && args.some((arg) => String(arg).includes('pocket-fp:'))).length;
}

function staleResolveCount(remote) {
  return remote.calls.filter((args) => args[0] === 'api'
    && args[1] === 'graphql'
    && args.some((arg) => String(arg).includes('resolveReviewThread'))
    && args.some((arg) => arg === 'threadId=PRRT_STALE' || arg === 'threadId=PRRT_LEGACY_RETRY'
      || arg === 'threadId=PRRT_ALREADY_MISSING')).length;
}

module.exports = { handlerOptions, inlinePostCount, staleResolveCount };
