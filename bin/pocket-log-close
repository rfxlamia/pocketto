#!/usr/bin/env python3
"""
pocket-log-close.py — Finalize log.json after all phases complete.

Usage:
  python3 pocket-log-close.py <plan_dir>

Verifies all phases are DONE, then sets header status=DONE and date_completed=today.
Exits non-zero if any phase is not DONE (with details).
"""

import json
import sys
from datetime import date
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 pocket-log-close.py <plan_dir>")

    plan_dir = Path(sys.argv[1])
    log_path = plan_dir / "log.json"

    if not log_path.exists():
        sys.exit(f"Error: log.json not found at '{log_path}'. Run pocket-log-init.py first.")

    log = json.loads(log_path.read_text())

    not_done = [p for p in log["phases"] if p["status"] != "DONE"]
    if not_done:
        print("Cannot close — phases not DONE:")
        for p in not_done:
            print(f"  [{p['order']}] {p['file']}: {p['status']}")
        sys.exit(1)

    log["header"]["status"] = "DONE"
    log["header"]["date_completed"] = date.today().isoformat()

    log_path.write_text(json.dumps(log, indent=2) + "\n")

    print(f"Closed {log_path}")
    print(f"  status         : DONE")
    print(f"  date_started   : {log['header']['date_started']}")
    print(f"  date_completed : {log['header']['date_completed']}")
    print(f"  phases         : {len(log['phases'])} — all DONE")


if __name__ == "__main__":
    main()
