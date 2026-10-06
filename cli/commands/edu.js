'use strict';

// pocketto-pi edu [<dir>]
// pocketto-pi edu init [<dir>] --level <skill>=<level> [--level ...] [--teaching-mode <mode>] [--journal <bool>] [--file <AGENTS.md|CLAUDE.md>] [--reset]
// pocketto-pi edu set  [<dir>] [--level <skill>=<level> ...] [--teaching-mode <mode>] [--journal <bool>] [--education <bool>]
//
// Reads and writes the Pocket Education learner profile. Pure local file
// writes — no git remote, no `gh`. Everything outside the profile block is
// preserved byte for byte. Consent for a level change is the skill layer's
// job (pocket-education); this command only makes every change explicit and
// reports it.

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('../lib/envelope');
const {
  FILES,
  HEADING,
  detectEducation,
  levelDirection,
  parseBoolFlag,
  parseLevelArgs,
  parseProfile,
  parseTeachingMode,
  readFile,
  renderBlock,
  renderFence,
  scanBlock,
  splitText,
} = require('../lib/education');

const INIT_USAGE =
  'Usage: pocketto-pi edu init [<dir>] --level <skill>=<level> [--level ...] [--teaching-mode guided|socratic] ' +
  '[--journal <bool>] [--file <AGENTS.md|CLAUDE.md>] [--reset]';
const SET_USAGE =
  'Usage: pocketto-pi edu set [<dir>] [--level <skill>=<level> ...] [--teaching-mode guided|socratic] ' +
  '[--journal <bool>] [--education <bool>]';

function resolveDir(arg) {
  const dir = path.resolve(arg || process.cwd());
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new CliError('NOT_FOUND', `'${dir}' is not a directory.`);
  }
  if (!st.isDirectory()) throw new CliError('NOT_FOUND', `'${dir}' is not a directory.`);
  return dir;
}

function writeLines(dir, file, lines, eol) {
  fs.writeFileSync(path.join(dir, file), lines.join(eol), 'utf8');
}

function profileLines(profile) {
  const mode = `teaching_mode=${profile.teaching_mode}, journal=${profile.journal ? 'on' : 'off'}`;
  const out = [
    profile.education ? `Pocket Education enabled (${mode})` : 'Pocket Education disabled',
  ];
  if (profile.source) {
    out.push(`Source: ${profile.source}${profile.education ? '' : ' (profile kept)'}`);
  }
  const ids = Object.keys(profile.skills);
  if (ids.length) {
    const width = Math.max(...ids.map((id) => id.length));
    out.push('Learner profile:');
    for (const id of ids) out.push(`  ${id.padEnd(width)}  ${profile.skills[id]}`);
  }
  return out;
}

function runRead(targetDir) {
  const data = detectEducation(resolveDir(targetDir));
  return { command: 'edu', exit: 0, human: profileLines(data), data };
}

function runInit(targetDir, { levels, teachingMode, journal, education, file, reset }) {
  if (education !== null && education !== undefined) {
    throw new CliError('BAD_USAGE', `edu init always enables Education; use \`edu set --education\` to toggle it.\n${INIT_USAGE}`);
  }
  const dir = resolveDir(targetDir);
  const parsedLevels = parseLevelArgs(levels);
  if (parsedLevels.length === 0) {
    throw new CliError('EDU_INPUT_INVALID', `edu init requires at least one --level <skill>=<level>.\n${INIT_USAGE}`);
  }
  if (file !== null && file !== undefined && !FILES.includes(file)) {
    throw new CliError('EDU_INPUT_INVALID', `--file must be one of: ${FILES.join(', ')}.`);
  }
  const mode = parseTeachingMode(teachingMode) || 'guided';
  const journalOn = parseBoolFlag('--journal', journal);

  // Locate existing profiles leniently: a malformed one still "exists" and
  // can only be replaced through an explicit --reset.
  const present = FILES.filter((f) => {
    const text = readFile(dir, f);
    return text !== null && scanBlock(splitText(text).lines) !== null;
  });
  if (present.length > 0 && !reset) {
    throw new CliError(
      'EDU_PROFILE_EXISTS',
      `A learner profile already exists in ${present.join(', ')}. Reuse it (read with \`edu\`, change levels with ` +
        '`edu set`). Recalibrate with --reset only when the learner asks for it.',
    );
  }
  if (present.length > 1) {
    throw new CliError(
      'EDU_FILE_MISMATCH',
      `Learner profiles exist in both ${present.join(' and ')}. Remove one ${HEADING} block before resetting.`,
    );
  }
  const target = present[0] || file || 'AGENTS.md';
  if (present.length === 1 && file && file !== present[0]) {
    throw new CliError(
      'EDU_FILE_MISMATCH',
      `The learner profile lives in ${present[0]}; reset it there (--file ${present[0]}) instead of creating a second one in ${file}.`,
    );
  }

  const profile = {
    education: true,
    teaching_mode: mode,
    journal: journalOn === null ? true : journalOn,
    skills: Object.fromEntries(parsedLevels),
  };
  const block = renderBlock(profile);

  const text = readFile(dir, target) || '';
  const { lines, eol } = splitText(text);
  let next;
  let action;
  if (present.length === 1) {
    const span = scanBlock(lines);
    next = [...lines.slice(0, span.heading), ...block, ...lines.slice(span.end + 1)];
    if (next[next.length - 1] !== '') next.push('');
    action = 'reset';
  } else if (text.trim() === '') {
    next = [...block, ''];
    action = 'created';
  } else {
    const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    next = [...body, '', ...block, ''];
    action = 'created';
  }
  writeLines(dir, target, next, eol);

  const data = { ...parseProfile(next.join(eol), target), wrote: [target], action };
  return {
    command: 'edu',
    exit: 0,
    human: [
      action === 'reset' ? 'Pocket Education profile recalibrated.' : 'Pocket Education enabled.',
      `Wrote: ${target}`,
      ...profileLines(data).slice(1),
    ],
    data,
  };
}

function runSet(targetDir, { levels, teachingMode, journal, education, file, reset }) {
  if (reset) throw new CliError('BAD_USAGE', `--reset belongs to edu init.\n${SET_USAGE}`);
  const dir = resolveDir(targetDir);
  const parsedLevels = parseLevelArgs(levels);
  const mode = parseTeachingMode(teachingMode);
  const journalOn = parseBoolFlag('--journal', journal);
  const enabled = parseBoolFlag('--education', education);
  if (parsedLevels.length === 0 && mode === null && journalOn === null && enabled === null) {
    throw new CliError('BAD_USAGE', `edu set needs at least one change.\n${SET_USAGE}`);
  }

  const current = detectEducation(dir);
  if (current.source === null) {
    throw new CliError(
      'EDU_NOT_INITIALIZED',
      'No learner profile found. Run /pocketto:pocket-init (Education Gate) or `edu init` first.',
    );
  }
  if (file && file !== current.source) {
    throw new CliError('EDU_FILE_MISMATCH', `The active learner profile lives in ${current.source}, not ${file}.`);
  }

  const next = {
    education: enabled === null ? current.education : enabled,
    teaching_mode: mode === null ? current.teaching_mode : mode,
    journal: journalOn === null ? current.journal : journalOn,
    skills: { ...current.skills },
  };
  const changes = [];
  for (const key of ['education', 'teaching_mode', 'journal']) {
    if (next[key] !== current[key]) changes.push({ key, from: current[key], to: next[key] });
  }
  for (const [id, level] of parsedLevels) {
    const from = Object.prototype.hasOwnProperty.call(current.skills, id) ? current.skills[id] : null;
    if (from === level) continue;
    next.skills[id] = level;
    changes.push({ key: `skill.${id}`, skill: id, from, to: level, direction: levelDirection(from, level) });
  }

  if (changes.length === 0) {
    const data = { ...current, changed: false, changes, wrote: [] };
    return { command: 'edu', exit: 0, human: ['No change — the profile already matches.', ...profileLines(current)], data };
  }

  // Replace only the fence body: the heading and any prose above the fence
  // (including learner notes) stay untouched.
  const text = readFile(dir, current.source);
  const { lines, eol } = splitText(text);
  const span = scanBlock(lines);
  const updated = [...lines.slice(0, span.open + 1), ...renderFence(next), ...lines.slice(span.close)];
  const updatedText = updated.join(eol);
  const parsed = parseProfile(updatedText, current.source); // validate before writing
  writeLines(dir, current.source, updated, eol);

  const data = { ...parsed, changed: true, changes, wrote: [current.source] };
  const human = ['Pocket Education profile updated.', `Wrote: ${current.source}`];
  for (const c of changes) {
    human.push(`  ${c.key}: ${c.from === null ? '(new)' : c.from} → ${c.to}${c.direction ? ` (${c.direction.replace('_', ' ')})` : ''}`);
  }
  return { command: 'edu', exit: 0, human, data };
}

function run({
  positionals = [],
  levels = [],
  teachingMode = null,
  journal = null,
  education = null,
  file = null,
  reset = false,
} = {}) {
  const sub = positionals[0];
  const opts = { levels, teachingMode, journal, education, file, reset };
  if (sub === 'init' || sub === 'set') {
    if (positionals.length > 2) {
      throw new CliError('BAD_USAGE', sub === 'init' ? INIT_USAGE : SET_USAGE);
    }
    return sub === 'init' ? runInit(positionals[1], opts) : runSet(positionals[1], opts);
  }
  if (positionals.length > 1) throw new CliError('BAD_USAGE', 'Usage: pocketto-pi edu [<dir>] | edu init | edu set');
  if (levels.length || teachingMode !== null || journal !== null || education !== null || reset) {
    throw new CliError('BAD_USAGE', 'Profile flags need a subcommand: edu init | edu set.');
  }
  return runRead(sub);
}

module.exports = { run };
