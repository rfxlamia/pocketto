#!/bin/bash

# Rebuild .skill archives from source directories

set -eo pipefail

SKILLS_DIR="skills"

for skill_dir in "$SKILLS_DIR"/*/; do
    skill_name=$(basename "$skill_dir")
    archive="$skill_dir$skill_name.skill"
    
    echo "Rebuilding $archive..."
    
    # Remove existing archive
    rm -f "$archive"
    
    # Create new archive from skill directory contents (no directory entries)
    # Include .skillkit-mode files
    cd "$skill_dir"
    find . -type f ! -name "*.skill" ! -path "./__pycache__/*" \
        \( ! -name ".*" -o -name ".skillkit-mode" \) |
        sort | zip -@ "$skill_name.skill"
    cd - > /dev/null
done

echo "Done rebuilding .skill archives"