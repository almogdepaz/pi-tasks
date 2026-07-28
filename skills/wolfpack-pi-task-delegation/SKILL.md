---
name: wolfpack-pi-task-delegation
description: Use this whenever the user asks to open, spawn, create, or use a Wolfpack/Pi subagent to do work, delegate work to another session, check delegated task results, or clean up completed child sessions. This skill connects existing Wolfpack session-control knowledge with the agent_task communication tools so agents spawn/select sessions, send work with agent_task_send, avoid terminal-output completion polling, and apply parent-owned session cleanup.
---

# Wolfpack Pi Task Delegation

This skill is the Wolfpack transport guidance for the task communication layer. It does not replace `wolfpack-tailnet-control`; use that
skill/instructions for opening, selecting, inspecting, or controlling Wolfpack
sessions.

## Goal

When the user says something like “open a subagent and do X”, create or select a
Wolfpack/Pi session using existing Wolfpack control, then send X through the
structured `agent_task_*` task communication tools. Keep Wolfpack terminals
visible and steerable, but treat task state/results as the protocol.

## Workflow

1. If the request includes opening/spawning/creating a subagent, use the
   existing Wolfpack control workflow (`wolfpack-tailnet-control`) to create the
   session. Prefer the canonical CLI path:

   ```bash
   wolfpack agent spawn <project> --prompt 'you are a task worker. wait for structured pi.task.assignment.v1 assignments; finish assigned work only with agent_task_done.' --json
   ```

   `wolfpack session open <project> --prompt ... --json` is a deprecated alias;
   use it only when that is the available command in the environment.

2. Parse the structured JSON response from Wolfpack for the created session
   handle/name/id. Treat it as opaque. Do not infer the target from browser UI
   labels, terminal prose, or pane previews. Before dispatch, verify the target
   loaded the pi-tasks extension/tools and can access the same shared task store.
   Establish tool availability during target setup; Wolfpack liveness does not
   prove Pi tool availability. If either capability is missing, fail before
   dispatch and instruct setup instead of sending an essay that cannot complete
   through the protocol.

3. Send the real work with `agent_task_send` to the selected/spawned session.
   Keep task text compact and action-oriented; state the outcome, scope, and
   constraints, but do not copy an entire implementation plan into `task`. For
   non-trivial work, require structured `metadata` with `phaseId`, `issueId`,
   `role`, `verificationTier`, and `rootCause` when known instead of encoding
   these fields in prose. Use `contextRefs` for existing plans, docs, diffs, and
   verification files instead of pasting their contents. Batch findings that
   share a root cause into one issue/task rather than creating review ping-pong
   with one task per finding.

   For readiness-sensitive work, set `preflight.requireReachable: true` and set
   `preflight.requiredProjectDir` when the target project matters. Wolfpack
   readiness comes only from structured `wolfpack session status <target>
   --json` terminal/session facts, never terminal prose. If the parent must do
   something specific when the result arrives, set `onCompletePrompt` with that
   parent-side follow-up. Example: “review the worker’s implementation diff
   before reporting completion.” Do not put parent-review instructions in the
   worker task unless the worker must do them.

4. Return immediately with the task id and target session. normal delegation
   requests are fire-and-forget. Do not call `agent_task_wait` after dispatch;
   use it only when the current user message explicitly asks to block for the
   result now. If preflight fails without `idempotencyKey`, the tool result is
   ephemeral and has no task id because no task directory was created. Continue
   local work if there is other useful work to do. When the task finishes, the
   idle inbox notification will remind the parent of any sender-defined
   `onCompletePrompt`.

5. Use structured task tools for follow-up:
   - `agent_task_status` for one task without blocking
   - `agent_task_wait` only when the current user message explicitly asks to block
   - `agent_task_inbox` to check completed delegated work
   - `agent_task_cancel` to cancel non-terminal tasks

6. In target sessions, finish assigned tasks with `agent_task_done`. Keep the
   required `summary` at or below 1200 characters and put machine-readable
   details under `result`: `issueId`, `verdict`, `changedFiles`, `verification`,
   `blockers`, `risks`, and `next` when useful. Verification entries should
   include the exact command, status, exit code, and short summary where
   applicable. After `agent_task_done`, do not send extra prose or attempt
   session cleanup; the tool result is the completion channel and must remain
   the worker's final action.

7. The parent owns cleanup for child sessions it spawned:
   - First receive and acknowledge the terminal structured task result.
   - Keep an implementer session alive while independent review or immediate
     correction work may reuse it.
   - After the result is accepted, no correction is pending, and no other task
     is assigned to that child, close it through the canonical Wolfpack control
     workflow in `wolfpack-tailnet-control`.
   - Close single-use reviewer sessions after acknowledging their results.
   - For cancelled or timed-out work, resolve the structured task state before
     closing the session; never use terminal prose to infer task completion.
   - Do not close a pre-existing session merely because it was selected as a
     task target. Cleanup ownership applies to sessions this parent spawned,
     unless the user explicitly asks otherwise.

   Pi task completion and Wolfpack session lifecycle remain separate: the task
   extension reports completion; the parent decides when reuse is over; Wolfpack
   performs the actual close.

## Store Boundary

Use cross-repo `agent_task_send` only when parent and target can access a shared
or global task store. The filesystem store is project-local, so separate repos
normally do not share task state. Until a shared store exists, direct
`wolfpack session send <target> <compact-instruction>` is only a fallback
instruction channel, not a task completion protocol. Do not use symlinks to fake
a shared store.

## Do Not

- Do not call `agent_task_wait` after dispatch unless the current user message
  explicitly asks to block for the result now.
- Do not poll terminal output to decide that delegated work is complete.
- Do not ask the target to report completion in prose.
- Do not use `wolfpack session wait` for task completion; it waits for literal
  terminal text and is the wrong protocol for this package.
- Do not copy whole plan files into task prompts when `contextRefs` can point at
  the source file.
- Do not split related review findings into one task each when they share an
  issue/root cause.
- Do not duplicate Wolfpack session-control rules here. If session control is
  ambiguous, consult/use `wolfpack-tailnet-control`.
- Do not make workers kill their own sessions or auto-close a session directly
  from `agent_task_done`; either can race result delivery and prevents deliberate
  worker reuse.
- Do not leave parent-spawned child sessions running after their structured
  results are accepted and no follow-up work remains.

## Examples

User: “open a subagent and inspect the auth middleware”

Expected approach:
1. Spawn a Wolfpack child session with the existing Wolfpack control workflow.
2. Call `agent_task_send` with the spawned session as `to`, “inspect the auth
   middleware and report actionable boundary risks” as `task`, plus `metadata`
   such as `{ "phaseId": "phase-1", "issueId": "auth-review", "role":
   "reviewer", "verificationTier": "focused", "rootCause": "auth-boundary" }`.
3. Prefer `contextRefs` like `{ "path": ".plans/current.md", "required": true
   }` over pasted plan text.
4. If follow-up is needed, set `onCompletePrompt`, e.g. “review the worker’s
   findings before reporting back.”
5. Tell the user the task id and that structured results will arrive through the
   async inbox notification. Do not wait for the result.

User: “check on the subagent”

Expected approach:
- Use `agent_task_inbox` or `agent_task_status`; do not read terminal prose to
  infer done-ness.
