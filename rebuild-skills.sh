#!/bin/bash

# Rebuild .skill archives from the explicit v4 surface manifest
# (surfaces.json) instead of an implicit per-directory wildcard loop.
#
# The manifest is the single source of declared skill ownership: this script
# resolves the union of `skills/<name>/**` include bases across all four
# roles and rebuilds exactly those skill archives. Node is used to parse
# surfaces.json (canonical reader: scripts/build-surfaces.js validation);
# archive generation itself is unchanged (sorted zip, same exclusions).

set -eo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

MANIFEST="surfaces.json"

# Resolve declared skill directories from the manifest (union over roles).
SKILL_DIRS="$(node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync("surfaces.json", "utf8"));
const dirs = new Set();
for (const role of Object.values(manifest.roles || {})) {
  for (const inc of role.includes || []) {
    const m = /^(skills\/[^/]+)(?:\/|$)/.exec(inc);
    if (m) dirs.add(m[1]);
  }
}
for (const d of [...dirs].sort()) console.log(d);
')"

if [ -z "$SKILL_DIRS" ]; then
    echo "error: no skill directories declared in $MANIFEST" >&2
    exit 1
fi

# Validate the manifest before touching any archive (fail closed).
node scripts/build-surfaces.js --validate > /dev/null

for skill_dir in $SKILL_DIRS; do
    # Skip explicit single-file includes (e.g. enterprise-reporting.md has no archive).
    if [ ! -d "$skill_dir" ]; then
        continue
    fi
    skill_name=$(basename "$skill_dir")
    archive="$skill_dir/$skill_name.skill"

    echo "Rebuilding $archive..."

    # Remove existing archive
    rm -f "$archive"

    # Create new archive from skill directory contents (no directory entries)
    # Include .skillkit-mode files
    cd "$skill_dir"
    find . -type f ! -name "*.skill" ! -path "*/__pycache__/*" \
        \( ! -name ".*" -o -name ".skillkit-mode" \) |
        LC_ALL=C sort | zip -@ "$skill_name.skill"
    cd - > /dev/null
done

echo "Done rebuilding .skill archives"
