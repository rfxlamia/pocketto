#!/usr/bin/env node
'use strict';

// Minimal process-level runner representing the immutable v3 local workflow.
// It reads the legacy projection only and deliberately knows nothing about v4.

const fs = require('node:fs');
const path = require('node:path');

const planDir = process.argv[2];
if (typeof planDir !== 'string' || planDir.length === 0) {
  process.stderr.write('Usage: legacy-runner.js <plan_dir>\n');
  process.exitCode = 2;
} else {
  const logPath = path.join(planDir, 'log.json');
  const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const firstPhase = log.phases && log.phases[0];
  if (!firstPhase) {
    process.stderr.write('Legacy plan has no phases.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      workflow_version: 3,
      plan_status: log.header.status,
      phase_status: firstPhase.status,
      task_count: (firstPhase.tasks || []).length,
    })}\n`);
  }
}
