# protocol and operations reference

start with the [readme](../README.md) for an overview, quickstart, and the transport-independent core example. this reference covers the default wolfpack integration.

Endpoint-owned task coordination for Pi over Wolfpack's memory-only relay. **Both relay mail and endpoint task bookkeeping live in RAM.** Pi's existing session history is the historical record; there is no SQLite database, task-history directory, migration, disk outbox or startup replay.

The [relay control API](https://github.com/almogdepaz/wolfpack/blob/main/docs/control-api-schema.md#pi-tasks-relay-v2-boundary) defines the transport boundary.

## endpoint-owned relay

The default extension requires a compatible Wolfpack memory-owned server. It negotiates `volatile-v1` at `POST /api/task-relay/volatile-v1`. No transport opt-in flag is needed. The old durable relay adapter is removed, not retained as a compatibility mode. The transport keeps at most 8 requests in flight, with 2 more slots reserved for ACK/connect; further requests wait for a slot in FIFO order instead of failing locally. A waiter aborted by its caller has sent nothing and fails with a retryable `ABORTED`; `RELAY_CAPACITY` comes only from the server.

Set `WOLFPACK_SESSION_NAME` for each Pi process. `WOLFPACK_PORT` defaults to `18790`; `WOLFPACK_SESSION_NAME` resolves the active Pi process to its relay endpoint. Read `taskEndpoint` from structured session creation/status and pass its opaque `{ relay, id }` unchanged. Never derive it from a name, terminal output or broker ID.

### minimal valid v2 send envelope

```json
{
  "to": {
    "relay": "wolfpack-pi-tasks-v2",
    "id": "target-opaque-endpoint-id"
  },
  "task": "implement the narrow change and run focused tests"
}
```

The `agent_task_send` schema is exactly `to`, `task`, and optional `timeoutMs`. Unsupported fields are rejected before admission: a pre-admission validation rejection creates no task. If an outcome is uncertain, idempotency remains necessary within the current lifetime; inspect the returned task ID rather than blindly creating another assignment.

## history versus live state

- Pi requests task-processing turns through its safe `deliverAs: "followUp"` queue. Pi session messages and tool calls/results preserve historical context. Parent ACKs, late-terminal facts and confirmed receiver-authored conversation echoes are archived as `pi-tasks-event-record` custom entries before transport ACK, without model insertion or wake. Received model-visible task events include the complete structured event in `pi-tasks-event` details, including results—not just a rendered summary.
- Active tasks, outbox intentions, individual ACK checkpoints, deduplication and delivery-blocked evidence are RAM-owned. Each endpoint has lower-only limits of 16,384 records/32MiB encoded state. Admission fails before exceeding those bounds; they are not a process-RSS guarantee.
- `agent_task_send` confirms relay acceptance, **not execution**. `receiver_recorded` confirms receiver RAM receipt, **not durable persistence**. Pi insertion and wake acceptance are separate evidence, never proof of model execution.
- Delivery receipts are origin-local status. The origin records each one in its task log without presenting, archiving or forwarding it to the worker. Stages are ordered `receiver_recorded` < `pi_inserted` < `wake_accepted`, and a later stage implies the earlier ones. Per event and refresh, a receiver sends only the highest stage it reached, plus `pi_insertion` `blocked` when Pi did not record the insertion, so an assignment received, inserted and woken in one refresh costs one receipt. The `wake_accepted` record is written before Pi emits the wake, which keeps it ahead of any intent the woken model sends; it is sent only after the wake appears in Pi's entries, and an unobserved or throwing wake withdraws the never-sent record. `wake_requested` remains in `TaskDeliveryStage` and is accepted from 0.1.15 receivers (status shows wake acceptance pending) but is no longer emitted.
- Session history is not an operational journal. A new process/lifecycle starts empty with a fresh endpoint/generation; it does not reconstruct tasks, replay envelopes, reuse old ACKs or reopen a worker gate from old history.
- A relay restart can lose even accepted mail. A Pi restart loses that endpoint's active task state. Relay-loss evidence marks affected work failed only in the discarded local lifetime; its remote outcome remains explicitly unknown and is never presented as canonical delivery or completion evidence.

## memory-owned lifecycle

`createConfiguredTaskCore()` owns its transport and `createTaskStore()` RAM state. Startup registers; background polling is one `setTimeout` chain that re-arms after each refresh: every 1s while a task is active, the outbox is pending, or a gate-enabled worker awaits an eligible assignment, otherwise every 5s. Successful send/message/done/ack/cancel tools, `turn_end`, agent end and agent settlement request an immediate single-flight refresh; requests made during a running refresh coalesce into one trailing refresh. `agent_task_wait` requests one refresh, then re-checks local state when the RAM store commits a change or after a backoff of 250ms doubling to 2s; it issues no relay requests of its own. Shutdown fences new work, aborts requests, drains active calls and discards state. Late callbacks cannot mutate a successor lifetime.

Background refresh records protocol facts in RAM even while Pi is busy or has queued messages. A valid completion within the fetched receive page can become canonical before its notification is presented. Model-visible insertion and the separate follow-up wake still wait for idle Pi with no queued messages; visible relay mail remains replayable until the required structured insertion/wake evidence is present. Intake alone does not incorporate an assignment or authorize worker tools. Parent acknowledgment before terminal presentation retains the event but suppresses its redundant wake. Origin-authored conversations do not echo to the origin. The origin's own view of other canonical events it creates, such as a completion canonicalized from a worker's raw intent, is queued in a RAM-only local presentation table instead of a self-addressed relay envelope. `receive()` merges those local items with relay mail by intake order, so a held item still blocks later ones. A local item needs the same insertion and wake evidence before it completes, but records no relay delivery receipts. Receiver-authored conversation copies remain canonical replicas, but local outbound intent identity makes their presentation archive-only; payload author claims are not provenance. Missing or unmatched intent identity leaves peer conversations actionable. This correlation is RAM-only and is never recovered from session history.

The adaptive 1s/5s polling cadence does not change relay byte limits. A single-flight background refresh shares one work scope through lease connection, ACK repair, timeout fan-out, receive and all inbox receipts: at most 56 scoped sends plus 8 rotating old-work sends, 48 ACK attempts and one initial receive page of up to 50 items, with a 2s overall deadline. Failed attempts consume the shared counts; the same send/ACK identity is not attempted twice in that scope. Separate 250ms retry/ACK-repair slices stop admitting another attempt, not an already admitted request: each admitted request gets the remaining background window. These are scheduling bounds, not throughput guarantees. Foreground send/message/done retain the configured transport request deadline (default 12s) and caller cancellation instead of inheriting the background cutoff. Any speculative old-work retry after a foreground send uses a finite 2s background window, starting only when that share is reached.

Each refresh deliberately fetches only one initial page, even when `hasMore` is true or the ACK frontier advances. Extra-page saturation draining (#27) is deferred, not fixed or optimized; byte limits can make this page shorter than 50 items, and shared send/ACK counts can defer work within it. The normal refresh reserves initial protocol intake ahead of requested-ACK repair; page intake also precedes its own repair pass. Speculative old-work sends wait until all current-page intake and available presentation/evidence/ACK work completes or deliberately yields. Inbox delivery holds that gate across receive and nested fanout/receipt flushes, releasing it in finalization even on empty, held/busy or failed passes when budget remains. Direct core receive suppresses speculation during page materialization and retains its bounded after-intake retry opportunity; an inbox-owned gate remains closed until presentation yields. After required canonical fan-out acceptance, both new and replayed raw intents stage authorized ACK requests in the existing checkpoint rather than retrying inline. The shared after-intake repair pass uses the same ACK budget, admission slice and overall background deadline; remaining raw ACK work reports local deferral on budget/slice/cooldown exhaustion. Failed or pending required fan-out still stops intake at that delivery. Retryable/slow repair still reports failure and retains uncertain requested IDs, but cannot prevent that initial real receive. A failed repair yields before presentation. Ignored-abort ACK responses cannot later advance local authority. Held visible mail, missing insertion/wake evidence, backpressure or exhaustion yields without reading ahead. A full held prefix can still prevent intake of a newer intent beyond that page; general backlog scanning is not provided.

Scoped operations attempt their own immutable IDs and cannot report acceptance for omitted or partial fan-out. Concurrent same-ID sends join existing delivery rather than retransmitting. Pending retry IDs rotate incrementally in RAM on attempts/actual skips, including failures and cooldown skips, without copying payloads or rotating an unattempted suffix past the retry deadline. A foreground packet's capacity refusal does not suppress smaller old packets to the same target; same-cycle target suppression starts only when speculative retry itself encounters capacity. Mail to one target leaves in creation order: an envelope is sent only after every older pending envelope to the same target is accepted, and a younger send waits for an older send already in flight. While the oldest envelope is cooling down or out of budget, younger mail to that target reports `TASK_DELIVERY_DEFERRED` (with `blockedBy`); a quarantined envelope leaves the queue and blocks nothing, and other targets are unaffected. Retry selection offers only each target's oldest pending envelope, and a reported send first offers older mail to its target from the bounded old-work share. Known capacity defers that envelope/ACK for at least 5s (or the validated longer `retryAfterMs`), without a retry timer. `TASK_DELIVERY_DEFERRED` is a retryable local budget/cooldown outcome, not relay acceptance or permanent quarantine. Raw intent replays retain their canonical fan-out reservation and are not ACKed while required sends remain pending; quarantined required sends report their blocked outcome instead of false acceptance. The exported `TaskStore` contract requires indexed lookup, fair rotation, cooldown, per-target FIFO selection (`pendingOutboxAhead`), withdrawal of a never-sent reservation (`discardUnsentOperation`), the RAM local presentation queue and post-commit `onChange` notification, supplied by `createTaskStore()`; custom `TaskStore`/`TaskCore` implementations written against 0.1.15 must add these members (`TaskCore` also gains `hasPendingWork`, `onChange` and `completeLocalPresentation`, and its `WakeRequest` gains `discard()`); there is no legacy snapshot/fixed-prefix fallback. `TaskCore.receive()` returns an ordered array of `{ kind: "relay", delivery, order }` and `{ kind: "local", event, order }` items; a consumer ACKs relay items and completes local items with `completeLocalPresentation(eventId)`. The documented transport seam is unchanged, and origin-targeted canonical envelopes from older peers are still accepted.

The default extension automatically replaces a lifetime only after a structured `RELAY_RESET` or `RELAY_REBIND_REQUIRED`. It fences and discards the unusable RAM state, records each active task in session history as locally failed with `RELAY_STATE_LOST` and an explicitly unknown remote outcome, then binds a fresh empty endpoint. The loss record does not wake the model by itself. Transient availability, authentication, capacity, abort, profile and malformed-response failures never trigger replacement. Historical tasks are not adopted into the successor lifetime.

`createVolatileTaskSession({ url, callerSession, store })` is the lower-level API for a caller-owned RAM store. Transport reconnect within that same lifetime retains pending immutable retries; `rebind()` clears the store, while `close()` stops transport and the caller then closes its state. Persistence/path options are rejected. Old database files are neither read nor deleted.

Full immutable content, including the original creation timestamp, is reused for retries. Destination-confirmed acceptance is required. Conflicting content, exhausted delivery and reset cannot become successful acceptance. Individual ACKs preserve sparse bigint cursors and cannot skip earlier pending mail. Bounds/deadlines apply through complete response bodies, including noncooperative injected transports.

## trusted Tailnet and optional authentication

The intended deployment trusts its Tailnet machines; Tailscale access control is the network boundary. Do not expose owner APIs through the public internet/Funnel or an untrusted proxy. No additional JWT or peer-signature scheme is required by the task protocol.

Existing global Wolfpack JWT enforcement remains **optional**. If the owner configures `WOLFPACK_JWT_SECRET`, the configured Pi factory supports it with short-lived tokens only for HTTP loopback. It never discovers/distributes secrets or automatically forwards them to arbitrary HTTPS URLs. HTTP401 reports `RELAY_AUTH_REQUIRED`, not an epoch reset.

Remote task endpoints must be locally resolved aliases. The paired CLI qualifies a selected remote endpoint through the local coordinator; remote lists expose explicit remote metadata. Failed qualification preserves any created session/ID but removes unsafe `taskEndpoint` output and reports `taskEndpointError`.

## delegation workflow

Configure `WOLFPACK_IMPLEMENTER_MODEL` and `WOLFPACK_REVIEWER_MODEL`; defaults are `openai-codex/gpt-5.6-terra` and `openai-codex/gpt-5.6-sol`. Explicit user or project choices override those defaults.

```bash
IMPLEMENTER_MODEL="${WOLFPACK_IMPLEMENTER_MODEL:-openai-codex/gpt-5.6-terra}"
REVIEWER_MODEL="${WOLFPACK_REVIEWER_MODEL:-openai-codex/gpt-5.6-sol}"
```

1. Use one assignment mode: full-startup instructions, or an endpoint assignment—not both. For a task worker: `wolfpack agent spawn --project-dir /absolute/worktree --name <task-role> --model "$IMPLEMENTER_MODEL" --task-worker --readiness-timeout-ms 30000 --json` (or `"$REVIEWER_MODEL"`). This mode rejects prompts/plans and `--notify-parent`; put all instructions in `agent_task_send.task`.
2. Verify exact session ID/root/Pi harness and registered `taskEndpoint`. `TASK_WORKER_PREFLIGHT_FAILED` precedes creation. `TASK_WORKER_NOT_READY` retains `createdSession`/`cleanup`; inspect `unconfirmed` cleanup by exact ID before retry. Registration is not model execution.
3. Submit the assignment and continue useful work. When none remains, yield to structured follow-up. Do not poll `agent_task_status` or `agent_task_inbox` merely to wait; use `agent_task_wait` only when explicitly asked to block.
4. Use `agent_task_message` for questions, answers and information. The receiver's last action is `agent_task_done`, not completion prose.
5. Independently verify, then acknowledge the terminal task and deliberately retain or clean up the parent-owned role.

Endpoint assignments require terminal completion and one `agent_task_ack`; full-startup children have no task ID, so use explicit completion/block notification and parent verification instead. Close only sessions the parent spawned using `wolfpack kill <stable-session-id> --json`, then verify that ID absent from `wolfpack list --json`. Never use `wolfpack session send`, `/exit`, or `/quit` for cleanup.

## worker-only execution gate

The exact value `PI_TASK_WORKER=1` enables a fail-closed model tool gate. Before assignment only inbox/status/wait are allowed; other tools receive `PI_TASK_WORKER_ASSIGNMENT_REQUIRED`. Ordinary interactive Pi and explicit user shell commands are outside this gate.

`PI_TASK_WORKER=1` sessions are leaf roles. Generic role-orchestration guidance applies only to non-worker coordinators. The spawning coordinator owns each child's complete lifecycle.

Workers cannot call `agent_task_send`, `agent_task_cancel`, or `agent_task_ack` (`PI_TASK_WORKER_COORDINATION_FORBIDDEN`). `agent_task_message` must name their eligible incorporated assignment. A structured session event alone is insufficient: its task must also be active in this endpoint's current RAM state. Old session history never authorizes work after restart.

Preflighting `agent_task_done` marks that task as closing before sibling calls are preflighted. Ordinary tools remain blocked for a closing, pending-terminal, accepted-terminal, or `delivery_blocked` task; an idempotent `agent_task_done` retry for that same assigned task remains allowed. Another independently active assignment can still authorize work.

## terminal delivery and acknowledgment

During the active lifetime `terminalDelivery` reports `not_submitted`, `pending`, `accepted`, or `delivery_blocked`. The blocked variant includes stable intent/envelope identities, origin endpoint, timestamp, and structured non-retryable relay error. Canonical task status is never changed to `delivery_blocked`. Retryable failures reuse the original intent; permanent failures are not rearmed. This evidence is lost on endpoint restart.

`agent_task_ack` is terminal-only and origin-owned. Sequential/concurrent retries in one lifetime reuse the logical event and envelope IDs. There is no restart recovery. Report changed source paths in `result.changedFiles`; artifacts are receiver-project-relative regular files, not the changed-file list.

```json
{ "result": { "changedFiles": ["src/extension.ts"] }, "artifacts": [{ "path": "verification/task-2.md" }] }
```

## development and verification

```bash
bun install
bun test
bun run typecheck
PI_TASKS_WOLFPACK_SOURCE=/absolute/clean/wolfpack-checkout \
PI_TASKS_WOLFPACK_REVISION=<full-commit-id> \
bun test tests/volatile-real-worker.test.ts tests/volatile-extension-worker.test.ts
```

Wolfpack worker tests require its supported Bun runtime (currently stable>=1.4.2). Optional source-selected checks use private HTTP/workers, not installed services. They test same-lifetime retry/ACK, automatic default-extension reset recovery, explicit lower-level session replacement, fresh endpoint state and history-only evidence. `createInMemoryTaskRelay` is a deterministic conformance fixture, never the default runtime transport. Physical two-machine qualification, final-path performance, release packaging and live activation remain separate gates.
