'use strict';

// Closure-specific transport, issue ownership, and result helpers.

const { createHash } = require('node:crypto');
const github = require('./github');
const { redactSecrets } = require('./retry');

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

function repoName(repoData) {
  const owner = repoData && repoData.owner;
  const login = typeof owner === 'string' ? owner : (owner && (owner.login || owner.name));
  const name = repoData && repoData.name;
  return typeof login === 'string' && login.length && typeof name === 'string' && name.length
    ? `${login}/${name}`
    : null;
}

function issueUrlMatchesRepository(url, expectedRepo, issueNumber) {
  if (typeof url !== 'string' || !url.length) return true;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parsed.hostname.toLowerCase() === 'github.com'
      && parts.length >= 4
      && `${parts[0]}/${parts[1]}`.toLowerCase() === expectedRepo.toLowerCase()
      && parts[2] === 'issues'
      && Number(parts[3]) === issueNumber;
  } catch {
    return false;
  }
}

function issueMatchesPlan(issue, planId) {
  const escaped = planId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titlePattern = new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, 'i');
  const specPathPattern = new RegExp(`docs/pocket/spec/${escaped}(?:/|\\b)`, 'i');
  return titlePattern.test(typeof issue.title === 'string' ? issue.title : '')
    || specPathPattern.test(typeof issue.body === 'string' ? issue.body : '');
}

function issueOwnershipError(issue, expectedRepo, planId) {
  const actualRepo = issue && issue.repository && issue.repository.full_name;
  if (typeof actualRepo === 'string' && actualRepo.toLowerCase() !== expectedRepo.toLowerCase()) {
    return 'ISSUE_OWNERSHIP_AMBIGUOUS';
  }
  const issueUrl = issue && (issue.html_url || issue.url);
  if (issueUrl && !issueUrlMatchesRepository(issueUrl, expectedRepo, issue.number)) {
    return 'ISSUE_OWNERSHIP_AMBIGUOUS';
  }
  if (!issueMatchesPlan(issue, planId)) return 'ISSUE_OWNERSHIP_AMBIGUOUS';
  if (typeof issue.state !== 'string') return 'ISSUE_OWNERSHIP_AMBIGUOUS';
  if (issue.state.toLowerCase() !== 'open') return 'ISSUE_CLOSED';
  return null;
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
  if (!issueUrlMatchesRepository(identity.url, repository, issueNumber)) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', 'ISSUE_OWNERSHIP_AMBIGUOUS',
        'The recorded issue URL does not belong to the current origin repository.', false),
    };
  }

  const fetched = ghJson(['api', `repos/${repository}/issues/${issueNumber}`], opts);
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
  const ownershipError = issueOwnershipError(issue, repository, event.plan_id);
  if (ownershipError) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', ownershipError,
        'The linked issue is closed or its repository/plan ownership cannot be proved; manual resolution is required.', false),
    };
  }
  if (issue.number !== issueNumber) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', 'ISSUE_OWNERSHIP_AMBIGUOUS',
        'The issue lookup did not match the recorded issue identity.', false),
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
  repoName,
  issueUrlMatchesRepository,
  issueMatchesPlan,
  selectIssue,
};
