'use strict';

const identity = require('../../cli/lib/identity');

function addPhaseMarker(pr, phase, id) {
  pr.commentPages[1].push({ id, body: `${identity.markerFor(String(phase))}\n\nPrior summary` });
}

function isRemoteMutation(args) {
  if (args[0] !== 'api') return false;
  const methodIndex = args.indexOf('--method');
  if (methodIndex >= 0) return args[methodIndex + 1] !== 'GET';
  return args.some((arg) => arg === 'body=' || arg.startsWith('body=') || arg.startsWith('body=@'));
}

function loadPhaseHandler() {
  try {
    return require('../../enterprise/phase-handler');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('enterprise/phase-handler')) {
      return null;
    }
    throw error;
  }
}

module.exports = { addPhaseMarker, isRemoteMutation, loadPhaseHandler };
