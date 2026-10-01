'use strict';

const github = require('./github');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function runJson(args, options) {
  return runRequest(args, options, true);
}

function runNoContent(args, options) {
  return runRequest(args, options, false);
}

function runRequest(args, options, expectJson) {
  const result = github.runGh(args, {
    runner: options.ghRunner,
    timeoutMs: options.timeoutMs,
    attemptsMade: 1,
    expectJson,
  });
  if (!result.ok) {
    const classification = result.classification || {};
    const error = classification.error || {};
    throw new PhaseHandlerError(error.code || 'GH_PHASE_FAILED', error.message || 'GitHub request failed.', {
      status: classification.status === 'terminal' ? 'terminal' : 'retryable',
      retryable: classification.status !== 'terminal',
    });
  }
  return result.data;
}

function listComments(endpoint, options) {
  const comments = runJson(['api', endpoint, '--paginate'], options);
  if (!Array.isArray(comments)) throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'PR comments response must be an array.', { status: 'retryable', retryable: true });
  return comments;
}

function upsertSummary(endpoint, comments, marker, body, options) {
  const matches = comments
    .filter((comment) => typeof comment.body === 'string' && comment.body.split(/\r?\n/, 1)[0] === marker)
    .sort((left, right) => Number(left.id) - Number(right.id));
  if (matches.length === 0) {
    runJson(['api', endpoint, '-f', `body=${body}`], options);
    return;
  }
  runJson(['api', commentEndpointForId(endpoint, matches[0].id), '--method', 'PATCH', '-f', `body=${body}`], options);
  for (const duplicate of matches.slice(1)) {
    runNoContent(['api', commentEndpointForId(endpoint, duplicate.id), '--method', 'DELETE'], options);
  }
}

function commentEndpointForId(endpoint, commentId) {
  const match = /^(repos\/[^/]+\/[^/]+)\/issues\/\d+\/comments$/.exec(endpoint);
  if (!match) throw new PhaseHandlerError('PHASE_COMMENT_ENDPOINT_INVALID', 'Cannot derive the canonical PR comment endpoint.');
  return `${match[1]}/issues/comments/${commentId}`;
}

function listReviewThreads(repo, prNumber, options) {
  const threads = [];
  let cursor = null;
  do {
    const query = 'query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved comments(first:100){nodes{body path line}}} pageInfo{hasNextPage endCursor}}}}}';
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${repo.owner}`, '-F', `repo=${repo.name}`,
      '-F', `number=${prNumber}`, '-F', `after=${cursor === null ? 'null' : cursor}`];
    const data = runJson(args, options);
    const page = data && data.data && data.data.repository && data.data.repository.pullRequest
      && data.data.repository.pullRequest.reviewThreads;
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo
        || typeof page.pageInfo.hasNextPage !== 'boolean') {
      throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'Review-thread response is malformed.', { status: 'retryable', retryable: true });
    }
    threads.push(...page.nodes);
    if (page.pageInfo.hasNextPage) {
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) {
        throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'Review-thread pagination did not advance.', { status: 'retryable', retryable: true });
      }
      cursor = page.pageInfo.endCursor;
    } else {
      cursor = null;
    }
  } while (cursor !== null);
  return threads;
}


module.exports = { runJson, runNoContent, listComments, upsertSummary, listReviewThreads };
