'use strict';

// Canonical remote closure proof: tasklist marker plus matching metadata.

const { TASKLIST_MARKER } = require('../cli/lib/bodies');
const github = require('./github');
const { PROOF_REF, adapterResult, fromTransport, ghJson } = require('./closure-prerequisites');

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

function hasCanonicalTasklistProof({ event, marker, metadata } = {}) {
  if (marker !== TASKLIST_MARKER || !event || typeof event.event_id !== 'string') return false;
  const tasklist = metadata && metadata.github_issue && metadata.github_issue.tasklist;
  if (!tasklist || tasklist.event_id !== event.event_id || tasklist.marker !== TASKLIST_MARKER) return false;
  if (tasklist.proof_ref !== PROOF_REF || !Number.isInteger(tasklist.comment_id)) return false;
  return typeof tasklist.proof_hash === 'string' && /^[0-9a-f]{64}$/.test(tasklist.proof_hash);
}

function evaluateClosureProof({ event, comments, metadata } = {}) {
  const markers = selectTasklistComments(comments);
  const tasklist = metadata && metadata.github_issue && metadata.github_issue.tasklist;
  const metadataMatches = hasCanonicalTasklistProof({
    event,
    marker: markers.length ? TASKLIST_MARKER : null,
    metadata,
  });
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

function createTasklistComment(eventId, endpoint, body, opts) {
  const created = updateComment(eventId, endpoint, 'POST', body, opts);
  if (!created.ok) return created;
  if (!created.data || !Number.isInteger(created.data.id)) {
    return {
      ok: false,
      result: adapterResult(eventId, 'reconciling', 'TASKLIST_COMMENT_UNCONFIRMED',
        'The tasklist mutation may have succeeded but returned no comment identity; replay will reconcile the marker.', true),
    };
  }
  return { ok: true, comment: created.data };
}

function updateTasklistComments(event, repository, body, opts, markers) {
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

function upsertTasklist(event, repository, issueNumber, body, opts, markers) {
  const endpoint = `repos/${repository}/issues/${issueNumber}/comments`;
  if (!markers) {
    const listed = listTasklistComments(event, repository, issueNumber, opts);
    if (!listed.ok) return listed;
    markers = listed.markers;
  }
  return markers.length === 0
    ? createTasklistComment(event.event_id, endpoint, body, opts)
    : updateTasklistComments(event, repository, body, opts, markers);
}

module.exports = {
  flattenPages,
  selectTasklistComments,
  hasCanonicalTasklistProof,
  evaluateClosureProof,
  listTasklistComments,
  upsertTasklist,
};
