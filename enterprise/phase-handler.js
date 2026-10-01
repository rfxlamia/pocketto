'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateEvent } = require('../cli/lib/lifecycle-contract');
const { setDiff } = require('../cli/lib/reconcile');
const { summaryBody } = require('../cli/lib/bodies');
const identity = require('../cli/lib/identity');
const enterpriseMeta = require('./meta');
const github = require('./github');
const { redactSecrets } = require('./retry');

const FINGERPRINT_PATTERN = /<!-- pocket-fp:([0-9a-f]{16}) -->/g;

class PhaseHandlerError extends Error {
  constructor(code, message, { status = 'terminal', retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function handlePhaseComplete(event, options = {}) {
  const eventId = event && typeof event.event_id === 'string' ? event.event_id : 'unknown-event';
  try {
    const checked = validateEvent(event);
    if (!checked.ok || event.type !== 'phase-complete') {
      throw new PhaseHandlerError('PHASE_EVENT_INVALID', 'Expected a valid phase-complete lifecycle event.');
    }

    const context = loadContext(event, options);
    const repo = resolveRepository(options);
    const phase = readPhaseEvidence(event, context);
    const meta = enterpriseMeta.readMetaFor(context.specDir);
    const issue = resolveOwnedIssue(event, context, repo, options);
    const selectedPr = resolvePhasePr(context, phase, repo, options);
    const pr = selectedPr.pr;
    const marker = identity.markerFor(phase.number);
    const commentEndpoint = `repos/${repo.nameWithOwner}/issues/${pr.number}/comments`;
    const comments = selectedPr.comments;
    upsertSummary(commentEndpoint, comments, marker, summaryBody({
      phase: phase.number,
      verdicts: phase.verdicts,
      prLinked: true,
    }), options);

    const threads = listReviewThreads(repo, pr.number, options);
    const fingerprints = reconcileFindings({
      repo,
      pr,
      threads,
      prior: readPriorFingerprints(meta, phase.key),
      findings: phase.findings,
      options,
    });

    const latestMeta = enterpriseMeta.readMetaFor(context.specDir);
    latestMeta.github_issue = { ...(latestMeta.github_issue || {}), number: issue.number, url: issue.url };
    const entry = phaseEntry(latestMeta, phase.key);
    entry.github_pr = { ...(entry.github_pr || {}), number: pr.number, url: pr.url };
    entry.review = { ...(entry.review || {}), fingerprints };
    try {
      enterpriseMeta.writeMetaFor(context.specDir, latestMeta);
    } catch (error) {
      throw new PhaseHandlerError('PHASE_PROOF_RECONCILING', `Remote phase proof succeeded but local metadata could not be saved: ${safeMessage(error)}`, {
        status: 'reconciling',
        retryable: true,
      });
    }

    const proof = JSON.stringify({ marker, fingerprints });
    return {
      event_id: eventId,
      status: 'succeeded',
      proof_ref: `meta:phases.${phase.key}.github_pr+meta:phases.${phase.key}.review.fingerprints`,
      proof_hash: crypto.createHash('sha256').update(proof).digest('hex'),
    };
  } catch (error) {
    if (error instanceof PhaseHandlerError) {
      return phaseFailure(eventId, error.code, error.message, error.status, error.retryable);
    }
    return phaseFailure(eventId, 'PHASE_HANDLER_FAILED', safeMessage(error), 'retryable', true);
  }
}

function phaseFailure(eventId, code, message, status, retryable) {
  return {
    event_id: eventId,
    status,
    error: { code, retryable, message: redactSecrets(String(message || code)) },
  };
}

function safeMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error ?? 'unknown error');
}

function loadContext(event, options) {
  const root = path.resolve(options.projectRoot || process.cwd());
  const defaultSpecDir = path.join(root, 'docs', 'pocket', 'spec', event.plan_id);
  const specDir = path.resolve(options.specDir || defaultSpecDir);
  const lifecyclePath = path.join(specDir, 'lifecycle.json');
  let lifecycle;
  try {
    lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
  } catch (error) {
    throw new PhaseHandlerError('PHASE_LIFECYCLE_UNAVAILABLE', `Cannot read phase lifecycle evidence: ${safeMessage(error)}`, {
      status: 'retryable',
      retryable: true,
    });
  }
  if (!lifecycle.plan || lifecycle.plan.plan_id !== event.plan_id) {
    throw new PhaseHandlerError('PHASE_PLAN_IDENTITY_MISMATCH', 'Lifecycle metadata does not identify this event plan.');
  }
  const defaultPlanDir = path.join(root, 'docs', 'pocket', 'plans', event.plan_id);
  const planDir = path.resolve(options.planDir || lifecycle.plan.plan_dir || defaultPlanDir);
  if (typeof lifecycle.plan.branch !== 'string' || lifecycle.plan.branch.length === 0) {
    throw new PhaseHandlerError('PHASE_BRANCH_REQUIRED', 'Lifecycle metadata does not contain the captured plan branch.');
  }
  return { root, specDir, planDir, branch: lifecycle.plan.branch, lifecycle };
}

function resolveRepository(options) {
  const data = runJson(['repo', 'view', '--json', 'owner,name,url'], options);
  const owner = typeof data.owner === 'string' ? data.owner : data.owner && data.owner.login;
  const name = data.name;
  if (typeof owner !== 'string' || owner.length === 0 || typeof name !== 'string' || name.length === 0) {
    throw new PhaseHandlerError('ORIGIN_UNPROVEN', 'The current origin repository could not be proven.');
  }
  return { owner, name, nameWithOwner: `${owner}/${name}`, url: data.url || null };
}

function resolveOwnedIssue(event, context, repo, options) {
  const stored = enterpriseMeta.getIssueIdentity(context.specDir);
  let invalidStored = false;
  if (Number.isInteger(stored.number) && stored.number > 0) {
    if (stored.url && !sameRepository(stored.url, repo)) {
      invalidStored = true;
    } else {
      try {
        const issue = runJson(['issue', 'view', String(stored.number), '--repo', repo.nameWithOwner,
          '--json', 'number,url,state,title,body'], options);
        if (isOwnedOpenIssue(issue, event.plan_id, repo)) return issue;
        invalidStored = true;
      } catch (_) {
        invalidStored = true;
      }
    }
  }

  const matches = runJson(['issue', 'list', '--repo', repo.nameWithOwner, '--state', 'open', '--label', 'pocket-plan',
    '--search', event.plan_id, '--json', 'number,url,state,title,body'], options);
  if (!Array.isArray(matches)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'Issue search response must be an array.', { status: 'retryable', retryable: true });
  }
  const exact = matches.filter((candidate) => hasExactPlanIdentity(candidate, event.plan_id));
  const owned = exact.filter((candidate) => isOwnedOpenIssue(candidate, event.plan_id, repo));
  if (exact.length === 1 && owned.length === 1) return owned[0];
  if (exact.length > 1 || (exact.length === 1 && owned.length === 0)) {
    throw new PhaseHandlerError('ISSUE_OWNERSHIP_UNPROVEN', 'Issue search found an ambiguous, foreign, closed, or mismatched plan issue.');
  }
  if (invalidStored) {
    throw new PhaseHandlerError('ISSUE_OWNERSHIP_UNPROVEN', 'Recorded issue metadata is invalid and no exact owned open issue could be proven.');
  }
  throw new PhaseHandlerError('ISSUE_REQUIRED', 'Phase reporting requires an existing owned open issue; no issue was created.', {
    status: 'retryable',
    retryable: true,
  });
}

function isOwnedOpenIssue(issue, planId, repo) {
  return issue
    && Number.isInteger(issue.number)
    && issue.number > 0
    && sameRepository(issue.url, repo)
    && String(issue.state).toUpperCase() === 'OPEN'
    && hasExactPlanIdentity(issue, planId);
}

function hasExactPlanIdentity(issue, planId) {
  if (!issue || typeof planId !== 'string') return false;
  const titleTokens = String(issue.title || '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
  if (titleTokens.includes(planId)) return true;
  const body = typeof issue.body === 'string' ? issue.body.replace(/\\/g, '/') : '';
  return new RegExp(`(?:^|/)docs/pocket/spec/${planId}(?:/|$)`, 'i').test(body);
}

function readPhaseEvidence(event, context) {
  const ref = event.artifact_refs.find((artifact) => artifact.root === 'plan' && artifact.kind === 'phase-evidence');
  if (!ref || typeof ref.path !== 'string') {
    throw new PhaseHandlerError('PHASE_EVIDENCE_REQUIRED', 'phase-complete requires a plan phase-evidence artifact.');
  }
  const filePath = resolveInside(context.planDir, ref.path);
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PhaseHandlerError('STALE_ARTIFACT', `Phase evidence is unavailable: ${safeMessage(error)}`);
  }
  const digest = crypto.createHash('sha256').update(contents).digest('hex');
  if (digest !== ref.sha256) throw new PhaseHandlerError('STALE_ARTIFACT', 'Phase evidence no longer matches its committed SHA-256.');
  const match = /phase[-_](\d+)/i.exec(ref.path);
  if (!match) throw new PhaseHandlerError('PHASE_IDENTITY_UNPROVEN', `Cannot derive phase identity from ${ref.path}.`);
  const number = Number(match[1]);
  const key = `phase-${number}`;
  let log;
  try {
    log = JSON.parse(fs.readFileSync(path.join(context.planDir, 'log.json'), 'utf8'));
  } catch (error) {
    throw new PhaseHandlerError('PHASE_EVIDENCE_UNAVAILABLE', `Cannot read plan task evidence: ${safeMessage(error)}`, {
      status: 'retryable',
      retryable: true,
    });
  }
  const phaseLog = (Array.isArray(log.phases) ? log.phases : []).find((phase) => samePath(phase.file, ref.path));
  if (!phaseLog || !Array.isArray(phaseLog.tasks)) {
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', `No task evidence matches ${ref.path}.`);
  }
  const verdicts = [];
  const findings = [];
  for (const task of phaseLog.tasks) {
    const report = readReviewReport(context.planDir, task);
    if (!report) {
      verdicts.push({ task: task.id, verdict: task.status === 'SKIP' ? 'SKIP' : 'SKIP' });
      continue;
    }
    const verdict = mapVerdict(report.overall);
    verdicts.push({ task: task.id, verdict });
    if (verdict === 'FAIL' || verdict === 'BLOCKED') appendFindings(findings, report, task.id, verdict);
  }
  return { number, key, verdicts, findings };
}

function readReviewReport(planDir, task) {
  if (!task || typeof task.id !== 'string' || task.id.length === 0) return null;
  const reviewPath = path.join(planDir, 'reviews', `${task.id}-review.json`);
  try {
    return JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new PhaseHandlerError('PHASE_REVIEW_EVIDENCE_INVALID', `Cannot read ${task.id} review evidence: ${safeMessage(error)}`);
  }
}

function mapVerdict(overall) {
  if (overall === 'REVIEW_PASS') return 'PASS';
  if (overall === 'REVIEW_FAIL') return 'FAIL';
  if (overall === 'REVIEW_BLOCKED') return 'BLOCKED';
  return 'SKIP';
}

function appendFindings(output, report, taskId, verdict) {
  for (const [stage, entries] of [
    ['stage_1', report.stage_1 && report.stage_1.issues],
    ['stage_2', report.stage_2 && report.stage_2.issues],
  ]) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((issue, occurrence) => {
      const location = parseLocation(issue && issue.location);
      const ruleId = stage === 'stage_1'
        ? `stage-1:${issue && issue.type ? issue.type : 'issue'}`
        : `stage-2:${String(issue && issue.severity ? issue.severity : 'issue').toLowerCase()}`;
      const message = String(issue && issue.description ? issue.description : '').split(/\r?\n/).join('\n').trim();
      const finding = {
        file: location.file,
        ruleId,
        message,
        occurrence,
        task: taskId,
        verdict,
      };
      output.push({
        fingerprint: identity.fingerprint({ file: location.file, ruleId, message, occurrence }),
        finding,
        line: location.line,
      });
    });
  }
}

function parseLocation(value) {
  const location = typeof value === 'string' ? value : '';
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(location);
  if (!match) return { file: location, line: null };
  return { file: match[1], line: Number(match[2]) };
}

function samePath(left, right) {
  return typeof left === 'string'
    && typeof right === 'string'
    && left.replace(/\\/g, '/').replace(/^\.\//, '') === right.replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveInside(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', 'Phase evidence path escapes the plan root.');
  }
  return target;
}

function resolvePhasePr(context, phase, repo, options) {
  const stored = enterpriseMeta.getPrIdentity(context.specDir, phase.key);
  const metadataMatch = resolveMetadataPr(stored, context, phase, repo, options);
  return metadataMatch || searchPhasePr(context, phase, repo, options);
}

function resolveMetadataPr(stored, context, phase, repo, options) {
  if (!Number.isInteger(stored.number) || stored.number <= 0
      || (stored.url && !sameRepository(stored.url, repo))) return null;
  try {
    const pr = loadPrView(stored.number, repo, options);
    const comments = listComments(`repos/${repo.nameWithOwner}/issues/${pr.number}/comments`, options);
    return validOpenPr(pr, context.branch, repo) && hasPhaseIdentity(comments, phase.number, true)
      ? { pr, comments }
      : null;
  } catch (_) {
    // Invalid or stale metadata is only a hint; exact branch/phase search follows.
    return null;
  }
}

function searchPhasePr(context, phase, repo, options) {
  const candidates = runJson(['pr', 'list', '--repo', repo.nameWithOwner, '--head', context.branch, '--state', 'open',
    '--json', 'number,url,state,headRefName,baseRefName,title,body,headRefOid'], options);
  if (!Array.isArray(candidates)) {
    throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'PR search response must be an array.', { status: 'retryable', retryable: true });
  }
  const matches = candidates.map((candidate) => searchCandidate(candidate, context, phase, repo, options)).filter(Boolean);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || candidates.length > 0) {
    throw new PhaseHandlerError('PR_MANUAL_RESOLUTION', 'PR search found ambiguous, foreign, closed, or mismatched phase candidates.');
  }
  throw requiredPr('No open PR matches the exact plan branch and phase marker; the adapter never creates PRs.');
}

function searchCandidate(candidate, context, phase, repo, options) {
  if (!Number.isInteger(candidate.number) || candidate.number <= 0) return null;
  let pr;
  try {
    pr = loadPrView(candidate.number, repo, options);
  } catch (_) {
    return null;
  }
  if (!validOpenPr(pr, context.branch, repo)) return null;
  const comments = listComments(`repos/${repo.nameWithOwner}/issues/${pr.number}/comments`, options);
  return hasPhaseIdentity(comments, phase.number, false) ? { pr, comments } : null;
}

function loadPrView(number, repo, options) {
  const pr = runJson(['pr', 'view', String(number), '--repo', repo.nameWithOwner,
    '--json', 'number,url,state,headRefName,baseRefName,title,body,headRefOid'], options);
  if (pr.number !== number || !sameRepository(pr.url, repo)) {
    throw new PhaseHandlerError('PR_OWNERSHIP_UNPROVEN', 'The PR does not belong to the current origin repository.');
  }
  return pr;
}

function validOpenPr(pr, branch, repo) {
  return pr
    && sameRepository(pr.url, repo)
    && String(pr.state).toUpperCase() === 'OPEN'
    && pr.headRefName === branch;
}

function hasPhaseIdentity(comments, phaseNumber, metadataFirst) {
  const markers = comments.map((comment) => {
    if (typeof comment.body !== 'string') return null;
    const match = /^<!-- pocket-phase-(\d+)-summary -->$/.exec(comment.body.split(/\r?\n/, 1)[0]);
    return match ? Number(match[1]) : null;
  }).filter((number) => number !== null);
  if (markers.includes(phaseNumber)) return true;
  return metadataFirst && markers.length === 0;
}

function sameRepository(url, repo) {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return false;
  }
  const parts = parsed.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  return parsed.hostname.toLowerCase() === 'github.com'
    && parts.length >= 2
    && parts[0].toLowerCase() === repo.owner.toLowerCase()
    && parts[1].toLowerCase() === repo.name.toLowerCase();
}

function requiredPr(message) {
  return new PhaseHandlerError('PR_REQUIRED', message, { status: 'retryable', retryable: true });
}

function runJson(args, options) {
  const result = github.runGh(args, {
    runner: options.ghRunner,
    timeoutMs: options.timeoutMs,
    attemptsMade: 1,
    expectJson: true,
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
    runJson(['api', commentEndpointForId(endpoint, duplicate.id), '--method', 'DELETE'], options);
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
    if (!page || !Array.isArray(page.nodes)) throw new PhaseHandlerError('GH_MALFORMED_OUTPUT', 'Review-thread response is malformed.', { status: 'retryable', retryable: true });
    threads.push(...page.nodes);
    if (page.pageInfo && page.pageInfo.hasNextPage) {
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

function reconcileFindings({ repo, pr, threads, prior, findings, options }) {
  const threadMap = new Map();
  const remoteByFingerprint = new Map();
  for (const thread of threads) {
    const comments = thread.comments && Array.isArray(thread.comments.nodes) ? thread.comments.nodes : [];
    for (const comment of comments) {
      FINGERPRINT_PATTERN.lastIndex = 0;
      let match;
      while ((match = FINGERPRINT_PATTERN.exec(String(comment.body || ''))) !== null) {
        const records = remoteByFingerprint.get(match[1]) || [];
        records.push(thread);
        remoteByFingerprint.set(match[1], records);
      }
    }
  }
  for (const [fingerprint, matches] of remoteByFingerprint) {
    const sorted = matches.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
    threadMap.set(fingerprint, sorted[0]);
    for (const duplicate of sorted.slice(1)) resolveThread(duplicate, repo, options);
  }

  const byFingerprint = new Map();
  for (const record of prior) {
    if (validFingerprintRecord(record)) byFingerprint.set(record.fingerprint, { ...record });
  }
  for (const [fingerprint, thread] of threadMap) {
    const existing = byFingerprint.get(fingerprint) || { fingerprint };
    existing.thread = thread.id;
    byFingerprint.set(fingerprint, existing);
  }
  const reconciliation = setDiff([...byFingerprint.values()], findings);
  for (const record of reconciliation.resolve) {
    const thread = threadMap.get(record.fingerprint);
    if (thread && !thread.isResolved) resolveThread(thread, repo, options);
    else if (record.thread && !thread) resolveThreadId(record.thread, repo, options);
  }
  for (const record of reconciliation.post) postFinding(repo, pr, record, options);

  const currentThreads = reconciliation.post.length > 0
    ? listReviewThreads(repo, pr.number, options)
    : threads;
  for (const thread of currentThreads) {
    const comments = thread.comments && Array.isArray(thread.comments.nodes) ? thread.comments.nodes : [];
    for (const comment of comments) {
      FINGERPRINT_PATTERN.lastIndex = 0;
      let match;
      while ((match = FINGERPRINT_PATTERN.exec(String(comment.body || ''))) !== null) {
        if (!threadMap.has(match[1])) threadMap.set(match[1], thread);
      }
    }
  }
  const saved = [];
  for (const record of [...reconciliation.keep, ...reconciliation.post]) {
    const thread = threadMap.get(record.fingerprint);
    if (!thread || !thread.id) {
      if (record.fingerprint && reconciliation.post.some((posted) => posted.fingerprint === record.fingerprint)) {
        throw new PhaseHandlerError('PHASE_THREAD_RECONCILING', 'A finding was posted but its review thread is not visible yet.', {
          status: 'reconciling',
          retryable: true,
        });
      }
      saved.push({ fingerprint: record.fingerprint, ...(record.thread ? { thread: record.thread } : {}) });
      continue;
    }
    saved.push({ fingerprint: record.fingerprint, thread: thread.id });
  }
  return saved.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function resolveThread(thread, repo, options) {
  if (thread.isResolved) return;
  resolveThreadId(thread.id, repo, options);
}

function resolveThreadId(threadId, repo, options) {
  const query = 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}';
  try {
    runJson(['api', 'graphql', '-f', `query=${query}`, '-F', `threadId=${threadId}`], options);
  } catch (_) {
    // GitHub rejects an already-resolved or missing thread; resolution is idempotent.
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

function phaseEntry(meta, phaseKey) {
  if (!meta.phases || typeof meta.phases !== 'object' || Array.isArray(meta.phases)) meta.phases = {};
  if (!meta.phases[phaseKey] || typeof meta.phases[phaseKey] !== 'object' || Array.isArray(meta.phases[phaseKey])) {
    meta.phases[phaseKey] = {};
  }
  return meta.phases[phaseKey];
}

module.exports = { handlePhaseComplete };
