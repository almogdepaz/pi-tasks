---
name: wolfpack-pi-task-delegation
description: Use when opening, selecting, delegating to, checking, or cleaning up a Wolfpack Pi subagent through the gateway-backed agent task tools.
---

# wolfpack pi task delegation

use `wolfpack-tailnet-control` for session control. this skill covers gateway task lifecycle, curated context, and parent verification. Pi is one conforming adapter. Wolfpack's [harness-neutral task adapter contract](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-adapter-contract.md) is the canonical adapter reference; its [task gateway guide](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-gateway.md) covers routes, trust, retention, and federation.

## gateway requirements and addressing

- every participating Pi process needs this package and a reachable local Wolfpack v1 gateway.
- `WOLFPACK_SESSION_NAME` is the caller selector; the local gateway resolves it to a stable broker ID. `WOLFPACK_PORT` selects the local port and defaults to `18790`.
- address a target as `to: { machine, sessionId }`, retaining the stable broker `sessionId` from structured Wolfpack session control rather than a terminal label.
- use `machine: "local"` for same-machine work. For remote work, use only the receiver's canonical HTTPS Tailnet origin, such as `https://worker.example.ts.net`; never a terminal name, arbitrary URL, path, query, fragment, credentials, or unexpected port.
- v1 trusts local processes and trusted Tailnet machines. Pi calls only its local gateway; gateways use direct fetch federation. JWT federation is unsupported, so do not promise remote delivery where Wolfpack global JWT requires credentials.

## workflow

1. create or select an existing Pi session with canonical Wolfpack session control. Read its structured response and retain the stable broker `sessionId`. Before remote dispatch, complete Wolfpack's [Live-peer readiness checklist](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-gateway.md#live-peer-readiness-checklist), including operator-recorded package/reload evidence; if it cannot pass, stop before task creation and report fixture-only verification.
2. send concise opaque task instructions with `agent_task_send`. Parent normally authors optional Markdown `context.summary` and deliberately selects `context.refs` with `path`, optional `selector`, and `purpose`; refs are metadata, not copied files or transcript. Use `task-context-summary` only for recovery/reuse.
3. include `role`, `metadata`, enforceable `preflight.requiredProject`, bounded timeout, idempotency key, and `onCompletePrompt` only when they apply. Timeout is 1000ms through 24h; default is 30 minutes. Task/context limits are 16 KiB each, assignment envelope 48 KiB, and request body 64 KiB.
4. after durable receipt, keep working. Do not call `agent_task_wait` unless the user explicitly asks to block. Use `agent_task_status` or `agent_task_inbox` for structured follow-up.
5. use `agent_task_message` for durable `question`, `answer`, or `information` flow. One question may be unresolved globally; answers link to it. A receiver question accepted by the sender ends the receiver turn; a parent question does not end the parent turn.
6. assignees call `agent_task_done` exactly once as their final action with `completed`, `failed`, or `cancelled`, concise summary, and optional structured result/error/artifact metadata. Report source modifications in `result.changedFiles`; artifacts are receiver-project-relative regular files for a parent to inspect, not changed-file lists: `{ "result": { "changedFiles": ["src/extension.ts"] }, "artifacts": [{ "path": "verification/task-2.md" }] }`. Follow the canonical Wolfpack artifact contract for provenance, containment, and warning behavior. No prose completion afterward.
7. parent independently verifies files, diff, tests, and artifacts before reporting success. Then use `agent_task_ack({ taskId })` for that one verified terminal task; remote acknowledgment is two-phase and failed propagation leaves the task visible for explicit repair. Cleanup applies only to sessions this parent spawned and only after result verification and acknowledgment. Retain reusable sessions while review or correction is pending.

## delivery and recovery

`agent_task_send` returns after durable receiver-gateway receipt, not model execution. A remote initial send gets one initial attempt. The receiver stores a provisional receipt, and Pi sees the assignment only after sender receipt confirmation. Later peer events get four total attempts: initial plus retries around 1, 2, and 4 seconds with jitter. Retry exhaustion is a surfaced local delivery failure; v1 has no queue, scheduler, or offline dispatch.

The sender gateway owns canonical order, expiry, and terminal choice; the first accepted terminal event wins. Sender timeout causes best-effort remote cancellation. The local extension polls every five seconds and injects only while idle with no pending messages. It stores `{ taskId, eventId }` in structured custom messages, replays missing events after restart, and records delivery only after structural insertion. Do not call that exactly-once execution.

Isolated coverage is the deterministic acceptance gate, but a specific live peer still requires current readiness at the time of use. Do not claim that a particular remote deployment is reachable without the checklist evidence.

## do not

- do not use terminal output as task state or completion evidence.
- do not ask workers to complete in prose.
- do not inject task context while Pi is busy or has pending messages.
- do not copy whole plans, ref contents, or transcripts into task context.
- do not use filesystem task storage or retain old `mustReturn`, `rejected`, or semantic completion contracts.
- do not promise JWT federation, artifact byte transfer, or background retry/offline dispatch.
- do not make workers close their own sessions.
