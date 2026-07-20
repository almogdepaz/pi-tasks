---
name: wolfpack-pi-task-delegation
description: Use this whenever the user asks to open, spawn, create, or use a Wolfpack/Pi subagent to do work, delegate work to another session, or check delegated task results. This skill connects existing Wolfpack session-control knowledge with the wolfpack-pi-tasks structured tools so agents spawn/select sessions, send work with agent_task_send, and avoid terminal-output completion polling.
---

# Wolfpack Pi Task Delegation

This skill is only about structured task delegation. It does not replace the
existing `wolfpack-tailnet-control` skill; use that skill/instructions for the
Wolfpack mechanics of opening, selecting, inspecting, or controlling sessions.

## Goal

When the user says something like “open a subagent and do X”, create or select a
Wolfpack/Pi session using existing Wolfpack control, then delegate X with the
structured task tools from this package. Keep normal Wolfpack terminal sessions
visible and steerable, but treat task state as the protocol.

## Workflow

1. If the request includes opening/spawning/creating a subagent, use the
   existing Wolfpack control workflow (`wolfpack-tailnet-control`) to create the
   session. Prefer the canonical CLI path:

   ```bash
   wolfpack agent spawn <project> --prompt 'you are a wolfpack task worker. wait for structured agent_task assignments; finish assigned work only with agent_task_done.' --json
   ```

   `wolfpack session open <project> --prompt ... --json` is a deprecated alias;
   use it only when that is the available command in the environment.

2. Parse the structured JSON response from Wolfpack for the created session
   handle/name/id. Treat it as opaque. Do not infer the target from browser UI
   labels, terminal prose, or pane previews.

3. Send the real work with `agent_task_send` to the selected/spawned session.
   The task text should be the user’s requested work, not the bootstrap prompt.

4. Return immediately with the task id and target session unless the user asked
   to wait. Continue local work if there is other useful work to do.

5. Use structured task tools for follow-up:
   - `agent_task_status` for one task
   - `agent_task_wait` only when the user wants the result now
   - `agent_task_inbox` to check completed delegated work
   - `agent_task_cancel` to cancel non-terminal tasks

6. In target sessions, finish assigned tasks with `agent_task_done`. After
   `agent_task_done`, do not send extra prose; the tool result is the completion
   channel.

## Do Not

- Do not poll terminal output to decide that delegated work is complete.
- Do not ask the target to report completion in prose.
- Do not use `wolfpack session wait` for task completion; it waits for literal
  terminal text and is the wrong protocol for this package.
- Do not duplicate Wolfpack session-control rules here. If session control is
  ambiguous, consult/use `wolfpack-tailnet-control`.

## Examples

User: “open a subagent and inspect the auth middleware”

Expected approach:
1. Spawn a Wolfpack child session with the existing Wolfpack control workflow.
2. Call `agent_task_send` with the spawned session as `to` and “inspect the auth
   middleware” as `task`.
3. Tell the user the task id and that you’ll check structured results later.

User: “check on the subagent”

Expected approach:
- Use `agent_task_inbox` or `agent_task_status`; do not read terminal prose to
  infer done-ness.
