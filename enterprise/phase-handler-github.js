'use strict';

const fs = require('node:fs');
const path = require('node:path');
const github = require('./github');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');

function withBodyFile(body, run) {
  const bodyFile = github.writeBodyFile(body);
  try {
    return run(bodyFile);
  } finally {
    try { fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
}

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
    // This invocation is one try. Core's delivery journal owns the
    // cross-invocation budget (one initial call plus five retries).
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
  const pages = runJson(['api', endpoint, '--paginate', '--slurp'], options);
  if (!Array.isArray(pages)) throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'PR comments response must be an array of pages.', { status: 'retryable', retryable: true });
  // `gh api --paginate --slurp` returns one array per page. Accept an already
  // flat array too for injected runners and older compatible gh behavior.
  if (pages.every(Array.isArray)) return pages.flat();
  if (pages.every((comment) => comment && typeof comment === 'object' && !Array.isArray(comment))) return pages;
  throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'PR comments response contains a malformed page.', { status: 'retryable', retryable: true });
}

function upsertSummary(endpoint, comments, marker, body, options) {
  const matches = comments
    .filter((comment) => typeof comment.body === 'string' && comment.body.split(/\r?\n/, 1)[0] === marker)
    .sort((left, right) => Number(left.id) - Number(right.id));
  if (matches.length === 0) {
    withBodyFile(body, (bodyFile) => runJson(['api', endpoint, ...github.bodyFileField(bodyFile)], options));
    return;
  }
  withBodyFile(body, (bodyFile) => runJson([
    'api', commentEndpointForId(endpoint, matches[0].id), '--method', 'PATCH', ...github.bodyFileField(bodyFile),
  ], options));
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
