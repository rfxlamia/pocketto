'use strict';

// Enterprise plan-closure reconciliation. The tasklist marker and its
// metadata record are the canonical remote proof; closeout.md is local and
// informational only.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateEvent } = require('../cli/lib/lifecycle-contract');
const { readLog } = require('../cli/lib/logjson');
const { closeoutBody, tasklistBody, TASKLIST_MARKER } = require('../cli/lib/bodies');
const enterpriseMeta = require('./meta');
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

function flattenPages(value, out = []) {
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (Array.isArray(item)) flattenPages(item, out);
    else if (item && typeof item === 'object') out.push(item);
  }
  return out;
}

// The first line is the canonical identity. Informational closeout text and
// arbitrary prose can never be selected as the tasklist proof.
function selectTasklistComments(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((comment) => comment && typeof comment.body === 'string'
      && comment.body.split(/\r?\n/, 1)[0] === TASKLIST_MARKER)
    .slice()
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function issueMatchesPlan(issue, planId) {
  const escaped = planId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titlePattern = new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, 'i');
  const specPathPattern = new RegExp(`docs/pocket/spec/${escaped}(?:/|\\b)`, 'i');
  return titlePattern.test(typeof issue.title === 'string' ? issue.title : '')
    || specPathPattern.test(typeof issue.body === 'string' ? issue.body : '');
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

function readPlan(planDir) {
  let log;
  try {
    log = readLog(path.join(planDir, 'log.json'));
  } catch {
    return { ok: false, code: 'PLAN_STATE_UNAVAILABLE', message: 'Final plan log is unavailable or malformed.' };
  }
  if (!log.header || log.header.status !== 'DONE' || !Array.isArray(log.phases)
      || log.phases.length === 0 || log.phases.some((phase) => phase.status !== 'DONE')) {
    return { ok: false, code: 'PLAN_NOT_CLOSED', message: 'Plan closure requires a DONE plan with every phase DONE.' };
  }
  return { ok: true, log };
}

function proofState(log) {
  return {
    status: log.header.status,
    phases: log.phases.map((phase) => ({
      file: phase.file,
      status: phase.status,
      tasks: (phase.tasks || []).map((task) => ({
        id: task.id,
        status: task.status,
        done_sha: task.done_sha || null,
      })),
    })),
  };
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

function updateComment(eventId, endpoint, method, body, opts) {
  const response = github.runGh(['api', endpoint, '--method', method, '-f', `body=${body}`], {
    runner: opts.ghRunner,
    timeoutMs: opts.timeoutMs,
    expectJson: method !== 'DELETE',
  });
  return response.ok
    ? { ok: true, data: response.data }
    : { ok: false, result: fromTransport(eventId, response, 'TASKLIST_UPSERT_FAILED') };
}

function evaluateClosureProof({ event, comments, metadata } = {}) {
  const markers = selectTasklistComments(comments);
  const tasklist = metadata && metadata.github_issue && metadata.github_issue.tasklist;
  const metadataMatches = Boolean(event && tasklist
    && tasklist.event_id === event.event_id
    && tasklist.marker === TASKLIST_MARKER
    && tasklist.proof_ref === PROOF_REF
    && Number.isInteger(tasklist.comment_id)
    && typeof tasklist.proof_hash === 'string'
    && /^[0-9a-f]{64}$/.test(tasklist.proof_hash));
  const markerMatches = metadataMatches && markers.some((comment) => comment.id === tasklist.comment_id);
  return {
    proven: markers.length > 0 && markerMatches,
    markerCount: markers.length,
    metadataMatches,
    proof_ref: metadataMatches ? tasklist.proof_ref : null,
    proof_hash: metadataMatches ? tasklist.proof_hash : null,
  };
}

function listTasklistComments(event, repository, issueNumber, opts) {
  const endpoint = `repos/${repository}/issues/${issueNumber}/comments`;
  const listed = ghJson(['api', endpoint, '--paginate', '--slurp'], opts);
  if (!listed.ok) return { ok: false, result: fromTransport(event.event_id, listed, 'TASKLIST_LOOKUP_FAILED') };
  return { ok: true, markers: selectTasklistComments(flattenPages(listed.data)) };
}

function upsertTasklist(event, repository, issueNumber, body, opts, markers) {
  const endpoint = `repos/${repository}/issues/${issueNumber}/comments`;
  if (!markers) {
    const listed = listTasklistComments(event, repository, issueNumber, opts);
    if (!listed.ok) return listed;
    markers = listed.markers;
  }

  if (markers.length === 0) {
    const created = updateComment(event.event_id, endpoint, 'POST', body, opts);
    if (!created.ok) return created;
    if (!created.data || !Number.isInteger(created.data.id)) {
      return {
        ok: false,
        result: adapterResult(event.event_id, 'reconciling', 'TASKLIST_COMMENT_UNCONFIRMED',
          'The tasklist mutation may have succeeded but returned no comment identity; replay will reconcile the marker.', true),
      };
    }
    return { ok: true, comment: created.data };
  }

  const earliest = markers[0];
  if (!Number.isInteger(earliest.id)) {
    return {
      ok: false,
      result: adapterResult(event.event_id, 'terminal', 'TASKLIST_COMMENT_ID_INVALID',
        'A canonical tasklist comment has no valid remote identity; manual resolution is required.', false),
    };
  }
  const updated = updateComment(event.event_id,
    `repos/${repository}/issues/comments/${earliest.id}`, 'PATCH', body, opts);
  if (!updated.ok) return updated;

  for (const duplicate of markers.slice(1)) {
    if (!Number.isInteger(duplicate.id)) {
      return {
        ok: false,
        result: adapterResult(event.event_id, 'reconciling', 'TASKLIST_DUPLICATE_UNCONFIRMED',
          'A duplicate tasklist marker could not be identified for safe cleanup; replay will reconcile it.', true),
      };
    }
    const deleted = updateComment(event.event_id,
      `repos/${repository}/issues/comments/${duplicate.id}`, 'DELETE', '', opts);
    if (!deleted.ok) return { ok: false, result: deleted.result };
  }
  return { ok: true, comment: { ...earliest, ...updated.data } };
}

function writeCloseoutFile(planDir, content, opts) {
  const filePath = path.join(planDir, 'closeout.md');
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return;
  } catch {
    // A missing or unreadable closeout is repaired by the same local write path.
  }
  (opts.writeFile || fs.writeFileSync)(filePath, content, 'utf8');
}

function handlePlanClosed(event, opts = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  const validation = validateEvent(event);
  if (!validation.ok || event.type !== 'plan-closed') {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_INVALID_EVENT',
      'Closure handler requires a valid plan-closed event.', false);
  }
  if (typeof opts.specDir !== 'string' || !opts.specDir.length
      || typeof opts.planDir !== 'string' || !opts.planDir.length) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PATH_REQUIRED',
      'Closure reconciliation requires the spec and plan directories.', false);
  }
  if (path.basename(path.resolve(opts.specDir)) !== event.plan_id) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_PLAN_ID_MISMATCH',
      'The spec directory does not match the lifecycle plan identity.', false);
  }
  if (!event.artifact_refs.some((ref) => ref.root === 'plan')) {
    return adapterResult(eventId, 'terminal', 'CLOSEOUT_ARTIFACT_REQUIRED',
      'Plan closure requires final plan-root artifact references.', false);
  }
  const plan = readPlan(opts.planDir);
  if (!plan.ok) return adapterResult(eventId, 'terminal', plan.code, plan.message, false);

  let metadata;
  try {
    metadata = enterpriseMeta.readMetaFor(opts.specDir);
  } catch {
    return adapterResult(eventId, 'terminal', 'ISSUE_METADATA_INVALID',
      'Linked issue metadata is unavailable or malformed; manual resolution is required.', false);
  }

  const currentRepo = ghJson(['repo', 'view', '--json', 'owner,name'], opts);
  if (!currentRepo.ok) return fromTransport(eventId, currentRepo, 'REPOSITORY_LOOKUP_FAILED');
  const repository = repoName(currentRepo.data);
  if (!repository) {
    return adapterResult(eventId, 'terminal', 'REPOSITORY_LOOKUP_FAILED',
      'The current origin repository could not be resolved.', false);
  }

  const selected = selectIssue(event, metadata, repository, opts);
  if (!selected.ok) return selected.result;

  const tasklist = tasklistBody(plan.log);
  const closeout = closeoutBody({
    slug: event.plan_id,
    issue: selected.issue.number,
    phases: plan.log.phases.length,
  });
  const listed = listTasklistComments(event, repository, selected.issue.number, opts);
  if (!listed.ok) return listed.result;
  const existingProof = evaluateClosureProof({ event, comments: listed.markers, metadata });
  const previousRecord = metadata.github_issue && metadata.github_issue.tasklist;
  const existingMarker = listed.markers.find((comment) => comment.id === (previousRecord && previousRecord.comment_id));
  if (existingProof.proven && listed.markers.length === 1 && existingMarker
      && existingMarker.body === tasklist && previousRecord.body_sha256 === sha256(tasklist)) {
    try {
      writeCloseoutFile(opts.planDir, closeout, opts);
    } catch (error) {
      return adapterResult(eventId, 'reconciling', 'CLOSEOUT_LOCAL_WRITE_FAILED',
        `Canonical tasklist proof is present but local closeout.md could not be written: ${error && error.message ? error.message : String(error)}. Replay will reconcile the local artifact.`, true);
    }
    return {
      event_id: eventId,
      status: 'succeeded',
      proof_ref: existingProof.proof_ref,
      proof_hash: existingProof.proof_hash,
    };
  }

  const upserted = upsertTasklist(event, repository, selected.issue.number, tasklist, opts, listed.markers);
  if (!upserted.ok) return upserted.result;

  const record = {
    event_id: event.event_id,
    revision: event.revision,
    marker: TASKLIST_MARKER,
    comment_id: upserted.comment.id,
    body_sha256: sha256(tasklist),
    final_state: proofState(plan.log),
    artifact_refs: event.artifact_refs.map((ref) => ({ ...ref })),
    proof_ref: PROOF_REF,
  };
  const proofHash = sha256(JSON.stringify(record));
  record.proof_hash = proofHash;
  metadata.github_issue = {
    ...(metadata.github_issue || {}),
    number: selected.issue.number,
    url: selected.issue.html_url || selected.issue.url || metadata.github_issue.url,
    tasklist: record,
  };

  try {
    (opts.writeMeta || enterpriseMeta.writeMetaFor)(opts.specDir, metadata);
  } catch (error) {
    return withTasklistProof(
      adapterResult(eventId, 'reconciling', 'CLOSEOUT_LEDGER_WRITE_FAILED',
        `Remote tasklist proof is present but local metadata persistence failed: ${error && error.message ? error.message : String(error)}. Replay will reconcile the existing marker.`, true),
      proofHash
    );
  }

  try {
    writeCloseoutFile(opts.planDir, closeout, opts);
  } catch (error) {
    return withTasklistProof(
      adapterResult(eventId, 'reconciling', 'CLOSEOUT_LOCAL_WRITE_FAILED',
        `Remote tasklist proof is present but local closeout.md could not be written: ${error && error.message ? error.message : String(error)}. Replay will reconcile the existing marker.`, true),
      proofHash
    );
  }

  return {
    event_id: eventId,
    status: 'succeeded',
    proof_ref: PROOF_REF,
    proof_hash: proofHash,
  };
}

module.exports = {
  handlePlanClosed,
  selectTasklistComments,
  flattenPages,
  issueMatchesPlan,
  evaluateClosureProof,
};
