# Security Review Report

## What Changed

| item | reviewed scope |
| --- | --- |
| Target | plan 015 task 5 adapter-contract changes plus plan 016's remote-initial-receipt ordering correction |
| Baselines | Wolfpack `5549047176e1f83261e00d91d054794c797c723c`; Pi Tasks `ab8893443ef9054fd752ae443ed3e8555148353e` |
| Files reviewed | 20 changed files: 13 Wolfpack (including the new adapter contract) and 7 Pi Tasks |
| Security-relevant files | `src/tasks/gateway.ts`, `src/tasks/domain.ts`, `src/extension.ts`, `src/task-inbox.ts` |
| Context loaded | Wolfpack `edc-context/index.md`, `modules/wolfpack.md`, and `modules/broker.md`; no Pi Tasks `edc-context/` exists, so its baseline was built from the changed code, callers, tests, and history |

The review was restricted to target eligibility and remote provisional persistence; peer error handling and caller/participant checks; inbox visibility and delivery evidence; explicit acknowledgment; opaque-field validation/rendering; and packaged tool/contract exposure.

## Findings

### No security findings

No exploitable or security-relevant regression survived verification in the reviewed diffs.

Checked:
- **identity and authorization:** local and peer target checks retain authoritative session resolution and replace the Pi-only gate with the existing closed `isOpenableHarness` taxonomy at `src/tasks/gateway.ts:196` and `src/tasks/gateway.ts:523`. Sender, receiver, and parent authorization remains enforced on send, delivery, and acknowledgment routes.
- **remote persistence ordering:** `src/tasks/gateway.ts:236-241` sends the single provisional peer receipt before sender-ledger creation, but only returns without persistence for a structured non-retryable result. Retryable/uncertain failures still create the sender ledger and terminal failure at `src/tasks/gateway.ts:241-262`. The receiver validates origin, assignment hash, target liveness, harness policy, and preflight before provisional persistence at `src/tasks/gateway.ts:499-535`.
- **peer errors and trust boundary:** peer origin remains canonical HTTPS Tailnet-only and redirects are rejected by the unchanged `#postPeer` boundary. The correction adds no new peer route, credential path, retry loop, or capability inference.
- **inbox filtering and delivery proof:** the complete event disposition map in `src/tasks/domain.ts:106-128` is applied before inbox exposure at `src/tasks/gateway.ts:315-350` and before local/remote replica inbox insertion at `src/tasks/gateway.ts:894-915`. Pi fails closed before cursor persistence for unknown visible events at `src/task-inbox.ts:40-42`; it verifies full durable `{taskId,eventId}` evidence before `delivered` at `src/task-inbox.ts:52-60`.
- **opaque fields and rendering:** Pi only renders `role`, structured context, refs, warnings, and the terminal parent-only follow-up condition at `src/task-inbox.ts:101-124`; `metadata` has no prompt-rendering sink. Gateway request bounds and field validation remain before assignment construction at `src/tasks/gateway.ts:167-174` and `src/tasks/gateway.ts:977+`.
- **acknowledgment/tool exposure:** `agent_task_inbox` no longer performs acknowledgments and the added `agent_task_ack` names one task at `src/extension.ts:135-158`; the gateway still verifies parent ownership and terminal state before acknowledging at `src/tasks/gateway.ts:446-454`.
- **history/regression scan:** `git log -S`/blame attribute the prior Pi-only gate and legacy internal-event filtering to the original durable gateway implementation (`524009e`); no relevant security/CVE/auth/validation-removal history was found in the reviewed paths. The diff replaces those protections with stricter taxonomy/disposition checks rather than removing them.

## Security Test Confidence

- independently executed Wolfpack focused domain/gateway/docs tests: **82 passed, 0 failed**; they cover isolated-peer routable/non-agent handling, zero-ledger definitive rejection, opaque-field round trips, redirect rejection, durable retries, and internal-inbox filtering.
- independently executed Pi focused inbox/extension/package tests: **26 passed, 0 failed**; they cover single-flight refresh, read-only inbox, task-specific acknowledgment, full-entry delivery proof, fail-closed unknown events, and parent-only completion prompts.
- independently executed both repository typechecks successfully.
- the inspected coverage exercises the reviewed trust boundaries without mocking away the peer HTTP boundary for the federation cases.

## Blast Radius

- public task routes affected: local/peer send, peer receive, inbox, delivered, and acknowledgment.
- affected consumers: any existing conforming adapter through the canonical inbox contract; Pi's extension is the only changed adapter implementation.
- EDC trust invariant preserved: server-side authoritative session identity and Tailnet/JWT policy remain the control boundary; routability does not assert adapter readiness or grant new session authority.

## Historical Context

- `TARGET_NOT_PI`, the former internal-event set, and the original sender-before-peer receipt ordering originated in the task-gateway introduction (`524009e`).
- the current uncommitted diff removes the runtime Pi-only restriction, expands filtering to a complete disposition map, and narrowly moves only the initial remote receipt before sender persistence.
- no security-, CVE-, authentication-, or validation-fix commit was found that this diff reintroduces or weakens in the reviewed paths.

## Limitations

- no live Tailnet peer, real non-Pi adapter, or production Pi session was dispatched; review used source tracing and isolated two-server coverage.
- this is a differential security review, not a generic delivery, quality, or full-repository audit.
- the full suites were not re-run by this reviewer.

## Recommendation

APPROVE — the reviewed diff preserves the identity, authorization, peer-origin, durable-evidence, cursor, and task-specific acknowledgment trust boundaries while closing the intended Pi-only and internal-event exposure gaps.
