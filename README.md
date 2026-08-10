# pi-tasks

`pi-tasks` is a Pi extension client for Wolfpack task transports. The retained v1 adapter uses Wolfpack's machine-global `~/.wolfpack/tasks` store; v2 keeps endpoint-owned Pi task state locally and uses Wolfpack as a content-blind relay. Neither adapter writes assignments to terminals. Read Wolfpack's [harness-neutral task adapter contract](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-adapter-contract.md) for canonical adapter behavior and its [task gateway guide](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-gateway.md) for routes and operations.

## v2 endpoint-owned relay

The default extension uses the configured local Wolfpack relay v2 adapter, never the in-memory conformance relay. It registers an opaque endpoint with `POST /api/task-relay/v2/connect`, stores endpoint-owned task state in `~/.pi/tasks/v2/tasks.sqlite`, and exchanges opaque relay envelopes through Wolfpack. The adapter needs a Wolfpack release exposing the stable [relay v2 control-api contract](https://github.com/almogdepaz/wolfpack/blob/main/docs/control-api-schema.md#pi-tasks-relay-v2-boundary); a v1-only gateway is incompatible and does not silently fall back.

Set `WOLFPACK_SESSION_NAME` for every Pi process. The adapter uses `WOLFPACK_PORT` when the local control port differs from `18790`; `WOLFPACK_SESSION_NAME` resolves the active Pi process to its relay endpoint. On startup, obtain a target's opaque `{ relay, id }` endpoint from its Wolfpack session-status projection after that target has registered, then send it through the endpoint-owned tool shape:

```json
{
  "to": { "relay": "wolfpack-pi-tasks-v2", "id": "target-opaque-endpoint-id" },
  "task": "implement the narrow change and run focused tests"
}
```

Wolfpack's relay owns durable mailbox delivery and peer forwarding; Pi owns task lifecycle, logical event order, receipts, and its local SQLite state. Insertion receipts are idempotent by `{ taskId, eventId }`, so replay after Pi has structurally recorded an event cannot create an additional logical receipt. `createInMemoryTaskRelay` remains exported solely as a deterministic conformance fixture.

## v1 gateway adapter (retained)

The v1 gateway client is available only through the published `@sgtbeatdown/pi-tasks/v1-compat-extension` entry. This is an explicit opt-in: after resolving the installed package root, add `src/v1-compat-extension.ts` as an extension path in Pi settings instead of loading the package default. The package manifest loads only `src/extension.ts` (v2); v2 does not fall back to v1 when its relay is unavailable or incompatible. Its v1 behavior and operational requirements are documented below.

## requirements and trust boundary

- a reachable local Wolfpack v1 task gateway on every participating machine;
- this package loaded in every participating Pi process;
- `WOLFPACK_SESSION_NAME` set by Wolfpack so the local gateway can resolve the caller to a stable broker ID; and
- `WOLFPACK_PORT` when the local control port is not the default `18790`.

The boundary is trusted local processes and trusted Tailnet machines. Pi only calls its own local gateway. The gateways perform direct fetch federation; Pi never fetches a peer directly. v1 adds no task capability authentication. Normal Wolfpack global JWT behavior is not bypassed, and JWT federation is unsupported: peer delivery fails clearly when credentials would be required.

## task address and send

A target is always `{ machine, sessionId }`, where `sessionId` is the stable opaque broker ID returned by Wolfpack session control. Use `machine: "local"` for same-machine work. For a peer, use the receiver's canonical HTTPS Tailnet origin, for example `https://worker.example.ts.net`; do not supply a hostname label, path, query, fragment, credentials, unexpected port, or arbitrary HTTPS URL.

```json
{
  "to": { "machine": "local", "sessionId": "receiver-broker-id" },
  "task": "implement the narrow change and run focused tests",
  "context": {
    "summary": "## constraints and preferences\n- keep scope narrow\n## key decisions\n- preserve the public contract",
    "refs": [{ "path": "src/extension.ts", "purpose": "affected tool wiring" }]
  },
  "metadata": { "phaseId": "phase-1", "issueId": "task-3", "verificationTier": "focused" },
  "onCompletePrompt": "review the receiver diff before reporting completion",
  "timeoutMs": 1800000
}
```

### minimal valid send envelope

```json
{
  "to": {
    "machine": "local",
    "sessionId": "receiver-broker-id"
  },
  "task": "implement the narrow change and run focused tests"
}
```

`INVALID_REQUEST.error.path` is an optional RFC 6901 JSON Pointer to the rejected send field, for example `/preflight/requiredProject`; use it rather than parsing error prose. A pre-persistence validation rejection creates no task, so correct the field and retry. If creation status is uncertain, idempotency remains necessary.

Remote addressing changes only `to.machine`:

```json
{ "to": { "machine": "https://worker.example.ts.net", "sessionId": "receiver-broker-id" }, "task": "review the cited diff" }
```

Context is optional, curated Markdown plus deliberately selected ref metadata. The extension renders refs but never reads or copies their contents. Relative refs resolve in the receiver project; absolute refs are same-machine only and must remain inside the authoritative parent or receiver project root. Missing refs are warnings, not copied content or transcript transfer.

Initial limits are 16 KiB UTF-8 each for task instructions and context summary, 48 KiB for the assignment envelope, and 64 KiB for an HTTP request body. The initial size limits require representative payload benchmarking before adjustment.

`agent_task_send` waits for durable gateway acceptance, not adapter insertion or task execution; delivery remains pending until `task.delivered`. A remote initial send has one initial attempt: the receiver persists a provisional receipt, then receives sender confirmation before Pi can see the assignment. Later peer confirmation, messages, terminal updates, cancellation, delivery notices, and parent acknowledgment have four total attempts: the initial attempt plus retries around 1, 2, and 4 seconds with jitter. Exhaustion is a visible local delivery failure, not a background queue or offline dispatch promise.

Normal delegation is fire-and-forget. Use `agent_task_wait` only when the user explicitly asks to block.

## tools, messages, and acknowledgment

| tool | purpose |
| --- | --- |
| `agent_task_send` | create a durable gateway assignment |
| `agent_task_status` | read task state, history, result, and warnings |
| `agent_task_wait` | explicitly poll a task until terminal or timeout |
| `agent_task_inbox` | read task events without acknowledgment |
| `agent_task_ack` | acknowledge one independently verified terminal task |
| `agent_task_message` | send a durable `question`, `answer`, or `information` event |
| `agent_task_cancel` | request cancellation |
| `agent_task_done` | receiver-only terminal completion; terminates the tool turn |

Use `agent_task_message` for clarification instead of terminal prose. Only one question can be unresolved per task; answers link to that question. Information is durable and does not change task state. An accepted receiver question terminates that receiver turn; a parent question does not.

Report source modifications in `result.changedFiles`. Artifacts are receiver-project-relative regular files for a parent to inspect, not a changed-file list:

```json
{ "result": { "changedFiles": ["src/extension.ts"] }, "artifacts": [{ "path": "verification/task-2.md" }] }
```

See the canonical Wolfpack artifact contract for provenance, containment, and warning behavior.

The sender gateway owns canonical event order, timeout, and terminal state. The first accepted terminal event wins. Sender timeout triggers best-effort remote cancellation; late terminals remain diagnostics. After independently verifying one terminal result, call `agent_task_ack({ taskId })`. Remote acknowledgment is two-phase: the receiver durably confirms pending acknowledgment before the sender records final parent acknowledgment. If that delivery fails, the task remains visible and a later explicit acknowledgment repairs it with the same event ID.

## structured delivery and replay

The extension polls the local gateway every five seconds. With no pending message, it submits each visible event as a structured custom message using Pi's safe `deliverAs: "followUp"` mode: idle Pi starts immediately, while an active turn finishes before the queued event starts the next turn. It never steers or interrupts active work. Delivery remains pending until `task.delivered`. The `{ taskId, eventId }` details let task context participate in the session without parsing prose.

On start or resume it rebuilds incorporated IDs from the full durable session entry set, not only active prompt context. A session gets only missing events; a new Pi session in the same Wolfpack PTY gets complete active history. The receiver records gateway delivery only after the structured insertion exists. A restart after insertion and before acknowledgment therefore acknowledges the existing entry without duplicate injection. Unknown model-visible events fail closed without advancing the cursor. Gateway delivery is at-least-once; this does not claim exactly-once model execution.

## parent workflow

1. create or select a Wolfpack Pi session with the canonical session-control workflow and retain its stable broker ID. Spawn a disposable worker without an initial model prompt so it reaches idle before assignment; put worker instructions in `agent_task_send.task`.
2. before remote dispatch, complete Wolfpack's [Live-peer readiness checklist](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-gateway.md#live-peer-readiness-checklist) and retain operator-recorded package/reload evidence; only then check the target's local requirements and send compact instructions with curated context and selected refs when they save receiver investigation.
3. keep working; use `agent_task_status` or `agent_task_inbox` for structured follow-up, and `agent_task_message` for questions, answers, and decisions.
4. verify cited files, diffs, tests, and paths-only artifact metadata independently before reporting success.
5. acknowledge the accepted terminal result, then clean up only sessions this parent spawned. Keep a reusable implementer alive while review or correction remains possible; never make workers close their own sessions.

Isolated coverage is the deterministic acceptance gate, but a specific live peer still requires current readiness at the time of use. If the checklist cannot pass, stop before task creation and report fixture-only verification. Do not use direct peer URLs from Pi.

See `skills/wolfpack-pi-task-delegation/SKILL.md` for the operational workflow and `skills/task-context-summary/SKILL.md` for recovery/reuse summaries.

## deferred follow-up

These are documented operational debt, not production TODOs: exact Pi runtime registration and heartbeat/capability leases; durable offline initial dispatch; JWT/authenticated peer federation; artifact byte transfer and retention; representative payload benchmarking; automated recovery summaries; and summary caching only after measured repeated-generation waste. v1 has no queue, scheduler, artifact transfer, or transcript transfer.

## legacy historical metrics

`task-metrics` and the task board remain read-only analyzers for already-existing historical `.pi/tasks` directories. They are not part of the runtime task protocol and must not create, mutate, or deliver v1 gateway tasks. Replacing or retiring that historical reporting surface requires a product decision about gateway-wide query/metrics ownership.

## development

```bash
bun install
bun test
bun run typecheck
```
