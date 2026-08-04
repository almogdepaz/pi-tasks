# Remote target rejection handshake order — execution status

plan: `.plans/016-remote-target-rejection-handshake-order.md`
plan_sha256: `649831370d8c4febb2ce23cfa48011d295709291eaecd07c1422316e8e8b28aa`
state: `complete`
current_phase: `accepted`

## Goal lock

Narrowly reorder remote initial persistence so definitive peer validation rejection creates zero durable task while uncertain/retryable delivery failure retains canonical failed sender evidence. Add no routes, attempts, rollback deletion, capability inference, or unrelated changes.

## Task state

- 1: `accepted`
- 2: `accepted`
- 3: `accepted`

## Authorization and conflict resolution

- user selected option 2 after the plan-015 delivery/architecture review identified the conflict.
- this plan supersedes only plan 008 lines 198–206 where they require sender `task.created` before `peer/receive`.
- plan 015 remains immutable at `13d87a48164e0332d5e756f1d2a5e489efeefc1c8b1f2bcea2dbbe85c3222167`.
- no commit, push, deployment, publication, merge, or live dispatch is authorized.

## Verification evidence

- plan 016 SHA-256 locked before implementation: `649831370d8c4febb2ce23cfa48011d295709291eaecd07c1422316e8e8b28aa`.
- regression failed red against the previous ordering: remote shell rejection left one sender ledger with canonical `task.created` plus `task.failed` reclassified as `PEER_UNREACHABLE`.
- focused green: definitive non-agent and project-mismatch rejections create zero ledgers; unreachable and lost-response failures retain canonical failed sender evidence.
- focused gateway/domain/control-schema suite passed 102/102; Wolfpack typecheck and both diff checks passed; plan 015 and 016 digests match.
- full Wolfpack suite passed 1624/1624 with 22 broker-binary-dependent skips; schema/snapshot hashes remained stable across regeneration; package dry run included the adapter contract and gateway guide; diff check remained clean.
- correction re-review task `019fce38-9d0c-777f-8d1b-c7605403cb1b` accepted both original blockers as resolved with direct source and regression evidence; delivery and architecture verdicts are accepted.

## Next action

Plan 016 is accepted. Resume plan 015 sequential security review.
