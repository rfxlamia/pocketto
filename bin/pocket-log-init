#!/usr/bin/env python3
"""
pocket-log-init.py — Create log.json for a pocket plan directory.

Usage:
  python3 pocket-log-init.py <plan_dir>

Examples:
  python3 pocket-log-init.py docs/pocket/plans/2026-05-08-auth-refactor
  python3 pocket-log-init.py docs/pocket/plans/2026-05-08-auth-refactor/execution-plan.md

Detects flat plan (execution-plan.md only) vs phase files (execution-plan-phase-N.md).
Writes log.json to <plan_dir>/log.json. If log.json already exists but phases are missing
tasks, injects tasks into existing phases (migration) without touching phase status.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path


def resolve_plan_dir(arg: str) -> Path:
    p = Path(arg)
    if p.is_file():
        return p.parent
    if p.is_dir():
        return p
    sys.exit(f"Error: '{arg}' is not a file or directory.")


def extract_tasks(phase_file: Path) -> list[dict]:
    """Parse ### Task N: Name [tag] headers from a phase/plan file."""
    if not phase_file.exists():
        return []
    content = phase_file.read_text()
    tasks = []
    for m in re.finditer(r"^### Task (\d+): (.+)$", content, re.MULTILINE):
        num = int(m.group(1))
        raw = m.group(2).strip()
        dep = re.search(r"\[depends:\s*([^\]]+)\]", raw)
        depends = dep.group(1).strip() if dep else None
        name = re.sub(r"\s*\[.*?\]", "", raw).strip()
        entry: dict = {"id": f"T{num}", "name": name, "status": "WAITING"}
        if depends:
            entry["depends"] = depends
        tasks.append(entry)
    return tasks


def collect_plan_files(plan_dir: Path) -> list[dict]:
    phase_files = sorted(
        plan_dir.glob("execution-plan-phase-*.md"),
        key=lambda f: int(re.search(r"phase-(\d+)", f.name).group(1)),
    )
    if phase_files:
        phases = []
        for i, f in enumerate(phase_files):
            tasks = extract_tasks(f)
            entry: dict = {"order": i + 1, "file": f.name, "status": "WAITING"}
            if tasks:
                entry["tasks"] = tasks
            phases.append(entry)
        return phases
    flat = plan_dir / "execution-plan.md"
    if flat.exists():
        tasks = extract_tasks(flat)
        entry = {"order": 1, "file": "execution-plan.md", "status": "WAITING"}
        if tasks:
            entry["tasks"] = tasks
        return [entry]
    sys.exit(f"Error: no execution-plan*.md files found in '{plan_dir}'.")


def migrate_existing(plan_dir: Path, log_path: Path) -> None:
    """Inject tasks into phases that are missing them. Preserves all existing status."""
    log = json.loads(log_path.read_text())
    migrated_count = 0
    for phase in log["phases"]:
        if "tasks" in phase:
            continue
        phase_path = plan_dir / phase["file"]
        tasks = extract_tasks(phase_path)
        if not tasks:
            continue
        # Inherit phase status so DONE phases show DONE tasks, not WAITING.
        phase_status = phase.get("status", "WAITING")
        task_status = phase_status if phase_status in {"DONE", "REVIEW", "BLOCKED"} else "WAITING"
        for t in tasks:
            t["status"] = task_status
        phase["tasks"] = tasks
        migrated_count += 1

    if migrated_count == 0:
        print(f"log.json already exists at {log_path} — no migration needed.")
        return

    log_path.write_text(json.dumps(log, indent=2) + "\n")
    print(f"Migrated tasks into existing {log_path}")
    for phase in log["phases"]:
        tasks = phase.get("tasks", [])
        ids = ", ".join(t["id"] for t in tasks)
        print(f"  [{phase['order']}] {phase['file']} ({phase['status']}) → tasks: {ids or 'none'}")


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 pocket-log-init.py <plan_dir>")

    plan_dir = resolve_plan_dir(sys.argv[1])
    log_path = plan_dir / "log.json"

    if log_path.exists():
        migrate_existing(plan_dir, log_path)
        return

    phases = collect_plan_files(plan_dir)
    plan_type = "phased" if len(phases) > 1 or "phase" in phases[0]["file"] else "flat"

    log = {
        "header": {
            "plan_dir": str(plan_dir),
            "plan_type": plan_type,
            "status": "IN_PROGRESS",
            "date_started": date.today().isoformat(),
            "date_completed": None,
        },
        "phases": phases,
    }

    log_path.write_text(json.dumps(log, indent=2) + "\n")
    print(f"Created {log_path}")
    print(f"  type    : {plan_type}")
    print(f"  phases  : {len(phases)}")
    for p in phases:
        tasks = p.get("tasks", [])
        ids = ", ".join(t["id"] for t in tasks)
        print(f"    [{p['order']}] {p['file']} → {p['status']} | tasks: {ids or 'none'}")


if __name__ == "__main__":
    main()
