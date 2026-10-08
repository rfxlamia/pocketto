#!/bin/bash

# Rebuild .skill archives from explicit role ownership in surfaces.json.
# Archives contain only files assigned to the role that owns each archive;
# mixed-owner physical directories are never bundled wholesale.

set -eo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

MANIFEST="surfaces.json"

# Validate the manifest before touching any archive (fail closed).
node scripts/build-surfaces.js --validate > /dev/null

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PLAN_FILE="$TMP_DIR/archive-plan.json"
MEMBERS_FILE="$TMP_DIR/archive-members.txt"

# Build a deterministic archive plan from role-owned includes. Pi and Claude
# roles that own the same archive must declare identical source sets.
ARCHIVES="$(node - "$PLAN_FILE" "$@" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { expandIncludes, loadManifest } = require('./cli/lib/surface-manifest');

const root = process.cwd();
const planPath = process.argv[2];
const manifest = loadManifest('surfaces.json', { sourceDir: root });
const archives = new Map();

function isArchiveMember(rel, skillDir) {
  if (!rel.startsWith(`${skillDir}/`)) return false;
  const local = rel.slice(skillDir.length + 1);
  if (!local || local.endsWith('.skill')) return false;
  return local.split('/').every((part) =>
    part !== '__MACOSX' &&
    part !== '__pycache__' &&
    part !== '.DS_Store' &&
    part !== 'Thumbs.db' &&
    (!part.startsWith('.') || part === '.skillkit-mode'),
  );
}

for (const [roleName, role] of Object.entries(manifest.roles)) {
  const expanded = expandIncludes(role.includes, root);
  for (const archive of expanded) {
    const match = /^skills\/([^/]+)\/\1\.skill$/.exec(archive);
    if (!match) continue;
    const skillDir = path.posix.dirname(archive);
    const members = expanded
      .filter((rel) => isArchiveMember(rel, skillDir))
      .map((rel) => rel.slice(skillDir.length + 1))
      .sort();
    const current = archives.get(archive);
    if (current) {
      if (current.kind !== role.kind || JSON.stringify(current.members) !== JSON.stringify(members)) {
        throw new Error(`SURFACE_ARCHIVE_OWNERSHIP_INVALID: ${archive} has conflicting role-owned source sets (${current.role} and ${roleName}).`);
      }
    } else {
      archives.set(archive, { kind: role.kind, role: roleName, members });
    }
  }
}

if (archives.size === 0) throw new Error('SURFACE_ARCHIVE_MISSING: no role declares a .skill archive.');
const plan = [...archives.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([archive, owner]) => ({ archive, ...owner }));
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
const requested = process.argv.slice(3);
const available = new Set(plan.map((entry) => entry.archive));
const selected = requested.length > 0 ? requested : plan.map((entry) => entry.archive);
const unknown = selected.filter((archive) => !available.has(archive));
if (unknown.length > 0) {
  throw new Error(`SURFACE_ARCHIVE_UNOWNED: ${unknown.join(', ')}`);
}
process.stdout.write(`${selected.join('\n')}\n`);
NODE
)"

if [ -z "$ARCHIVES" ]; then
    echo "error: no skill archives declared in $MANIFEST" >&2
    exit 1
fi

for archive in $ARCHIVES; do
    skill_dir="${archive%/*}"
    archive_name="${archive##*/}"
    skill_name="${archive_name%.skill}"

    echo "Rebuilding $archive from its role-owned source set..."
    node - "$PLAN_FILE" "$archive" > "$MEMBERS_FILE" <<'NODE'
const fs = require('node:fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const entry = plan.find((candidate) => candidate.archive === process.argv[3]);
if (!entry || entry.members.length === 0) {
  throw new Error(`SURFACE_ARCHIVE_SOURCE_MISSING: no role-owned source files for ${process.argv[3]}.`);
}
process.stdout.write(`${entry.members.join('\n')}\n`);
NODE

    rm -f "$archive"
    (
      cd "$skill_dir"
      LC_ALL=C sort "$MEMBERS_FILE" | zip -q -@ "$skill_name.skill"
    )
done

echo "Done rebuilding role-owned .skill archives"
