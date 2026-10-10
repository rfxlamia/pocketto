'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { prBody } = require('../cli/lib/bodies');
const { stackBlock, upsertStackBlock, phasePrBody } = require('../enterprise/stack-body');

const START = '<!-- pocket-stack-context:start -->';
const END = '<!-- pocket-stack-context:end -->';

const PHASE_2 = {
  planId: '2026-10-10-phase-aware-stacked-pull-requests',
  phaseKey: 'phase-2',
  phaseOrder: 2,
  phaseCount: 3,
  baseBranch: 'pocket/p/phase-1',
  parentPr: 41,
};

test('stack body builds the snapshot, one stack block, and the prBody link line', () => {
  const closeoutSnapshot = '## Closeout: Phase 2\n\nPhase 2 finished with review PASS.\n';
  const block = stackBlock(PHASE_2);
  const body = phasePrBody({ closeoutSnapshot, block, issueLink: { issue: 12, finalPhase: false } });

  assert.ok(body.startsWith(closeoutSnapshot.trimEnd()), 'body must start with the closeout snapshot');
  assert.equal(body.split(START).length - 1, 1, 'body must contain exactly one stack block');
  assert.ok(body.includes(block), 'body must contain the block verbatim');
  assert.match(block, /Phase 2 of 3/);
  assert.ok(block.includes(PHASE_2.planId));
  assert.ok(block.includes('phase-2'));
  assert.ok(block.includes('pocket/p/phase-1'));
  assert.ok(block.includes('#41'));
  assert.ok(block.includes("This PR contains only phase 2's changes."));

  const expectedLink = prBody({ issue: 12, finalPhase: false, fileCount: 0, what: '', why: '', howToTest: '' })
    .body.trimEnd()
    .split('\n')
    .pop();
  assert.equal(expectedLink, 'refs #12');
  assert.equal(body.trimEnd().split('\n').pop(), expectedLink, 'body must end with the prBody refs/closes line');
});

test('stack body names the repository root base when phase 1 has no parent PR', () => {
  const block = stackBlock({ ...PHASE_2, phaseOrder: 1, phaseKey: 'phase-1', parentPr: null, baseBranch: 'main' });
  assert.ok(block.includes('Phase 1 of 3'));
  assert.ok(block.includes('repository root base'));
  assert.doesNotMatch(block, /#\d/, 'no PR number may appear when there is no parent');
  assert.ok(block.includes("This PR contains only phase 1's changes."));
});

test('stack upsert append adds the block after human text with exactly one blank line', () => {
  const block = stackBlock(PHASE_2);

  const withNewline = 'Human notes for the reviewer.\n\nMore notes.\n';
  assert.equal(upsertStackBlock(withNewline, block), `${withNewline}\n${block}`);

  const withoutNewline = 'Human notes for the reviewer.';
  assert.equal(upsertStackBlock(withoutNewline, block), `${withoutNewline}\n\n${block}`);
});

test('stack upsert replace swaps only the managed span and is idempotent', () => {
  const oldBlock = stackBlock({ ...PHASE_2, parentPr: 30 });
  const newBlock = stackBlock({ ...PHASE_2, parentPr: 41 });
  const before = 'Intro written by a human.\n\n';
  const summary = '<!-- pocket-phase-2-summary -->\nPhase 2 summary, owned by the adapter.\n';
  const after = `\n\nFooter written by a human.\n${summary}`;
  const body = `${before}${oldBlock}${after}`;

  const once = upsertStackBlock(body, newBlock);
  assert.ok(once.startsWith(before), 'bytes before the managed block must be unchanged');
  assert.ok(once.endsWith(after), 'bytes after the managed block must be unchanged');
  assert.equal(once.slice(before.length, once.length - after.length), newBlock, 'managed span must equal the new block');
  assert.ok(once.includes(summary), 'pocket-phase-N-summary content must be untouched');
  assert.equal(once.split(START).length - 1, 1, 'upsert must not duplicate the block');

  assert.equal(upsertStackBlock(once, newBlock), once, 'a second upsert with the same block must be byte-identical');
});

const MALFORMED_BODIES = {
  'start-only': `Intro.\n\n${START}\nunterminated block\n`,
  'end-only': `Intro.\n\nunterminated block\n${END}\n`,
  'end-before-start': `Intro.\n\n${END}\nreversed\n${START}\n`,
  nested: `Intro.\n\n${START}\nouter\n${START}\ninner\n${END}\n${END}\n`,
  duplicated: `Intro.\n\n${stackBlock(PHASE_2)}\n\nMiddle.\n\n${stackBlock(PHASE_2)}\n`,
};

for (const [shape, body] of Object.entries(MALFORMED_BODIES)) {
  test(`stack upsert malformed rejects ${shape} markers without producing output`, () => {
    assert.throws(() => upsertStackBlock(body, stackBlock(PHASE_2)), { code: 'STACK_BLOCK_MALFORMED' });
  });
}

test('stack upsert malformed counts a marker quoted in a code fence as a real marker', () => {
  // Rule: markers match as literal text anywhere in the body, code fences included.
  // A quoted marker therefore counts toward the pair, and the upsert fails closed on the result.
  const body = `Notes.\n\n\`\`\`\n${START}\n\`\`\`\n\n${stackBlock(PHASE_2)}\n`;
  assert.throws(() => upsertStackBlock(body, stackBlock(PHASE_2)), { code: 'STACK_BLOCK_MALFORMED' });
});

test('stack upsert malformed rejects a block argument that is not itself marker-delimited', () => {
  assert.throws(() => upsertStackBlock('Intro.\n', 'plain text, no markers'), { code: 'STACK_BLOCK_MALFORMED' });
});
