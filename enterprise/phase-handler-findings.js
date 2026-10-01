'use strict';

const { setDiff } = require('../cli/lib/reconcile');
const identity = require('../cli/lib/identity');
const { PhaseHandlerError } = require('./phase-handler-errors');
const { runJson, listReviewThreads } = require('./phase-handler-github');

const FINGERPRINT_PATTERN = /<!-- pocket-fp:([0-9a-f]{16}) -->/g;

function readPriorFingerprints(meta, phaseKey) {
  const entry = meta.phases && meta.phases[phaseKey];
  const records = entry && entry.review && entry.review.fingerprints;
  if (Array.isArray(records)) return records.filter(validFingerprintRecord);
  const legacyRecords = entry && entry.fingerprints;
  return Array.isArray(legacyRecords) ? legacyRecords.filter(validFingerprintRecord) : [];
}

function validFingerprintRecord(record) {
  return record && typeof record.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(record.fingerprint);
}

function reconcileFindings(input) {
  const remoteFingerprints = collectRemoteFingerprints(input.threads);
  const { threadMap, duplicates } = selectCanonicalThreads(remoteFingerprints);
  const priorByFingerprint = mergePriorFingerprints(input.prior, threadMap);
  const recoveryProof = [...priorByFingerprint.values()];
  resolveDuplicateThreads(duplicates, input, recoveryProof);

  const reconciliation = setDiff([...priorByFingerprint.values()], uniqueFindingsByFingerprint(input.findings));
  resolveRemovedFindings(reconciliation.resolve, threadMap, priorByFingerprint, input);
  postFindings(reconciliation.post, input);
  const currentThreads = threadsAfterPosts(reconciliation.post, input);
  addObservedFingerprints(currentThreads, threadMap);
  return saveCanonicalFingerprints(reconciliation, threadMap, priorByFingerprint);
}

function uniqueFindingsByFingerprint(findings) {
  const seen = new Set();
  return findings.filter((record) => {
    if (seen.has(record.fingerprint)) return false;
    seen.add(record.fingerprint);
    return true;
  });
}

function collectRemoteFingerprints(threads) {
  const fingerprints = new Map();
  for (const thread of threads) {
    const comments = thread.comments && Array.isArray(thread.comments.nodes) ? thread.comments.nodes : [];
    for (const comment of comments) {
      FINGERPRINT_PATTERN.lastIndex = 0;
      let match;
      while ((match = FINGERPRINT_PATTERN.exec(String(comment.body || ''))) !== null) {
        const threadsById = fingerprints.get(match[1]) || new Map();
        if (!threadsById.has(thread.id)) threadsById.set(thread.id, thread);
        fingerprints.set(match[1], threadsById);
      }
    }
  }
  return fingerprints;
}

function selectCanonicalThreads(remoteFingerprints) {
  const threadMap = new Map();
  const duplicates = [];
  for (const [fingerprint, matches] of remoteFingerprints) {
    const sorted = [...matches.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    threadMap.set(fingerprint, sorted[0]);
    duplicates.push(...sorted.slice(1));
  }
  return { threadMap, duplicates };
}

function mergePriorFingerprints(prior, threadMap) {
  const byFingerprint = new Map();
  for (const record of prior) {
    if (validFingerprintRecord(record)) byFingerprint.set(record.fingerprint, { ...record });
  }
  for (const [fingerprint, thread] of threadMap) {
    const existing = byFingerprint.get(fingerprint) || { fingerprint };
    existing.thread = thread.id;
    byFingerprint.set(fingerprint, existing);
  }
  return byFingerprint;
}

function resolveDuplicateThreads(duplicates, input, recoveryProof) {
  for (const duplicate of duplicates) {
    try {
      resolveThread(duplicate, input.repo, input.pr, input.options);
    } catch (error) {
      input.onResolveFailure(recoveryProof);
      throw error;
    }
  }
}

function resolveRemovedFindings(records, threadMap, priorByFingerprint, input) {
  for (const record of records) {
    const thread = threadMap.get(record.fingerprint);
    try {
      if (thread && !thread.isResolved) resolveThread(thread, input.repo, input.pr, input.options);
      else if (record.thread && !thread) resolveThreadId(record.thread, input.repo, input.pr, input.options);
    } catch (error) {
      input.onResolveFailure([...priorByFingerprint.values()]);
      throw error;
    }
  }
}

function postFindings(records, input) {
  for (const record of records) postFinding(input.repo, input.pr, record, input.options);
}

function threadsAfterPosts(posted, input) {
  return posted.length > 0
    ? listReviewThreads(input.repo, input.pr.number, input.options)
    : input.threads;
}

function addObservedFingerprints(threads, threadMap) {
  for (const thread of threads) {
    const comments = thread.comments && Array.isArray(thread.comments.nodes) ? thread.comments.nodes : [];
    for (const comment of comments) {
      FINGERPRINT_PATTERN.lastIndex = 0;
      let match;
      while ((match = FINGERPRINT_PATTERN.exec(String(comment.body || ''))) !== null) {
        if (!threadMap.has(match[1])) threadMap.set(match[1], thread);
      }
    }
  }
}

function saveCanonicalFingerprints(reconciliation, threadMap, priorByFingerprint) {
  const saved = [];
  for (const record of [...reconciliation.keep, ...reconciliation.post]) {
    const thread = threadMap.get(record.fingerprint);
    const priorRecord = priorByFingerprint.get(record.fingerprint);
    const threadId = thread && thread.id ? thread.id : (record.thread || (priorRecord && priorRecord.thread));
    if (!threadId) {
      if (wasPosted(record, reconciliation.post)) throw missingPostedThread(record);
      saved.push({ fingerprint: record.fingerprint });
      continue;
    }
    saved.push({ fingerprint: record.fingerprint, thread: threadId });
  }
  return saved.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function wasPosted(record, posted) {
  return Boolean(record.fingerprint && posted.some((candidate) => candidate.fingerprint === record.fingerprint));
}

function missingPostedThread(record) {
  return new PhaseHandlerError('PHASE_THREAD_RECONCILING', 'A finding was posted but its review thread is not visible yet.', {
    status: 'reconciling',
    retryable: true,
  });
}

function resolveThread(thread, repo, pr, options) {
  if (thread.isResolved) return;
  resolveThreadId(thread.id, repo, pr, options);
}

function resolveThreadId(threadId, repo, pr, options) {
  const query = 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}';
  let response;
  try {
    response = runJson(['api', 'graphql', '-f', `query=${query}`, '-F', `threadId=${threadId}`], options);
  } catch (error) {
    if (confirmsThreadResolvedOrMissing(threadId, repo, pr, options)) return;
    throw error;
  }
  const resolved = response && response.data && response.data.resolveReviewThread
    && response.data.resolveReviewThread.thread;
  if (resolved && resolved.id === threadId && resolved.isResolved === true) return;
  if (confirmsThreadResolvedOrMissing(threadId, repo, pr, options)) return;
  throw new PhaseHandlerError('PHASE_THREAD_RECONCILING', `GitHub did not confirm resolution of review thread ${threadId}.`, {
    status: 'reconciling',
    retryable: true,
  });
}

function confirmsThreadResolvedOrMissing(threadId, repo, pr, options) {
  try {
    const threads = listReviewThreads(repo, pr.number, options);
    if (threads.some((candidate) => !candidate || typeof candidate.id !== 'string'
        || typeof candidate.isResolved !== 'boolean')) return false;
    const thread = threads.find((candidate) => candidate.id === threadId);
    return !thread || thread.isResolved === true;
  } catch (_) {
    return false;
  }
}

function postFinding(repo, pr, record, options) {
  const finding = record.finding || {};
  if (!finding.file || !Number.isInteger(record.line) || record.line < 1 || !pr.headRefOid) {
    throw new PhaseHandlerError('PHASE_FINDING_LOCATION_REQUIRED', `Finding ${record.fingerprint} lacks a reviewable diff location.`);
  }
  const body = `${finding.message}\n\n<!-- pocket-fp:${record.fingerprint} -->`;
  runJson([
    'api', `repos/${repo.nameWithOwner}/pulls/${pr.number}/comments`,
    '-f', `body=${body}`,
    '-f', `commit_id=${pr.headRefOid}`,
    '-f', `path=${finding.file}`,
    '-F', `line=${record.line}`,
    '-f', 'side=RIGHT',
  ], options);
}

module.exports = { readPriorFingerprints, reconcileFindings };
