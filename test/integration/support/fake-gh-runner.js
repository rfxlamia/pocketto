#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
const repository = process.env.FAKE_GH_REPOSITORY;
const repositoryUrl = process.env.FAKE_GH_REPOSITORY_URL;
const issueNumber = Number(process.env.FAKE_GH_ISSUE_NUMBER);
const repo = { owner: { login: 'acme' }, name: 'pocketto', nameWithOwner: repository, url: repositoryUrl };
const json = (value) => {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};
const fail = (message) => {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  process.stderr.write(message);
  process.exit(1);
};
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const field = (name) => {
  for (let index = 0; index < args.length - 1; index++) {
    if ((args[index] === '-f' || args[index] === '-F') && args[index + 1].startsWith(`${name}=`)) {
      return args[index + 1].slice(name.length + 1);
    }
  }
  return null;
};
const issueByNumber = (number) => state.issues.find((issue) => issue.number === Number(number));
const issueView = (issue) => ({ ...issue, html_url: issue.url, repository: { full_name: repository } });
const commentsFor = (number) => state.comments[String(number)] || (state.comments[String(number)] = []);

if (args[0] === 'repo' && args[1] === 'view') json(repo);
if (args[0] === 'issue' && args[1] === 'list') json(state.issues.filter((issue) => issue.state === 'OPEN'));
if (args[0] === 'issue' && args[1] === 'create') createIssue();
if (args[0] === 'issue' && args[1] === 'view') {
  const issue = issueByNumber(args[2]);
  if (issue) json(issueView(issue));
  fail('issue not found in fake repository');
}
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state.pullRequests.find((candidate) => candidate.number === Number(args[2]));
  if (pr) json(pr);
  fail('pull request not found in fake repository');
}
if (args[0] === 'pr' && args[1] === 'list') json(state.pullRequests);
if (args[0] === 'api' && args[1] === 'graphql') {
  json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
}
if (args[0] === 'api' && typeof args[1] === 'string') handleApiRequest(args[1]);
fail(`fake GitHub rejected unexpected request: ${args.join(' ')}`);

function createIssue() {
  if (process.env.FAKE_GH_GATE_EFFECT === 'issue-create'
      && !fs.existsSync(process.env.FAKE_GH_GATE_READY_FILE)) {
    fs.writeFileSync(process.env.FAKE_GH_GATE_READY_FILE, 'issue-create');
    const signal = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.FAKE_GH_GATE_RELEASE_FILE)) Atomics.wait(signal, 0, 0, 10);
  }
  const number = state.nextIssueNumber++;
  const url = `${repositoryUrl}/issues/${number}`;
  const bodyFile = value('--body-file');
  const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : '';
  const issue = { number, url, state: 'OPEN', title: value('--title'), body, labels: [{ name: 'pocket-plan' }], createdAt: process.env.FAKE_GH_NOW };
  state.issues.push(issue);
  state.effects.push({ kind: 'issue-create', number });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`${url}\n`);
  process.exit(0);
}

function handleApiRequest(endpoint) {
  if (endpoint.endsWith('/comments')) return handleComments(endpoint);
  const commentMatch = endpoint.match(/\/issues\/comments\/(\d+)$/);
  if (commentMatch) return handleCommentMutation(Number(commentMatch[1]));
  const issueMatch = endpoint.match(/\/issues\/(\d+)$/);
  if (issueMatch) {
    const issue = issueByNumber(issueMatch[1]);
    if (issue) json(issueView(issue));
    fail('issue not found in fake repository');
  }
  fail('unrecognized API endpoint');
}

function handleComments(endpoint) {
  const match = endpoint.match(/\/issues\/(\d+)\/comments$/);
  if (!match) fail('unrecognized comments endpoint');
  const number = Number(match[1]);
  const comments = commentsFor(number);
  const method = value('--method') || (field('body') === null ? 'GET' : 'POST');
  if (method === 'GET') json(comments);
  if (method === 'POST') createComment(number, comments);
}

function createComment(number, comments) {
  const comment = { id: state.nextCommentId++, body: field('body') || '' };
  comments.push(comment);
  const isPullRequest = state.pullRequests.some((pullRequest) => pullRequest.number === number);
  const kind = isPullRequest ? 'phase-summary-create' : 'tasklist-create';
  state.effects.push({ kind, number, marker: comment.body.split(/\r?\n/, 1)[0] });
  json(comment);
}

function handleCommentMutation(id) {
  const comment = Object.values(state.comments).flat().find((item) => item.id === id);
  const method = value('--method');
  if (!comment) fail('comment not found');
  if (method === 'PATCH') {
    comment.body = field('body') || '';
    state.effects.push({ kind: 'comment-update', id });
    json(comment);
  }
  if (method === 'DELETE') {
    for (const items of Object.values(state.comments)) {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) items.splice(index, 1);
    }
    state.effects.push({ kind: 'comment-delete', id });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    process.exit(0);
  }
}
