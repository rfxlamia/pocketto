'use strict';

// Pocket Education learner profile — a `## Pocket Education` heading followed
// by a fenced `key: value` block in AGENTS.md / CLAUDE.md, the same memory
// files (and the same AGENTS.md < CLAUDE.md precedence) as Pocket Enterprise.
//
//   education: true
//   profile_schema: 1
//   teaching_mode: guided
//   journal: true
//   skill.testing: foundation
//
// The block is deliberately separate from both the regenerable pocket-init
// managed section (so refreshing the project guide never resets calibration)
// and the Enterprise block (so neither mode can clobber the other).

const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('./envelope');

const HEADING = '## Pocket Education';
const PROFILE_SCHEMA = 1;
const FILES = ['AGENTS.md', 'CLAUDE.md'];
const BOOLS = new Set(['true', 'false']);
const LEVELS = ['foundation', 'guided', 'independent'];
const TEACHING_MODES = ['guided', 'socratic'];
const SKILL_PREFIX = 'skill.';
const SKILL_ID_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
const MAX_SKILLS = 16;
const SCALAR_KEYS = new Set(['education', 'profile_schema', 'teaching_mode', 'journal']);

// Written above the fence so any agent that loads the memory file learns the
// contract even before the pocket-education skill is loaded.
const PROSE =
  'When `education: true`, the learner writes the code; the agent explains, points to files, ' +
  'reviews, and gives progressive hints (`pocket-education` skill). Teach each skill at its level ' +
  'below and do not re-explain what a level already covers. Levels change only when the learner ' +
  'explicitly agrees: `npx -y pocketto-pi edu set --level <skill>=<level>`.';

const DEFAULT_EDUCATION = {
  education: false,
  profile_schema: null,
  teaching_mode: null,
  journal: null,
  skills: {},
  source: null,
};

function invalid(message) {
  throw new CliError('EDU_CONFIG_INVALID', message, { human: `Invalid Pocket Education profile: ${message}` });
}

function badInput(message) {
  throw new CliError('EDU_INPUT_INVALID', message);
}

// Preserve the file's line endings: a CRLF memory file stays CRLF.
function splitText(text) {
  const raw = text || '';
  return { lines: raw.split(/\r?\n/), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

function isSectionHeading(line) {
  return /^#{1,2}\s/.test(line.trim());
}

function isFence(line) {
  return line.trim().startsWith('```');
}

// Lenient scan used by both the strict parser and the writer. The fence must
// open before the next H1/H2 heading, so a profile whose fence was deleted can
// never borrow the fence of a following section (e.g. ## Pocket Enterprise).
// `end` is the last line the block owns, even when the block is malformed, so
// `edu init --reset` can repair it.
function scanBlock(lines) {
  const headings = [];
  lines.forEach((line, i) => {
    if (line.trim() === HEADING) headings.push(i);
  });
  if (headings.length === 0) return null;

  const heading = headings[0];
  let sectionEnd = lines.length - 1;
  for (let i = heading + 1; i < lines.length; i++) {
    if (isSectionHeading(lines[i])) {
      sectionEnd = i - 1;
      break;
    }
  }

  let open = -1;
  for (let i = heading + 1; i <= sectionEnd; i++) {
    if (isFence(lines[i])) {
      open = i;
      break;
    }
  }
  let close = -1;
  if (open !== -1) {
    for (let i = open + 1; i < lines.length; i++) {
      if (isFence(lines[i])) {
        close = i;
        break;
      }
    }
  }
  const end = close !== -1 ? close : sectionEnd;
  return { heading, open, close, end, duplicate: headings.length > 1 };
}

function parseFields(blockLines, source) {
  const fields = {};
  const skillOrder = [];
  for (const rawLine of blockLines) {
    const line = rawLine.split('#')[0].trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) invalid(`${source}: cannot parse line "${line}". Use key: value.`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === '' || value === '') invalid(`${source}: cannot parse line "${line}". Use key: value.`);
    if (Object.prototype.hasOwnProperty.call(fields, key)) invalid(`${source}: duplicate key ${key}.`);
    if (!SCALAR_KEYS.has(key) && !key.startsWith(SKILL_PREFIX)) {
      invalid(`${source}: unknown key ${key}. Allowed: ${[...SCALAR_KEYS].join(', ')}, ${SKILL_PREFIX}<id>.`);
    }
    fields[key] = value;
    if (key.startsWith(SKILL_PREFIX)) skillOrder.push(key);
  }
  return { fields, skillOrder };
}

function boolField(fields, key, fallback, source) {
  if (!Object.prototype.hasOwnProperty.call(fields, key)) return fallback;
  if (!BOOLS.has(fields[key])) invalid(`${source}: ${key} must be one of: true, false.`);
  return fields[key] === 'true';
}

function validateSkill(id, level, source) {
  if (!SKILL_ID_RE.test(id)) {
    invalid(`${source}: skill id "${id}" must be lowercase letters/digits joined by _ or - (e.g. system_design).`);
  }
  if (!LEVELS.includes(level)) {
    invalid(`${source}: ${SKILL_PREFIX}${id} must be one of: ${LEVELS.join(', ')}.`);
  }
}

function normalize({ fields, skillOrder }, source) {
  if (!Object.prototype.hasOwnProperty.call(fields, 'education')) {
    invalid(`${source}: ${HEADING} requires education: true|false.`);
  }
  const education = boolField(fields, 'education', false, source);

  if (!Object.prototype.hasOwnProperty.call(fields, 'profile_schema')) {
    invalid(`${source}: ${HEADING} requires profile_schema: ${PROFILE_SCHEMA}.`);
  }
  const schema = fields.profile_schema;
  if (!/^\d+$/.test(schema)) invalid(`${source}: profile_schema must be an integer.`);
  if (Number(schema) !== PROFILE_SCHEMA) {
    throw new CliError(
      'EDU_SCHEMA_UNSUPPORTED',
      `${source}: profile_schema ${schema} is not supported by this CLI (expects ${PROFILE_SCHEMA}). ` +
        'Update the CLI (npx -y pocketto-pi@latest), or recalibrate with `edu init --reset`.',
    );
  }

  const teachingMode = Object.prototype.hasOwnProperty.call(fields, 'teaching_mode')
    ? fields.teaching_mode
    : 'guided';
  if (!TEACHING_MODES.includes(teachingMode)) {
    invalid(`${source}: teaching_mode must be one of: ${TEACHING_MODES.join(', ')}.`);
  }

  const skills = {};
  for (const key of skillOrder) {
    const id = key.slice(SKILL_PREFIX.length);
    validateSkill(id, fields[key], source);
    skills[id] = fields[key];
  }
  if (skillOrder.length > MAX_SKILLS) {
    invalid(`${source}: at most ${MAX_SKILLS} skills keep the profile compact (found ${skillOrder.length}).`);
  }
  if (education && skillOrder.length === 0) {
    invalid(`${source}: education true requires at least one ${SKILL_PREFIX}<id> level.`);
  }

  return {
    education,
    profile_schema: PROFILE_SCHEMA,
    teaching_mode: teachingMode,
    journal: boolField(fields, 'journal', true, source),
    skills,
    source,
  };
}

// Strict parse of one file's text. null = no profile in this file.
function parseProfile(text, source) {
  const { lines } = splitText(text);
  const span = scanBlock(lines);
  if (span === null) return null;
  if (span.duplicate) invalid(`${source}: ${HEADING} appears more than once.`);
  if (span.open === -1) invalid(`${source}: ${HEADING} must contain a fenced block.`);
  if (span.close === -1) invalid(`${source}: ${HEADING} fenced block is not closed.`);
  return normalize(parseFields(lines.slice(span.open + 1, span.close), source), source);
}

function readFile(dir, file) {
  const filePath = path.join(dir, file);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

// Whole-heading precedence, last wins: CLAUDE.md overrides AGENTS.md. A
// malformed profile in either file is an error, never a silent "disabled".
function detectEducation(targetDir = process.cwd()) {
  const dir = path.resolve(targetDir || process.cwd());
  let active = null;
  for (const file of FILES) {
    const text = readFile(dir, file);
    if (text === null) continue;
    const parsed = parseProfile(text, file);
    if (parsed) active = parsed;
  }
  return active || { ...DEFAULT_EDUCATION, skills: {} };
}

function renderFence(profile) {
  const lines = [
    `education: ${profile.education}`,
    `profile_schema: ${PROFILE_SCHEMA}`,
    `teaching_mode: ${profile.teaching_mode}`,
    `journal: ${profile.journal}`,
  ];
  for (const [id, level] of Object.entries(profile.skills)) {
    lines.push(`${SKILL_PREFIX}${id}: ${level}`);
  }
  return lines;
}

function renderBlock(profile) {
  return [HEADING, '', PROSE, '', '```', ...renderFence(profile), '```'];
}

// `--level <id>=<level>` values → ordered [[id, level], ...].
function parseLevelArgs(levels) {
  const out = [];
  const seen = new Set();
  for (const raw of levels || []) {
    const eq = raw.indexOf('=');
    if (eq === -1) badInput(`--level expects <skill>=<level>, got '${raw}'.`);
    const id = raw.slice(0, eq).trim();
    const level = raw.slice(eq + 1).trim();
    if (!SKILL_ID_RE.test(id)) {
      badInput(`--level: skill id '${id}' must be lowercase letters/digits joined by _ or - (e.g. system_design).`);
    }
    if (!LEVELS.includes(level)) badInput(`--level ${id}: level must be one of: ${LEVELS.join(', ')}.`);
    if (seen.has(id)) badInput(`--level ${id} given more than once.`);
    seen.add(id);
    out.push([id, level]);
  }
  return out;
}

function parseTeachingMode(value) {
  if (value === null || value === undefined) return null;
  if (!TEACHING_MODES.includes(value)) badInput(`--teaching-mode must be one of: ${TEACHING_MODES.join(', ')}.`);
  return value;
}

function parseBoolFlag(name, value) {
  if (value === null || value === undefined) return null;
  if (!BOOLS.has(value)) badInput(`${name} must be one of: true, false.`);
  return value === 'true';
}

// Guidance direction of a level change, from the learner's point of view.
function levelDirection(from, to) {
  if (from === null || from === undefined) return 'added';
  const delta = LEVELS.indexOf(to) - LEVELS.indexOf(from);
  if (delta > 0) return 'less_guidance';
  if (delta < 0) return 'more_guidance';
  return 'unchanged';
}

module.exports = {
  DEFAULT_EDUCATION,
  FILES,
  HEADING,
  LEVELS,
  MAX_SKILLS,
  PROFILE_SCHEMA,
  TEACHING_MODES,
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
};
