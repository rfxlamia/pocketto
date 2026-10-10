'use strict';

// `pocketto-pi doctor` — read-only health check for the Pi extensions Pocket
// depends on. Reads ~/.pi/agent/settings.json and reports which required /
// recommended extensions are installed vs missing. Pure: never spawns `pi`,
// never writes. Default exit 0; `--strict` exits nonzero when a REQUIRED
// extension is missing, so it can gate a script.
//
// With an optional <plan_dir>, adds `data.warnings[]` for Pocket artifacts that
// git ignores. Warnings are display-only and never change the exit code.

const path = require('node:path');
const { statSync } = require('node:fs');
const { CliError } = require('../lib/envelope');
const { classify } = require('../lib/extensions');
const { planArtifactWarnings } = require('../lib/artifact-ignore');

function resolvePlanDirArg(arg) {
  let st;
  try {
    st = statSync(arg);
  } catch {
    throw new CliError('NOT_FOUND', `'${arg}' is not a file or directory.`);
  }
  return path.resolve(st.isFile() ? path.dirname(arg) : arg);
}

function run({ env = process.env, strict = false, planDir = null } = {}) {
  const items = classify(env);
  const required = items.filter((i) => i.tier === 'required');
  const recommended = items.filter((i) => i.tier === 'recommended');
  const missingRequired = required.filter((i) => !i.installed);
  const missingRecommended = recommended.filter((i) => !i.installed);

  const human = ['Pocket extension check (~/.pi/agent/settings.json)', '', 'Required:'];
  for (const i of required) {
    human.push(`  ${i.installed ? '✓' : '✗'} ${i.name}${i.installed ? '' : `  — ${i.unlocks}`}`);
  }
  human.push('', 'Recommended:');
  for (const i of recommended) {
    human.push(`  ${i.installed ? '✓' : '○'} ${i.name}${i.installed ? '' : `  — ${i.unlocks}`}`);
  }

  if (missingRequired.length || missingRecommended.length) {
    human.push('', 'Install the missing ones:');
    if (missingRequired.length) {
      human.push(`  pi install ${missingRequired.map((i) => `npm:${i.name}`).join(' ')}`);
    }
    human.push(`  # or: npx pocketto-pi setup-extensions${missingRecommended.length ? ' --all' : ''}`);
  } else {
    human.push('', 'All Pocket extensions are installed. ✓');
  }

  const healthy = missingRequired.length === 0;

  const data = {
    ok: healthy,
    required: required.map((i) => ({ name: i.name, installed: i.installed })),
    recommended: recommended.map((i) => ({ name: i.name, installed: i.installed })),
    missingRequired: missingRequired.map((i) => i.name),
    missingRecommended: missingRecommended.map((i) => i.name),
  };

  if (planDir !== null && planDir !== undefined) {
    data.warnings = planArtifactWarnings(resolvePlanDirArg(planDir));
    for (const w of data.warnings) {
      human.push('', `Warning ${w.code}: ${w.paths.length} Pocket artifact(s) ignored by git.`, `  ${w.consequence}`);
      for (const line of w.fix.split('\n')) human.push(`  ${line}`);
    }
  }

  return {
    command: 'doctor',
    exit: strict && !healthy ? 1 : 0,
    human,
    data,
  };
}

module.exports = { run };
