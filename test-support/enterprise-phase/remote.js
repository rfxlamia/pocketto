'use strict';

function fakeGh(remote) {
  return (args) => {
    remote.calls.push(args.slice());
    const context = createCommandContext(args, remote);
    return routeCommand(context) || context.failure(`unexpected fake gh command: ${args.join(' ')}`);
  };
}

function createCommandContext(args, remote) {
  return {
    args,
    remote,
    json: (value) => ({ exit: 0, stdout: JSON.stringify(value), stderr: '' }),
    failure: (message) => ({ exit: 1, stdout: '', stderr: message }),
    valueFor: (flag) => valueFor(args, flag),
    fieldFor: (name) => fieldFor(args, name),
  };
}

function routeCommand(context) {
  return routeRepository(context)
    || routeIssue(context)
    || routePullRequest(context)
    || routeGraphql(context)
    || routeApi(context);
}

function routeRepository({ args, remote, json }) {
  if (args[0] !== 'repo' || args[1] !== 'view') return null;
  return json({
    owner: { login: remote.owner },
    name: remote.repository,
    nameWithOwner: `${remote.owner}/${remote.repository}`,
    url: `https://github.com/${remote.owner}/${remote.repository}`,
  });
}

function routeIssue({ args, remote, json, failure }) {
  if (args[0] !== 'issue') return null;
  if (args[1] === 'view') {
    const issue = remote.issue && remote.issue.number === Number(args[2]) ? remote.issue : null;
    return issue ? json(issue) : failure('issue not found');
  }
  return args[1] === 'list' ? json(remote.issueSearch) : null;
}

function routePullRequest({ args, remote, json, failure }) {
  if (args[0] !== 'pr') return null;
  if (args[1] === 'view') {
    const pr = remote.prs.find((candidate) => candidate.number === Number(args[2]));
    return pr ? json(publicPr(pr)) : failure('pull request not found');
  }
  return args[1] === 'list' ? json(remote.prs.map(publicPr)) : null;
}

function routeGraphql({ args, remote, fieldFor, json, failure }) {
  if (args[0] !== 'api' || args[1] !== 'graphql') return null;
  const query = fieldFor('query') || '';
  if (query.includes('resolveReviewThread')) return resolveThreadMutation(remote, fieldFor('threadId'), json, failure);
  if (query.includes('reviewThreads')) return json(threadPage(remote, fieldFor('after'), Number(fieldFor('number'))));
  return failure('unexpected GraphQL operation');
}

function resolveThreadMutation(remote, threadId, json, failure) {
  if (remote.resolveFailuresRemaining > 0) {
    remote.resolveFailuresRemaining -= 1;
    return failure('temporarily unavailable');
  }
  const thread = allThreads(remote).find((candidate) => candidate.id === threadId);
  if (!thread) return failure('review thread not found');
  thread.isResolved = true;
  remote.successfulResolutions += 1;
  return json({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } });
}

function routeApi(context) {
  const { args, remote, fieldFor, valueFor, json, failure } = context;
  if (args[0] !== 'api' || typeof args[1] !== 'string') return null;
  const endpoint = args[1];
  const method = (valueFor('--method') || (fieldFor('body') === null ? 'GET' : 'POST')).toUpperCase();
  const issueComments = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
  if (issueComments) return routeIssueComments(remote, issueComments[1], method, fieldFor, json);
  const issueComment = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
  if (issueComment) return routeIssueComment(remote, issueComment[1], method, fieldFor, failure);
  const pullComments = endpoint.match(/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/);
  if (pullComments) return routePullComments(remote, pullComments[1], method, fieldFor, json);
  return null;
}

function routeIssueComments(remote, prNumber, method, fieldFor, json) {
  if (method === 'GET') return json(allComments(remote, Number(prNumber)));
  if (method !== 'POST') return null;
  const comment = { id: remote.nextCommentId++, body: fieldFor('body') || '' };
  prState(remote, Number(prNumber)).comments.push(comment);
  return json(comment);
}

function routeIssueComment(remote, commentId, method, fieldFor, failure) {
  if (method === 'PATCH') {
    const comment = findComment(remote, Number(commentId));
    if (!comment) return failure('comment not found');
    comment.body = fieldFor('body') || '';
    return { exit: 0, stdout: JSON.stringify(comment), stderr: '' };
  }
  if (method === 'DELETE') {
    removeComment(remote, Number(commentId));
    return { exit: 0, stdout: '', stderr: '' };
  }
  return null;
}

function routePullComments(remote, prNumber, method, fieldFor, json) {
  if (method !== 'POST') return null;
  const body = fieldFor('body') || '';
  const thread = {
    id: `PRRT_${remote.nextThreadId++}`,
    isResolved: false,
    comments: { nodes: [{ body, path: fieldFor('path'), line: Number(fieldFor('line')), side: fieldFor('side') }] },
  };
  prState(remote, Number(prNumber)).threads.push(thread);
  return json({ id: remote.nextThreadId, body });
}

function valueFor(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

function fieldFor(args, name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if ((args[index] === '-f' || args[index] === '-F') && args[index + 1].startsWith(`${name}=`)) {
      return args[index + 1].slice(name.length + 1);
    }
  }
  return null;
}

function makePr(number, planId = 'demo-plan') {
  return {
    number,
    url: `https://github.com/pocketto-test/phase-fixtures/pull/${number}`,
    state: 'OPEN',
    headRefName: 'feature/demo-plan',
    baseRefName: 'main',
    headRefOid: 'abc123def456',
    title: `Phase 1: ${planId}`,
    body: `Implements ${planId}`,
    commentPages: [[], []],
    comments: [],
    threadPages: [[], []],
    threads: [],
  };
}

function publicPr(pr) {
  const { commentPages, comments, threadPages, threads, ...fields } = pr;
  return fields;
}

function prState(remote, prNumber = 42) {
  return remote.prs.find((pr) => pr.number === prNumber) || {
    commentPages: [[], []], comments: [], threadPages: [[], []], threads: [],
  };
}

function allComments(remote, prNumber = 42) {
  const state = prState(remote, prNumber);
  return [...state.commentPages.flat(), ...state.comments].sort((left, right) => left.id - right.id);
}

function findComment(remote, id) {
  return remote.prs.flatMap((pr) => allComments(remote, pr.number)).find((comment) => comment.id === id) || null;
}

function removeComment(remote, id) {
  for (const pr of remote.prs) {
    for (const page of pr.commentPages) {
      const index = page.findIndex((comment) => comment.id === id);
      if (index >= 0) page.splice(index, 1);
    }
    const index = pr.comments.findIndex((comment) => comment.id === id);
    if (index >= 0) pr.comments.splice(index, 1);
  }
}

function allThreads(remote, prNumber = 42) {
  const state = prState(remote, prNumber);
  return [...state.threadPages.flat(), ...state.threads];
}

function threadPage(remote, after, prNumber) {
  const pageIndex = after && after !== 'null' ? Number(String(after).replace(/^cursor-/, '')) : 0;
  const state = prState(remote, prNumber);
  const pages = state.threadPages.map((page) => page.slice());
  pages[pages.length - 1].push(...state.threads);
  const nodes = pages[pageIndex] || [];
  const hasNextPage = pageIndex + 1 < pages.length;
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes,
            pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${pageIndex + 1}` : null },
          },
        },
      },
    },
  };
}

module.exports = { allComments, allThreads, fakeGh, makePr };
