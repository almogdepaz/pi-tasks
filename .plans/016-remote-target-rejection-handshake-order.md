# Remote target rejection handshake order

## Goal

Resolve the verified plan-015 delivery/architecture blocker without adding routes, retries, registration, capability inference, or destructive ledger rollback. A definitive remote target-policy rejection must return its canonical error with zero sender and receiver ledgers, while uncertain or retryable initial delivery failures must retain the existing durable failed sender task.

This plan narrowly supersedes plan 008's requirement that the sender commit `task.created` before the one bounded `peer/receive` attempt. Every other plan 008 and plan 015 authority, trust, receipt, retry, recovery, timeout, acknowledgment, retention, timestamp, artifact, and federation contract remains unchanged.

## Locked handshake

For a remote send:

1. The sender resolves and validates the caller, remote origin, request bounds, refs, and idempotency scope, then constructs the immutable assignment, participants, canonical creation timestamp, task ID, and assignment hash in memory.
2. The sender makes the existing single bounded `peer/receive` attempt before creating its sender ledger. The receiver applies authoritative target identity, routable-harness, liveness, and project-preflight validation before provisional persistence.
3. A structured non-retryable peer rejection returns unchanged and creates no sender ledger, receiver ledger, idempotency record, canonical event, tombstone, or inbox entry.
4. A successful durable provisional receipt causes the sender to create its sender ledger, append canonical `task.created`, persist idempotency evidence when supplied, append canonical `task.received`, and deliver the existing receipt-confirmation event. The receiver remains invisible until confirmation.
5. An uncertain or retryable initial delivery failure causes the sender to create its sender ledger, append canonical `task.created`, persist idempotency evidence when supplied, and append the existing canonical terminal failure. A receiver provisional replica created before response loss remains invisible and follows existing orphan cleanup.

The sender remains authoritative for canonical events and timestamps. Receiver provisional state is not canonical task acceptance and remains invisible to adapters.

## Success criteria

- Remote shell, custom, and unknown targets return `TARGET_NOT_AGENT` with zero sender and receiver ledgers.
- Other definitive remote validation failures remain their existing structured errors and do not become `PEER_UNREACHABLE` lifecycle failures.
- Network failure, malformed upstream response, and lost successful receipt response retain a durable sender `task.created` plus terminal failure and existing retryability semantics.
- Successful local and remote task behavior, exact replica timestamps, idempotency, provisional cleanup, confirmation retries, nine-case federation coverage, and restart recovery remain green.
- No new API route, extra peer attempt, rollback deletion, capability registration, heartbeat, adapter inference, commit, push, deployment, publication, merge, or live dispatch is introduced.

## 1. Lock rejection and uncertainty behavior with regression tests

Change the isolated-process remote harness matrix to require zero sender and receiver ledgers for definitive non-agent rejection. Add or retain focused coverage proving retryable/uncertain initial failures still create the canonical failed sender ledger, including response loss after receiver provisional persistence. Cover at least one other definitive remote validation rejection so transport and policy failures cannot be conflated again.

## 2. Reorder only remote initial persistence

Refactor the remote branch of `TaskGateway.send` so the existing `peer/receive` call occurs before sender-ledger creation. Share one small sender-ledger initialization path for success and uncertain/retryable failure. Return structured non-retryable peer failures before persistence. Preserve local ordering and all later receipt-confirmation behavior.

Do not add a rollback/delete primitive. Do not change peer routes, attempt count, assignment hashing, canonical timestamps, idempotency semantics, or receiver provisional visibility.

## 3. Verify and re-review

Run focused gateway/domain/control-schema tests, the full Wolfpack suite and typecheck, schema idempotence, package dry run, diff check, and the unchanged plan 015/016 digests. Re-run the delivery/architecture reviewer against the corrected diff. Only after that reviewer accepts the correction may plan 015 proceed to its sequential security and quality/test-value reviews.
