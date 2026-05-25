#!/usr/bin/env python3
"""
pocket-log-update.py — Update status of a phase or task within a phase in log.json.

Usage:
  python3 pocket-log-update.py <plan_dir> <phase_file> <status>
  python3 pocket-log-update.py <plan_dir> <phase_file> <status> --task <task_id>

Status values: WAITING | REVIEW | DONE | BLOCKED

Examples:
  python3 pocket-log-update.py docs/pocket/plans/2026-05-08-auth execution-plan-phase-1.md REVIEW
  python3 pocket-log-update.py docs/pocket/plans/2026-05-08-auth execution-plan.md DONE
  python3 pocket-log-update.py docs/pocket/plans/2026-05-08-auth execution-plan-phase-1.md DONE --task T1
  python3 pocket-log-update.py docs/pocket/plans/2026-05-08-auth execution-plan-phase-1.md REVIEW --task T2
"""

import argparse
import json
import sys
from pathlib import Path

VALID_STATUSES = {"WAITING", "REVIEW", "DONE", "BLOCKED"}


def main():
    parser = argparse.ArgumentParser(
        description="Update phase or task status in log.json.",
        usage="%(prog)s <plan_dir> <phase_file> <status> [--task <task_id>]",
    )
    parser.add_argument("plan_dir", help="Path to the plan directory containing log.json")
    parser.add_argument("phase_file", help="Phase file name, e.g. execution-plan-phase-1.md")
    parser.add_argument("status", help="New status: WAITING | REVIEW | DONE | BLOCKED")
    parser.add_argument("--task", metavar="task_id", default=None, help="Task ID to update, e.g. T1")
    args = parser.parse_args()

    new_status = args.status.upper()
    if new_status not in VALID_STATUSES:
        sys.exit(f"Error: status must be one of {sorted(VALID_STATUSES)}, got '{args.status}'.")

    plan_dir = Path(args.plan_dir)
    log_path = plan_dir / "log.json"
    if not log_path.exists():
        sys.exit(f"Error: log.json not found at '{log_path}'. Run pocket-log-init.py first.")

    log = json.loads(log_path.read_text())

    matched = [p for p in log["phases"] if p["file"] == args.phase_file]
    if not matched:
        available = [p["file"] for p in log["phases"]]
        sys.exit(f"Error: '{args.phase_file}' not found in log. Available: {available}")

    phase = matched[0]

    if args.task:
        # Task-level update
        tasks = phase.get("tasks", [])
        if not tasks:
            sys.exit(
                f"Error: phase '{args.phase_file}' has no tasks in log.json. "
                "Re-run pocket-log-init.py to inject tasks."
            )
        task_match = [t for t in tasks if t["id"].upper() == args.task.upper()]
        if not task_match:
            available_ids = [t["id"] for t in tasks]
            sys.exit(
                f"Error: task '{args.task}' not found in phase '{args.phase_file}'. "
                f"Available: {available_ids}"
            )
        task = task_match[0]
        old_status = task["status"]
        task["status"] = new_status
        log_path.write_text(json.dumps(log, indent=2) + "\n")
        print(f"Updated {args.phase_file} / {task['id']} ({task['name']}): {old_status} → {new_status}")
    else:
        # Phase-level update
        old_status = phase["status"]
        phase["status"] = new_status
        log_path.write_text(json.dumps(log, indent=2) + "\n")
        print(f"Updated {args.phase_file}: {old_status} → {new_status}")

    # Summary
    print("Current log:")
    for p in log["phases"]:
        marker = "←" if p["file"] == args.phase_file else " "
        tasks = p.get("tasks", [])
        task_summary = " | tasks: " + ", ".join(f"{t['id']}={t['status']}" for t in tasks) if tasks else ""
        print(f"  {marker} {p['file']}: {p['status']}{task_summary}")


if __name__ == "__main__":
    main()
