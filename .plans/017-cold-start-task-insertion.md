# Plan 017: Remove cold-start task insertion latency

## Goal

A Pi adapter must queue a newly visible task event safely when the target is already running a model turn, rather than waiting for that turn to end and a later inbox refresh. Sender output and delegation guidance must distinguish durable gateway acceptance from structural adapter insertion.

## Locked decisions

- This is Pi Tasks adapter and workflow-guidance work. Wolfpack gateway behavior and schemas remain unchanged unless verification proves they are insufficient.
- Use Pi's documented custom-message `deliverAs: "followUp"` mode. Do not steer, interrupt, abort, or inject an ordinary user message.
- Preserve single-flight refresh, structural `{taskId,eventId}` deduplication, fail-closed event disposition, durable cursor behavior, and `task.delivered` only after structural insertion evidence exists.
- Do not shorten the five-second poll interval or add gateway retries.
- Prefer spawning a task worker idle, without an initial model prompt. Assignment-specific worker instructions belong in `agent_task_send.task`.
- `agent_task_send` reports durable gateway acceptance with adapter insertion pending; it must not call that state task receipt or model delivery.

## Non-goals

- Wolfpack source changes.
- Automatic session creation, capability registration, heartbeat/readiness leases, push sockets, forced turn interruption, or hidden delivery retries.
- Publication, version bump, commit, push, merge, deployment, or release.
- Changes to task authority, retention, acknowledgment, federation, artifacts, or terminal-state semantics.

## 1. Queue visible events safely during active turns

Add a regression at the real inbox/extension boundary proving that a visible task discovered while Pi is busy and has no queued message is submitted as a follow-up custom message immediately. Prove it is not acknowledged as delivered until structural session evidence exists, and preserve no-duplicate behavior while a pending message exists. Implement the minimum adapter change using Pi's documented follow-up delivery mode.

## 2. Correct sender and delegation language

Add tests for sender output that says gateway acceptance is complete while adapter insertion remains pending until `task.delivered`. Update package guidance to spawn disposable workers without a blocking initial prompt and to put worker instructions in the assignment. Keep remote receipt-confirmation semantics accurate.

## 3. Verify and smoke-test

Run focused tests first, then the full Pi Tasks suite, typecheck, package dry-run, immutable plan digest, and diff checks. If implementation verification passes, install the local package and run one disposable live child smoke test that records timing from `task.created` through `task.delivered`, verifies opaque assignment fields, task-specific acknowledgment, no source changes, and child cleanup.
