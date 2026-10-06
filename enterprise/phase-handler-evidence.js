'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const identity = require('../cli/lib/identity');
const enterpriseMeta = require('./meta');
const { PhaseHandlerError, safeMessage } = require('./phase-handler-errors');
const { resolvePlanArtifactPath } = require('./phase-handler-context');

function readPhaseEvidence(event, context) {
  const ref = findPhaseEvidenceRef(event);
  for (const artifactRef of event.artifact_refs) {
    const rootDir = artifactRef.root === 'spec' ? context.specDir : context.planDir;
    readPhaseArtifact(artifactRef, rootDir);
  }
  const number = phaseNumberFromArtifact(ref);
  const phaseLog = readPhaseLog(context.planDir, ref.path);
  return collectPhaseEvidence(number, phaseLog, context.planDir);
}

function findPhaseEvidenceRef(event) {
  const ref = event.artifact_refs.find((artifact) => artifact.root === 'plan' && artifact.kind === 'phase-evidence');
  if (!ref || typeof ref.path !== 'string') {
    throw new PhaseHandlerError('PHASE_EVIDENCE_REQUIRED', 'phase-complete requires a plan phase-evidence artifact.');
  }
  return ref;
}

function readPhaseArtifact(ref, rootDir) {
  try {
    if (typeof ref.path !== 'string' || !ref.path.length || path.isAbsolute(ref.path)
        || ref.path.split(/[\\/]/).includes('..')) {
      throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed phase artifact must use a contained root-relative path.');
    }
    const filePath = resolvePlanArtifactPath(rootDir, ref.path, 'phase evidence');
    const artifactStat = fs.lstatSync(filePath);
    if (artifactStat.isSymbolicLink() || !artifactStat.isFile()) {
      throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed phase artifact must resolve to a regular file.');
    }
    const contents = fs.readFileSync(filePath);
    verifyPhaseArtifact(ref, contents);
    return contents;
  } catch (error) {
    if (error instanceof PhaseHandlerError) {
      if (error.code === 'PHASE_ARTIFACT_PATH_INVALID') {
        throw new PhaseHandlerError('STALE_ARTIFACT', 'Committed phase artifact path is unavailable or unsafe.');
      }
      throw error;
    }
    if (enterpriseMeta.isTransientIoError(error)) {
      throw new PhaseHandlerError('PHASE_EVIDENCE_UNAVAILABLE',
        `Phase evidence could not be read because of a temporary I/O failure: ${safeMessage(error)}`, {
          status: 'retryable',
          retryable: true,
        });
    }
    throw new PhaseHandlerError('STALE_ARTIFACT', `Phase evidence is unavailable: ${safeMessage(error)}`);
  }
}

function verifyPhaseArtifact(ref, contents) {
  const digest = crypto.createHash('sha256').update(contents).digest('hex');
  if (digest !== ref.sha256) throw new PhaseHandlerError('STALE_ARTIFACT', 'Phase evidence no longer matches its committed SHA-256.');
}

function phaseNumberFromArtifact(ref) {
  const match = /phase[-_](\d+)/i.exec(ref.path);
  if (!match) throw new PhaseHandlerError('PHASE_IDENTITY_UNPROVEN', `Cannot derive phase identity from ${ref.path}.`);
  return Number(match[1]);
}

function readPhaseLog(planDir, artifactPath) {
  let log;
  try {
    const logPath = resolvePlanArtifactPath(planDir, 'log.json', 'plan task evidence');
    log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch (error) {
    if (error instanceof PhaseHandlerError) throw error;
    if (enterpriseMeta.isTransientIoError(error)) {
      throw new PhaseHandlerError('PHASE_EVIDENCE_UNAVAILABLE',
        `Cannot read plan task evidence because of a temporary I/O failure: ${safeMessage(error)}`, {
          status: 'retryable',
          retryable: true,
        });
    }
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', `Cannot read plan task evidence: ${safeMessage(error)}`);
  }
  if (!log || typeof log !== 'object' || Array.isArray(log)) {
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', 'Plan task evidence must be a JSON object.');
  }
  const phaseLog = (Array.isArray(log.phases) ? log.phases : []).find((phase) => samePath(phase.file, artifactPath));
  if (!phaseLog || !Array.isArray(phaseLog.tasks)) {
    throw new PhaseHandlerError('PHASE_EVIDENCE_INVALID', `No task evidence matches ${artifactPath}.`);
  }
  return phaseLog;
}

function collectPhaseEvidence(number, phaseLog, planDir) {
  const verdicts = [];
  const findings = [];
  for (const task of phaseLog.tasks) {
    const report = readReviewReport(planDir, task);
    if (!report) {
      verdicts.push({ task: task.id, verdict: 'SKIP' });
      continue;
    }
    const verdict = mapVerdict(report.overall);
    verdicts.push({ task: task.id, verdict });
    if (verdict === 'FAIL' || verdict === 'BLOCKED') appendFindings(findings, report, task.id, verdict);
  }
  return { number, key: `phase-${number}`, verdicts, findings };
}

function readReviewReport(planDir, task) {
  if (!task || typeof task.id !== 'string' || task.id.length === 0) return null;
  let reviewPath;
  try {
    reviewPath = resolvePlanArtifactPath(
      planDir,
      path.join('reviews', `${task.id}-review.json`),
      'review evidence',
      { allowMissing: true },
    );
  } catch (error) {
    if (error instanceof PhaseHandlerError) throw error;
    if (enterpriseMeta.isTransientIoError(error)) {
      throw new PhaseHandlerError('PHASE_REVIEW_EVIDENCE_UNAVAILABLE',
        `Cannot read ${task.id} review evidence because of a temporary I/O failure: ${safeMessage(error)}`, {
          status: 'retryable',
          retryable: true,
        });
    }
    throw new PhaseHandlerError('PHASE_REVIEW_EVIDENCE_INVALID', `Cannot read ${task.id} review evidence: ${safeMessage(error)}`);
  }
  if (!reviewPath) return null;
  try {
    return JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  } catch (error) {
    if (enterpriseMeta.isTransientIoError(error)) {
      throw new PhaseHandlerError('PHASE_REVIEW_EVIDENCE_UNAVAILABLE',
        `Cannot read ${task.id} review evidence because of a temporary I/O failure: ${safeMessage(error)}`, {
          status: 'retryable',
          retryable: true,
        });
    }
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
    appendStageFindings(output, entries, stage, taskId, verdict);
  }
}

function appendStageFindings(output, entries, stage, taskId, verdict) {
  entries.forEach((issue, occurrence) => {
    const location = parseLocation(issue && issue.location);
    const ruleId = findingRuleId(issue, stage);
    const message = String(issue && issue.description ? issue.description : '').split(/\r?\n/).join('\n').trim();
    const finding = { file: location.file, ruleId, message, occurrence, task: taskId, verdict };
    output.push({
      fingerprint: identity.fingerprint({ file: location.file, ruleId, message, occurrence }),
      finding,
      line: location.line,
    });
  });
}

function findingRuleId(issue, stage) {
  return stage === 'stage_1'
    ? `stage-1:${issue && issue.type ? issue.type : 'issue'}`
    : `stage-2:${String(issue && issue.severity ? issue.severity : 'issue').toLowerCase()}`;
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

module.exports = { readPhaseEvidence };
