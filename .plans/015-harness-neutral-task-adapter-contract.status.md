# Harness-neutral task adapter contract — execution status

plan: `.plans/015-harness-neutral-task-adapter-contract.md`
plan_sha256: `13d87a48164e0332d5e756f1d2a5e489efeefc1c8b1f2bcea2dbbe85c3222167`
state: `complete`
current_phase: `accepted`

## Goal lock

Remove Pi-only policy from Wolfpack's canonical gateway, define and enforce a deterministic harness-adapter contract, and certify the Pi extension against it. Preserve canonical lifecycle, trust, federation, delivery, task timeout, retention, artifact, and recovery behavior. Do not implement a Claude adapter.

## Task state

- 1: `accepted`
- 2: `accepted`
- 3: `accepted`
- 4: `accepted`
- 5: `accepted`

## Locked decisions

- Routable targets use Wolfpack's existing openable agent-harness taxonomy; shell/custom/unknown targets fail with `TARGET_NOT_AGENT`.
- Adapter-loaded readiness is external evidence and is never inferred from routability or durable receipt.
- `TARGET_NOT_PI` remains deprecated/never emitted in v1 for generated-client compatibility.
- Wolfpack owns a data-driven event disposition matrix and filters internal events from adapter inboxes.
- Mandatory adapter conformance includes durable structural evidence, single-flight insertion, post-evidence delivery acknowledgment, replay, fail-closed unknown events, and task-specific parent acknowledgment.
- Pi uses full durable session entries as insertion evidence, renders role, omits metadata from prompt text, and limits completion follow-up to parent terminal delivery.
- `agent_task_inbox` becomes read-only; new `agent_task_ack({taskId})` is the only Pi acknowledgment tool.
- No CLI, MCP, shared SDK, Claude adapter, version bump, publication, deployment, or live dispatch.

## Branches and worktrees

- Wolfpack: `feat/task-adapter-contract` at base `5549047176e1f83261e00d91d054794c797c723c` in clean worktree `/Users/home/Dev/wolfpack-task-adapter-contract`.
- Pi Tasks: `feat/task-adapter-contract` at base `ab8893443ef9054fd752ae443ed3e8555148353e` in `/Users/home/Dev/wolfpack-pi-tasks`.

## Worktree exclusions

- Original `/Users/home/Dev/wolfpack-task-gateway` remains untouched with its onboarding modifications.
- Pi `.edc/`, plans 005/007/009/012, and unrelated untracked `docs/` remain excluded.
- Plan 014 remains superseded.

## Review input incorporated before lock

Sol task `019fcdfb-b44b-709a-882e-b43cda80c6e5` approved the responsibility direction but identified target eligibility, minimum conformance, event ownership, concurrent insertion, bulk acknowledgment, role asymmetry, uncertain outcomes, compatibility, and terminology gaps. The locked revision addresses those findings. Sol's status-ledger suggestion was already satisfied.

## Verification evidence

- user approved execution with “lets go” and explicitly requested Terra implementation delegation.
- locked plan SHA-256: `13d87a48164e0332d5e756f1d2a5e489efeefc1c8b1f2bcea2dbbe85c3222167`.
- both branches were created from current `main`; Wolfpack gateway is merged.
- final parent verification and all sequential independent reviews are accepted.

## Execution log

- Sol reviewer result was structurally inspected and task-specifically acknowledged.
- Terra implementation session: `terra-adapter-implementation` (`4c8604c7-1eba-4472-8891-7645021ae19b`), verified model `openai-codex/gpt-5.6-terra`.
- tasks 1–4 dispatched as task `019fce0a-a248-7600-9d8f-1f83cf968e50` with immutable plan/status refs, digest, TDD, exclusions, and no-commit boundary.
- Terra completed tasks 1–4 and reported focused red evidence, Pi 45/45, Wolfpack 1621/1621 with 22 environment-dependent skips, both typechecks, schema regeneration, package dry runs, and diff checks.
- fresh parent verification matched those results: Pi focused 33/33 and full 45/45; Wolfpack focused gateway/domain/schema/docs passed and full 1621/1621 with 22 broker-binary-dependent skips; both typechecks, schema hash stability, package dry runs, plan digest, and diff checks passed.
- parent found and corrected one documentation miss test-first: generic `/delivered` wording plus a dedicated Pi readiness subsection; docs/readiness tests passed 5/5.
- parent plan-to-diff review found remaining correction requirements: isolated peer acceptance/rejection must cover the locked target taxonomy; opaque assignment fields need local/federated round-trip proof; destination events need conditional receiver-delivery semantics in the disposition map.
- bounded correction task `019fce1b-8ebb-7fbe-864a-71ae1dfdf031` dispatched to the existing Terra session; it preserved the parent's docs correction and touched only the scoped Wolfpack worktree.
- fresh post-correction parent verification: focused Wolfpack contract/domain/docs/gateway suite 106/106; full Wolfpack 1623/1623 with 22 broker-binary-dependent skips; Pi 45/45; both typechecks; generated schema and snapshot hashes stable across regeneration; both package dry runs include required files; both diff checks and immutable plan digest passed.
- sequential delivery/architecture reviewer task `019fce27-4f26-77c7-a37a-da232e5f1c43` dispatched to fresh Pi session `015-delivery-review` (`545a944e-5e35-419d-928f-2fa3fc531dbb`); report target `/tmp/plan015-delivery-architecture-review.md`. The cross-worktree context ref was rejected as outside the Pi project root, but the exact absolute worktree path remained in the assignment text.
- delivery/architecture review returned two blockers with one verified root cause: a definitive remote `TARGET_NOT_AGENT` rejection occurs after the sender ledger is committed, so the sender retains a canonical failed task and reclassifies it as `PEER_UNREACHABLE` while the receiver creates no ledger.
- hard conflict: immutable plan 008 requires the sender to commit `task.created` before its one bounded `peer/receive` attempt (`008` lines 198–206), while plan 015 requires remote non-agent rejection with zero durable task. Meeting both is impossible with the locked two-route handshake. Security review has not started.
- user selected resolution option 2: make the existing `peer/receive` provisional attempt before sender-ledger creation; definitive rejection creates zero ledgers, while uncertain/retryable failure still creates canonical failed sender evidence.
- narrow superseding plan 016 locked at `649831370d8c4febb2ce23cfa48011d295709291eaecd07c1422316e8e8b28aa`; it supersedes only plan 008's initial ordering and adds no route, attempt, rollback deletion, capability inference, deployment, or release work.
- plan 016 correction is parent-verified; delivery/architecture correction re-review task `019fce38-9d0c-777f-8d1b-c7605403cb1b` accepted both original blockers as resolved. Delivery and architecture verdicts are accepted.
- sequential security reviewer task `019fce3a-7bc7-7c76-996f-370c8a5d1b3e` dispatched to fresh Pi session `015-security-review` (`3ab5132a-9a94-4086-984d-0b4fbc6a1a9e`); report target `.plans/reviews/015-harness-neutral-task-adapter-contract-security.md`.
- security report inspected: APPROVE with 0 critical/high/medium/low findings; reviewer independently passed Wolfpack focused 82/82, Pi focused 26/26, and both typechecks. No security correction is required.
- sequential quality/test-value reviewer task `019fce3e-9bb0-771c-ba1b-c5cc5b6875de` dispatched to fresh Pi session `015-quality-review` (`19492213-8ce4-476a-88cc-c8d6c38fa44b`); report target `.plans/reviews/015-harness-neutral-task-adapter-contract-quality.md`.
- quality review returned CHANGES_REQUESTED with two verified medium test-value gaps and zero source-quality defects.
- finding 1 corrected: extension-boundary coverage now overlaps actual session-start, interval, and agent-end handlers around a blocked status call and observes exactly one inbox read, status read, structural insertion, and delivery acknowledgment; focused test and typecheck pass.
- finding 2 corrected: inbox coverage now supplies two distinct terminal task statuses, proves inspection performs zero acknowledgments, then proves explicit acknowledgment touches only the named task.
- post-correction Pi verification: full 45/45, typecheck, package dry run, diff check, and both immutable digests passed.
- quality correction re-review task `019fce44-5f80-7652-82ef-2b3464ad7425` accepted both original medium findings as corrected; reviewer independently passed extension tests 6/6, Pi typecheck, and diff check.
- final focused run exposed only the isolated eight-harness matrix exceeding Bun's 5-second default after starting 16 subprocesses. Three isolated reproductions reached 5.5–6.0 seconds with all 40 assertions passing under an explicit repository-standard 20-second subprocess-test budget; no production defect was found.
- fresh final acceptance: Wolfpack focused domain/store/gateway/control-schema/docs 126/126; full Wolfpack 1624/1624 with 22 broker-binary-dependent skips; Pi focused 33/33 and full 45/45; both typechecks passed; schema and snapshot hashes stayed stable across regeneration; both package dry runs contained required files; both diff checks and plan 015/016 digests passed.
- scoped inventories match the feature plus approved plan/review artifacts. `TARGET_NOT_PI` remains only in the deprecated domain/schema compatibility mapping. The excluded original gateway worktree retains only its pre-existing onboarding modifications. No commit, push, deployment, publication, merge, or live dispatch occurred.
- after final verification, the parent task-specifically acknowledged both Terra tasks and all delivery/security/quality review tasks. Parent-spawned Terra and reviewer sessions were closed; structured status now returns `SESSION_NOT_FOUND` with terminal unavailable for all four session IDs.

## Next action

Plan 015 is accepted. Await separate user authorization for commits, pushes, deployment, publication, merge, or live dispatch.
