'use strict';

// Closure-specific transport, issue ownership, and result helpers.

const { createHash } = require('node:crypto');
const github = require('./github');
const { redactSecrets } = require('./retry');
const { validateIssueOwnership, validateIssueReference } = require('./issue-identity');

const PROOF_REF = 'meta:github_issue|marker:issue-tasklist';
const ISSUE_REQUIRED = 'ISSUE_REQUIRED';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function adapterResult(eventId, status, code, message, retryable = false) {
  return {
    event_id: eventId,
    status,
    error: {
      code,
      retryable,
      message: redactSecrets(message),
    },
  };
}

function withTasklistProof(result, proofHash) {
  return { ...result, proof_ref: PROOF_REF, proof_hash: proofHash };
}

function fromTransport(eventId, result, fallbackCode) {
  const classification = result && result.classification;
  const status = classification && classification.status === 'terminal' ? 'terminal' : 'retryable';
  const error = classification && classification.error;
  return adapterResult(
    eventId,
    status,
    error && error.code ? error.code : fallbackCode,
    error && error.message ? error.message : 'GitHub request failed; replay is safe.',
    status === 'retryable'
  );
}

function isNotFound(result) {
  const stderr = result && result.raw && typeof result.raw.stderr === 'string' ? result.raw.stderr : '';
  return /\b404\b|not found/i.test(stderr);
}

function ghJson(args, opts) {
  return github.runGh(args, {
    runner: opts.ghRunner,
    timeoutMs: opts.timeoutMs,
    expectJson: true,
  });
}

function selectIssue(event, metadata, repository, opts) {
  const identity = metadata.github_issue || {};
  const issueNumber = identity.number;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', ISSUE_REQUIRED,
        'No linked issue is recorded for this plan. Link an owned open issue before closure.', false),
    };
  }
  if (!validateIssueReference(identity, repository, issueNumber).ok) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', 'ISSUE_OWNERSHIP_AMBIGUOUS',
        'The recorded issue URL does not belong to the current origin repository.', false),
    };
  }

  const fetched = ghJson(['api', `repos/${repository.nameWithOwner}/issues/${issueNumber}`], opts);
  if (!fetched.ok) {
    if (isNotFound(fetched)) {
      return {
        ok: false,
        result: adapterResult(event.event_id, 'terminal', ISSUE_REQUIRED,
          'The linked issue is unavailable. Resolve issue ownership before closure.', false),
      };
    }
    return { ok: false, result: fromTransport(event.event_id, fetched, 'ISSUE_LOOKUP_FAILED') };
  }
  const issue = fetched.data;
  const ownership = validateIssueOwnership(issue, {
    repo: repository,
    planId: event.plan_id,
    expectedUrl: identity.url,
    expectedNumber: issueNumber,
  });
  if (!ownership.ok) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', ownership.code,
        'The linked issue is closed or its repository/plan ownership cannot be proved; manual resolution is required.', false),
    };
  }
  return { ok: true, issue };
}

module.exports = {
  PROOF_REF,
  ISSUE_REQUIRED,
  sha256,
  adapterResult,
  withTasklistProof,
  fromTransport,
  ghJson,
  selectIssue,
};
