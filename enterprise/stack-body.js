'use strict';

const { linkLine } = require('../cli/lib/bodies');

const STACK_START = '<!-- pocket-stack-context:start -->';
const STACK_END = '<!-- pocket-stack-context:end -->';

// Marker rule: markers match as literal text anywhere in the body, code fences included.
// A body must hold either no markers or exactly one start followed by one end.
// Anything else fails closed with STACK_BLOCK_MALFORMED.

function stackBlock({ planId, phaseKey, phaseOrder, phaseCount, baseBranch, parentPr }) {
  const parent = parentPr == null ? 'repository root base' : `#${parentPr}`;
  return [
    STACK_START,
    '## Stack context',
    '',
    `- Phase: Phase ${phaseOrder} of ${phaseCount}`,
    `- Plan: \`${planId}\``,
    `- Phase key: \`${phaseKey}\``,
    `- Base branch: \`${baseBranch}\``,
    `- Parent PR: ${parent}`,
    '',
    `This PR contains only phase ${phaseOrder}'s changes.`,
    STACK_END,
  ].join('\n');
}

function phasePrBody({ closeoutSnapshot, block, issueLink }) {
  return [closeoutSnapshot.replace(/\n+$/, ''), block, linkLine(issueLink)].join('\n\n') + '\n';
}

function malformedError(detail) {
  const error = new Error(`Stack context markers are malformed: ${detail}`);
  error.code = 'STACK_BLOCK_MALFORMED';
  return error;
}

function indexesOf(text, needle) {
  const found = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    found.push(i);
  }
  return found;
}

// Returns the managed span [start, end) covering the start marker through the end marker,
// or null when the body holds no markers at all.
function managedSpan(text) {
  const starts = indexesOf(text, STACK_START);
  const ends = indexesOf(text, STACK_END);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    throw malformedError(`found ${starts.length} start and ${ends.length} end markers`);
  }
  if (starts[0] > ends[0]) throw malformedError('end marker precedes start marker');
  return { start: starts[0], end: ends[0] + STACK_END.length };
}

function assertWellFormedBlock(block) {
  const span = managedSpan(block);
  if (!span || span.start !== 0 || span.end !== block.length) {
    throw malformedError('block argument is not a single marker-delimited block');
  }
}

// Replaces the managed span in place, or appends the block when no markers exist yet.
// Bytes outside the managed span are never altered. Rerunning with the same block is idempotent.
function upsertStackBlock(body, block) {
  assertWellFormedBlock(block);
  const span = managedSpan(body);
  if (span) return body.slice(0, span.start) + block + body.slice(span.end);
  if (body === '') return block;
  const trailingNewlines = body.match(/\n*$/)[0].length;
  return body + '\n'.repeat(Math.max(0, 2 - trailingNewlines)) + block;
}

module.exports = { stackBlock, phasePrBody, upsertStackBlock };
