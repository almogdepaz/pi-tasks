# action items: task preflight and structured workflow

status: aligned with v1 implementation
created: 2026-07-23

related:
- `../wolfpack-pi-tasks/.plans/004-task-preflight-structured-workflow.md`
- `../wolfpack/.plans/issue-pi-task-target-preflight-2026-07-23.md`

## problem and reasoning

The problem in the plan055 workflow was that subagent coordination lived in repeated prose instead of structured state, which burned tokens and caused review/dispatch churn.

How we got here:

1. measured the plan055 run
   - 67 task dispatches
   - ~103k chars of prompts
   - ~261k chars of results
   - ~91k direct protocol-ish tokens before counting file reads, diffs, tests, and logs
   - repeated typecheck/full-suite/diffcheck mentions across many tasks

2. identified the waste pattern
   - same context copied into many task prompts
   - agents returned essay-shaped results instead of compact structured evidence
   - some dispatches went to dead, wrong, or stale targets
   - fixes/reviews bounced one finding at a time
   - adversarial review happened late, so root-cause families were discovered serially

3. separated ownership
   - Wolfpack should not become an agent-task brain
   - Wolfpack only knows terminal/session truth: exists, alive, project, harness, stable id
   - Pi tasks owns task protocol, metadata, preflight decision, results, verification, and issue state

4. converted the pain into requirements
   - preflight before dispatch so dead/wrong targets fail early
   - `phaseId`, `issueId`, `role`, and `verificationTier` so tasks are grouped structurally
   - `contextRefs` so prompts point to files instead of pasting whole plans
   - compact `agent_task_done` schema so results do not become essays
   - tiered verification so full-suite gates happen at cluster/phase boundaries, not every micro-fix
   - later postmortem metrics so loops and waste are visible without vibes

5. selected the first implementation slice
   - implement the boring high-value core first: protocol/store metadata, context refs, preflight hook, `agent_task_send` integration, docs/skill update
   - postpone task board, postmortem, selector parsing, model aliases, and automatic verification capture

The solution is to stop treating agent delegation like terminal chat and make it a structured task protocol with preflight, references, compact results, and explicit verification evidence.

## action items

1. wolfpack: target liveness api
   - stabilize/extend `wolfpack session status <session-or-id> --json`
   - return `sessionId`, canonical name, project/projectDir, harness, terminal exists/alive/status
   - fail closed on unknown, ambiguous, or dead targets
   - keep pi/model/task semantics out of wolfpack

2. pi-tasks: dispatch preflight
   - add optional `TaskTransport.preflightTarget`
   - make `agent_task_send` run final preflight before dispatch
   - check target syntax/reachability, required context refs, active task conflicts, required project/model when authoritative facts exist
   - wire wolfpack transport to wolfpack liveness api when available

3. preflight failure behavior
   - v1 creates/returns a durable terminal `rejected` task for preflight failures
   - set `error.code = "preflight_failed"`
   - save preflight checks on `task.json`
   - do not write assignment or dispatch text on preflight failure (`assignmentRef` stays undefined)

4. protocol/store metadata
   - add optional `phaseId`, `issueId`, `role`, `verificationTier`, `rootCause`
   - store metadata outside `taskText`
   - include metadata in assignment envelope and compact results where useful

5. context refs
   - add `{ path, selector?, required?, purpose? }`
   - v1 validates required paths exist/readable relative to project cwd
   - selector is opaque and forwarded, not resolved yet

6. required model matching
   - exact string only for v1
   - run only when pi exposes authoritative target model facts
   - never infer model from terminal output or prose

7. verification evidence
   - manual only via `agent_task_done.result.verification[]`
   - support `command`, `status`, `exitCode`, `summary`, `durationMs`
   - no automatic command capture in first slice

8. compact structured result contract
   - standardize optional result fields: `issueId`, `verdict`, `changedFiles`, `verification`, `blockers`, `risks`, `next`
   - keep required `summary` short and capped

9. task board
   - postpone new `agent_task_board` post-v1
   - optionally expose cheap metadata in existing `status`/`inbox`
   - build board after preflight/protocol slice lands

10. postmortem metrics
   - postpone post-v1
   - later generate prompt/result chars, loops per issue, rejected/preflight failures, verification counts, full-suite count, and longest tasks/results

11. skills/docs
   - update delegation skill to require metadata for nontrivial work, context refs over copied plans, compact results, no terminal polling, and `onCompletePrompt`
   - update verification tier guidance: `smoke`, `focused`, `cluster`, `phaseGate`

## recommended first implementation slice

- tests + protocol/store metadata/contextRefs
- preflight hook
- `agent_task_send` integration
- docs/skill update
- wolfpack transport adapter after wolfpack json liveness is stable

## postpone

- task board tool
- postmortem generator
- selector resolution
- model aliases
- automatic verification capture
- separate boundary-review skill
