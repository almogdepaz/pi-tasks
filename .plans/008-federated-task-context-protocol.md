# federated task context protocol implementation plan

this plan replaces the shared-project `.pi/tasks` model with a Wolfpack-owned task gateway that works identically for same-machine and cross-machine Pi sessions. it covers both repositories top to bottom:

- `/Users/home/Dev/wolfpack`
- `/Users/home/Dev/wolfpack-pi-tasks`

implementation must not begin until this plan is approved, its sha-256 digest is recorded in the companion status ledger, and the goal-lock gate passes.

## locked goal

A parent Pi session can delegate a bounded task to an existing or newly spawned Pi session without copying its transcript. Wolfpack durably routes task events; Pi injects curated task context and messages; the parent remains authoritative and verifies returned claims before reporting completion.

success means:

- same-machine and cross-machine delegation use one protocol and one machine-global Wolfpack store
- `agent_task_send` waits only for durable receiver-gateway receipt, never task execution
- assignments carry opaque task instructions, optional Markdown context, and selected file refs rather than parent history
- clarification and information messages are durable, replayable task events
- terminal state is structured and independent of terminal prose
- sender-owned event order, deduplication, timeout, cancellation, and acknowledgment are deterministic
- the receiver can return structured results and machine-qualified artifact-path metadata
- parent verifies files, diffs, tests, artifacts, or an independent reviewer before making claims
- phase 1 same-machine behavior is freshly verified before federation work starts

## source of truth and ownership

- each Wolfpack server owns the task gateway and machine-global store at `~/.wolfpack/tasks/`
- the sender Wolfpack gateway owns the canonical task ledger, validates transitions/caller identity, deduplicates event IDs, and assigns canonical per-task sequence numbers
- a receiver Wolfpack gateway owns a durable inbox replica and outbox ledger; receiver events become canonical only after sender acceptance
- `event.delivery_failed` and attempt records are local transport diagnostics and never mutate the other machine's task state
- Pi extensions are gateway clients; they do not own task truth
- the Wolfpack control API schema is the canonical HTTP contract; the Pi client validates all responses defensively against that contract
- task spawning remains outside this protocol and continues through existing Wolfpack session-control CLI/skills
- cleanup of parent-spawned sessions remains parent-owned and occurs only after result verification

## locked protocol behavior

### trust boundary

v1 adds no task capability token, inter-session authorization, or peer JWT distribution. it assumes trusted machines and trusted processes with access to Wolfpack endpoints. caller/target session matching prevents accidental mutation but is not a security credential.

cross-machine v1 assumes Wolfpack JWT is unset. existing Wolfpack global authentication behavior is not bypassed: if JWT is configured, unsupported peer delivery must fail clearly rather than silently weakening authentication. JWT-capable federation is deferred.

remote machine origins must be canonical HTTPS origins within the configured Tailscale namespace. reject credentials, paths, query strings, fragments, unexpected ports, and non-tailnet hosts so model-provided targets cannot become an arbitrary server-side request primitive.

### identity and address

```ts
interface TaskAddress {
  machine: "local" | string; // canonical tailnet HTTPS origin
  sessionId: string;         // stable opaque Wolfpack broker session id
}
```

human-facing names may be resolved by CLI/skill workflows, but persisted assignments pin stable session IDs. the gateway normalizes input `"local"` and remote origins into a durable Wolfpack machine ID plus observed canonical origin; literal `"local"` never enters stored protocol identity. each Wolfpack install persists its machine UUID under `~/.wolfpack/`, and `/api/info` exposes it for peer resolution.

local Pi requests supply the current `WOLFPACK_SESSION_NAME`; the gateway resolves that selector through authoritative active-session identity and uses the resulting stable broker ID for every caller check. this supports already-running sessions without pretending the Pi process already knows its broker ID. new session-ID environment propagation may be added only if it can be sourced authoritatively; it is not required by v1.

v1 binds to the Wolfpack session only. a restarted Pi process in the same PTY may inherit active work. Pi runtime instance registration, capabilities, heartbeat leases, and exact-runtime binding are deferred technical debt.

### send input

```ts
agent_task_send({
  to: TaskAddress,
  task: string,
  context?: {
    summary?: string,
    refs?: ContextRef[]
  },
  role?: string,
  preflight?: {
    requiredProject?: string
  },
  metadata?: {
    phaseId?: string,
    issueId?: string,
    verificationTier?: string,
    rootCause?: string
  },
  onCompletePrompt?: string,
  timeoutMs?: number,
  idempotencyKey?: string
})
```

`task` is opaque prose for the receiver. semantic model instructions remain Markdown/prose rather than a typed intent or completion-contract object. remove superseded `mustReturn`, typed semantic intent, `requiredModel`, `requireIdle`, `requireReachable`, and truth-claim validation.

### curated context

```ts
interface ContextRef {
  path: string;
  selector?: string;
  purpose?: string;
}
```

- context is optional and included only when it saves receiver investigation
- the parent authors normal delegation summaries from its already-loaded understanding
- a separate summary skill is for recovery/reuse; automated session recovery and summary caching are deferred
- relative refs resolve inside the receiver project root
- absolute refs are accepted only for same-machine tasks and only when their real path remains inside the resolved parent project root or receiver project root
- remote assignments with absolute refs are rejected
- no `required` flag exists; missing refs produce warnings, and the receiver asks a clarification question when blocked
- gateway path checks must prevent traversal and symlink escape
- automatic file-candidate extraction is skill guidance; the parent selects final refs

Markdown summaries use any non-empty subset of:

```md
## constraints and preferences
## progress
### done
### in progress
### blocked
## key decisions
## critical context
## failed approaches
## open questions
```

goal/task instructions and refs remain separate fields.

initial limits:

- task instructions: 16 KiB UTF-8
- Markdown context summary: 16 KiB UTF-8
- combined assignment envelope: 48 KiB UTF-8
- Wolfpack HTTP request body: 64 KiB

oversized input is rejected before persistence. production constants must carry a concise comment that these are initial limits requiring representative benchmarking before adjustment. the benchmark itself remains tracked debt, not an unbounded implementation detour.

### events and states

all task history is append-only. the original assignment, target, context, deadline, and assignment hash are immutable. corrections and added context are message events.

minimum ledger record/event types:

```text
task.created
task.received
task.receipt_confirmed
task.delivered
task.question
task.answer
task.information
message.delivered
task.cancel_requested
task.completed
task.failed
task.cancelled
task.timed_out
task.parent_ack_pending
task.parent_acknowledged
event.delivery_failed
task.late_terminal
```

current state is derived from ordered events:

```text
pending_delivery
received
active
waiting_for_parent
waiting_for_receiver
cancel_requested
completed
failed
cancelled
timed_out
```

there is no `running` claim and no `rejected` state. receiver rejection is a failure.

`task.received` means the receiver gateway durably stored the assignment after resolving an existing, live Wolfpack Pi session. it does not prove a Pi runtime received or understood it.

`task.delivered` means the receiver Pi extension successfully injected the assignment into its session while idle. it does not prove reasoning started.

### IDs, ordering, and deduplication

- task and source event IDs use UUIDv7
- the creating gateway assigns each event ID once; network retries retain it
- sender acceptance atomically validates/deduplicates the event and assigns its canonical per-task sequence number
- each gateway also assigns an increasing machine-local delivery sequence in the accepted log record; inbox cursors use this local sequence and are not task state
- duplicate assignment ID plus identical immutable-assignment hash returns the existing receipt
- duplicate assignment ID with different immutable content returns HTTP `409`
- duplicate event IDs return the prior acknowledgment without appending again
- HTTP success bodies include the acknowledged event ID; no separate network `task.ack` request is required
- parent inbox acknowledgment remains a distinct task event

### delivery and retries

same-machine delivery follows the same gateway path without a peer HTTP hop.

initial remote assignment delivery uses a response-loss-safe provisional handshake:

1. sender commits `task.created`, then makes one bounded `peer/receive` attempt.
2. receiver durably stores a provisional replica keyed by sender machine, task ID, and assignment hash; it returns a receiver-generated `receiptId` but does not expose the assignment to Pi.
3. sender appends and fsyncs canonical `task.received` containing that receipt ID. only then may `agent_task_send` return receipt to the parent.
4. sender delivers a `task.receipt_confirmed` control event containing receipt ID, canonical received-event ID/sequence, and assignment hash under the subsequent-event retry policy.
5. receiver commits that confirmation before making the assignment eligible for Pi inbox delivery.

if the initial response is lost after provisional persistence, sender records terminal `failed`; the unconfirmed receiver replica never reaches Pi and is purged at the earlier of task expiry or ten minutes. duplicate provisional receives with matching identity/hash return the same receipt; conflicts return `409`. if confirmation delivery exhausts retries, sender retains canonical `received`, records local delivery failure, and eventually follows ordinary timeout semantics; receiver still never injects without confirmation.

subsequent remote events use an initial attempt plus three retries at approximately 1, 2, and 4 seconds with jitter. after exhaustion:

- originating gateway appends `event.delivery_failed`
- no active retry continues
- only the sender may mutate authoritative task status
- receiver-side delivery failure cannot manufacture a matching sender terminal state
- failures are exposed through the relevant Pi tool or inbox

remote parent acknowledgment is a bounded two-phase cleanup operation, not an eventually retried background event:

1. sender records `task.parent_ack_pending` with a stable ack event ID but does not mark the task acknowledged.
2. sender delivers that event using the initial-plus-three policy.
3. receiver durably records cleanup acknowledgment and idempotently returns the same ack event ID.
4. sender then appends canonical `task.parent_acknowledged`; both replicas start their ten-day retention clocks from their respective durable acknowledgment.

if delivery or its response exhausts retries, the parent ack tool returns `delivery_failed`, the sender task remains unacknowledged/visible, and neither replica is cleanup-eligible. a later explicit inbox-ack call reuses the pending ack event ID and can repair response loss idempotently; there is no automatic retry beyond the chosen limit.

### Pi polling, replay, and context incorporation

receiver and parent Pi extensions poll their local gateway every five seconds. assignment delivery waits until `ctx.isIdle()` and there are no pending messages; it never interrupts unrelated work.

injected assignment/message prompts include task and event IDs. assignment/message injection uses Pi `sendMessage` with a dedicated custom type and structured `{ taskId, eventId }` details, `triggerTurn: true`, and visible Markdown content. custom messages participate in model context and leave a structured session entry.

on resume, the extension reconstructs incorporated IDs from those entries instead of parsing message prose, fetches the active task snapshot, and injects only missing events. it advances its persisted inbox cursor only after every preceding event is structurally present or successfully inserted. this closes the ordinary crash window between injection and gateway acknowledgment: an existing structured entry is acknowledged, not reinjected. a new Pi session inside the same Wolfpack PTY has no prior entries and therefore receives the complete active assignment/message history, matching v1 session-level inheritance.

successful injection produces a delivery event referencing the injected event ID. gateway delivery is at-least-once, while session insertion is deduplicated by the structured event ID. a storage-level crash during Pi's own session append remains an upstream durability boundary and must not be described as exactly-once semantic handling. durable refs and parent verification remain the evidence path.

### clarification and information

```ts
agent_task_message({
  taskId: string,
  type: "question" | "answer" | "information",
  message: string,
  replyToMessageId?: string
})
```

- all three message types are bidirectional
- only one unresolved question globally per task is allowed
- answers must reference that open question event; any other reply target returns a conflict
- sender acceptance of the question event is the acknowledgment that changes canonical waiting state
- a receiver question accepted by the sender moves to `waiting_for_parent` and terminates the receiver turn
- if receiver-question delivery exhausts retries, the tool returns `delivery_failed` without terminating so the receiver can fail cleanly
- a parent question moves to `waiting_for_receiver`, wakes the receiver when idle, and does not terminate the parent turn
- sender acceptance of a valid answer closes the open question and returns the task to `active`; peer delivery remains separately observable and may still fail
- information wakes the destination when idle, changes no task state, and remains in task history
- ordinary progress streaming is not part of v1

### completion, timeout, and cancellation

`agent_task_done` accepts `completed`, `failed`, or `cancelled`, plus a bounded summary, optional arbitrary structured result, optional error, and optional artifacts. it does not pretend to validate model truthfulness. sender-generated `timed_out` is not a receiver completion option.

status/inbox responses preserve the bounded structured result, message history, warnings, and artifact metadata; they must not collapse completion back to summary-only output. Markdown summary content is presentation, never parsed machine state.

first terminal event accepted by the sender wins:

- cancellation before remote receipt becomes immediately `cancelled`
- cancellation after receipt becomes `cancel_requested`
- receiver may acknowledge cancellation with terminal `cancelled`
- completion arriving before cancellation wins
- sender alone evaluates absolute `expiresAt`
- timeout triggers best-effort remote cancellation
- sender restart immediately expires overdue nonterminal tasks
- late terminal events are retained diagnostically and never replace terminal state

### result and artifact metadata

result shape remains deliberately permissive:

```ts
interface TaskResultInput {
  summary: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
  artifacts?: ArtifactInput[];
}

interface ArtifactInput {
  path: string; // receiver-project-relative
  mimeType?: string;
  description?: string;
}

interface StoredArtifactRef {
  machine: string; // gateway-derived stable machine identity/origin
  project: string; // gateway-derived receiver project basename
  path: string;    // gateway-normalized project-relative path
  mimeType?: string;
  description?: string;
  sizeBytes?: number;
  modifiedAt?: string;
}
```

v1 transfers no artifact bytes. Pi supplies only project-relative artifact path/MIME/description input; it cannot claim machine or project provenance. receiver gateway derives stored machine/project identity and validates up to 20 declared refs at completion:

- regular files only
- normalized real path must remain inside the authoritative receiver project root
- symlinks and directories are rejected
- missing/invalid refs produce warnings without erasing an otherwise valid terminal result

machine-qualified paths may require remote inspection, a remote reviewer, or git-based transfer. artifact snapshot/pull transfer, hashes, download states, and retention are deferred.

### HTTP contract

Wolfpack's generated control API schema is canonical. v1 uses fixed routes so the existing exact route dispatcher needs no ad hoc path parser.

local Pi client routes:

```text
POST /api/tasks/v1/send
GET  /api/tasks/v1/status?taskId=...&callerSession=...
GET  /api/tasks/v1/inbox?callerSession=...&cursor=...&includeAcknowledged=...
POST /api/tasks/v1/message
POST /api/tasks/v1/complete
POST /api/tasks/v1/cancel
POST /api/tasks/v1/delivered
POST /api/tasks/v1/ack
```

peer gateway routes:

```text
POST /api/tasks/v1/peer/receive
POST /api/tasks/v1/peer/event
```

all POST routes require `application/json`. local mutation bodies carry `callerSession`; the gateway resolves it to a stable ID before validation. peer envelopes carry immutable source/destination machine and session identities, task/event IDs, assignment hash where applicable, and bounded payloads.

success uses `{ "ok": true, ... }`. failure uses:

```ts
interface TaskApiErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
```

stable v1 codes cover invalid request/content type, payload too large, caller/target/task not found, target dead/non-Pi, project mismatch, caller mismatch, immutable-content conflict, invalid transition/reply, open-question conflict, peer unreachable/auth unsupported, and store unavailable. map malformed input to `400`, missing records to `404`, immutable/state conflicts to `409`, size violations to `413`, target/preflight failures to `422`, malformed upstream response to `502`, and unavailable store/peer to `503`.

inbox polling is ordered by a gateway-assigned machine-local delivery sequence. `cursor` is the last observed decimal sequence, not a timestamp or remote event sequence. responses return `{ events, nextCursor, hasMore }`, at most 50 events and 256 KiB serialized per page; the client drains pages before advancing its persisted cursor. duplicate delivery acknowledgments are idempotent.

atomic operation boundaries:

- receiver `peer/receive` commits a provisional replica before returning `receiptId`; it does not claim canonical `task.received` or expose inbox delivery
- sender appends canonical `task.received` only after observing that response
- receiver commits `task.receipt_confirmed` before promoting the provisional replica into the Pi-visible inbox
- sender `peer/event` validates identity/transition, deduplicates event ID, assigns canonical task sequence, and commits before acknowledgment
- receiver/local outbound actions commit an outbox record before network delivery
- remote parent acknowledgment does not become canonical or cleanup-eligible until the receiver's durable ack response is observed
- local task actions commit their event before returning
- interrupted initial sender dispatch is reconciled to terminal `failed` on startup; v1 never silently resumes it

### durable storage and retention

Wolfpack stores tasks under `~/.wolfpack/tasks/`, with a test-only/configurable root. each sender ledger or receiver replica has one authoritative append-only JSONL log. its first record carries the immutable assignment and canonical hash; all task state, outbox attempts, acknowledgments, diagnostics, and cleanup eligibility derive from appended records. an atomically replaced materialized-state/index cache may accelerate reads but is never authoritative.

requirements:

- serialize mutation per task and machine-local delivery-sequence allocation inside the single Wolfpack server process
- canonicalize immutable assignment JSON by a specified stable key ordering and UTF-8 encoding before SHA-256 hashing
- scope caller idempotency keys to the resolved parent machine/session and require the same assignment hash on reuse
- append and `fsync` authoritative records before acknowledging them; receipt means that durable append completed
- write each state transition as one authoritative log append; rebuildable caches/indexes must not create multi-file transaction requirements
- tolerate and preserve evidence for a crash-truncated final line
- quarantine midstream malformed/corrupt task records rather than silently accepting or deleting them
- rebuild derived state and the in-memory inbox index from logs on startup
- retain unresolved and unacknowledged tasks without eviction; expose count/byte observability and document the disk-growth risk
- delete terminal task payloads ten days after completed two-phase parent acknowledgment
- retain compact task-ID/assignment-hash tombstones for a further ten days so delayed duplicate receive calls cannot resurrect cleaned tasks
- failed parent-ack propagation leaves both copies unacknowledged; an explicit later ack reuses the same event ID as the only repair path
- cleanup must never delete outside the configured task root

## explicit non-goals and deferred debt

v1 does not implement:

- full transcript or automatic branch-history transfer
- `/tree` lineage as a task requirement
- mandatory scouting or separate summarization on every delegation
- Pi runtime registration, heartbeats, capabilities, or exact-instance binding
- durable offline initial assignment delivery
- more than three retries for subsequent events
- JWT/authenticated peer federation or capability tokens
- artifact byte transfer or snapshot retention
- automated session recovery summarization
- summary caching before measured repeated-generation waste
- automatic ref attachment by the gateway
- model-start or semantic-understanding detection
- ordinary progress streaming
- compatibility with the old `.pi/tasks` filesystem store, terminal assignment transport, `ContextPackageV1`, `mustReturn`, or `rejected` terminal status

tracked follow-up measurements:

- benchmark representative task/context payloads before changing size limits
- measure whether repeated summary generation justifies caching
- measure offline-dispatch failures before designing a durable sender outbox

cutover is explicit rather than compatible:

- drain or cancel active legacy `.pi/tasks` before enabling the gateway client
- do not import active legacy records because they lack deterministic machine/stable-session identities
- leave old task directories untouched as read-only historical data unless the user separately requests removal
- update or retire metrics/board code that assumes the old layout; do not let it mutate legacy files after cutover

## execution discipline

- use test-driven development for every behavior change
- use focused implementer and independent reviewer subagents; every newly opened agent must be switched to `openai-codex/gpt-5.6-terra` before receiving work, and the parent checks plan digest before every dispatch
- status, task IDs, review findings, corrections, and verification evidence belong only in the companion status ledger
- do not edit this plan after approval
- do not commit or merge unless the user explicitly requests it
- before Wolfpack work, preserve the dirty existing checkout and create a clean worktree from updated `main`:

```bash
git -C /Users/home/Dev/wolfpack fetch origin main:main
git -C /Users/home/Dev/wolfpack worktree add --detach /Users/home/Dev/wolfpack-task-gateway main
cd /Users/home/Dev/wolfpack-task-gateway
git checkout -b feat/federated-task-gateway main
```

## 1. Implement Wolfpack task protocol and durable local store

Goal contribution: establish the single machine-global source of truth required to remove shared-project split-brain.

### 1a. Lock the domain and HTTP contract with failing tests

- add the locked route, request, response, cursor, error, task/event/address/message/result schemas to Wolfpack’s control API source
- cover strict field bounds, stable JSON hashing, UUIDv7 IDs, sender sequence assignment, machine-local delivery sequences, scoped idempotency, reply linkage, and terminal first-wins behavior
- cover the derived state reducer and transition table, including both waiting directions, global one-question scope, cancellation races, timeout, late terminals, local delivery diagnostics, and receiver outbox acceptance
- generate and verify the documented control API schema through the existing schema workflow

### 1b. Build the append-only task store

- implement machine-global task paths with test-root injection
- persist one authoritative append-only ledger per sender task or receiver replica, with assignment/hash in the first record and rebuildable state/index caches
- add per-task mutation serialization, delivery-sequence allocation, atomic cache replacement, append-plus-fsync-before-ack, restart rebuild, idempotent append, conflict detection, tombstones, and corruption quarantine
- implement explicit sender canonical-ledger and receiver inbox/outbox roles without creating separate task state machines

### 1c. Implement lifecycle retention and recovery

- expire overdue sender-owned tasks on access/startup and produce best-effort cancellation events
- retain unresolved/unacknowledged tasks and remove acknowledged terminal tasks after ten days
- make cleanup containment testable and safe against traversal/symlinks
- cover crash-truncated tails, midstream corruption, restart, duplicate events, and acknowledgment propagation

## 2. Expose and verify the same-machine Wolfpack gateway

Goal contribution: prove the new source of truth locally before adding federation.

### 2a. Add versioned local task routes

- expose only the locked local Pi-client `/api/tasks/v1/*` routes compatible with Wolfpack’s existing route dispatcher; phase 1 may define/test peer schemas but must not register peer routes or perform peer HTTP
- enforce the locked content type, body bounds, success/error envelopes, inbox cursor/page bounds, and local commit-before-ack boundaries
- support same-machine send/receive, status, inbox, message, completion, cancellation, parent acknowledgment, and Pi delivery acknowledgment
- return bounded structured errors and acknowledged event IDs
- apply existing global API authentication behavior without adding task-specific bypasses

### 2b. Resolve sessions, projects, refs, and artifacts

- resolve local caller and target selectors through authoritative active-session identity at the edge, then pin stable broker session IDs; do not require unavailable self-ID environment state
- normalize `local`/remote origins into durable machine IDs and reject unsafe peer origins
- require target session existence, live terminal, and Pi harness
- enforce optional receiver project-basename preflight
- validate context-ref and artifact containment against the target session project root
- return missing context refs and invalid artifacts as structured warnings under the locked rules

### 2c. Complete same-machine lifecycle behavior

- route local assignments through durable receive without PTY text delivery
- support sender-authoritative canonical event sequencing and caller session matching
- implement one-open-question messaging, delivery events, cancellation, timeout, terminal first-wins, and parent acknowledgment
- prove no task operation depends on terminal prose or `.pi/tasks`

## 3. Replace Pi filesystem/terminal communication with the gateway client

Goal contribution: give Pi sessions token-efficient context handoff, automatic delivery, clarification, and structured results over the new local gateway.

### 3a. Build a bounded Wolfpack task client and session resolver

- send the current Wolfpack session name from environment and let the local gateway resolve its stable ID from structured session status, supporting already-running sessions without inventing process identity
- call the local gateway with strict request/response parsing, cancellation signals, bounded timeouts, and useful errors
- replace the default filesystem store plus `wolfpack session send` transport; remove now-unreachable compatibility code/tests/docs rather than retaining two protocols

### 3b. Redesign tools and assignment rendering

- implement the locked `agent_task_send` schema with structured address, optional Markdown context, selected refs, enforceable preflight, role/metadata, timeout, idempotency, and parent completion prompt
- add `agent_task_message` with bidirectional question/answer/information behavior and explicit reply IDs
- adapt status, wait, inbox, cancel, and done tools to gateway actions and new states
- render compact Markdown assignments/events without typed semantic contracts, transcript dumps, or duplicate file content
- reject size-limit violations before calling Wolfpack and include the requested benchmark comment beside constants

### 3c. Implement idle polling, injection, and replay

- poll every five seconds for assignment/message/result events addressed to the current session
- inject assignments and messages only at idle/no-pending-message boundaries using structured Pi custom messages that participate in model context
- persist `{ taskId, eventId }` in custom-message details and reconstruct incorporated IDs structurally on session start/resume; never regex human prose
- replay only missing events for the same Pi session and the complete active stream for a new Pi session in the same Wolfpack PTY
- acknowledge an already-present structured entry after a crash instead of reinjecting it
- record delivery only after successful insertion; document at-least-once gateway delivery and never label model work as running

### 3d. Add the context-summary and delegation skills

- create a package-owned `task-context-summary` skill using the locked Pi-style Markdown headings
- state that the parent authors normal summaries and the skill is for recovery/reuse
- update `wolfpack-pi-task-delegation` to reference that skill, select refs explicitly, use the gateway address, use clarification events, and preserve parent verification/cleanup ownership
- remove shared-filesystem and terminal-output guidance that becomes false

## 4. Pass the phase 1 same-machine verification gate

Goal contribution: prevent federation from hiding defects in context semantics or local lifecycle behavior.

### 4a. Run automated local verification

fresh evidence must cover:

- assignment bounds, Markdown rendering, optional context, ref warnings, and absolute-local refs contained under authoritative parent/receiver project roots
- same-machine durable receipt, idle custom-message delivery, structured event-ID deduplication, post-insertion/pre-ack crash recovery, and restart replay
- questions in both directions, explicit replies, information incorporation, and one-open-question enforcement
- completion, failure, cancellation races, timeout, late terminal diagnostics, local parent acknowledgment, gateway-derived artifact provenance, and ten-day retention
- duplicate task/event handling and immutable-assignment conflicts
- no `.pi/tasks` or PTY assignment dependency in the default path
- complete `bun test` and typecheck suites in both repositories

### 4b. Perform parent-owned behavioral verification

- run a real same-machine parent/receiver Pi delegation with a curated summary and selected refs
- verify the receiver result using cited files/diff/tests rather than trusting prose
- resume/restart a receiver session and demonstrate missing-event replay without duplicate injection
- record commands, outputs, changed files, residual risks, and reviewer verdict in the status ledger

**hard stop:** federation tasks 5–7 may not start until the parent has fresh phase 1 evidence, an independent reviewer accepts the local implementation, the status ledger marks the gate accepted, and the user explicitly approves proceeding through the gate.

## 5. Add direct Wolfpack peer federation

Goal contribution: extend the already-verified gateway across trusted tailnet machines without changing Pi semantics.

### 5a. Add constrained peer addressing and receive routes

- normalize and validate canonical tailnet HTTPS origins without allowing arbitrary outbound URLs
- register the previously specified peer assignment/event endpoints under `/api/tasks/v1/*` only after the phase 1 gate
- implement provisional receiver persistence and sender-confirmed receipt before enabling Pi delivery
- return idempotent acknowledgments and `409` immutable-assignment conflicts
- fail clearly when peer JWT configuration makes v1 credential-free federation unsupported

### 5b. Implement synchronous assignment delivery

- perform exactly one bounded remote assignment attempt
- make `agent_task_send` return only after receiver receipt or sender-terminal failure
- preserve same-machine behavior through the same domain service without an HTTP loopback
- test DNS/network failure, invalid target, dead/non-Pi session, project mismatch, malformed response, duplicate send, conflict, initial-response loss after provisional persistence, orphan expiry, and confirmation exhaustion

### 5c. Implement subsequent event delivery and failure handling

- deliver receipt confirmation, messages, terminal updates, cancellation, delivery notices, and two-phase parent acknowledgment with original event IDs
- retry after approximately 1, 2, and 4 seconds with jitter, then append `event.delivery_failed` and stop
- accept HTTP acknowledgment bodies as network ack
- keep sender authority under receiver outage, retry exhaustion, timeout, restart, and concurrent terminal events
- retain late or undeliverable evidence without manufacturing cross-machine agreement

## 6. Verify end-to-end federation and recovery

Goal contribution: demonstrate that remote behavior preserves the phase 1 contracts and failure semantics.

### 6a. Add deterministic two-server integration coverage

- run isolated Wolfpack servers with separate task roots, session fixtures, ports, and machine identities
- cover provisional receipt/confirmation/result round trip, canonical sequencing, duplicate requests, response loss, orphan cleanup, three-retry exhaustion, restart recovery, timeout/cancel races, message reply flow, failed/repaired two-phase parent acknowledgment, and cleanup eligibility
- prove remote absolute refs are rejected and machine-qualified artifact metadata remains paths-only

### 6b. Run cross-repository and real-tailnet checks

- run full Wolfpack and Pi Tasks test/typecheck suites after integration
- perform a real cross-machine delegation when two test peers are available
- verify the parent receives and independently checks the result
- verify unreachable initial send fails immediately and later event exhaustion is surfaced
- if a real two-peer environment is unavailable, record that exact untested area and risk instead of claiming cross-machine completion

## 7. Finish documentation, review, and handoff

Goal contribution: leave one accurate operational model and explicit debt rather than stale parallel protocols.

### 7a. Update canonical documentation

- document gateway ownership, routes, trust assumptions, storage/retention, target addressing, retry limits, and unsupported JWT federation in Wolfpack
- update Pi Tasks README/tool examples for curated context, message flow, gateway requirements, parent verification, and session cleanup
- regenerate committed control API artifacts through repository scripts
- list deferred runtime registration, offline dispatch, JWT, artifact transfer, benchmark, and cache work in the status ledger/docs rather than production TODOs, except the explicitly requested benchmark comment beside size constants

### 7b. Conduct independent delivery and security reviews

- review requirement coverage against this immutable plan
- review tailnet origin validation, path containment, HTTP bounds, caller-session matching, corruption handling, and SSRF/file-disclosure risks
- fix findings one at a time through the status-ledger correction flow
- rerun focused tests after each fix and both full suites before acceptance

### 7c. Final parent verification and cleanup

- inspect both repository diffs and all subagent claims
- confirm the plan digest still matches
- record final test evidence, manual gaps, deferred debt, and changed-file inventories
- close only parent-spawned sessions whose results are accepted and no longer need correction
- suggest commits for each repository, but do not commit, push, or merge without explicit user instruction
