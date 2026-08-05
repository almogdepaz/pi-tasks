# Plan 017 execution status

plan: `.plans/017-cold-start-task-insertion.md`
sha256: `73b1a72d7618522b5cb94f322604b22d55c579d832651b8ebf366e5d31a9cf51`
state: `complete`
current_phase: `accepted`

## Goal lock

The direct goal is to eliminate active-turn assignment delay at the Pi adapter boundary while preserving Wolfpack authority and structural delivery evidence. Wolfpack source, protocol semantics, polling cadence, forced interruption, publication, versioning, commits, pushes, merges, deployment, and release are excluded.

## Tasks

- 1: `accepted`
- 2: `accepted`
- 3: `accepted`

## Evidence

- live task `019fd0fb-9dac-7304-a59f-e2f10a5028e4` reached `task.received` in 16 ms but the worker reported missing insertion after 49.398 s; completion occurred at 54.921 s and `task.delivered` at 58.115 s.
- Pi extension docs explicitly support `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`, which queues a custom message safely until an active run finishes.
- source tracing found `deliverTaskInbox` exits whenever `ctx.isIdle()` is false, so it never invokes the supported queueing primitive during the active spawn turn.
- history shows no prior reverted active-turn queue fix. The five-second poll and idle-only guard originated with the gateway adapter; the latest single-flight correction preserved that guard.

- red evidence: focused run produced the expected four failures—busy Pi queued zero messages, busy-after-status queued zero messages, sender output said `task received`, and docs lacked the locked guidance.
- implementation uses Pi's documented follow-up custom-message queue whenever no message is already pending. Structural delivery acknowledgment and cursor advancement still require durable session-entry evidence.
- sender output now says `task accepted` and explicitly marks adapter insertion pending until `task.delivered`.
- README and packaged skill now prefer promptless disposable workers, explain follow-up insertion, and forbid steering/interruption.
- focused green: 27/27 tests, typecheck, and diff check passed.
- full verification: 46/46 tests, typecheck, package dry-run, diff check, immutable digest, and scoped inventory passed.
- the configured Pi package is a live local path, so no install or deployment mutation was needed for a fresh child to load the working-tree fix.
- active-turn live task `019fd10f-1a96-7f49-ba8f-d45f68a127b4`: gateway receipt took 6 ms; structural `task.delivered` occurred 4.097 s after creation; completion occurred at 4.574 s with `verdict: pass`, `changedFiles: []`, and no `task.question` or resend. The previous trace required 58.115 s for delivery.
- the parent task-specifically acknowledged the live result and closed the disposable child; structured status returns `SESSION_NOT_FOUND` with terminal unavailable.
- changed scope: `README.md`, `skills/wolfpack-pi-task-delegation/SKILL.md`, `src/extension.ts`, `src/task-inbox.ts`, `tests/extension.test.ts`, `tests/package.test.ts`, `tests/task-inbox.test.ts`, and plan 017 files. Wolfpack source is unchanged.

## Next action

Await separate authorization for commit, push, deployment, publication, or release.
