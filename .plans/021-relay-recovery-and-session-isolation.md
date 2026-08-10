# relay recovery and session isolation

## goal

make the trusted-local wolfpack pi-tasks relay reliably usable after transient startup failures, isolate durable task state by wolfpack session, and remove harness classification as a relay registration requirement.

## assumptions

- the local wolfpack environment is trusted and non-adversarial.
- relay callers still must resolve to an existing live wolfpack session for correctness.
- harness type is not an authorization or capability boundary.
- the old global sqlite layout has no migration, fallback, or compatibility path; configured wolfpack cores use per-session stores exclusively.
- changes are limited to `/Users/home/Dev/wolfpack-pi-tasks` and a clean wolfpack worktree based on `main`.

## non-goals

- adding session capabilities, tokens, or a new authentication protocol.
- changing task event semantics, envelope formats, or remote peer routing.
- deleting existing runtime database files from the user's machine.
- refactoring unrelated wolfpack session-control or pi extension systems.

## success criteria

- a failed initial core setup is retried without requiring another user turn.
- lifecycle refresh failures do not escape as extension stack traces.
- the unavailable status is shown on failure and cleared after recovery.
- default durable sqlite state is isolated by wolfpack session while explicit store paths retain current behavior.
- an existing live non-pi wolfpack session may register a relay endpoint; missing and dead callers remain rejected.
- regression tests cover each corrected behavior.
- relevant focused tests, full suites, and typechecks pass when run by the user.

## 1. make extension recovery total

add behavior-first regression coverage for failed startup, autonomous retry, contained `agent_end` failures, and status clearing. implement the smallest lifecycle change that keeps one bounded background loop per session and clears it on shutdown.

## 2. isolate default durable stores

add regression coverage proving distinct wolfpack session names receive distinct default sqlite paths while repeated starts of one session reuse its store. preserve explicit `path` behavior, remove use of the global default layout, and add no legacy fallback or migration code.

## 3. remove wolfpack harness classification

in a clean wolfpack worktree based on `main`, add relay gateway coverage proving any existing live session can register regardless of harness. remove only the pi-harness rejection; preserve existence and liveness checks.

## 4. review and verify

perform an independent read-only review against this plan, correct verified findings sequentially, then have the user run focused tests, full suites, and typechecks in both repositories. perform a final structured live status/recovery check without rotating relay generations manually.
