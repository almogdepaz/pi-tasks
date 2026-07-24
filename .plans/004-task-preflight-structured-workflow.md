# plan 004: task preflight and structured workflow protocol

status: v1 implemented; post-v1 task board/postmortem postponed
created: 2026-07-23
updated: 2026-07-24

## work log

- 2026-07-24: implementation started; architecture decisions requested from `looper-ai` via task `task_1c6e11d2dba340a7bfe0c79d2b207c1f`.
- 2026-07-24: `looper-ai` decisions: durable rejected records for created/idempotent preflight failures; context selectors opaque with path readability validation only; required model exact string but target model check deferred until Pi exposes it; verification evidence manual via `agent_task_done.result`; task board postponed post-v1.
- 2026-07-24: implemented v1 slice: metadata/context refs, structured result validation helper, optional transport preflight hook, automatic send preflight, active `issueId` conflict checks, README/skill updates.
- 2026-07-24: corrected v1 behavior: non-idempotent preflight failures are ephemeral; idempotent preflight failures create/reuse durable rejected records; required project checks use target project facts from transport preflight, not parent cwd; Wolfpack preflight maps `wolfpack session status <target> --json` structured output.
- 2026-07-24: verified with `bun test` (31 pass) and `bun run typecheck`.
- 2026-07-24: updated the Wolfpack transport adapter to the deployed PR219 contract: strict structured `terminal.exists/alive/status` readiness, canonical session/id evidence, `projectDir`/`projectPath` checks, bounded structured failures, and optional-vs-required availability semantics. Fake-exec regressions cover ready, dead, missing, ambiguous, project mismatch/missing, backend unavailable, invalid JSON, missing terminal liveness, and command errors. Live `wolfpack session status wolfpack-pi-tasks --json` returned the PR219 fields including canonical identity, both project paths, and `terminal: { exists: true, alive: true, status: "ready" }`; invoking the transport adapter against that live command produced passed `transport_reachable` and `target_project_dir` checks. Verified with `bun test` (45 pass) and `bun run typecheck`.

## goal

reduce wasted multi-agent coordination by moving dispatch readiness, task identity, context references, verification evidence, and compact results into the Pi task communication protocol instead of repeating them in prose prompts.

## success state

`agent_task_send` can fail before dispatch when the target is not reachable/ready, tasks carry structured phase/issue/role/verification metadata, assignments can point at context artifacts instead of copying long plans, results are compact and machine-readable, and a postmortem can report task-loop cost without parsing terminal output or agent prose.

## ownership boundary

`pi-tasks` owns:

- agent task protocol and store records
- task dispatch preflight decision
- target model/task readiness checks when Pi exposes them
- context refs and assignment shape
- compact result/verification schema
- task board and postmortem metrics

Wolfpack owns only terminal/session facts when used as a transport:

- session exists
- broker/server can address the session
- terminal/pty is alive or stale/dead
- project path/harness/session identity if known

Wolfpack must not decide Pi model readiness, task issue semantics, verification tiers, or completion state.

## problem evidence from plan055 workflow

Observed in `.pi/tasks` for the plan055 run:

- 67 plan-related task dispatches
- ~103k chars of task prompts and ~261k chars of task results
- repeated gate checks: typecheck mentioned 61 times, full-suite/full-suite-like verification 31 times, diff checks 48 times
- dead or invalid target dispatches occurred before task delivery failed/rejected
- related root-cause families were discovered serially through review loops instead of being grouped up front

The fix is not less review. The fix is less repeated context, earlier boundary failure matrices, and machine-readable task state.

## non-goals

- do not make `pi-tasks` a session/terminal spawner
- do not infer completion from terminal output
- do not make Wolfpack a model/task authority
- do not require every transport to implement liveness on day one
- do not break current `agent_task_send/status/wait/inbox/cancel/done` behavior
- do not force a plan-file convention on simple one-off tasks

## phase 1: dispatch preflight

### behavior

Add an optional preflight step before store task creation/dispatch.

Checks are composed from protocol-level facts and optional transport facts:

1. target address is syntactically acceptable for the transport
2. no conflicting active task exists for the same target + `issueId` when supplied
3. context refs exist/read as allowed before dispatch when supplied
4. required model matches if Pi can expose active target model
5. target is reachable/alive if the transport supports liveness
6. transport-specific readiness passes

If required preflight fails, `agent_task_send` returns a rejected preflight result without delivering assignment text. V1 returns an ephemeral rejected tool result for non-idempotent sends. When `idempotencyKey` is supplied, V1 creates or reuses a durable terminal `rejected` task record with `error.code = "preflight_failed"`, saved preflight checks, and no `assignmentRef`.

### protocol shape

```ts
interface TaskPreflightRequirement {
  readonly requiredProjectDir?: string;
  readonly requiredModel?: string;
  readonly requireIdle?: boolean;
  readonly requireReachable?: boolean;
}

interface TaskPreflightCheck {
  readonly name: string;
  readonly status: "passed" | "failed" | "unavailable" | "skipped";
  readonly message?: string;
  readonly source: "pi" | "transport" | "store" | "protocol";
}

interface TaskPreflightResult {
  readonly ok: boolean;
  readonly checks: readonly TaskPreflightCheck[];
  readonly targetSession: string;
}
```

### transport extension point

```ts
interface TaskTransport {
  // existing
  readonly dispatchTask: (input: DispatchTaskInput) => Promise<DispatchTaskResult>;

  // new optional hook
  readonly preflightTarget?: (input: PreflightTargetInput) => Promise<TaskPreflightResult>;
}
```

Transports that do not implement `preflightTarget` remain supported. Their liveness check is `unavailable`, not failed, unless the caller explicitly requires reachability.

## phase 2: task metadata

Add optional structured fields to task creation and persisted records:

```ts
interface TaskWorkflowMetadata {
  readonly phaseId?: string;
  readonly issueId?: string;
  readonly role?: "planner" | "implementor" | "reviewer" | "integrator" | "observer" | string;
  readonly verificationTier?: "smoke" | "focused" | "cluster" | "phaseGate" | string;
  readonly rootCause?: string;
}
```

Rules:

- metadata is optional for backward compatibility
- metadata must be stored outside `taskText`
- `issueId` drives duplicate active-task detection when present
- task board and postmortem group by `phaseId`, `issueId`, `role`, and `rootCause`

## phase 3: context refs

Add bounded context references to `agent_task_send` and assignment envelopes.

```ts
interface ContextRef {
  readonly path: string;
  readonly selector?: string; // e.g. json pointer, heading, or line range; exact syntax to define in implementation
  readonly required?: boolean;
  readonly purpose?: string;
}
```

Rules:

- refs are references, not copied context
- project-local refs are resolved relative to `ctx.cwd`
- required missing/unreadable refs fail preflight
- v1 treats `selector` as opaque metadata; it does not resolve line ranges, headings, or JSON pointers
- assignment envelope includes refs so the target can read them explicitly
- no model-visible automatic expansion in the sender unless a later phase adds bounded summaries

Intended files for complex workflows:

```text
.plans/current.md
.plans/issues.json
.plans/verification.json
.plans/ledger.md
```

## phase 4: compact result and verification schema

Extend `agent_task_done` payload guidance with a compact structured contract.

```ts
interface TaskVerificationEvidence {
  readonly command?: string;
  readonly status: "passed" | "failed" | "skipped" | "not_run";
  readonly exitCode?: number;
  readonly summary?: string;
  readonly durationMs?: number;
}

interface StructuredTaskResult {
  readonly issueId?: string;
  readonly verdict: "completed" | "changes_required" | "rejected" | "failed" | "cancelled";
  readonly changedFiles?: readonly string[];
  readonly verification?: readonly TaskVerificationEvidence[];
  readonly blockers?: readonly {
    readonly id?: string;
    readonly severity?: string;
    readonly evidence: string;
    readonly minimalFix?: string;
  }[];
  readonly risks?: readonly string[];
  readonly next?: string;
}
```

Keep existing `summary` required and capped. Store the structured result under `result`, but document the expected shape and add validation helpers/tests.

## phase 5: task board and issue state

status: postponed post-v1 per `looper-ai` decision on 2026-07-24.

Add read APIs/helpers that summarize task state without loading every result body into prompt context.

Minimum compact board fields:

```ts
interface TaskBoardIssueSummary {
  readonly phaseId?: string;
  readonly issueId?: string;
  readonly status: "pending" | "active" | "blocked" | "ready_for_review" | "closed";
  readonly activeTaskIds: readonly string[];
  readonly latestVerdict?: string;
  readonly blockerCount: number;
}
```

Expose through either:

- `agent_task_board` tool, or
- compact mode on `agent_task_inbox/status`, or
- both if tests prove distinct use.

Do not parse task prose to infer issue state; only use metadata and structured result fields.

## phase 6: postmortem metrics

status: postponed post-v1 with task board.

Add a deterministic report generator over task records:

- task count by phase/issue/role
- prompt/result chars by phase/issue
- rejected/preflight-failed dispatches
- loops per issue
- verification command counts by tier
- full-suite count
- longest task prompts/results
- root-cause churn

This can start as a CLI/test helper or tool result. It should not require provider token telemetry; char counts are acceptable as first-order evidence.

## phase 7: skills/docs update

Update the task delegation skill to require:

- use structured metadata for non-trivial work
- use context refs instead of copying full plans when refs exist
- use preflight before dispatch when target readiness matters
- use `onCompletePrompt` for parent follow-up
- use compact structured result shape
- do not poll terminals for task completion

Add a boundary-review skill or section for large implementations:

- classify boundary: identity, redaction, cache/parser, subprocess, artifact lifecycle, capability/provenance
- write adversarial matrix before implementation
- group issues by `rootCause` when the same boundary owns the fix

Update verification guidance to support tiers:

```json
{
  "smoke": ["new regression only"],
  "focused": ["targeted suite", "typecheck if types touched"],
  "cluster": ["focused suite", "diff check"],
  "phaseGate": ["full suite", "typecheck", "diff check"]
}
```

## wolfpack dependency

For the Wolfpack transport, `pi-tasks` needs a stable machine-readable way to inspect a Wolfpack target before dispatch. See the Wolfpack issue file:

`../wolfpack/.plans/issue-pi-task-target-preflight-2026-07-23.md`

Expected use:

```text
agent_task_send
→ pi-tasks protocol/store checks
→ wolfpack transport calls wolfpack session status/preflight --json
→ pi-tasks combines transport liveness with Pi/task/model readiness
→ assignment dispatch only if required checks pass
```

## implementation order

1. [x] add protocol/store tests for metadata + context refs + compact result validation helpers
2. [x] add optional `TaskTransport.preflightTarget` with fake transport tests
3. [x] add automatic preflight inside `agent_task_send`
4. [x] add Wolfpack transport preflight adapter once Wolfpack exposes stable JSON facts
5. [ ] add task board compact summaries (post-v1)
6. [ ] add postmortem report generator (post-v1)
7. [x] update README and delegation skill
8. [ ] add boundary-review and verification-tier docs/skills

## verification plan

- [x] unit tests for preflight pass/fail/unavailable/skipped states
- [x] store tests for metadata persistence and idempotency
- [x] protocol tests for assignment envelope compatibility
- [x] extension tests for `agent_task_send` preflight rejection without dispatch
- [x] extension tests for ephemeral vs idempotent durable preflight rejection
- [x] fake transport tests for liveness unavailable vs failed
- [x] fake transport tests for required target project matching from transport facts
- [x] Wolfpack transport preflight mapping tests
- [x] result validation tests for compact structured payloads
- [ ] postmortem fixture tests over recorded task directories (post-v1)
- [x] `bun test`
- [x] `bun run typecheck`

## decisions

1. pure preflight failure is ephemeral unless `idempotencyKey` is supplied; idempotent preflight failure creates/reuses a durable rejected task record with `error.code = "preflight_failed"` and no `assignmentRef`.
2. `contextRefs.selector` is opaque in this implementation; preflight validates project-local path readability only.
3. `requiredModel` is exact string only, but active target model inspection is deferred until Pi exposes it; current check reports `unavailable`.
4. verification evidence is collected manually through `agent_task_done.result.verification`.
5. task board/postmortem are postponed post-v1.
