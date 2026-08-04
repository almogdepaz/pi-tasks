# Harness-neutral task adapter contract

## Goal

Make Wolfpack's durable task gateway genuinely harness-neutral while preserving existing authority, federation, recovery, acknowledgment, retention, and artifact contracts. Define the boundary every harness adapter must implement, then certify the existing Pi extension against that boundary.

Wolfpack remains a content-blind but stateful task control plane. Harness adapters remain responsible for native tools, safe event insertion, harness lifecycle, and turn control. This plan does not implement a Claude adapter; it establishes the contract a later Claude adapter will use.

## Current defects

- Wolfpack rejects local and federated targets whose resolved harness is not Pi through `TARGET_NOT_PI`.
- Wolfpack and Pi lack a canonical event-action matrix, so Pi maintains a model-visible allowlist and silently skips unknown event types while advancing its cursor.
- Pi inbox refresh can run concurrently from session start, the interval timer, and `agent_end`, allowing duplicate insertion races.
- Pi uses active context entries rather than full durable session entries as insertion evidence, making compaction/pruning semantics unclear.
- `agent_task_inbox({ ack: true })` bulk-acknowledges every terminal task it finds instead of one explicitly verified task.
- Generic gateway documentation names Pi where it means any conforming harness adapter.

## Terminology and target eligibility

- **routable session:** a live session whose harness is in Wolfpack's existing openable agent-harness taxonomy (`pi`, `claude`, `codex`, `gemini`, or `cursor` at plan approval). This is identity policy, not proof of adapter capability.
- **conforming adapter:** a harness integration satisfying the mandatory profile below.
- **loaded/ready adapter:** a conforming adapter with current operator evidence that it is installed and loaded in the target process.
- **durable task receipt:** proof that the receiving gateway durably accepted the task, not proof that an adapter or model received or executed it.

Shell sessions, unknown strings, and custom commands outside the openable-harness taxonomy are not routable task targets. Supporting a new harness requires adding it to Wolfpack's canonical harness taxonomy and building/verifying its adapter separately. Wolfpack does not infer loaded adapter readiness.

## Locked responsibility split

### Wolfpack owns

- stable caller and target identity resolution and routable-harness policy;
- durable sender ledgers, receiver replicas, inbox indexes, and tombstones;
- canonical event IDs, sequence, deadline, status, and first-terminal choice;
- participant authorization and transition validation;
- the data-driven event disposition matrix and which events enter adapter inboxes;
- local routing and trusted-tailnet federation;
- bounded peer delivery retries and surfaced delivery failure;
- task timeout, cancellation, messaging invariants, acknowledgment, and retention;
- project preflight and artifact provenance/containment;
- canonical task API schema, limits, errors, and protocol documentation.

### Each harness adapter owns

- native model tool registration and ergonomic early validation;
- request cancellation and response presentation;
- one single-flight inbox receive loop per harness session;
- deciding whether its harness is safe to interrupt;
- converting a canonical model-visible event into structured harness context;
- preventing duplicate insertion using durable `{taskId,eventId}` structural evidence;
- recording `delivered` only after successful structural insertion;
- replaying unincorporated events after adapter/session restart;
- failing closed without advancing past an unknown model-visible event;
- harness-specific prompt rendering, notifications, and turn termination;
- exposing parent verification and explicit task-specific acknowledgment workflows.

### Skills own

- when to delegate, wait, message, verify, acknowledge, and clean up;
- curated context and artifact-reporting guidance;
- harness-specific instructions for invoking native tools.

Skills do not own transport, polling, retries, ledgers, state transitions, or deduplication.

## Adapter conformance profiles

Mandatory:

- durable structural insertion evidence survives restart and compaction;
- one receive loop or equivalent atomic pre-insert deduplication per session;
- no delivery acknowledgment before structural evidence exists;
- cursor never advances past the first unincorporated model-visible event;
- replay and deduplication use canonical task/event IDs, never prose;
- unknown model-visible events fail closed and remain retryable;
- parent acknowledgment names one independently verified task.

Optional and declared per adapter:

- automatic idle wakeup;
- push/subscription instead of polling;
- native terminating-tool behavior;
- custom rendering and notifications.

An integration missing a mandatory property is not a conforming adapter. Optional limitations must not be represented as gateway failure or lack of durable routing.

## Canonical event-action matrix

Wolfpack owns a data-driven disposition for every canonical event type. The generated protocol/docs must identify at least:

| Event family | Adapter inbox | Receiver `delivered` | Parent `ack` | Turn policy |
| --- | --- | --- | --- | --- |
| assignment | receiver | after receiver structural insertion | never | adapter-specific |
| question/answer/information | canonical destination | only when destination is receiver and insertion succeeded | never | adapter-specific |
| cancel request | receiver | after receiver structural insertion | never | adapter-specific |
| completed/failed/cancelled/timed-out | parent | never | only after independent verification | adapter-specific |
| receipt/delivery/ack/failure/late-terminal internals | none; status/history only | never | never | none |

The gateway filters internal events from adapter inbox responses, including historical ledgers created before this plan. Pi may defensively recognize known internal events from an older gateway, but must not silently skip an unknown event returned by a gateway.

Adding a new model-visible event requires updating the canonical disposition matrix, generated/schema contract where applicable, adapter fixtures, and protocol compatibility notes. An old adapter must fail closed rather than discard it.

## Opaque assignment-field contract

Wolfpack validates fields against the canonical schema, applies documented security/existence checks, persists them, and otherwise does not infer model behavior from:

- `role`;
- `metadata`;
- `onCompletePrompt`;
- `context.summary`;
- `context.refs`.

For Pi:

- `role`, when present, is rendered as assignment guidance;
- `context.summary` and refs remain structurally rendered without reading ref contents;
- `metadata` remains structured task/metrics data and is not injected into model prompt text by default;
- `onCompletePrompt` is rendered only to the parent with a terminal event;
- gateway warnings remain visible without changing canonical state.

“Opaque” means opaque after canonical schema validation, not arbitrary JSON. Local and federated round-trip tests cover every accepted assignment field.

## Delivery, acknowledgment, and uncertain outcomes

- Inbox visibility means a canonical model-visible event is available; it does not prove model insertion.
- `delivered` means the receiver adapter found durable structural `{taskId,eventId}` evidence after insertion. Fetching or rendering is insufficient.
- Parent-targeted terminal insertion never emits receiver delivery evidence and never implies acceptance.
- Parent `ack` names one terminal task and occurs only after independent verification.
- Gateway delivery remains at-least-once; adapter insertion is replay-safe, not exactly-once model execution.

The adapter contract documents route-specific reconciliation after local abort/network timeout:

- `send`: automatically retry only with the same idempotency key; otherwise inspect known receipt/status before explicit retry.
- `status`/`inbox`: safe read-only retry.
- `delivered` and `ack`: protocol-idempotent retry after canonical inspection.
- `message`, `complete`, and `cancel`: do not blindly retry an uncertain mutation; inspect canonical status/history and reconcile explicitly.

Adapter request timeout never changes canonical task expiry.

## Error compatibility

Remove every runtime branch that emits `TARGET_NOT_PI`, but retain the code as deprecated and never emitted in the v1 schema/error mapping to avoid source-breaking exhaustive generated clients. Add generic `TARGET_NOT_AGENT` (`422`) for live targets outside Wolfpack's routable agent-harness taxonomy. Document eventual removal of the deprecated code only at a versioned compatibility boundary.

## Success criteria

- Local and remote assignments accept every live routable non-Pi harness identity.
- Shell/unknown/custom targets fail with `TARGET_NOT_AGENT` and create no durable task.
- Unknown, dead, mismatched-project, unauthorized, and malformed targets continue to fail as before.
- No runtime capability registration, heartbeat, lease, inferred model readiness, or automatic terminal injection is introduced.
- Wolfpack's data-driven disposition matrix prevents internal events from entering adapter inbox results.
- Pi fails closed and preserves its cursor if an unknown event is returned.
- Pi has single-flight receive, durable full-session insertion evidence, compaction/restart replay safety, and post-evidence delivery acknowledgment.
- `agent_task_inbox` is read-only; `agent_task_ack` acknowledges exactly one named task and returns its own outcome.
- Wolfpack preserves opaque assignment fields locally and through federation without branching lifecycle behavior on them.
- Existing timestamp equality, nine-case federation, retry, timeout, cancellation, artifact, acknowledgment, retention, and restart coverage remains green.

## 1. Generalize Wolfpack target and inbox policy

Use test-first changes in `/Users/home/Dev/wolfpack-task-adapter-contract`.

Add failing local and isolated-process cases proving:

- Claude and Codex targets are accepted, durably replicated, and exposed through the normal receiver inbox;
- shell, unknown, and custom harness strings fail with `TARGET_NOT_AGENT` and zero ledger creation;
- local send and peer receive enforce the same taxonomy;
- unknown/dead targets, project mismatch, caller mismatch, and invalid remote identities retain existing behavior.

Then minimally:

- replace both `AGENT_KIND.PI` gates with the existing openable-harness predicate;
- add `TARGET_NOT_AGENT` while retaining deprecated never-emitted `TARGET_NOT_PI` for v1 compatibility;
- add a data-driven canonical event disposition map in the task domain;
- use that map to keep internal events out of inbox responses without deleting them from status/history;
- regenerate schema/snapshots and document compatibility;
- do not add adapter registration or capability guessing.

Add matrix completeness tests requiring every canonical event type to have exactly one disposition and inbox tests for current plus historical internal records.

## 2. Publish and enforce the adapter contract

Add canonical Wolfpack `docs/task-adapter-contract.md`, referenced by the task gateway guide, README, and agent-skills guide.

Document:

- terminology, responsibility split, mandatory/optional profiles;
- the canonical event-action matrix;
- the adapter receive algorithm and cursor checkpoint rule;
- full-session structural evidence across restart/compaction;
- receiver delivery versus parent acceptance;
- opaque fields;
- route-by-route uncertain-outcome reconciliation;
- gateway/session readiness versus harness-specific installed/loaded evidence.

Update `docs/task-gateway.md` to use generic terms. Preserve a dedicated Pi readiness subsection with current `pi list` plus fresh-start/`/reload` evidence. Change the delivered-route description to conforming-adapter structural insertion.

Documentation tests may enforce shipped files, links, required headings, and stable command/schema references. Do not use broad regex/prose assertions as a substitute for behavioral tests.

## 3. Make Pi receive delivery race-safe and contract-conforming

Test first in `/Users/home/Dev/wolfpack-pi-tasks`:

- simultaneous session-start/timer/agent-end refresh attempts produce one insertion and one delivery record;
- idle/pending gates hold before and after status retrieval;
- durable full session entries, not only active post-compaction context, prove incorporation;
- incorporated-but-unrecorded delivery replays as delivery acknowledgment without reinsertion;
- cursor remains before failed/busy/unknown visible events;
- known internal legacy events are ignored safely, while unknown events fail closed;
- role renders on assignments;
- metadata is absent from model prompt text;
- `onCompletePrompt` appears only on parent terminal delivery;
- receiver question and terminal completion preserve current turn behavior.

Implement one per-session single-flight refresh gate in the extension. Use full durable session entries for structural insertion evidence while preserving current context construction for model delivery. Make only test-required rendering changes.

## 4. Replace bulk acknowledgment with explicit task acknowledgment

Add `agent_task_ack({ taskId })` as the only Pi parent-acceptance tool. It calls the existing gateway acknowledgment route and reports that task's structured outcome.

Make `agent_task_inbox` read-only and remove its boolean bulk-ack behavior. Tests must prove:

- inbox inspection acknowledges nothing;
- acknowledging one terminal task leaves unrelated terminal tasks untouched;
- non-terminal/unauthorized failures remain structured;
- partial/batch ambiguity is impossible because one invocation names one task;
- the delegation skill requires independent verification before this tool.

Update Pi README, tool descriptions, and skill. Describe Pi as one conforming adapter and link to Wolfpack's canonical contract. Retain Pi-specific tool, idle-delivery, final-action, verification, and reload guidance; remove duplicated protocol exposition where canonical links suffice.

Do not make Pi invoke a Wolfpack CLI, export a shared SDK, rename the package, or remove other native tools.

## 5. Cross-repository acceptance and independent review

Verify:

1. Wolfpack accepts routable non-Pi targets locally and through isolated peers without claiming adapters are loaded.
2. Wolfpack rejects non-agent targets and filters internal inbox events while retaining complete status history.
3. Wolfpack round-trips every accepted assignment field locally and federated.
4. Pi records delivery only after durable structural insertion and remains race/restart/compaction safe.
5. Pi parent acknowledgment is task-specific.
6. Existing Pi-to-Pi behavior remains unchanged except role rendering and the intentional acknowledgment-tool migration.

Run focused tests, then Wolfpack task domain/store/gateway/control-schema suites, exact timestamp and nine-case federation coverage, full suite/typecheck, Pi focused/full suites/typecheck, schema generation/hash checks, package dry runs, `git diff --check`, and scoped inventories.

Perform sequential delivery/architecture, security, and quality/test-value reviews. Fix verified findings one at a time with regression tests and correction re-review.

## Expected file inventory

Wolfpack:

- `src/tasks/gateway.ts`
- `src/tasks/domain.ts`
- `src/control-api/schema.ts`
- `docs/generated/control-api.schema.json`
- `tests/unit/__snapshots__/control-api-schema.test.ts.snap`
- `tests/integration/task-gateway.test.ts`
- `tests/unit/task-domain.test.ts`
- `tests/unit/task-control-api-contract.test.ts`
- `docs/task-adapter-contract.md` (new)
- `docs/task-gateway.md`
- `docs/agent-skills.md`
- `README.md`
- focused docs test only where structural shipping/link coverage is needed

Pi Tasks:

- `src/task-inbox.ts`
- `src/extension.ts`
- `tests/task-inbox.test.ts`
- `tests/extension.test.ts`
- `README.md`
- `skills/wolfpack-pi-task-delegation/SKILL.md`
- `tests/package.test.ts`

Inventory remains subject to test-confirmed necessity.

## Worktree exclusions

- Keep `/Users/home/Dev/wolfpack-task-gateway` untouched with its onboarding changes. Wolfpack work occurs only in `/Users/home/Dev/wolfpack-task-adapter-contract`.
- Preserve Pi `.edc/`, plans 005/007/009/012, unrelated untracked `docs/`, and superseded plan 014 except its status ledger.

## Non-goals

- Claude/Codex adapter implementation or packaging;
- task CLI, MCP server, or alternate runtime path;
- moving canonical state or transitions into adapters;
- runtime adapter registration, heartbeat, or leases;
- gateway-driven wakeup or terminal prompt injection;
- queues/workers, offline dispatch, hidden retries, JWT federation, transcript transfer, or artifact bytes;
- shared SDK extraction before a second adapter proves common code;
- changing trust, retention, task timeout, federation retry, or artifact semantics;
- version bump, publication, commit, push, merge, deployment, or live dispatch.
