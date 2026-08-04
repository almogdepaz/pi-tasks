# federated task context protocol status

plan: `.plans/008-federated-task-context-protocol.md`
state: `accepted_publication_pending`
approved_for_implementation: `yes`
plan_digest: `sha256:dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`
approved_at: `2026-08-02`

## current phase

tasks 1-7 are accepted. security and delivery findings were corrected through TDD and independently passed; full verification, inventories, canonical docs, server-only deployment, and live structured smoke pass. only parent-owned session cleanup and the user-authorized commit / `dev_04` merge / push sequence remain.

## locked planning decisions

- Wolfpack owns a machine-global `~/.wolfpack/tasks/` gateway/store.
- same-machine and remote tasks use one protocol; no legacy compatibility requirement.
- targets persist canonical machine origin plus stable Wolfpack session ID.
- v1 binds to Wolfpack sessions, not exact Pi runtime instances.
- no JWT/authenticated federation in v1; trusted tailnet/process boundary is explicit.
- direct peer HTTP carries assignments/events; broker/PTY protocol is untouched.
- Pi polls every five seconds and injects assignments/messages only when idle.
- receiver-gateway receipt and Pi delivery are separate events.
- initial remote send gets one synchronous attempt and fails terminally if unavailable.
- later events get initial attempt plus three retries around 1/2/4 seconds with jitter, then hard local delivery failure.
- sender owns canonical event sequence and terminal state; UUIDv7 IDs deduplicate retries.
- sender alone times out; first accepted terminal event wins; late terminals are diagnostic.
- terminal tasks are retained ten days after parent acknowledgment; unresolved/unacknowledged tasks remain.
- assignments are immutable; added context/corrections are messages.
- relative refs resolve under receiver project; absolute refs are local-only; missing refs warn.
- task and summary are initially limited to 16 KiB each, envelope to 48 KiB, HTTP body to 64 KiB.
- bidirectional question/answer/information uses explicit replies and one unresolved question.
- artifacts are validated, machine-qualified project-relative path metadata only; no transfer.
- parent verifies claims and owns spawned-session cleanup.

## repository/workspace constraints

- `/Users/home/Dev/wolfpack` remains a dirty unrelated worktree on `fix/delegation-grid-scrollback`; do not edit it.
- implementation uses `/Users/home/Dev/wolfpack-task-gateway` on `feat/federated-task-gateway`; it started from `762d997` and was authorizedly fast-forwarded/reapplied onto `origin/main` `0577b596e452b1667057a2bcb0aadca59c33b40e`.
- `/Users/home/Dev/wolfpack-pi-tasks` currently contains untracked planning/review artifacts; do not modify unrelated files.
- the user explicitly authorized commits in both repositories, creation of `dev_04` from updated `main`, merge of accepted feature work into it, and push only after clean task-7 acceptance; unrelated files remain excluded.
- every newly opened implementer/reviewer agent must be switched to `openai-codex/gpt-5.6-terra` before receiving work.

## delegated planning review

state: `accepted_with_corrections`
task_id: `task_24c9de40fada48a789ea0e19c84bf8fd`
target_session: `plan-008-review`
target_session_id: `26b826c4-fd55-4d08-8b6a-1a4bf28c2f58`
verdict: `changes_required`
result_acknowledged: `yes`
session_cleanup: `closed after accepted review`

verified dispositions:

- sender canonical ledger versus receiver inbox/outbox ownership: pinned explicitly.
- exact local/peer routes, envelopes, errors, cursors, page bounds, and commit boundaries: pinned.
- stable caller identity: resolved by the local gateway from `WOLFPACK_SESSION_NAME` through authoritative active-session status; reviewer proposal to inject broker ID into process env was not adopted because the broker assigns it after launch and existing sessions must work.
- injection crash window: replaced prose/user-message dedupe with structured Pi custom messages carrying task/event IDs; gateway delivery remains explicitly at-least-once.
- synchronous initial receipt, preflight replacement, origin validation, context/artifact bounds, question transitions, scoped idempotency, result preservation, migration, and cutover: pinned.
- SQLite recommendation not adopted: accepted design remains append-only JSONL. each mutation is one authoritative append-plus-fsync; materialized caches and inbox indexes are rebuildable, avoiding cross-file transactional truth.
- cleanup now retains compact tombstones for ten additional days and exposes unresolved-store growth.

next: independent final candidate review with a newly opened 5.6 Terra agent.

final_review_state: `accepted_with_corrections`
final_review_task_id: `task_45688b30ff794841bfb3aa2061bd119c`
final_review_target: `plan-008-final-review`
final_review_target_session_id: `64d00ea8-174a-4c32-a6a7-517eddbdd095`
model_setup: `/model openai-codex/gpt-5.6-terra` sent before bootstrap/task assignment
final_review_verdict: `changes_required`
final_review_acknowledged: `yes`
final_review_session_cleanup: `closed after corrections recorded`

final-review dispositions:

- phase 1 now registers local routes only; peer route registration is reserved for post-gate task 5.
- initial remote receipt now uses a provisional receiver record plus sender-confirmed receipt; unconfirmed orphans never reach Pi and expire safely.
- same-machine absolute refs are realpath-contained under authoritative parent/receiver project roots.
- Pi artifact input is project-relative only; receiver gateway derives machine/project provenance.
- remote parent acknowledgment is a bounded two-phase operation. failed propagation keeps both replicas unacknowledged and visible; explicit later ack reuses the same event ID as the repair path without automatic retries.

next: repeat independent final review on the corrected candidate before approval.

approval_gate_review_state: `clean_approval`
approval_gate_review_task_id: `task_9bdbbb799ea84fc99a282896f54db087`
approval_gate_review_target: `plan-008-gate-review`
approval_gate_review_target_session_id: `473984a2-90be-4c99-a8ec-eb5a0a60eb86`
approval_gate_model_setup: `/model openai-codex/gpt-5.6-terra` sent before bootstrap/task assignment
approval_gate_review_acknowledged: `yes`
approval_gate_review_session_cleanup: `closed after accepted verdict`
approval_gate_blocking_findings: `none`
approval_gate_candidate_digest: `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`

## 1. Implement Wolfpack task protocol and durable local store

state: `accepted`
active_subtask: `none`
task_1a_state: `accepted`
implementer_task_id: `task_26b44b0c8ae543b1a488fae857e94a23`
implementer_result: `completed; parent verification found review-sensitive contract edges`
implementer_session: `task-gateway-domain`
implementer_session_id: `448f1ecf-f326-41e2-bc5e-17be35f17eaa`
implementer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
reviewer_task_id: `task_b480cb33792b4077b602166ee8fc3164`
reviewer_session: `task-gateway-domain-review`
reviewer_session_id: `3d342c24-770e-412b-9916-d4d46a9693b7`
reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
review_verdict: `changes_required`
reviewer_session_cleanup: `closed after findings were acknowledged and correction dispatched`
review_findings:
- `1a-f1 blocker`: enforce per-event actor authority and terminal-only two-phase parent acknowledgment ordering
- `1a-f2 blocker`: split unsequenced peer input from canonical events and add discriminated receipt/control payloads
- `1a-f3 blocker`: separate completion input from stored result/artifact/warning output and preserve it in status/inbox contracts
- `1a-f4 blocker`: add malformed-upstream error plus exhaustive HTTP status mapping including 502
- `1a-f5 blocker`: model duplicate assignment task-ID/hash receipt reuse versus conflict independently of idempotency keys
- `1a-f6 important`: distinguish JSON Schema character ceilings from mandatory UTF-8 byte enforcement and test non-ASCII overflow
correction_task_id: `task_ed736f3304204504bd24616a5ac7ffe8`
correction_implementer_session: `task-gateway-domain` (retained)
correction_model: `openai-codex/gpt-5.6-terra`
correction_result: `completed; no commit`
parent_correction_verification:
- approved plan digest reverified
- focused task/schema tests: 33 pass, 0 fail
- typecheck: passed
- full suite: 1469 pass, 22 skipped, 0 fail
- diff check and no-runtime-route gate: passed
parent_re_review_notes:
- independently scrutinize whether event type/actor/payload are truly discriminated and caller identity is verified rather than trusted from input
- independently scrutinize one-shot stable parent-ack pending/acknowledged behavior
- independently verify TypeScript stored completion projections match the generated schema, not only schema declarations
re_reviewer_task_id: `task_94b96583dd36411c89fa3245b0a17602`
re_reviewer_session: `task-gateway-domain-rereview`
re_reviewer_session_id: `9d0de9d3-09c6-467e-bd0e-7bb794bcce1b`
re_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
re_review_verdict: `changes_required`
re_reviewer_session_cleanup: `closed after findings were acknowledged and correction round 2 dispatched`
re_review_closure:
- `1a-f1 open blocker`: sender authority is forgeable from event fields; parent ack pending/acknowledged can repeat
- `1a-f2 open blocker`: event type/actor/payload are independent bags; peer envelope/event coherence is absent
- `1a-f3 open blocker`: stored completion projection is schema-only and not preserved by TypeScript domain/state/inbox contracts
- `1a-f4 closed`: malformed upstream error and 502 mapping
- `1a-f5 partial blocker`: duplicate receipt identity omits verified sender machine/address
- `1a-f6 closed`: UTF-8 byte enforcement contract
- `1a-f7 important`: canonical hashing throws on realistic optional undefined assignment fields
correction_round_2_task_id: `task_f8f0785fa4bd4f2ea7d33900301d43e6`
correction_round_2_implementer_session: `task-gateway-domain` (retained)
correction_round_2_model: `openai-codex/gpt-5.6-terra`
correction_round_2_result: `completed; no commit`
parent_round_2_verification:
- plan digest reverified
- focused task/schema tests: 33 pass, 0 fail
- typecheck: passed
- full suite: 1469 pass, 22 skipped, 0 fail
- diff check and no-runtime-route gate: passed
parent_round_2_re_review_notes:
- verify untrusted completion input cannot carry `StoredTaskCompletion` provenance in TypeScript while schema uses `TaskCompletionInput`
- verify control-event TypeScript and canonical-output schemas are discriminated as strictly as peer input
- verify late-terminal canonical actor/source identity is coherent when original principal is the receiver
- verify duplicate detection occurs only after authority validation
- verify receiver replica identity uses sender machine plus task ID rather than accidentally allowing same-machine/session variants
round_2_reviewer_task_id: `task_0e344ed3eef2413185bb55f4316d54f1`
round_2_reviewer_session: `task-gateway-domain-rereview-2`
round_2_reviewer_session_id: `0dcf5dd8-9c01-4c9f-96f1-5dbedb64e885`
round_2_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
round_2_re_review_verdict: `changes_required`
round_2_reviewer_session_cleanup: `closed after findings were acknowledged and correction round 3 dispatched`
round_2_re_review_closure:
- `1a-f1 open blocker`: duplicate acknowledgment precedes authorization and sender identity is not bound
- `1a-f2 open blocker`: TS control events and canonical schema remain broad; late-terminal source contradicts sender actor
- `1a-f3 open blocker`: untrusted TS completion takes stored provenance and cancelled terminal result is dropped/mismatched
- `1a-f4 closed`: malformed upstream 502 contract
- `1a-f5 open blocker`: provisional receipt key incorrectly includes sender session instead of sender machine only
- `1a-f6 closed`: UTF-8 runtime byte contract
- `1a-f7 closed`: absent/undefined canonical hashing
correction_round_3_task_id: `task_f42ff3c4ab264025b1f5a4b1249d0323`
correction_round_3_implementer_session: `task-gateway-domain` (retained)
correction_round_3_model: `openai-codex/gpt-5.6-terra`
correction_round_3_result: `failed retryable; f1/f5 partial changes applied, f2/f3 incomplete`
original_implementer_session_cleanup: `closed after truthful failure and focused model-rewrite handoff`
parent_round_3_inspection:
- focused task/schema tests: 33 pass, 0 fail
- typecheck and diff check: passed
- `f1`: authority now precedes duplicate lookup and bound sender is used when participants exist, but optional/unbound participants remain a bypass to resolve
- `f5`: lookup now uses sender machine plus task ID; same-machine/different-session tests exist
- `f2/f3`: confirmed broad `ControlTaskEvent`, broad canonical schema, stored provenance in untrusted TS input, and `as unknown as` fixture casts remain
model_rewrite_task_id: `task_f9c17be6139b4542b85fd1e06cc7ff6a`
model_rewrite_session: `task-gateway-event-model`
model_rewrite_session_id: `6b4123ed-d6e1-4a3b-a1b4-006a64462427`
model_rewrite_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
model_rewrite_result: `completed; no commit`
parent_model_rewrite_verification:
- approved plan digest reverified
- focused task/schema tests: 34 pass, 0 fail
- typecheck: passed
- full suite: 1470 pass, 22 skipped, 0 fail
- diff check and no-runtime-route gate: passed
parent_model_rewrite_review_notes:
- scrutinize whether caller-supplied `TaskCompletionCanonicalization` may silently replace summary/result/error/path rather than only enrich provenance/warnings
- scrutinize why parent-authored `task.cancelled` is a public input variant when pending parent `task.cancel_requested` already derives immediate cancellation, and whether it permits direct post-receipt cancellation
- reconcile `ACTORS_BY_EVENT_TYPE.task.failed` allowing sender while the TS/schema union permits receiver only
- decide whether sender-generated `task.late_terminal` should be accepted as peer input or remain canonical-only
model_rewrite_reviewer_task_id: `task_c70276069057452ea96ea55e8a63e4d3`
model_rewrite_reviewer_session: `task-gateway-event-model-review`
model_rewrite_reviewer_session_id: `947c76f1-71e5-44a8-b3f2-fc471389c1cd`
model_rewrite_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
model_rewrite_review_verdict: `changes_required`
model_rewrite_reviewer_session_cleanup: `closed after findings were acknowledged and correction round 4 dispatched`
model_rewrite_review_closure:
- `f1 closed`: immutable authority, duplicate ordering, one-shot acknowledgment
- `f2 open blocker`: sender `task.failed` allowance and generated-only `task.late_terminal` contradict TS/schema/runtime input contracts
- `f3 open blocker`: completion canonicalization can replace receiver summary/result/error/path instead of only enriching metadata
- `new cancel blocker`: public parent `task.cancelled` bypasses required post-receipt `cancel_requested`
- `f4-f7 closed`
correction_round_4_task_id: `task_9cb22c00bafa48dc86891ffab1b09bae`
correction_round_4_implementer_session: `task-gateway-event-model` (retained)
correction_round_4_model: `openai-codex/gpt-5.6-terra`
correction_round_4_result: `completed; no commit`
parent_round_4_verification:
- approved plan digest reverified
- focused task/schema tests: 36 pass, 0 fail
- typecheck: passed
- full suite: 1472 pass, 22 skipped, 0 fail
- diff check and no-runtime-route gate: passed
- parent direct inspection confirmed parent `task.cancelled` and peer `task.late_terminal` are absent, sender `task.failed` is present, and stored completion copies summary/result/error from input
final_task_1a_reviewer_task_id: `task_1f1cf2abb65f4640b6a495a5e50c11d5`
final_task_1a_reviewer_session: `task-gateway-domain-final-review`
final_task_1a_reviewer_session_id: `7e3aa2fb-e3dd-4586-8a88-7ac735e3e084`
final_task_1a_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
final_task_1a_review_verdict: `changes_required`
final_task_1a_review_findings:
- reject foreign task IDs before duplicate and late-terminal handling
- enforce bounded, one-to-one, schema-valid stored artifact projections
- restrict late-terminal `originalType` to terminal event types in TypeScript and schemas
correction_round_5_task_id: `task_ab2a1b82e579487ea76cbd4002e9b47a`
correction_round_5_session: `task-gateway-event-model`
correction_round_5_session_id: `6b4123ed-d6e1-4a3b-a1b4-006a64462427`
correction_round_5_model: `openai-codex/gpt-5.6-terra`
correction_round_5_result: `completed; no commit`
parent_round_5_verification:
- approved plan digest reverified
- focused task/schema tests: 44 pass, 0 fail
- typecheck: passed
- full suite: 1480 pass, 22 skipped, 0 fail
- diff check and no-runtime-route gate: passed
- parent inspection confirmed foreign task rejection precedes duplicate/late-terminal; projections enforce max 20, unique input-bound source paths, nonempty provenance/path, nonnegative integer size; late-terminal type/schema are terminal-only
round_5_reviewer_task_id: `task_d8924ba349134ebf835e32901cd9d714`
round_5_reviewer_session: `task-gateway-domain-round5-review`
round_5_reviewer_session_id: `9aba3e9f-a2ff-48b8-81b2-fd8fa40b127b`
round_5_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
round_5_review_verdict: `changes_required`
round_5_review_finding: `standalone TaskEventPayload late_terminal.originalType still references broad TaskEventType`
correction_round_6_task_id: `task_4ff131075ad14321a527c69ec02c4f42`
correction_round_6_session: `task-gateway-event-model`
correction_round_6_model: `openai-codex/gpt-5.6-terra`
correction_round_6_result: `completed; no commit`
parent_round_6_verification:
- focused task/schema tests: 45 pass, 0 fail
- typecheck: passed
- full suite rerun: 1481 pass, 22 skipped, 0 fail
- first full run exposed unrelated randomized VAPID test flake; 100 isolated reruns reproduced 2 failures, confirming baseline probabilistic test defect; task/schema code does not touch push crypto
- diff, generated schema, plan digest, and no-runtime-route gates: passed
round_6_reviewer_task_id: `task_d34231bab2324d70a19b314773d448e5`
round_6_reviewer_session: `task-gateway-domain-round6-review`
round_6_reviewer_session_id: `d47fb24e-f952-4dd9-8c25-f8c3734cdc73`
round_6_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
round_6_review_verdict: `clean_approval`
round_6_review_findings: `none`
task_1a_final_parent_verification:
- focused task/schema tests: 45 pass, 0 fail
- typecheck: passed
- `git diff --check`: passed
task_1a_accepted_at: `2026-08-03`
task_1b_initial_dispatch_task_id: `task_c04691b486224d51a87c5190e88fb549` (preflight rejected because absolute context refs were outside the shared task project; no work assigned)
task_1b_implementer_task_id: `task_9cf8dffee86948119bbf8e5e2d054959`
task_1b_implementer_session: `task-gateway-store-implementation`
task_1b_implementer_session_id: `db393c75-d5e6-448e-ada9-746cedc8303a`
task_1b_implementer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_1b_implementer_result: `completed; no commit`
parent_task_1b_verification:
- focused task/store/schema tests: 56 pass, 0 fail
- typecheck: passed
- full suite: 1492 pass, 22 skipped, 0 fail
- diff, plan digest, and no-runtime-route gates: passed
- direct probe: retrying identical inbox record currently returns STORE_UNAVAILABLE instead of idempotent reuse
parent_task_1b_review_focus:
- file and parent-directory fsync durability before acknowledgment
- non-authoritative cache/index failures must not invalidate a committed append
- durable scoped caller idempotency mappings
- header/participant/completion record validation and quarantine
- exact duplicate inbox retry and global delivery-sequence uniqueness after rebuild
- tombstone/ledger role and immutable-identity conflicts
- multi-store-instance races within one process
task_1b_reviewer_task_id: `task_23da881343ba4a08a23f9a5409953841`
task_1b_reviewer_session: `task-gateway-store-review`
task_1b_reviewer_session_id: `60304800-fb18-4944-8a56-2f22ff392c1f`
task_1b_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_1b_review_verdict: `changes_required`
task_1b_review_blockers:
- committed authoritative appends can return STORE_UNAVAILABLE or be quarantined on derived-cache failure; creation/quarantine directory fsync is missing
- instance-local ledger snapshots corrupt same-root concurrent TaskStore mutations
- durable scoped idempotency is missing and exact inbox retry reallocates sequence/fails
- header, tombstone, participant, and stored-completion validation is shallow/incoherent
- receiver outbox lacks durable outbound intent sufficient for crash recovery
task_1b_correction_round_1_task_id: `task_dc0a21b5d9044e268138622d2a0c7a2a`
task_1b_correction_round_1_model_setup: `/model openai-codex/gpt-5.6-terra` resent before assignment
task_1b_correction_round_1_status: `implemented; no commit`
task_1b_correction_round_1_parent_verification:
- focused store/domain/schema tests: 60 pass, 0 fail
- typecheck, diff, plan digest, and no-runtime-route gates: passed
- real-process restart probe: strict header unknown-field validation and outbox envelope-hash recomputation still fail; forged durable data was accepted
- concurrent cross-task idempotency probe: divergent records for one caller scope both appended
- unit tests labeled restart currently reuse the process-global root coordinator rather than proving disk rebuild
correction_review_task_id: `task_a4e9afaf0c204a96b7476c3f9af36a5a`
correction_reviewer_session: `task-gateway-store-correction-review`
correction_reviewer_session_id: `90534786-5656-4828-b77f-386a7b27f1d1`
correction_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
correction_round_1_full_suite: `1496 pass, 22 skipped, 0 fail`
stale_session_cleanup:
- closed `task-gateway-store-review` (`60304800-fb18-4944-8a56-2f22ff392c1f`)
- retained `task-gateway-store-implementation` because correction work is still pending
- closed `task-gateway-store-correction-review` (`90534786-5656-4828-b77f-386a7b27f1d1`) after result acknowledgment
trusted_local_recalibration:
- retained blockers: concurrent divergent scoped-idempotency commit; instance/shared initialization architecture
- rejected as out-of-model: deliberate durable-data forgery, unknown-field tampering, hostile internal objects, arbitrary competing stores/processes, duplicate-sequence disk fabrication, quarantine destination sabotage
- production contract: one Wolfpack-owned TaskStore singleton per server process
simplification_task_id: `task_4196163db4d94a7f839018e74a110d0b`
simplification_model_setup: `/model openai-codex/gpt-5.6-terra` resent before assignment
simplification_status: `implemented; no commit`
simplification_line_counts: `store 810→788; tests 318→315; total deletion 25 lines`
simplification_parent_verification:
- focused store/domain/schema: 60 pass, 0 fail
- typecheck, diff, plan digest, and no-runtime-route gates: passed
- singleton-only scoped-idempotency regression passes
trusted_final_review_task_id: `task_04f0b7de90284808a81d778b52045c70`
trusted_final_reviewer_session: `task-gateway-store-trusted-review`
trusted_final_reviewer_session_id: `bdef212f-6cd7-4a45-be3c-3c83bc7981bd`
trusted_final_reviewer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
trusted_final_review_verdict: `changes_required; one trusted-local important finding`
trusted_final_review_finding: `fresh recursive store-directory creation does not fsync each new parent link before ledger acknowledgment`
trusted_final_review_verified: `singleton state and concurrent scoped-idempotency fixes clean`
trusted_final_review_safe_deletion: `redundant TaskStoreError cause redeclaration/assignment; 2 lines`
trusted_final_reviewer_cleanup: `closed task-gateway-store-trusted-review after acknowledgment`
directory_durability_fix_task_id: `task_c78637e1b7c047d6bb56b0c465aaad53`
directory_durability_fix_model_setup: `/model openai-codex/gpt-5.6-terra` resent before assignment
directory_durability_fix_status: `implemented; no commit`
task_1b_final_parent_verification:
- focused store/domain/schema: 60 pass, 0 fail
- typecheck, diff, plan digest, and no-runtime-route gates: passed
- full suite: 1496 pass, 22 skipped, 0 fail
- first-root directory parent links fsync bottom-up before ledger file/directory acknowledgment
- trusted-local singleton and scoped idempotency fixes verified by independent review
task_1b_state: `accepted`
task_1b_accepted_at: `2026-08-03`
task_1b_implementer_cleanup: `closed task-gateway-store-implementation after acceptance`
task_1c_state: `implementation dispatched`
task_1c_implementer_task_id: `task_736d22dd7c7943148e841ee6870d35c4`
task_1c_implementer_session: `task-gateway-lifecycle`
task_1c_implementer_session_id: `83fd807b-1163-41b1-a5d9-9d8dcf81cf08`
task_1c_implementer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_1c_implementer_result: `implemented; no commit`
task_1c_changed_scope: `src/tasks/lifecycle.ts; src/tasks/store.ts; tests/unit/task-lifecycle.test.ts`
task_1c_reported_verification: `10 lifecycle tests; full suite 1506 pass, 22 skipped; typecheck/gates pass`
task_1c_parent_inspection:
- lifecycle policy is isolated from store-owned deletion primitives
- expiry, startup interrupted dispatch, 10+10-day retention, receiver cleanup eligibility, partial cleanup retry, and symlink unlink are covered
- concrete correction: production default used UUIDv4 instead of required UUIDv7
- test corrections: symlink target must be outside root; pending-but-unacknowledged sender retention needs explicit coverage
task_1c_parent_correction_task_id: `task_7e78782cec064da4a3ff5534384dac3f`
task_1c_parent_correction_model_setup: `/model openai-codex/gpt-5.6-terra` resent before assignment
task_1c_parent_correction_status: `implemented; no commit`
task_1c_parent_verification:
- focused lifecycle/store/domain/schema: 71 pass, 0 fail
- full suite: 1507 pass, 22 skipped, 0 fail
- typecheck, diff, plan digest, and no-runtime-route gates: passed
- UUIDv7 default, pending-ack retention, and outside-root symlink target regressions verified
task_1c_review_session: `task-gateway-lifecycle-review`
task_1c_review_session_id: `047d3cfb-1817-4b68-bcff-4f5dad762460`
task_1c_review_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_1c_review_task_id: `task_6c9e3ea44f43456f9f20bd0289e8ade7`
task_1c_review_status: `changes requested; one concrete crash-durability blocker`
task_1c_review_finding:
- first tombstone directory's parent link was not fsynced before ledger deletion
- a crash could persist ledger deletion while losing the newly created tombstone directory
- no other blockers reported; focused reviewer tests 49 pass, diff check passed
task_1c_review_cleanup: `closed task-gateway-lifecycle-review after result`
task_1c_tombstone_directory_fix_task_id: `task_13d22bf874f94de2beee0c4e057e2291`
task_1c_tombstone_directory_fix_status: `implemented and parent-verified; no commit`
task_1c_final_parent_verification:
- focused lifecycle/store/domain/schema: 72 pass, 0 fail
- full suite: 1508 pass, 22 skipped, 0 fail
- typecheck, diff, plan digest, and no-runtime-route gates: passed
- first tombstone directory parent link is durable before ledger unlink
task_1c_state: `accepted`
task_1c_accepted_at: `2026-08-03`
task_1c_implementer_cleanup: `closed task-gateway-lifecycle after acceptance`
task_2_state: `2a-2c minimal vertical same-machine implementation dispatched`
task_2_implementer_task_id: `task_db1324657d14457cb04432d5741eb92d`
task_2_implementer_session: `task-gateway-local-routes`
task_2_implementer_session_id: `0437c166-8c32-4118-beb4-826225a2955b`
task_2_implementer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_2_implementer_result: `implemented; no commit`
task_2_changed_scope: `gateway service, machine identity, local route adapter/registration, startup wiring, schema/info, 3 integration tests`
task_2_reported_verification: `full 1511 pass, 22 skipped; typecheck/schema/gates pass`
task_2_parent_initial_verification: `focused 75 pass, 0 fail; typecheck passed`
task_2_parent_inspection:
- implementation is a compact vertical slice and peer routes remain unregistered
- report says 1ms minimum despite instructed 1-second minimum
- only three integration tests cover a materially larger lifecycle surface
- acceptance requires concrete concurrency, ack-order, delivery-dedup, pagination, and restart checks
task_2_review_session: `task-gateway-local-review`
task_2_review_session_id: `6639d5c1-1936-4641-804e-5f5f82a3bf89`
task_2_review_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_2_review_task_id: `task_e3bf7bc5439e47f09b842257a9112b7c`
task_2_review_status: `partially delivered; six concrete corrections required`
task_2_review_verdict: `delivery partially delivered; sender atomic-owner boundary violated`
task_2_review_findings:
- concurrent identical idempotent sends can durably expose two tasks
- canonical transition validation/sequence assignment occurs outside store task lock
- inbox nextCursor skips first count/byte-overflow event
- delivery ack lacks injected-event reference and stable crash retry
- parent ack commits sender canonical success before receiver durable ack and cannot repair crash
- runtime/schema accept 1ms despite locked 1000ms minimum
task_2_review_cleanup: `closed task-gateway-local-review after result`
task_2_correction_task_id: `task_dcc9a7488b2c483f8a40d61f951f76a9`
task_2_correction_status: `worker implemented fixes and reported 1512 pass/22 skip, but lost task id and failed agent_task_done; stale structured task cancelled by parent`
task_2_correction_parent_focus: `76 pass, 0 fail; typecheck/diff passed`
task_2_correction_transport_failure: `parent initially trusted stale dispatched status instead of reading session; corrected after user report`
task_2_correction_gap:
- only concurrent idempotency regression was added; five corrected behaviors lacked direct regressions
- idempotency record still appended after receiver inbox visibility
task_2_regression_followup_task_id: `task_3fd11bd53d7d48249287b2b80d6e281d`
task_2_regression_followup_status: `completed; no commit`
task_2_regression_followup_completion_instruction: `task id sent explicitly; agent_task_done completed correctly`
task_2_regression_followup_changes:
- scoped idempotency persisted after canonical created but before receiver inbox visibility
- direct regressions for concurrent idempotency, 51-event cursor boundary, concurrent cancel/complete, exact delivery retry and payload reference, exact parent-ack retry, and 999/1000ms timeout
- practical 256KiB boundary and crash injection were not added; exact code paths assigned to recheck
task_2_final_parent_verification:
- focused task/store/domain/lifecycle/schema: 78 pass, 0 fail
- full suite: 1514 pass, 22 skipped, 0 fail
- typecheck and diff check: passed
task_2_recheck_session: `task-gateway-local-recheck`
task_2_recheck_session_id: `e1c5c79c-2cba-456a-98e7-6974d6abbd8d`
task_2_recheck_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_2_recheck_task_id: `task_e221409fab5040a79fbe8b5844789832`
task_2_recheck_status: `clean_approval`
task_2_recheck_evidence: `focused 78 pass; typecheck and diff check pass; byte/fault paths source-inspected`
task_2_state: `accepted`
task_2_accepted_at: `2026-08-03`
task_2_session_cleanup: `closed task-gateway-local-routes and task-gateway-local-recheck after acceptance`
task_3_state: `implementation complete; calibrated delivery review active`
task_3_implementer_session: `pi-task-gateway-client`
task_3_implementer_session_id: `93118e80-f077-4836-9d87-ff7a2c3ab784`
task_3_implementer_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_3_implementer_task_id: `task_5401681d46904e219b636fca2724d8f8`
task_3_scope: `bounded HTTP client; gateway-backed tools; structured idle delivery and resume dedupe; context skill/docs; legacy protocol removal`
task_3_implementation_result: `task_5401681d46904e219b636fca2724d8f8 completed; no commit`
task_3_parent_verification:
- focused gateway/client/inbox/extension/package: 13 pass, 0 fail
- full suite: 25 pass, 0 fail
- typecheck and diff check: passed
- immutable plan digest: matched
task_3_metrics_decision: `retain metrics/task-board only as read-only historical .pi/tasks analyzers per plan migration lines 413-416; default runtime has no legacy imports or mutation path`
task_3_review_session: `pi-task-gateway-review`
task_3_review_session_id: `ea45cc11-7709-46bf-84a0-45b3a2d4d34a`
task_3_review_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_3_review_task_id: `task_7fd98029f0ec4b1cbd751076481f75dd`
task_3_review_status: `analysis completed; structured completion cancelled after cutover mismatch; recovered at /tmp/plan-008-task-3-review.json`
task_3_review_cutover_failure: `reviewer spawned after Pi migration loaded gateway-backed agent_task_done, but live Wolfpack server lacks uncommitted task routes; completion returned MALFORMED_RESPONSE while parent still used old filesystem task record`
task_3_review_verdict: `delivery partially delivered; architecture fits with delivery defects`
task_3_review_findings:
- high: fresh Pi process requests only unacknowledged events and misses previously delivered active assignment/message history
- medium: idle state is not rechecked after status await; delivery ack/cursor do not verify structured entry presence
- medium: Pi client omits 48KiB assignment-envelope preflight and required benchmark comment
task_3_parent_additional_finding: `internal receipt/delivery/ack/diagnostic events are injected despite plan limiting model delivery to assignments/messages/results/cancellation`
task_3_review_session_cleanup: `closed after artifact recovery and cancellation of unrecoverable old task record`
task_3_correction_task_id: `task_61c749571de446969e4bfdd9a1416c4d`
task_3_correction_status: `completed; no commit`
task_3_correction_changes:
- fresh session can request acknowledged active history while suppressing parent-acknowledged terminal history
- idle/pending rechecked after status; structural custom-message evidence required before delivery acknowledgment/cursor progress
- 48KiB assignment-envelope client rejection plus required benchmark comment
- internal receipt/delivery/ack/diagnostic events filtered from model context
- focused regressions added for all four paths
task_3_correction_parent_verification:
- focused: 20 pass, 0 fail
- full suite: 32 pass, 0 fail
- typecheck, diff, digest, and legacy-runtime gates: passed
task_3_recheck_session: `pi-task-gateway-recheck`
task_3_recheck_session_id: `71de9366-7a3f-4275-a81e-5e545a83a5cb`
task_3_recheck_model_setup: `/model openai-codex/gpt-5.6-terra` sent before assignment
task_3_recheck_task_id: `task_402c39de72d6452386e294f50cf4a2cb`
task_3_recheck_status: `timed out only because new client could not complete against old live server; fallback artifact found one interrupted-replay blocker and confirmed the other three fixes`
task_3_final_replay_fix_task_id: `task_ec39e8c6c8cd4892b962bb2ae279daac`
task_3_final_replay_fix: `fresh acknowledged replay remains enabled until a cursor entry is persisted; exact two-poll interrupted replay regression added`
task_3_final_parent_verification:
- focused: 21 pass, 0 fail
- full suite: 33 pass, 0 fail
- typecheck, diff, digest, and legacy-runtime gates: passed
task_3_state: `accepted`
task_3_accepted_at: `2026-08-03`
task_3_session_cleanup: `closed pi-task-gateway-client and pi-task-gateway-recheck after acceptance`
task_4_state: `accepted`
task_4_accepted_at: `2026-08-03`
task_4_real_gate:
- clean parent/receiver delegation completed with exactly one clarification round, information decision, structured result, gateway-derived artifact metadata, parent verification, and two-phase acknowledgment
- Pi restart replay injected the queued assignment exactly once and persisted structural `task.delivered` evidence
- cancellation and sender-timeout terminal routing reached only the parent inbox and were acknowledged
- no-duplicate assignment/message injection evidence passed
task_4_real_gate_artifacts:
- `/tmp/wolfpack-plan008-phase1/task-final-evidence-4.json`
- `/tmp/wolfpack-plan008-phase1/runtime-restart-evidence.json`
- `/tmp/wolfpack-plan008-phase1/timeout-route-evidence.json`
- `/tmp/wolfpack-plan008-phase1/cancel-evidence.json`
- `/tmp/wolfpack-plan008-phase1/pi-no-duplicate-evidence.json`
- `/tmp/wolfpack-plan008-phase1/waiting-delivery-recovery-evidence.json`
task_4_final_review_task_id: `task_55d885ab4538406ab33012a80efb97a2`
task_4_final_review_verdict: `changes_required`
task_4_final_review_fixes:
- recover sender-authoritative canonical events into receiver replicas and destination inboxes after post-commit crashes, including received-before-confirmation restart recovery
- treat duplicate declared artifact paths as `INVALID_ARTIFACT` warnings without erasing completed, failed, or cancelled results
- skip receipt-confirmation recovery after lifecycle timeout and propagate the canonical timeout unchanged
task_4_final_rereview_task_id: `task_8404404b3812401b8380ab65739ec9d2`
task_4_final_rereview_artifact: `/tmp/plan-008-phase1-final-rereview-2.json`
task_4_final_rereview_verdict: `pass; zero findings`
task_4_final_parent_verification:
- gateway full suite: 1528 pass, 22 skipped, 0 fail
- gateway typecheck, schema generation, diff check, immutable-plan digest, and no-peer-runtime-route gates: passed
- Pi full suite: 34 pass, 0 fail
- Pi typecheck, diff check, immutable-plan digest, and no-legacy-runtime-import gate: passed
task_4_session_cleanup:
- closed final reviewer `plan-008-final-review` (`374deda5-6d3e-4977-95bb-15847c430bee`)
- closed retained implementer `task-gateway-envelope-fix` (`d270d312-30e0-4980-a9c9-10947b0cbb2a`)
phase_1_decision: `accepted; stop before federation tasks 5-7 until explicit user approval`
phase_1_commit_state: `all implementation remains uncommitted`
task_3_assumptions:
- `WOLFPACK_PORT` selects the local gateway port; fallback is `18790`
- no Pi-side JWT/task-auth implementation in v1
- real local HTTP fixture at the external network boundary
- preserve all unrelated untracked plan/review files and keep work uncommitted
task_2_execution_assumptions:
- implement 2a-2c together to avoid placeholder route/service layers
- same-machine target accepts `local` or persisted local machine UUID; no peer HTTP
- omitted timeout is 30 minutes, bounded 1 second through 24 hours
- one compact gateway service, thin route adapter, server singleton; no generic framework
task_1c_rejected_dispatch: `task_613d73956ea04749852a44f9d88c3c38 rejected because worktree refs were outside communication projectDir; redispatched without those refs`
task_1c_duplicate_review_session_cleanup: `task-gateway-lifecycle-review-2 closed immediately`
execution_recalibration:
- deliver the smallest working trusted-local implementation
- block only on concrete correctness, crash durability, or plan-delivery defects
- no adversarial local-input/disk/process model
- no speculative extensibility, policy engines, schedulers, or defensive validation
- defer improvements until real behavior is working and measured
- active task 1c implementer was explicitly steered with this rubric
verification:
- `bun test ./tests/unit/task-domain.test.ts ./tests/unit/task-control-api-contract.test.ts ./tests/unit/control-api-schema.test.ts`: 27 pass, 0 fail on 2026-08-02
- `bun run typecheck`: passed on 2026-08-02
- `bun test ./tests/unit/broker-ws-attach.test.ts`: 19 pass, 0 fail on isolated rerun
- `git diff --check`: passed
- full suite implementer run: 1462 pass, 22 skipped, 1 timing failure; isolated failing file passed for both implementer and parent
changed_file_scope: `/Users/home/Dev/wolfpack-task-gateway only`
review_focus: `event actor authority, event payload completeness, response/result schemas, error mappings, terminal/ack transitions, and generated-contract fidelity`

## 2. Expose and verify the same-machine Wolfpack gateway

state: `accepted`
verification: `local route, lifecycle, concurrency, crash-recovery, replay, timeout, cancellation, artifact, and acknowledgment gates passed`

## 3. Replace Pi filesystem/terminal communication with the gateway client

state: `accepted`
verification: `gateway client/tools and structural idle replay passed; legacy runtime removed while historical metrics remain read-only`

## 4. Pass the phase 1 same-machine verification gate

state: `accepted`
reviewer_task_id: `task_8404404b3812401b8380ab65739ec9d2`
verification: `independent pass with zero findings; gateway 1528 pass/22 skip and Pi 34 pass/0 fail`
gate_decision: `phase 1 accepted on 2026-08-03`

## 5. Add direct Wolfpack peer federation

state: `accepted`
approved_at: `2026-08-03`
implementation_scope: `one minimal direct-HTTP peer path reusing the accepted gateway/store; trusted tailnet; no JWT federation, background queue, scheduler, capability system, or artifact transfer`
implementer_task_id: `task_a990503650614789995524b70bac4b44`
implementer_session: `plan-008-peer-implementation`
implementer_session_id: `a1686285-0c18-422d-872b-3cc5817deb23`
implementer_model: `openai-codex/gpt-5.6-terra`
implementation_result: `truthful failure; partial provisional receive/event routes and one-shot initial fetch only; no commit`
partial_verification: `93 focused pass, typecheck/schema/diff/digest pass; peer routes registered exactly once`
open_blockers:
- `subsequent remote actions are not forwarded to the sender for canonical acceptance`
- `initial confirmation lacks the required retry schedule and durable attempt accounting`
- `remote parent acknowledgment repair is not implemented`
- `sender startup reconciliation still treats remote receiver replicas as local`
- `tailnet origin validation accepts any ts.net namespace instead of the configured namespace`
correction_task_id: `task_91bd783393b6457f9af8a1369cbd96fb`
correction_session: `plan-008-peer-completion`
correction_session_id: `9eb52c0e-2d56-4d4f-9af2-7e60987dc410`
correction_model: `openai-codex/gpt-5.6-terra`
correction_result: `completed through fallback artifact; no commit`
correction_reported_verification: `18 peer integration pass; full gateway 1532 pass, 22 skipped, 0 fail; typecheck/schema/diff/digest pass`
parent_inspection:
- `80 focused task tests passed; typecheck and diff check passed`
- `suspected remote created-event ID divergence can break task.delivered canonical acceptance`
- `suspected explicit ack repair can conflict on reused durable attempt/ack record IDs`
- `suspected peer receive does not bind assignment target origin to this receiver`
reviewer_task_id: `task_d91aa4ca6a08430b99607153c4947df4`
reviewer_session: `plan-008-peer-review`
reviewer_session_id: `01860761-963e-4ee4-acdc-1c7ae3d3b302`
reviewer_model: `openai-codex/gpt-5.6-terra`
review_verdict: `needs_changes`
review_findings:
- `remote receiver seeds task.created with a noncanonical ID, breaking task.delivered evidence`
- `peer receive accepts assignments addressed to another host in the same tailnet`
- `sender timeout is not propagated to the remote receiver`
- `parent-ack response loss marks receiver cleanup early and explicit repair conflicts on reused records`
- `receiver crash after sender acceptance leaves pending outbox intent and permanently divergent replica`
review_evidence: `/tmp/plan-008-task-5-review.json`; `80 focused pass`; four concrete two-gateway probes reproduced blockers
review_overengineering: `none; corrections remain inside the existing direct peer/store path`
correction_round_2_task_id: `task_f4689fffdd824c71ac89d490b9410990`
correction_round_2_session: `plan-008-peer-completion` (`9eb52c0e-2d56-4d4f-9af2-7e60987dc410`)
correction_round_2_model: `openai-codex/gpt-5.6-terra`
correction_round_2_result: `worker stopped idle after malformed agent_task_done, wrote the old task ID/path, ran only 18 focused tests, and left ack repair/replay defects; parent cancelled task and closed session`
parent_takeover_corrections:
- `persisted and replayed exact sender task.created and task.received identities/timestamps`
- `bound peer receive to this configured canonical origin and preserved configured-tailnet validation`
- `made sender backlog replay sequence-safe after delivery failures without background retries`
- `made pending and final parent acknowledgment explicitly repairable; receiver cleanup begins only after canonical final acknowledgment`
- `made receiver crash recovery reuse the original canonical terminal event and skip exhausted outbox intents`
- `propagated sender timeout to remote receiver state and inbox; covered cancellation and bidirectional messages`
- `restored same-machine cleanup eligibility and remote missing-ref warnings`
parent_takeover_regressions: `24 peer/local integration tests pass including canonical delivery IDs, wrong-host rejection, pending/final ack loss, timeout inbox, cancellation, crash recovery, and exhaustion stop`
parent_takeover_probes: `all four original reviewer probes now pass their expected invariants`
parent_takeover_verification: `gateway full suite 1538 pass/22 skip/0 fail; 1 schema snapshot current; typecheck, schema generation, diff check, immutable-plan digest, 24 integration regressions, and four original reviewer probes pass; Pi 34 pass/0 fail and typecheck passes`
final_reviewer_task_id: `task_c3f74a8f67074367a2598285aafca65d`
final_reviewer_session: `plan-008-peer-final-review` (`613fe066-ca44-48e6-a670-546723c8e3ba`)
final_reviewer_model: `openai-codex/gpt-5.6-terra`
final_review_initial_verdict: `needs_changes; one valid remote idempotency blocker, one invalid missing-plan finding caused by checking the gateway cwd instead of assigned plan cwd`
final_review_correction: `remote idempotency replay now resolves the durable sender ledger by role+taskId; regression observed red then green`
final_rereviewer_task_id: `task_06a9cfac32864e85b92eb7ff69cf1ded`
final_rereview_artifact: `/tmp/plan-008-task-5-final-rereview.json`
final_rereview_verdict: `pass; zero findings; no overengineering`
final_verification: `gateway 1539 pass/22 skip/0 fail; 103 focused pass; typecheck/schema/diff/digest pass; Pi 34 pass/0 fail and typecheck pass`
accepted_at: `2026-08-03`
deployment_state: `accepted candidate deployed locally server-only with --broker=no; final server pid 51477; broker pid preserved at 73645; all 5 sessions and identities preserved; installed hash edb0713649ddf87ca01aa04e596545546d7f48ebc53eb72bb17cc0bf50134c23`
deployment_build_note: `first pre-mutation build failed because this worktree lacked its gitignored verified Ghostty bundle; retry used the existing matching verified bundle from /Users/home/Dev/wolfpack and completed successfully`
deployment_cli_note: `running the globally installed 1.6.14 wolfpack CLI after the first deployment self-updated the stable binary and replaced the candidate; root cause confirmed in src/cli/index.ts updateStableBinary path; candidate was redeployed and no global wolfpack CLI command was run afterward`
isolated_smoke: `task 019fc922-937d-7d86-849e-4d97be376a67 completed and acknowledged on port 18891; task and peer routes verified`
live_smoke: `fresh Pi child completed canonical task 019fc937-e218-7a43-9c86-8fbdc162ec14 through the deployed gateway with information message, delivery evidence, structured result, and idempotent two-phase acknowledgment; the terminal/acknowledged task replayed after the final server restart; evidence /tmp/plan-008-live-direct-final.json and /tmp/plan-008-live-post-restart.json`
reload_boundary: `the parent Pi process still has the pre-cutover extension loaded and produced expected TASK_NOT_FOUND when its legacy .pi task ID reached a fresh child; reload this chat before task 6`
post_acceptance_main_merge: `feat/federated-task-gateway fast-forwarded from 762d997 to origin/main 0577b59 (13 commits); every uncommitted gateway change reapplied without conflicts; source version is now 1.6.14; 104 focused tests, 1585 full-suite tests, typecheck, and diff check pass`
post_merge_deployment: `performed server-only with scripts/deploy-local.sh --broker=no; live source/deployed version 1.6.14, installed hash 2537e30e2afa0d2fa56c610cd869daef5d5cca78afb7a71a5830db4e8ba34a61; broker and sessions preserved`

## 6. Verify end-to-end federation and recovery

state: `accepted`
started_at: `2026-08-03`
goal_lock: `verify that remote behavior preserves phase-1 contracts and failure semantics; no protocol redesign or deferred infrastructure`
reload_gate: `passed; parent session reloaded after task-5 deployment`
active_subtask: `none`
extension_smoke_task_id: `019fc947-a059-73e8-85e6-b041467efa85`
extension_smoke_session: `plan-008-task6-extension` (`7bfdada5-e784-44fe-829d-2d6cda546c7c`)
extension_smoke_result: `passed; canonical assignment, receiver question, linked parent answer token task6-confirm-6a, two information events, structured completion, and two-phase parent acknowledgment`
extension_review: `child-side assignment/answer injection and delivery evidence observed; structural {taskId,eventId} dedup and post-insertion ack confirmed in source/tests; parent stayed busy, so idle parent auto-injection was not directly exercised in this run`
merged_deployment: `1.6.14 deployed server-only; server pid 75113; broker pid preserved 73645; 5 sessions preserved before task-6 child spawn; installed hash 2537e30e2afa0d2fa56c610cd869daef5d5cca78afb7a71a5830db4e8ba34a61`
implementer_task_id: `019fc94b-e771-78eb-9514-bb3f08cf96f1`
implementer_result: `completed; four deterministic tests added; no production changes (parent byte-compared untracked production sources to pre-task backup)`
implementer_scope: `tests only for remote absolute refs, paths-only artifact metadata, provisional orphan cleanup, and one-attempt unreachable initial send`
parent_test_review: `assertions inspect pre-fetch rejection/no ledger, metadata/no source path or bytes, exact ten-minute orphan tombstone/removal, and one fetch/no sleep plus canonical sender failure`
reviewer_task_id: `019fc952-dfc1-7f3d-be1a-5413bc54665d`
reviewer_session: `plan-008-task6-review` (`7fe7f3b0-c842-47c4-9aaf-7062304032a0`)
reviewer_model: `openai-codex/gpt-5.6-terra`
verification: `41 focused pass; gateway 1589 pass/0 fail plus typecheck/schema/diff; Pi 34 pass/0 fail plus typecheck/diff; immutable digest matches; oldsgt reachable at 1.6.11 but task route returns 404, so real two-candidate-peer test remains unavailable`
extension_idle_injection: `directly observed when task 019fc94b-e771-78eb-9514-bb3f08cf96f1 completion arrived as structured parent custom-message event after this parent became idle`
review_state: `accepted after corrections and final independent pass`
review_verdict: `needs_changes`
review_findings:
- `6a-f1 required`: direct TaskGateway callbacks do not prove two isolated Wolfpack HTTP servers, peer route parsing/dispatch, separate roots/ports/session fixtures, or singleton wiring
- `6a-f2 required`: manually constructed orphan receipt does not prove receive persistence -> lost initial response -> sender failure -> ten-minute receiver purge
correction_order: `fix and verify 6a-f1 first, then 6a-f2`
correction_6a_f1_first_task: `019fc959-0593-7d93-8279-9841787ee5d3 timed out after design exploration; no edits`
correction_6a_f1_first_session: `plan-008-task6-extension closed after timeout acknowledgment`
correction_6a_f1_task: `019fc988-7313-756a-82a5-75d94fe93b81`
correction_6a_f1_session: `plan-008-task6-http` (`5c4d9889-de45-4c57-ba71-407f88ab3ba3`)
correction_6a_f1_result: `accepted; real production-importing two-process HTTP fixture with separate roots/HOMEs/ports/origins/session fixtures; canonical receive/event/message/completion round trip; no production edits; parent focused test/typecheck/diff pass`
correction_6a_f1_design: `two real server subprocesses; test-only pre-import fetch rewrite maps canonical tailnet HTTPS origins to localhost ports; separate HOME/config/root/backend fixtures; no production seam`
correction_6a_f2_state: `accepted after parent inspection and full verification`
correction_6a_f2_task: `019fc996-a082-7d9b-b685-54c7e75bd71f`
correction_6a_f2_result: `real receivePeer persisted peer.receipt; initial successful response was lost; sender recorded PEER_UNREACHABLE after one attempt; exact ten-minute lifecycle sweep removed receiver payload and retained tombstone; tests only`
task_6_parent_verification: `gateway 1591 passed/0 failed; Pi 34 passed/0 failed; gateway and Pi typechecks passed; schema generation, diff check, and immutable digest passed`
task_6_rereview_session: `plan-008-task6-rereview (ec1d50c1-6e29-4a60-b5ac-8b059cedc35b)`
task_6_rereview_model_setup: `waited for structured runtime idle before session send; session read verified command executed and footer reports openai-codex/gpt-5.6-terra`
task_6_rereview_task: `019fc99b-15c6-7d16-bfb5-e9053af39b5a`
task_6_rereview_result: `needs_changes; two-process happy path is solid, but response-loss/orphan chain remains in-process and can pass without real peer HTTP routing or isolated-process restart recovery`
correction_6a_f3_state: `accepted after parent verification and independent rereview`
correction_6a_f3_task: `019fc9a5-1b60-78f1-88ab-f410d79dd564`
correction_6a_f3_result: `tests-only subprocess chain: real HTTP receive returned 200 after receiver persistence, sender fixture lost response, sender route returned 503 PEER_UNREACHABLE, processes stopped before store inspection, receiver provisional receipt verified, clock advanced exactly ten minutes, real receiver restarted on same root and production initialization purged to tombstone`
correction_6a_f3_parent_verification: `focused subprocess test pass; gateway 1591/0; Pi 34/0; both typechecks, schema generation, diff check, and immutable digest pass; only integration fixture/test changed during correction`
task_6_rereview_2_task: `019fc9ab-bc49-7233-a179-429935e58a70`
task_6_rereview_2_result: `needs_changes; high: §6a isolated two-server suite still lacks subprocess HTTP/singleton evidence for duplicate requests, retry exhaustion, restart recovery, timeout/cancel races, and failed/repaired parent acknowledgment; happy path and response-loss/orphan pass`
correction_6a_f4_state: `accepted; tests-only isolated-server matrix`
correction_6a_f4_task: `019fc9af-94c4-7c13-91bd-83133e4d1efe`
correction_6a_f4_session: `plan-008-task6-http-full (3718b023-6865-4620-8e8a-edc2e36bdb64); model verified after structured idle as openai-codex/gpt-5.6-terra`
correction_6a_f4_result: `tests-only isolated subprocess coverage added for duplicate requests, four-attempt exhaustion/no restart replay, crash-after-acceptance/original-ID restart recovery, timeout propagation/cancel-completion race, and lost/repaired two-phase parent ack/cleanup eligibility`
correction_6a_f4_parent_verification: `7 subprocess tests pass; gateway 1596/0; Pi 34/0; both typechecks, schema generation, diff check, and immutable digest pass; fixture/test only; production files unchanged during correction; stores inspected after relevant processes stop`
task_6_rereview_3_state: `needs_changes`
task_6_rereview_3_task: `019fc9ce-2664-7e2a-8dfd-a2aeb88c4464`
task_6_rereview_3_result: `important: remote absolute-ref rejection and machine-qualified paths-only artifact projection still only use in-process callback pairs; add production-importing subprocess HTTP coverage`
correction_6a_f5_state: `accepted; subprocess ref/artifact cases and distinct persisted machine identities`
correction_6a_f5_parent_finding: `senderTaskRoot and receiverTaskRoot were siblings under one fixture root, while getMachineId(taskRoot) stores at dirname(taskRoot)/machine-id; corrected to distinct sender/tasks and receiver/tasks parents with unequal persisted-ID assertions.`
correction_6a_f5_task: `019fc9d1-65a5-7e40-829f-6842def31e96`
correction_6a_f5_result: `tests-only subprocess absolute-ref rejection proves zero peer dispatch/ledgers; subprocess artifact completion binds metadata to distinct receiver machine ID and excludes absolute/source paths/bytes; all subprocess fixture root layouts now isolate persisted machine IDs`
correction_6a_f5_parent_verification: `9 subprocess tests pass; gateway 1598/0; Pi 34/0; both typechecks, schema generation, diff check, immutable digest pass; no production correction edits`
task_6_rereview_4_state: `pass`
task_6_rereview_4_task: `019fc9d7-a968-7f80-aff5-bc2c2945a8ce`
task_6_state: `accepted`
task_6_acceptance: `final independent pass after full nine-case isolated HTTP subprocess matrix; gateway 1598/0, Pi 34/0, typechecks/schema/diff/digest pass; real second peer remains unavailable because oldsgt 1.6.11 task routes return 404`
task_7_state: `accepted`
task_7a_state: `accepted`
task_7a_assignment:
- task_id: `019fc9dc-7ba2-7457-bb39-664fa13dc2a8`
- scope: documentation-only changes in `/Users/home/Dev/wolfpack-task-gateway` and `/Users/home/Dev/wolfpack-pi-tasks`; no production source changes
- plan_digest_reverified: `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`
- direct contribution: publish the one accurate gateway operating model and remove stale project-local filesystem guidance before review
- non-goals preserved: no queue/scheduler, offline dispatch, JWT federation, artifact transfer, transcript transfer, runtime registration, or production TODOs
- TDD red observed: new Wolfpack task-gateway documentation test failed because `docs/task-gateway.md` and its package/README link did not exist; extended Pi documentation test failed because the required acknowledged-inbox and peer-operating guidance was absent
- documentation additions: canonical Wolfpack task-gateway guide, README/agent-skill links, local/peer Pi examples and delegation guidance, and explicit read-only legacy metrics boundary
- deferred documentation: runtime registration and heartbeat/capability leases; durable offline initial dispatch; JWT federation; artifact transfer and retention; representative payload benchmark; automated recovery summaries; and measured-only summary caching
- verification: focused documentation contracts red then green (`Wolfpack 2 pass`; `Pi Tasks 3 pass`); Wolfpack canonical `bun run gen:schema` then schema/docs contracts (`19 pass`); full suites (`Wolfpack 1600 pass, 0 fail`; `Pi Tasks 34 pass, 0 fail`); both `bun run typecheck` passed; both `git diff --check` passed; immutable plan digest remained `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`; no commit
- state: `accepted`
correction_6a_f5_execution:
- task_id: `019fc9d1-65a5-7e40-829f-6842def31e96`
- state: `accepted`
- plan_digest_reverified: `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`
- scope: `tests/integration/task-gateway.test.ts` and the existing test-only subprocess fixture only; no production changes
- TDD target: subprocess-only absolute-ref rejection and artifact projection assertions plus red/green persisted machine-ID isolation across all two-server fixture roots
- TDD red observed: with sibling roots, both live subprocesses read the same `dirname(taskRoot)/machine-id`; the new distinct-ID assertion failed with one UUID.
- identity correction: helper, legacy happy-path, and orphan subprocess fixtures now use `sender/tasks` and `receiver/tasks`, giving each server a distinct machine-ID parent. The persisted IDs now differ while canonical task source/target origins remain sender/receiver tailnet origins.
- coverage added: real sender HTTP `send` with absolute context ref returns `400 INVALID_REQUEST` before any peer receive/event dispatch; both processes are stopped before both stores prove no ledger. Real receiver project file completion reaches sender HTTP status with receiver persisted machine ID plus derived project/path/mime/description/size metadata, and no sourcePath/absolute project path/file bytes.
- changed files: `/Users/home/Dev/wolfpack-task-gateway/tests/integration/task-gateway.test.ts` only; no production changes.
- verification: subprocess group => `8 pass, 0 fail`; all focused task/ref/artifact suites => `117 pass, 0 fail`; `bun run typecheck` => passed; `git diff --check` => passed; plan digest remained `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`.
- state: `accepted; no commit`
correction_6a_f4_execution:
- task_id: `019fc9af-94c4-7c13-91bd-83133e4d1efe`
- state: `accepted`
- plan_digest_reverified: `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`
- scope: `tests/integration/task-gateway.test.ts` and `tests/integration/fixtures/task-gateway-peer-server.ts` only; production imports/routes/singletons and existing accepted subprocess coverage remain unchanged
- TDD target: isolated production-importing two-server HTTP coverage for duplicate/idempotency, bounded exhaustion/restart, response-loss recovery, timeout/cancel terminal convergence, and two-phase acknowledgment repair
- TDD red observed: before fixture controls, exhaustion, receiver-recovery, and parent-ack tests returned `200` where their lost-response paths required `503`; route event-ID assertions were absent from fixture logs. After test-only control support, the subprocess group passed.
- changed files: `/Users/home/Dev/wolfpack-task-gateway/tests/integration/task-gateway.test.ts`; `/Users/home/Dev/wolfpack-task-gateway/tests/integration/fixtures/task-gateway-peer-server.ts`
- coverage added: concurrent idempotent HTTP sends create one sender/receiver ledger and one receive route dispatch; information delivery gets exactly four same-ID peer-event requests, durable sender failure, and no restart replay; a receiver subprocess crash after sender acceptance replays the original completion ID on restart without a duplicate canonical terminal; sender timeout reaches receiver and cancellation/completion has one converged terminal; four lost pending-ack responses retain receiver non-eligibility until explicit same-ID repair and final acknowledgment.
- verification: `bun test tests/integration/task-gateway.test.ts --test-name-pattern "cross-process peer task gateway"` => `6 pass, 0 fail`; focused task suites => `115 pass, 0 fail`; `bun run typecheck` => passed; `git diff --check` => passed.
- production boundary: no `src/` or route edits in this correction; fixture imports the production server/routes/singleton in isolated subprocesses with independent HOME/root/port/origin/session state.
- state: `accepted; no commit`
cleanup_after_rereview_2: `closed accepted idle implementer plan-008-task6-http and single-use reviewer plan-008-task6-rereview-2 after terminal task acknowledgment`
task_6_live_tools: `send/status/wait active-timeout+terminal/cancel/inbox ack/done completed+failed+cancelled/messages/timeout/artifact metadata exercised; controlled cancel retry 019fc9a1-c852-7e12-bdb6-7c2ac9444cb9 passed; controlled failed artifact task 019fc9a2-79b6-791e-baa1-0883d409b084 passed; invalid first cancel probe 019fc99b-52e5-778f-ae5f-112fb122a3d4 self-waited and correctly sender-timed-out`
model_setup_race: `user observed /model left unsent in both child editors and manually pressed enter; root cause is immediate post-spawn session send while Pi bootstrap turn is busy—terminal ready is not Pi idle; model switch was not structurally proven`
model_setup_correction: `for future workers, wait for structured runtime idle before sending /model, then dispatch only after model setup; do not treat PTY-ready as harness-idle`

## 7. Finish documentation, review, and handoff

state: `accepted`
task_7a_state: `accepted`
implementer_task_id: `019fc9dc-7ba2-7457-bb39-664fa13dc2a8`
delivery_reviewer_task_id: `019fc9e4-7bea-7ea8-92e8-e4c28dbae203`
delivery_review_state: `initial findings corrected; sender outbox rereview passed; final inventory correction recorded below`
security_reviewer_task_id: `019fc9e4-7c01-7c74-bf1e-4c447fee2079`
security_review_state: `initial redirect finding corrected; focused security rereview passed`
correction_7b_security_redirect_state: `implemented and parent-verified; redirect:error on shared peer POST plus real 307 assignment/308 event sink regression with zero sink requests/bytes`
correction_7b_security_redirect_task: `019fc9e8-e330-7578-bd5b-0b38bf696058`
correction_7b_security_redirect_parent_verification: `focused real-HTTP test 1/0; typecheck and diff check pass; immutable plan digest passes`
security_rereview_state: `pass`
security_rereview_task: `019fc9ed-6189-7e83-a880-4be707d20977`
security_acceptance: `redirect:error is enforced by sole shared peer POST path; 301/302/303/307/308 probe and production-importing 307/308 regression reached zero sink requests`
correction_7b_sender_outbox_state: `implemented and parent-verified: startup replays unresolved remote sender intents with original event ID; durable outbox.delivered resolves success; four attempts are lifetime-bounded; four-attempt/no-diagnostic crash finalizes delivery_failed without another request`
correction_7b_sender_outbox_tasks: `019fc9f0-4366-7a80-895b-b63e96754000, 019fc9f9-07cf-7d5c-9a2a-b1f160d467ff`
correction_7b_sender_outbox_parent_verification: `integration + store 59/0; typecheck/diff pass; isolated subprocess proves crash recovery, stable ID, one receiver event, durable success, no resolved replay, zero-request exhaustion finalization, exactly-once failure`
delivery_rereview_state: `concurrency finding corrected and independently accepted in rereview 3`
delivery_rereview_task: `019fc9fd-3946-7319-8069-cb36565dc5a3`
correction_7b_sender_outbox_concurrency_state: `implemented and parent-verified: singleton-owned keyed delivery serialization reloads durable ledger inside lock; concurrent subprocess regression fell from 10 peer requests to four with four records, one delivery_failed/diagnostic, no restart replay`
correction_7b_sender_outbox_concurrency_task: `019fca00-92f1-7c25-ac02-0ef33fa97049`
correction_7b_sender_outbox_concurrency_parent_verification: `integration + store 60/0; typecheck/diff pass`
delivery_rereview_2_state: `finding disputed and retracted in rereview 3: release-only lock promise cannot propagate operation rejection`
delivery_rereview_2_task: `019fca05-5b7a-735b-aef3-2d9ee928069f`
delivery_rereview_3_state: `pass; reviewer retracted lock-poison finding after faithful rejection/queue probe proved release-only predecessor fulfillment and map cleanup`
delivery_rereview_3_task: `019fca09-3a91-7032-85e2-9d3b2fb91287`
delivery_acceptance: `pass for sender outbox durability/restart/concurrency architecture after TDD corrections; stale ledger/inventory finding corrected in task 7c`
task_7a_state: `accepted`
task_7b_state: `accepted; security and delivery/architecture pass after corrections`
task_7c_state: `accepted`
final_security_task: `019fca0e-d60b-7850-a7cd-e2941d1c5a3b`; verdict: `pass; zero actionable findings`
final_delivery_task: `019fca0e-d617-711b-8baa-3b6f47baebd2`; verdict: `delivery pass; architecture pass; publication ready`
verification: `exact final inventories: Wolfpack 1604 pass/0 fail and full typecheck; Pi Tasks 34 pass/0 fail and typecheck; canonical schema regenerated; both diff checks pass; immutable plan digest matches; inventory union checked against explicit Pi exclusions`
post_review_deployment_state: `accepted source deployed with scripts/deploy-local.sh --broker=no; server pid 75113 -> 26968; broker pid preserved at 73645; all 13 session identities preserved; installed server hash c8fd7ea40d8968a20dcc3b7d34581bab82089455d6899b6095793e3e3cafb575; version 1.6.14; bundle hash 12011e718bf4dde746cba02debb89b2313294cab9be784f41bdce71a21bb25c3`
post_review_live_smoke: `task 019fca14-f796-71bf-a1f2-117b5430d9dc delivered to preserved Pi session after redeploy; assignment token deploy-c8fd7ea4, information token info-c8fd7ea4, structured completion, assignment/message delivered evidence, and task.parent_ack_pending/task.parent_acknowledged verified`
final_parent_cleanup: `closed accepted parent-owned sessions plan-008-task7-docs, plan-008-task7-delivery-review, plan-008-task7-security-review, plan-008-task7-security-fix, and previously retained plan-008-task6-review; verified their stable IDs are absent; unrelated/pre-existing sessions left untouched`

## deferred debt

- exact Pi runtime registration, capability advertisement, and heartbeat leases
- durable offline initial assignment outbox
- JWT/authenticated peer federation
- artifact snapshot/pull transfer and retention
- representative payload benchmark before changing initial limits
- automated session-recovery summarization
- summary caching only after measured repeated-generation waste
- progress streaming

## fresh verification evidence

- first rewritten candidate verified by full-file reads on 2026-08-02: 511 lines, 26,362 bytes.
- first candidate sha-256 was `6dd53d5750d22c873978e153d03e9d38b71d4cec5f9b28008589282d465e7734`; it is superseded by review corrections and was never approved.
- planning-review result read from `.pi/tasks/task_24c9de40fada48a789ea0e19c84bf8fd/result.json` and checked against repository surfaces on 2026-08-02.
- corrected candidate verified by full-file reads on 2026-08-02: 587 lines, 33,874 bytes.
- corrected candidate sha-256 `4456d253db92dae08579fec84c978ff752bde88c2841af76d6957dc3325a241d` was reviewed and superseded; it was never approved.
- 5.6 Terra final-review result read from `.pi/tasks/task_45688b30ff794841bfb3aa2061bd119c/result.json`; four blockers were verified and corrected.
- post-final-review candidate verified by full-file reads on 2026-08-02: 615 lines, 37,336 bytes.
- post-final-review candidate sha-256 independently verified by reviewer and parent on 2026-08-02: `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c`.
- approval-gate planning review verdict: clean approval, zero blocking findings.
- immutable plan digest is recorded as `dd74bf5aaf20d1e523a8b76a899c34e8603aa3f081af5debd310b42f3856f11c` and remained unchanged through implementation.
- final phase-1 review artifact `/tmp/plan-008-phase1-final-rereview-2.json`: pass, zero findings.
- fresh gateway verification on 2026-08-03: 1528 pass, 22 skipped, 0 fail; typecheck/schema/diff/digest/no-peer-route gates passed.
- fresh Pi verification on 2026-08-03: 34 pass, 0 fail; typecheck/diff/digest/no-legacy-runtime-import gates passed.

## changed-file inventory for the final candidate

Wolfpack (`/Users/home/Dev/wolfpack-task-gateway`):
- `README.md`
- `docs/agent-skills.md`
- `docs/generated/control-api.schema.json`
- `docs/task-gateway.md`
- `package.json`
- `scripts/gen-control-api-schema.ts`
- `src/control-api/schema.ts`
- `src/server/http.ts`
- `src/server/index.ts`
- `src/server/routes.ts`
- `src/server/task-routes.ts`
- `src/tasks/domain.ts`
- `src/tasks/gateway.ts`
- `src/tasks/lifecycle.ts`
- `src/tasks/machine-id.ts`
- `src/tasks/store.ts`
- `tests/integration/fixtures/task-gateway-peer-server.ts`
- `tests/integration/task-gateway.test.ts`
- `tests/unit/__snapshots__/control-api-schema.test.ts.snap`
- `tests/unit/control-api-schema.test.ts`
- `tests/unit/task-control-api-contract.test.ts`
- `tests/unit/task-domain.test.ts`
- `tests/unit/task-gateway-docs.test.ts`
- `tests/unit/task-lifecycle.test.ts`
- `tests/unit/task-store.test.ts`

Pi Tasks (`/Users/home/Dev/wolfpack-pi-tasks`):
- `.plans/008-federated-task-context-protocol.md`
- `.plans/008-federated-task-context-protocol.status.md`
- `README.md`
- `skills/task-context-summary/SKILL.md`
- `skills/wolfpack-pi-task-delegation/SKILL.md`
- `src/extension.ts`
- `src/gateway-client.ts`
- `src/task-inbox.ts`
- deleted legacy runtime: `src/auto-notify.ts`, `src/preflight.ts`, `src/protocol.ts`, `src/store.ts`, `src/stores/filesystem.ts`, `src/task-communication.ts`, `src/transports/wolfpack.ts`, `src/types.ts`
- `tests/extension.test.ts`
- `tests/gateway-client.test.ts`
- `tests/package.test.ts`
- `tests/task-inbox.test.ts`
- deleted legacy tests: `tests/auto-notify.test.ts`, `tests/preflight.test.ts`, `tests/protocol.test.ts`, `tests/store.test.ts`, `tests/task-communication.test.ts`

Explicitly excluded unrelated Pi files: `.edc/`, `.plans/005-central-task-registry.md`, `.plans/007-context-reconstruction-assessment.json`, `.plans/007-task-context-activation-no-pi-upstream.md`, `.plans/009-stale-extension-context-race.md`, `.plans/009-stale-extension-context-race.status.md`.

## next action

execute the user-authorized commit / `dev_04` merge / push sequence in both repositories; unrelated Pi artifacts and the dirty `/Users/home/Dev/wolfpack` worktree remain untouched.
