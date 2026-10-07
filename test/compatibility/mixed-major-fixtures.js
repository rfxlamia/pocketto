'use strict';

const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lifecycleStore = require('../../cli/lib/lifecycle-store');
const { tempDirectory, installRecordingRemoteBoundary } = require('./support');

function writeSurface(root, major) {
  fs.mkdirSync(root, { recursive: true });
  const manifestPath = path.join(root, 'surfaces.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ schema: 1, release: { major } }, null, 2)}\n`);
  return manifestPath;
}

function readCoreInfo(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const major = manifest.release.major;
  return {
    present: true,
    packageMajor: major,
    releaseMajor: major,
    contract: major === 3 ? 2 : 3,
    pipeline: major === 3 ? 4 : 5,
    lifecycleSchema: major === 3 ? null : 1,
    adapterContract: 1,
    surfaceManifest: manifest.schema,
  };
}

function readEnterpriseInfo(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return {
    packageMajor: manifest.release.major,
    releaseMajor: manifest.release.major,
    adapterContract: 1,
    surfaceManifest: manifest.schema,
  };
}

function createMatrixFixture(t, coreMajor, enterpriseMajor) {
  const tempRoot = tempDirectory(t, `pocket-compat-v${coreMajor}-v${enterpriseMajor}-`);
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const coreManifest = writeSurface(path.join(tempRoot, 'core'), coreMajor);
  const remote = installRecordingRemoteBoundary(projectRoot, tempRoot, { adapterMajor: enterpriseMajor });
  const enterpriseManifest = path.join(tempRoot, 'surfaces.json');
  return { tempRoot, projectRoot, coreManifest, enterpriseManifest, remote };
}

function createPendingEvent(specDir) {
  fs.mkdirSync(specDir, { recursive: true });
  const artifact = 'approved-spec.md';
  const bytes = Buffer.from('Compatibility fixture approved spec.\n');
  fs.writeFileSync(path.join(specDir, artifact), bytes);
  fs.writeFileSync(path.join(specDir, '.pocket-meta.json'), '{"preserve":"metadata"}\n');
  fs.writeFileSync(path.join(specDir, 'log.json'), '{"preserve":"task projection"}\n');
  fs.writeFileSync(path.join(specDir, 'remote-marker.md'), '<!-- pocket-plan:compatibility-plan -->\n');
  const committed = lifecycleStore.commitTransition({
    specDir,
    planId: 'compatibility-plan',
    planDir: null,
    type: 'spec-approved',
    artifacts: [{
      root: 'spec',
      kind: 'spec-doc',
      path: artifact,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      revision: 1,
    }],
    deps: { now: () => '2026-09-20T12:00:00.000Z' },
  });
  assert.equal(committed.ok, true, `fixture event should commit locally: ${JSON.stringify(committed)}`);
  return committed.event.event_id;
}

function snapshotLocalState(specDir) {
  const doc = JSON.parse(fs.readFileSync(path.join(specDir, 'lifecycle.json'), 'utf8'));
  return {
    plan: doc.plan,
    events: doc.events.map((event) => ({
      event_id: event.event_id,
      type: event.type,
      revision: event.revision,
      payload_hash: event.payload_hash,
      artifact_refs: event.artifact_refs,
      delivery: {
        status: event.delivery.status,
        attempts: event.delivery.attempts,
        error: event.delivery.error ?? null,
      },
    })),
    files: Object.fromEntries(['.pocket-meta.json', 'log.json', 'remote-marker.md'].map((name) => [
      name,
      fs.readFileSync(path.join(specDir, name)),
    ])),
  };
}

module.exports = {
  createMatrixFixture,
  createPendingEvent,
  readCoreInfo,
  readEnterpriseInfo,
  snapshotLocalState,
  writeSurface,
};
