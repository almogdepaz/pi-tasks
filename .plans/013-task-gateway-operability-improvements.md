# Task-gateway operability improvements

## Goal

Implement the three evidence-backed `next` improvements accepted from `docs/reviews/post-step5-task-gateway-friction.md`:

1. distinguish changed-file reporting from paths-only artifact declarations and make rejected artifact warnings identify the submitted path;
2. add a compact, read-only live-peer readiness checklist; and
3. return field-level diagnostics for invalid `agent_task_send` requests.

The result should remove avoidable warning noise and blind retries without changing task authority, delivery, trust, acknowledgment, or retention semantics.

## Locked assumptions

- Field locations use an optional structured `error.path` encoded as an RFC 6901 JSON Pointer, for example `/preflight/requiredProject` or `/context/refs/0/path`. `INVALID_REQUEST`, HTTP status, `message`, and `retryable` remain unchanged. Consumers must not parse prose to recover the field.
- Field-level diagnostics cover send validation in the Pi client, Wolfpack HTTP route, and Wolfpack gateway semantic checks. Other task routes are unchanged.
- Unknown send properties identify their own escaped JSON Pointer. When multiple fields are invalid, validation reports the first deterministic failure; the retry may reveal the next one.
- Artifact declarations remain optional, paths-only metadata for existing project-relative regular files. They do not become changed-file lists, accept absolute paths, or transfer bytes. Changed files belong in structured result data such as `result.changedFiles`.
- Invalid artifact declarations remain warnings and do not invalidate an otherwise accepted terminal result. Per-entry warnings name the rejected submitted path; the existing aggregate over-limit warning may report the count instead of emitting an unbounded warning per entry.
- Peer readiness remains an operator checklist using existing read-only endpoints and package/session controls. It adds no endpoint, CLI command, runtime registration, heartbeat, capability lease, hidden retry, or automatic dispatch.
- No package version bump, publication, Wolfpack deployment, live task creation, commit, push, merge, or child-session cleanup is authorized by this plan.

## Sources of truth and worktree boundaries

- Review evidence and backlog: `/Users/home/Dev/wolfpack-pi-tasks/docs/reviews/post-step5-task-gateway-friction.md`.
- Canonical gateway contract and operations: `/Users/home/Dev/wolfpack-task-gateway/docs/task-gateway.md` and generated control API schema.
- Pi client/tool behavior: `/Users/home/Dev/wolfpack-pi-tasks/src/gateway-client.ts` and `src/extension.ts`.
- Preserve the existing nine-case isolated-process federation matrix and exact sender/receiver creation-timestamp regression unchanged.
- Preserve unrelated dirty gateway onboarding work in `README.md`, `package.json`, `tests/unit/task-gateway-docs.test.ts`, and `docs/task-gateway-onboarding.html`. Do not stage, rewrite, or fold it into this work. Add a separate documentation-contract test rather than editing the dirty onboarding test unless the user explicitly changes this boundary.
- Preserve unrelated Pi `.edc/`, plans 005/007/009/012, and review files. The plan and its status ledger are the only new planning artifacts.

## 1. Add structured send-validation paths

### 1a. Lock the failing behavior with tests

- In Wolfpack, add table-driven route/gateway tests for representative missing, wrong-type, empty, out-of-range, nested-ref, invalid remote-ref, and unexpected-property send inputs.
- Require `INVALID_REQUEST` failures to include a deterministic JSON Pointer in `error.path`, including correct RFC 6901 escaping for unexpected property names.
- Add control-schema contract coverage proving `TaskApiErrorEnvelope.error.path` is optional and string-valued; valid envelopes without a path remain accepted.
- In Pi Tasks, add gateway-client and extension tests proving a gateway-provided path survives parsing into `GatewayClientError`, structured tool details, and human-readable tool output. Add local preflight cases that identify their own send field without making HTTP requests.
- Keep valid send, idempotency, durable creation, and malformed-response behavior unchanged.

### 1b. Implement the smallest typed contract

- Extend the Wolfpack task error envelope/failure plumbing with optional `path`, and regenerate the canonical control API schema.
- Replace the current monolithic send-validation collapse with a small deterministic validator that returns field path plus reason. Apply it only to send request shape and send semantic validation; do not build a repository-wide validation framework.
- Attach paths to semantic send failures currently discovered below the HTTP shape layer, including timeout bounds and forbidden absolute remote context refs.
- Extend `GatewayClientError` with optional `path`; strictly validate an optional path in gateway error envelopes and preserve it without extracting semantics from `message`.
- Surface the path in `agent_task_send` error details and display text while preserving existing code/message/retryability behavior for every other tool.

### 1c. Document the correction path

- Keep one canonical minimal valid send envelope in Pi Tasks documentation and state that `error.path` points to the rejected send field.
- Document that correcting a pre-persistence validation error and retrying does not imply that a task was created; idempotency remains the protection when creation status is uncertain.

## 2. Separate changed files from artifacts

### 2a. Write artifact-guidance regressions first

- Add Pi extension/package tests requiring the `agent_task_done` artifact schema and prompt guidance to say that artifact paths are receiver-project-relative regular files, not a list of changed files.
- Require a concrete completion example with `result.changedFiles` separate from a valid relative artifact declaration.
- Add Wolfpack integration cases proving invalid/absolute, duplicate, unavailable, escaped, and symlinked artifact warnings identify the submitted path while valid projections and terminal acceptance remain unchanged.

### 2b. Improve tool guidance and warnings

- Update `agent_task_done` parameter descriptions and prompt guidance so agents report source modifications under structured result data and reserve `artifacts` for files a parent should inspect as gateway-resolved outputs.
- Update the Pi README and delegation skill with one concise changed-files-versus-artifacts example; reference the canonical Wolfpack artifact contract instead of duplicating protocol internals.
- Make per-entry `INVALID_ARTIFACT` warnings include the rejected path. Do not normalize unsafe input into acceptance and do not change warning codes, projection provenance, file checks, or completion state.
- Update the canonical Wolfpack guide only where needed to describe actionable per-path warnings.

## 3. Add the live-peer readiness checklist

### 3a. Define a non-mutating pass/fail sequence

- Add a canonical runbook section to Wolfpack's task-gateway guide that records: expected Wolfpack and Pi Tasks versions; peer HTTPS origin; `/api/info` reachability/version/machine identity; a non-mutating task-route probe whose expected response proves the route exists rather than returning 404/HTML; authentication blockers; structured target-session ID; installed pinned Pi Tasks package; and fresh Pi start or `/reload` completion.
- Define the outcome explicitly: all checks permit the existing live smoke sequence; any missing route, wrong version, auth failure, absent stable session ID, unconfirmed package load, or unreachable peer stops before task creation and is reported as fixture-only verification.
- Use existing `pi list`, pinned `pi install`, `/reload`, Wolfpack session-control, and HTTP inspection workflows. Do not invent runtime capability evidence that the current system cannot provide.

### 3b. Keep operator docs consistent

- Add a new focused Wolfpack documentation-contract test for the readiness section, avoiding the dirty onboarding test file.
- Update the Pi README and delegation skill to reference the canonical checklist before remote dispatch and to require operator-recorded package/reload evidence.
- Remove the now-false claim that no real second peer is available. State only what was actually proven: isolated coverage is the deterministic acceptance gate, while a specific live peer still requires the checklist at the time of use.
- Add Pi package-documentation assertions for the checklist and for removal of the stale availability claim.

## 4. Verify and independently review each slice

### 4a. Focused red/green verification

- For each task above, capture the focused test failing for the intended reason before production changes, then passing after the minimal implementation.
- Run focused Wolfpack tests for task routes, gateway semantics, artifact projection, schema contract, the isolated-process federation matrix, and exact replica equality.
- Run focused Pi Tasks tests for gateway-client parsing, extension tool output/guidance, and package documentation.
- Confirm invalid send retries create zero tasks before a valid retry and exactly one task after it; inspect the isolated task root rather than inferring persistence from HTTP prose.

### 4b. Independent reviews

- Dispatch three bounded independent reviews after implementation: one for structured send errors, one for artifact guidance/warnings, and one for peer-readiness documentation.
- Review structured errors for contract compatibility, JSON Pointer correctness, information exposure, and string-as-protocol regressions.
- Review artifacts for preservation of containment/symlink/regular-file checks and terminal-result behavior.
- Review readiness guidance for non-mutating commands, correct authority boundaries, and absence of runtime-registration claims.
- Resolve verified findings one at a time with a regression test where behavior changes; do not batch unrelated cleanup.

### 4c. Final verification gate

- Recheck this plan digest and inspect both repository diffs against the changed-file boundary.
- In Wolfpack, run `bun test`, `bun run typecheck`, `bun run gen:schema`, verify the regenerated schema has no unexplained drift, and run `git diff --check`.
- In Pi Tasks, run `bun test`, `bun run typecheck`, and `git diff --check`.
- Per repository instructions, the user supplies the final full-suite outputs; record those exact results in the status ledger before any completion claim.
- Verify no package version, deployment artifact, release metadata, unrelated plan, onboarding file, or excluded worktree file changed.

## Success criteria

- Every invalid send covered by the accepted scope returns `INVALID_REQUEST` with a machine-readable JSON Pointer, and Pi exposes that path without parsing error prose.
- Correcting the identified field leads to one durable task, with no task persisted by the rejected request.
- Completion guidance clearly separates `result.changedFiles` from `artifacts`; deliberate invalid artifacts still warn with their submitted paths and do not weaken validation.
- The live-peer checklist detects the known 404/version/package-load class before task creation and explicitly falls back to fixture-only verification.
- Existing federation, timestamp replica-equality, task lifecycle, trust, retry, acknowledgment, and artifact-security regressions pass unchanged.
- No speculative runtime machinery, release, deployment, or unrelated cleanup is introduced.
