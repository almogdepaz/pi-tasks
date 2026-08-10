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

## phase roles and handoffs

For a multi-step project phase, retain one persistent implementer and one persistent read-only reviewer. Reuse a healthy role session for corrections and follow-up review; a completed task is an assignment result, not a reason to replace its session. Do not rotate a healthy role session for routine corrections. Rotate only for explicit phase completion, material context saturation, harness failure, or a required independent specialist. Keep at most one active assignment per role unless the user explicitly asks for parallel work.

Persistence is a parent decision, not a default. After every verified and acknowledged terminal task, the parent must explicitly choose whether to retain or close a session it spawned. Retain it only when the parent expects concrete follow-up work; close it when the parent does not expect to use it again. Do not leave the cleanup decision implicit.

Use gateway task tools for assignments, questions, decisions, completion, and acknowledgment. terminal `send` is only for explicit human steering; it is not task state, a completion channel, or a substitute for `agent_task_message`.

## workflow

1. create or select an existing Pi session with canonical Wolfpack session control. Reuse the phase role session when it is healthy. For a disposable worker, omit `--prompt`: `wolfpack agent spawn <project> --name <task-role> --json`. Put all worker instructions in `agent_task_send.task` so the fresh Pi process can reach idle before assignment. Do not start a disposable worker with a blocking “wait for assignments” model prompt. Read the structured spawn response and retain the stable broker `sessionId`. Before remote dispatch, complete Wolfpack's [Live-peer readiness checklist](https://github.com/almogdepaz/wolfpack/blob/main/docs/task-gateway.md#live-peer-readiness-checklist), including operator-recorded package/reload evidence; if it cannot pass, stop before task creation and report fixture-only verification.
2. send concise opaque task instructions with `agent_task_send`. Use `context.summary` only for constraints, decisions, and recovery state, and deliberately select `context.refs` with `path`, optional `selector`, and `purpose`; refs are metadata, not copied files or transcript. Use `task-context-summary` only for recovery/reuse.
3. include `role`, `metadata`, enforceable `preflight.requiredProject`, bounded timeout, idempotency key, and `onCompletePrompt` only when they apply. Timeout is 1000ms through 24h; default is 30 minutes. Task/context limits are 16 KiB each, assignment envelope 48 KiB, and request body 64 KiB.
4. after durable receipt, keep working. Do not call `agent_task_wait` unless the user explicitly asks to block. Use `agent_task_status` or `agent_task_inbox` for structured follow-up.
5. use `agent_task_message` for durable `question`, `answer`, or `information` flow. One question may be unresolved globally; answers link to it. A receiver question accepted by the sender ends the receiver turn; a parent question does not end the parent turn.
6. assignees call `agent_task_done` exactly once as their final action with `completed`, `failed`, or `cancelled`, concise summary, and optional structured result/error/artifact metadata. Report source modifications in `result.changedFiles`; artifacts are receiver-project-relative regular files for a parent to inspect, not changed-file lists: `{ "result": { "changedFiles": ["src/extension.ts"] }, "artifacts": [{ "path": "verification/task-2.md" }] }`. Follow the canonical Wolfpack artifact contract for provenance, containment, and warning behavior. No prose completion afterward.
7. parent independently verifies files, diff, tests, and artifacts before reporting success. Then use `agent_task_ack({ taskId })` for that one verified terminal task; remote acknowledgment is two-phase and failed propagation leaves the task visible for explicit repair. After acknowledgment, explicitly decide whether the spawned session has a likely next assignment. Retain it while review, correction, or another concrete assignment is expected; otherwise close it through canonical Wolfpack session control. Cleanup applies only to sessions this parent spawned and only after result verification and acknowledgment.

## delivery and recovery

`agent_task_send` returns after durable receiver-gateway acceptance, not adapter insertion or model execution; delivery remains pending until `task.delivered`. A remote initial send gets one initial attempt. The receiver stores a provisional receipt, and Pi sees the assignment only after sender receipt confirmation. Later peer events get four total attempts: initial plus retries around 1, 2, and 4 seconds with jitter. Retry exhaustion is a surfaced local delivery failure; v1 has no gateway queue, scheduler, or offline dispatch.

The sender gateway owns canonical order, expiry, and terminal choice; the first accepted terminal event wins. Sender timeout causes best-effort remote cancellation. The local extension polls every five seconds. With no pending message, it submits visible events through Pi's safe `deliverAs: "followUp"` queue: idle sessions start immediately, active turns finish first, and task delivery never steers or interrupts them. It stores `{ taskId, eventId }` in structured custom messages, replays missing events after restart, and records delivery only after structural insertion. Do not call that exactly-once execution.

Isolated coverage is the deterministic acceptance gate, but a specific live peer still requires current readiness at the time of use. Do not claim that a particular remote deployment is reachable without the checklist evidence.

## do not

- do not use terminal output as task state or completion evidence.
- do not ask workers to complete in prose.
- do not steer or interrupt an active Pi turn with task context; use the adapter's follow-up queue.
- Do not copy plans, source contents, or transcripts into task context.
- do not use filesystem task storage or retain old `mustReturn`, `rejected`, or semantic completion contracts.
- do not promise JWT federation, artifact byte transfer, or background retry/offline dispatch.
- do not make workers close their own sessions.
- do not leave a parent-spawned session open after acknowledgment when the parent does not expect further work from it.
