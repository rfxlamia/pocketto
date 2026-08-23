'use strict';

// Single source of truth for CLI version + output contract.
//
//   CLI_VERSION  full semver, read from package.json (informational)
//   CONTRACT     integer JSON-output contract. Bumped ONLY on a breaking
//                change to the --json envelope/schema (== a new major, e.g.
//                v3 -> contract 3). Within one contract, output is additive-
//                only, so older skills keep working against a newer CLI.
//   PIPELINE     integer execution-pipeline generation. Bumped independently
//                of CONTRACT when the in-repo skill pipeline changes.
//   PIPELINE_FLOOR_CLI
//                CLI version that can finish a log stamped with a PIPELINE
//                value lower than current. Update this to the last release
//                that spoke the PRIOR PIPELINE value every time PIPELINE is
//                bumped, so a plan stuck mid-execution has a correct pin.
//   MARKERLESS_FLOOR_CLI
//                CLI version that can finish a log with NO pipeline marker
//                at all (predates the marker system entirely). Fixed —
//                does not move when PIPELINE bumps, unlike PIPELINE_FLOOR_CLI.
//
//   3.1.0 note: `structure`'s output `data.action` enum was renamed
//   ("passthrough" -> "single") as part of the PIPELINE 3->4 change (every
//   plan now decomposes into index+task files, so there is no true
//   passthrough anymore). CONTRACT was NOT bumped for this: `data.action`
//   is documented as informational-only in the consuming skills (routing
//   never branches on it — see pocket-planning/SKILL.md), so the rename
//   does not break additive-only JSON consumption within CONTRACT 2.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  version = pkg.version || version;
} catch {
  // package.json missing/unreadable — fall back to placeholder.
}

module.exports = {
  CLI_VERSION: version,
  CONTRACT: 2,
  PIPELINE: 4,
  PIPELINE_FLOOR_CLI: '3.0.1',
  MARKERLESS_FLOOR_CLI: '2.4.4',
};
