# Review Report Template

## Contents
- [Schema](#schema)
- [Example: REVIEW_FAIL (Stage 1)](#example-review_fail-stage-1)
- [Example: REVIEW_PASS](#example-review_pass)
- [Example: REVIEW_BLOCKED](#example-review_blocked)
- [File Naming](#file-naming)
- [Write Location](#write-location)

JSON schema for review report artifact written to `reviews/<task_id>-cycle-N.json`.

## Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": [
    "task_id",
    "task_name",
    "cycle",
    "timestamp",
    "reviewer_mode",
    "reviewer_config",
    "stage_1",
    "stage_2",
    "overall",
    "fix_instructions",
    "loop_info"
  ],
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Task identifier (e.g., T3)"
    },
    "task_name": {
      "type": "string",
      "description": "Human-readable task name"
    },
    "cycle": {
      "type": "integer",
      "minimum": 1,
      "description": "Review cycle number (1-indexed)"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp"
    },
    "reviewer_mode": {
      "type": "string",
      "description": "Review mode (read-only)"
    },
    "reviewer_config": {
      "type": "string",
      "description": "Reviewer configuration (standard/deep)"
    },
    "stage_1": {
      "type": "object",
      "required": ["status", "issues"],
      "properties": {
        "status": {
          "type": "string",
          "enum": ["PASS", "FAIL"]
        },
        "issues": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["type", "description"],
            "properties": {
              "type": {
                "type": "string",
                "enum": ["missing", "extra", "misunderstanding"]
              },
              "description": {
                "type": "string"
              },
              "location": {
                "type": "string",
                "description": "file:line format"
              }
            }
          }
        },
        "concerns_addressed": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "stage_2": {
      "type": "object",
      "required": ["status", "issues", "assessment"],
      "properties": {
        "status": {
          "type": "string",
          "enum": ["PASS", "FAIL", "SKIPPED"],
          "description": "SKIPPED if Stage 1 failed"
        },
        "strengths": {
          "type": "array",
          "items": { "type": "string" }
        },
        "issues": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["severity", "description"],
            "properties": {
              "severity": {
                "type": "string",
                "enum": ["Critical", "Important", "Minor"]
              },
              "description": {
                "type": "string"
              },
              "location": {
                "type": "string",
                "description": "file:line format"
              }
            }
          }
        },
        "assessment": {
          "type": "string",
          "enum": ["Approved", "Request Changes", "N/A"]
        }
      }
    },
    "overall": {
      "type": "string",
      "enum": ["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_BLOCKED"]
    },
    "fix_instructions": {
      "type": "string",
      "description": "Human-readable fix instructions. Empty if PASS."
    },
    "loop_info": {
      "type": "object",
      "properties": {
        "current_cycle": { "type": "integer" },
        "max_cycles": { "type": "integer" },
        "cycles_remaining": { "type": "integer" }
      }
    }
  }
}
```

## Example: REVIEW_FAIL (Stage 1)

```json
{
  "task_id": "T3",
  "task_name": "Extract auth layer",
  "cycle": 1,
  "timestamp": "2026-05-08T12:00:00Z",
  "reviewer_mode": "read-only",
  "reviewer_config": "standard",
  "stage_1": {
    "status": "FAIL",
    "issues": [
      {
        "type": "missing",
        "description": "Token expiry not checked",
        "location": "auth_service.py:42"
      },
      {
        "type": "extra",
        "description": "Added OAuth2 support not in spec",
        "location": "auth_service.py:15-30"
      }
    ],
    "concerns_addressed": [
      "Implementer concern 'tests feel fragile' — confirmed: tests don't cover expiry edge case"
    ]
  },
  "stage_2": {
    "status": "SKIPPED",
    "strengths": [],
    "issues": [],
    "assessment": "N/A"
  },
  "overall": "REVIEW_FAIL",
  "fix_instructions": "1. In auth_service.py:42 — add token expiry check per spec rule 3.2. 2. Remove OAuth2 code (auth_service.py:15-30) — not in spec. 3. Add test for token expiry edge case.",
  "loop_info": {
    "current_cycle": 1,
    "max_cycles": 2,
    "cycles_remaining": 1
  }
}
```

## Example: REVIEW_PASS

```json
{
  "task_id": "T3",
  "task_name": "Extract auth layer",
  "cycle": 2,
  "timestamp": "2026-05-08T13:00:00Z",
  "reviewer_mode": "read-only",
  "reviewer_config": "standard",
  "stage_1": {
    "status": "PASS",
    "issues": [],
    "concerns_addressed": []
  },
  "stage_2": {
    "status": "PASS",
    "strengths": [
      "Clean separation of concerns",
      "All 8 tests passing",
      "Follows existing error handling patterns"
    ],
    "issues": [
      {
        "severity": "Minor",
        "description": "Unused import 'os'",
        "location": "auth_service.py:3"
      }
    ],
    "assessment": "Approved"
  },
  "overall": "REVIEW_PASS",
  "fix_instructions": "",
  "loop_info": {
    "current_cycle": 2,
    "max_cycles": 2,
    "cycles_remaining": 0
  }
}
```

## Example: REVIEW_BLOCKED

```json
{
  "task_id": "T3",
  "task_name": "Extract auth layer",
  "cycle": 3,
  "timestamp": "2026-05-08T14:00:00Z",
  "reviewer_mode": "read-only",
  "reviewer_config": "deep",
  "stage_1": {
    "status": "FAIL",
    "issues": [
      {
        "type": "missing",
        "description": "Token expiry still not checked after 2 fix attempts",
        "location": "auth_service.py:42"
      }
    ],
    "concerns_addressed": []
  },
  "stage_2": {
    "status": "SKIPPED",
    "strengths": [],
    "issues": [],
    "assessment": "N/A"
  },
  "overall": "REVIEW_BLOCKED",
  "fix_instructions": "ESCALATE: Token expiry check failed 2 cycles. Implementer consistently misses error handling. Recommend human review of error handling approach or task split.",
  "loop_info": {
    "current_cycle": 3,
    "max_cycles": 2,
    "cycles_remaining": 0
  }
}
```

## Example: REVIEW_PASS (skip stub — no file changes)

Written by the main agent in preflight (Step 5) for any `DONE + done_sha` task whose SHA range contains no file changes. No subagent is dispatched for these tasks.

```json
{
  "task_id": "T2",
  "task_name": "Update config defaults",
  "cycle": 1,
  "timestamp": "2026-05-08T12:05:00Z",
  "reviewer_mode": "read-only",
  "reviewer_config": "batch-parallel",
  "stage_1": { "status": "PASS", "issues": [], "concerns_addressed": [] },
  "stage_2": { "status": "PASS", "strengths": [], "issues": [], "assessment": "Approved" },
  "overall": "REVIEW_PASS",
  "fix_instructions": "",
  "loop_info": { "current_cycle": 1, "max_cycles": 1, "cycles_remaining": 0 },
  "skip_reason": "no_file_changes",
  "reviewed_sha": "cde3456fgh7890"
}
```

`skip_reason: "no_file_changes"` identifies this as an auto-generated stub, not a subagent review. `reviewed_sha` is the task's `done_sha` — pocket-closing uses it for the exact-SHA freshness check (stronger than the timestamp proxy).

## File Naming

**Batch mode (pocket-review, post-phase):**
```
reviews/<task_id>-review.json
```
Examples:
- `reviews/T1-review.json`
- `reviews/T3-review.json`

Re-running pocket-review overwrites these files. No audit history is preserved automatically.

**Legacy per-task mode (deprecated):**
```
reviews/<task_id>-cycle-<N>.json
```

## Write Location

```
<plan_dir>/reviews/<task_id>-review.json
```

Where `<plan_dir>` is the pocket plan directory (e.g., `docs/pocket/plans/2026-05-08-auth-refactor/`).

The `reviews/` subdirectory must be created by the main agent before dispatching subagents.

## Batch Mode Field Notes

In batch mode (invoked by pocket-review post-phase), set these fields as follows:

| Field | Batch mode value |
|-------|-----------------|
| `cycle` | Always `1` |
| `reviewer_config` | `"batch-parallel"` |
| `loop_info.current_cycle` | `1` |
| `loop_info.max_cycles` | `1` |
| `loop_info.cycles_remaining` | `0` |
| `overall` | `"REVIEW_PASS"` \| `"REVIEW_FAIL"` \| `"REVIEW_BLOCKED"` |

`REVIEW_FAIL` in batch mode means: issues found, no re-dispatch. Fix code and re-run pocket-review.
