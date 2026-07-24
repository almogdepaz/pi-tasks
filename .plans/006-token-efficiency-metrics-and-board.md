# plan 006: token-efficiency metrics and task board

status: phase 2 metrics implemented and verified; phase 4 board postponed
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

postponed. reuse phase 2 grouping primitives for issue/root-cause board output, with dedicated grouping and board-output tests before implementation.
