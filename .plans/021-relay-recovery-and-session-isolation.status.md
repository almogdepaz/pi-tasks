# relay recovery and session isolation status

- plan: `.plans/021-relay-recovery-and-session-isolation.md`
- plan sha-256: `783de2cde538b9e16b03581f736fea5c1a6192686d40caa0b697530cc33980db`
- overall state: `implemented_verified_not_deployed`
- current phase: pull-request handoff
- wolfpack worktree: `/Users/home/Dev/wolfpack-pi-task-relay-fix`
- wolfpack branch: `fix/pi-task-relay-recovery`

## role sessions

- implementer session: `relay-fix-implementer` (`29607e71-de46-4a85-88a3-553778bd7333`), endpoint `wolfpack-pi-tasks-v2/174f5138-6226-48f7-b5fe-f905469ad6ef`
- implementer task: implementation accepted; retain session for deployment corrections
- reviewer session: `relay-fix-reviewer` (`3d230a04-9349-4517-86dc-9fa631ea60e3`), endpoint `wolfpack-pi-tasks-v2/f8ce84a1-01f5-4195-a8f1-edfa548f893f`
- reviewer task: final complete-diff review approved; retain session for deployment recheck

## task states

- task 1, extension recovery: `accepted`
- task 2, session store isolation: `accepted`
- task 3, harness-neutral registration and stable lease renewal: `accepted`
- task 4, review and verification: `accepted`

## goal lock

- direct contribution: make trusted-local relay startup recover autonomously, prevent false persistent outage reporting, isolate endpoint-owned state, and remove harness type as a registration gate.
- non-goal check: no capability protocol, event format changes, peer-routing refactor, runtime file deletion, or unrelated v1 adapter removal.

## verification

- regression tests added in `tests/endpoint-extension-corrections.test.ts`, `tests/wolfpack-task-relay.test.ts`, and `/Users/home/Dev/wolfpack-pi-task-relay-fix/tests/unit/task-relay.test.ts`.
- user explicitly instructed the agent to run tests, overriding the default user-run handoff for this task.
- red: `bun test tests/endpoint-extension-corrections.test.ts` — 4 failures proving no autonomous startup poll/status clear and escaping `agent_end` errors.
- red: `bun test tests/wolfpack-task-relay.test.ts` — module load failure proving `wolfpackTaskStorePath`/session-isolated default storage is absent.
- red: `cd /Users/home/Dev/wolfpack-pi-task-relay-fix && bun test ./tests/unit/task-relay.test.ts` — 4 failures proving live non-pi rejection and same-generation renewal identity rotation; 10 existing tests passed.
- live structured dispatch failed with `invalid relay envelope`; read-only sqlite inspection proved a shared pending outbox envelope was flushed before the new assignment.
- replaying the new assignment's transformed envelope passed structural validation and returned `REGISTRATION_EXPIRED` for its old source, proving a separate endpoint-renewal defect.

- review finding: HIGH at `src/extension.ts:59-72,79,86-90` — an in-flight poll may survive shutdown and deliver or update status through stale session context; verified from source and Pi lifecycle contract.
- correction red: pending receive delivered one stale message after shutdown; the earlier pre-delivery form also observed stale status writes.
- correction green: focused lifecycle 10/10, pi-tasks typecheck exit 0, full pi-tasks suite 84/84, diff check clean.
- reviewer re-review: approved under the explicit invariant that endpoint-owned durable operations may finish after shutdown while stale session-bound delivery/status effects are suppressed.
- final consistency finding: `README.md` documented the removed global runtime store, and Wolfpack published unused `CALLER_NOT_PI` in `src/task-relay/domain.ts` plus generated schema artifacts.
- cleanup red: package documentation assertion and relay error-catalog assertion failed against stale artifacts.
- cleanup green: package docs 10/10; Wolfpack relay/schema unit tests 34/34 with generated snapshot; both typechecks exit 0; diff checks clean.
- final reviewer verdict: approve; no remaining actionable findings.
- fresh parent verification: `bun test` in pi-tasks — 85 pass, 0 fail; `bun run typecheck` — exit 0.
- fresh parent verification: `bun test` in Wolfpack worktree — 1803 pass, 22 broker-binary skips, 0 fail, 1 snapshot; `bun run typecheck` — exit 0.
- fresh parent verification: both `git diff --check` commands clean; plan digest unchanged at `783de2cde538b9e16b03581f736fea5c1a6192686d40caa0b697530cc33980db`.

## decisions

- no legacy store migration, fallback, or compatibility code.
- existing runtime database files are not deleted automatically.
- wolfpack changes use a clean worktree because `/Users/home/Dev/wolfpack` contains unrelated work.
- same-generation lease renewal must preserve endpoint identity even after expiration; otherwise the immutable `TaskCore` source becomes invalid.
- structured delegation is blocked by the defects being repaired; implementer/reviewer communication uses `wolfpack session send` until the repaired relay is deployed.

## next action

- review and merge both pull requests, deploy/restart Wolfpack, reload Pi sessions, then run a live structured task smoke test. current installed processes still run old code.
