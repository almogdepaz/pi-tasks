# plan 006: token-efficiency metrics and task board

status: phase 2 metrics and phase 4 board implemented and verified
created: 2026-07-24
updated: 2026-07-24

## goal

produce deterministic coordination/token-waste metrics from structured Pi task-store artifacts without parsing terminal prose.

## phase 2: postmortem metrics

- [x] count task statuses, durable preflight rejection, and failed/unavailable checks
- [x] measure task text, assignment/instruction, result summary, and structured result payload characters
- [x] expose bounded largest prompt/result lists
- [x] group task counts by `phaseId`, `issueId`, and `rootCause`, including loops per issue
- [x] extract verification commands/statuses only from `result.verification`
- [x] report malformed/missing artifacts as diagnostics without aborting the report
- [x] add a JSON CLI, tests, and README usage
- [x] verify with `bun test`, `bun run typecheck`, and `git diff --check`

verification: `bun test` — 52 pass, 0 fail; `bun run typecheck` — exit 0; `git diff --check` — exit 0.

## phase 4: task board

- [x] reuse structured task-artifact reading for metrics and board output
- [x] group complete `phaseId`/`issueId`/`rootCause` tuples with task and status counts
- [x] include latest timestamps and structured verification/blocker/risk counts
- [x] mark repeated issues and shared root causes as coordination candidates
- [x] bound group/task output and sort active, recent, then identifiers
- [x] expose legacy/missing-metadata tasks through reconciled `ungrouped` coverage
- [x] add `task-metrics <tasksRoot> --board` JSON mode and README usage
- [x] add phase 4 grouping, structured-field, sorting, diagnostics, legacy coverage, and CLI tests
- [x] verify with `bun test`, `bun run typecheck`, `git diff --check`, and a live task store

verification: `bun test` — 59 pass, 0 fail; `bun run typecheck` — exit 0; `git diff --check` — exit 0. live `/Users/home/Dev/looper-ai/.pi/tasks` — 77 records, 1 grouped, 76 ungrouped, 0 diagnostics, with coverage totals reconciled.

postponed: shared/global registry and full project-management behavior.
