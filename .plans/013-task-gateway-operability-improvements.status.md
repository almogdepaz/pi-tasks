# Task-gateway operability improvements — execution status

plan: `.plans/013-task-gateway-operability-improvements.md`
plan_sha256: `7a31762f405519328549f39e8277f2d396fd932cd6d650754db4e3446b526617`
state: `complete`
current_phase: `complete`

## Goal lock

Implement only the accepted artifact guidance/warnings, read-only peer-readiness checklist, and field-level send errors. Preserve the existing protocol authority, trust boundary, delivery/retry behavior, acknowledgment, retention, nine-case federation matrix, and timestamp replica-equality regression.

## Task state

- 1: `implemented`
- 2: `implemented`
- 3: `implemented`
- 4: `verified`

## Locked decisions

- send error locations: optional RFC 6901 JSON Pointer in `error.path`;
- artifact mistakes: per-entry path-bearing warnings, never relaxed acceptance;
- changed files: structured result data, not artifact declarations;
- peer readiness: documentation/operator evidence only;
- no release, deploy, commit, push, merge, live dispatch, or session cleanup.

## Worktree exclusions

Wolfpack pre-existing dirty files, excluded from this plan:

- `README.md`
- `package.json`
- `tests/unit/task-gateway-docs.test.ts`
- `docs/task-gateway-onboarding.html`

Pi pre-existing untracked material, excluded except for this plan/status pair:

- `.edc/`
- plans 005, 007, 009, and 012
- `docs/reviews/`

## Expected implementation inventory

Wolfpack, subject to TDD-confirmed necessity:

- `src/tasks/domain.ts`
- `src/tasks/gateway.ts`
- `src/server/task-routes.ts`
- `src/control-api/schema.ts`
- `docs/generated/control-api.schema.json`
- `docs/task-gateway.md`
- `tests/integration/task-gateway.test.ts`
- `tests/unit/task-control-api-contract.test.ts`
- `tests/unit/__snapshots__/control-api-schema.test.ts.snap` if schema regeneration requires it
- one new focused live-peer documentation-contract test

Pi Tasks, subject to TDD-confirmed necessity:

- `src/gateway-client.ts`
- `src/extension.ts`
- `README.md`
- `skills/wolfpack-pi-task-delegation/SKILL.md`
- `tests/gateway-client.test.ts`
- `tests/extension.test.ts`
- `tests/package.test.ts`

## Verification evidence

- plan digest rechecked before task 1: `7a31762f405519328549f39e8277f2d396fd932cd6d650754db4e3446b526617`
- task 1 focused red/green evidence was recorded by the implementer and corrections; parent focused reruns are listed below.
- task 2 red observed: Pi focused guidance tests failed 2/2; gateway focused projection test failed because absolute and duplicate warnings omitted submitted paths.
- task 2 green observed: Pi focused rerun passed 2/2 (11 assertions); gateway focused rerun passed the new invalid/absolute/duplicate/unavailable/escaped/symlink case plus the existing all-terminal duplicate case, 2/2 (10 assertions).
- independent reviews: complete; all verified findings resolved and correction re-review found no residual defects
- task 2 broader verification: Pi `bun test tests/extension.test.ts tests/package.test.ts` passed 9/9 (47 assertions); Wolfpack `bun test tests/integration/task-gateway.test.ts` passed 46/46 (333 assertions); after adding explicit unchanged aggregate-limit coverage, Wolfpack artifact-focused rerun passed 3/3 (14 assertions); Pi `bun run typecheck` and Wolfpack `bun run typecheck` both exited 0; scoped `git diff --check` passed in both repositories.
- final full-suite output: user explicitly delegated the runs to the parent; Wolfpack `bun test` passed 1613/1613 (4819 assertions, one snapshot) and Pi Tasks `bun test` passed 40/40 (160 assertions)

## Execution log

- user approved execution with `do it`.
- task 1 goal lock: machine-readable send-field diagnostics only; no other route validation framework or protocol lifecycle change.
- task 1 implementer: session `013-send-errors` (`ded80115-bccd-42a9-83a3-eb0172401333`), task `019fcc30-be99-794e-8ce0-1ae3bfd6608b`.
- dispatch warnings: the two absolute gateway source refs were rejected as cross-project context refs; their paths remain in the task instructions, and no source content was transferred.
- task 1 implementer result: completed with red/green evidence, but the parent's pre-completion supervision message arrived after the terminal event.
- correction required: cover empty `preflight.requiredProject` in HTTP, semantic gateway, and local Pi validation; prove rejected sends persist zero ledgers and a valid retry persists exactly one task.
- correction task `019fcc3a-b9df-71d2-8eda-f4b8253041ba` completed; parent focused rerun passed 14 gateway assertions across four selected cases and 24 Pi assertions across ten tests.
- remaining task 1 gap from parent diff review: task 1c documentation was initially omitted.
- task 1c correction `019fcc3f-6a43-70b0-9c69-b3c1ea0121f5` completed with a failing package-doc contract followed by 37/37 Pi tests passing.
- task 1 parent verification: selected gateway route/semantic/schema tests passed (4 tests, 39 assertions total across commands); selected Pi client/extension tests passed (10 tests, 24 assertions); scoped `git diff --check` passed.
- task 1 is implemented and awaits its independent review under task 4.
- task 2 implementer: session `013-artifacts` (`5ac1d6fe-5f28-4420-b62c-932f3bab3e9b`), task `019fcc42-07c8-7c51-a4e8-e76480d8ba2e`; the sender deadline won before its late completion, so canonical task state is `timed_out`.
- the task-2 child improperly edited this parent-owned ledger despite the task boundary; parent inspected and normalized those entries.
- task 2 TDD red: added focused Pi extension/package and gateway artifact-projection regressions before production/docs changes; Pi run failed 2/2 for missing guidance, gateway run failed because absolute/duplicate warning messages did not identify submitted paths.
- task 2 TDD green: minimally updated Pi done-tool schema/prompt, Pi docs/skill, gateway per-entry invalid/absolute and duplicate warnings, and canonical gateway guide; focused Pi rerun passed 2/2 (11 assertions) and focused gateway rerun passed 2/2 (10 assertions). An explicit aggregate-over-limit preservation regression then passed 3/3 focused artifact tests (14 assertions), retaining the existing one-warning bounded behavior.
- task 2 broader verification: Pi extension/package tests passed 9/9 (47 assertions); Wolfpack gateway integration passed 46/46 (333 assertions); both typechecks and both scoped diff checks passed. No full-suite run was made; plan requires user-supplied final full-suite output.
- task 2 boundary check: task-1 modifications remain present and untouched; excluded dirty gateway onboarding files and Pi unrelated untracked material remain excluded.
- task 2 parent verification: gateway artifact-focused tests passed 3/3 (14 assertions); Pi extension/package tests passed 9/9 (47 assertions); scoped diff checks passed.
- task 3 implementer: session `013-peer-readiness` (`173ba7b6-58a1-4081-ba01-7dd3c129d35e`), task `019fcc5f-ce32-79f1-80a0-e04e8301ca52` completed.
- parent review rejected the readiness route probe because it used malformed `POST /send`; correction task `019fcc67-3c8b-7208-9abc-e550140c8236` replaced it with read-only missing-query `GET /status` and passed the focused docs contract.
- parent review found a second docs overclaim: `pi list` cannot prove current-process loading. correction task `019fcc69-0103-7669-bfaa-a3f16b236f59` separated configured package evidence from fresh-start/`/reload` operator evidence.
- task 3 parent verification: gateway readiness contract passed 1/1 (28 assertions); Pi package docs passed 6/6 (46 assertions); scoped diff and readiness-section negative assertions passed.
- tasks 1–3 are implemented and await the three bounded independent reviews required by task 4.
- initial concurrent task-1 review `019fcc6c-13c2-7867-bd9f-61728ee13c30` and task-3 review `019fcc6c-140a-774f-8a42-5fe5cc9e56db` timed out after the user closed idle sessions.
- task-2 review `019fcc6c-13e6-7f79-81ce-95a274fda5c3` completed with no implementation/security defects and one low test-coverage finding; parent tightened the assertion to exactly six ordered per-entry warnings, and the focused test passed.
- user direction: do not open many concurrent subagents. remaining reviews run sequentially in one session.
- sequential review session: `013-review-sequential` (`17e06cb7-f072-4b91-8e54-4c95e64f59ae`).
- task-1 review `019fcc89-12e8-769b-a5fa-efed46b7fe8d` found one medium defect: non-array runtime `context.refs` threw raw `TypeError`. Parent reproduced red, added the no-network `/context/refs` regression, guarded with `Array.isArray`, and verified 11/11 client/extension tests plus typecheck.
- task-3 sequential review `019fcc8d-17a7-70c9-b72d-3ea40b9b133f` found one medium defect: the shell probe could exit 0 after a disallowed 404. Parent reproduced red, added an executable fail-closed 400/404 contract, and updated the runbook with fail-closed execution and cleanup.
- correction re-review `019fcc91-3ae0-7837-ac42-7ebb3b315235` found no residual defects in the task-1 or task-3 corrections.
- all terminal delegated results were acknowledged. User authorized cleanup; sequential reviewer `013-review-sequential` (`17e06cb7-f072-4b91-8e54-4c95e64f59ae`) was closed and a structured session-list check returned no match.
- final parent Pi verification: `bun test` passed 40/40 (160 assertions), `bun run typecheck` exited 0, and `git diff --check` exited 0.
- final parent Wolfpack focused verification: schema regeneration produced the same schema hash; task gateway, control-schema, control-contract, and readiness suites passed 72/72 (477 assertions, one snapshot); `bun run typecheck` and `git diff --check` exited 0.
- plan digest rechecked at final parent gate: `7a31762f405519328549f39e8277f2d396fd932cd6d650754db4e3446b526617`.
- user explicitly delegated the final full-suite runs to the parent. Wolfpack `bun test` passed 1613/1613 across 139 files (4819 assertions, one snapshot); Pi Tasks `bun test` passed 40/40 across five files (160 assertions).
- final boundary check: both package versions match HEAD (`wolfpack` 1.6.14, Pi Tasks 0.1.1); both diff checks pass; plan files and implementation inventory match the accepted boundary; gateway onboarding files and unrelated Pi `.edc/`, plans 005/007/009/012, and `docs/` remain excluded dirty/untracked material.
- no commit, push, merge, deployment, release, publication, or live dispatch was performed during plan execution.
- post-completion follow-up: the user explicitly authorized committing and pushing the scoped plan 013 changes in both repositories; deployment, release, publication, merge, and live dispatch remain unauthorized.

## Next action

Commit and push the scoped plan 013 changes only. Preserve excluded dirty/untracked files.
