# wolfpack-pi-tasks

Structured task delegation for Pi agents running inside Wolfpack sessions.

## goal

Wolfpack already gives you controllable terminal sessions. This plugin keeps
that model, but stops using terminal prose as the completion/result protocol.

The goal is that you can say things like:

> open a subagent and inspect the auth middleware

…and the parent agent can:

1. open/select a Wolfpack subagent session using existing Wolfpack controls
2. send the work as a structured task
3. keep working without blocking
4. check structured task state/results later
5. avoid polling terminal text to guess whether the subagent is done

## what this plugin does

- adds Pi tools for structured task delegation between Wolfpack sessions
- stores task state in the project-local `.wolfpack/tasks/` directory
- dispatches assignments through the existing Wolfpack CLI terminal input transport
- requires the target agent to finish via `agent_task_done`
- returns `terminate: true` from `agent_task_done`, so the target stops after submitting the result
- shows background inbox/status UI notifications without injecting task results into model context
- ships a skill so natural-language requests like “open a subagent and do x” route through this protocol

## how it works

Task state is file-backed under the active project:

```text
.wolfpack/tasks/<taskId>/
├── task.json        # current task metadata/status
├── assignment.json  # structured assignment sent to the target
├── events.jsonl     # append-only task event log
└── result.json      # terminal result, once completed/failed/cancelled/etc.
```

The parent sends work with `agent_task_send`. The tool creates a task directory,
writes the structured assignment, then delivers that assignment through the v1
Wolfpack terminal input transport with:

```bash
wolfpack session send <target-session> <assignment>
```

The target session receives the assignment in its normal terminal and completes
only by calling `agent_task_done`. Completion/result state is recorded in
`result.json`, not inferred from terminal prose.

## natural-language delegation

This package includes the `wolfpack-pi-task-delegation` skill.

With the package installed, the agent should handle prompts like:

- “open a subagent and inspect x”
- “spawn a worker to fix y”
- “delegate this to another Wolfpack session”
- “check on the subagent”

The skill does **not** duplicate Wolfpack session-control knowledge. It tells the
agent to use the existing `wolfpack-tailnet-control` skill for opening/selecting
sessions, then use this plugin’s structured task tools for the actual work and
result tracking.

## install

Install the package into Pi:

```bash
pi install -l ../wolfpack-pi-tasks
```

Every participating Pi session needs this package loaded. That includes spawned
subagent sessions. If the target session does not load the plugin, the task will
remain non-terminal until timeout or cancellation.

Temporary one-off run:

```bash
pi -e ../wolfpack-pi-tasks/src/extension.ts
```

## tools

### `agent_task_send`

Send a task to another Wolfpack session name or stable session id and return immediately.

Use when delegating work without waiting for completion.

### `agent_task_status`

Read compact structured status for a task.

### `agent_task_wait`

Wait for a task to become terminal.

Use only when the user wants the result now; otherwise prefer nonblocking send
plus later inbox/status checks.

### `agent_task_inbox`

List terminal tasks for the current parent session. Can acknowledge results after
reading them.

### `agent_task_cancel`

Cancel a non-terminal task in the shared task store.

### `agent_task_done`

Target-side completion tool. The target agent should call this exactly once as
its final action for an assigned task.

It records structured completion and terminates the target turn.

## statuses

Tasks can be:

- `pending`
- `dispatched`
- `running`
- `completed`
- `failed`
- `cancelled`
- `timed_out`
- `rejected`

Terminal statuses are first-writer-wins. Once a task is completed, failed,
cancelled, timed out, or rejected, conflicting later completions are rejected.

## constraints

This is intentionally plugin-only v1:

- no Wolfpack server changes
- no new Wolfpack task API
- no capability registry
- no terminal/prose polling for completion
- local/shared filesystem coordination only

Because dispatch uses existing Wolfpack session input, the plugin cannot prove
that the target session loaded the plugin. Missing target-side plugin support is
handled by timeout/cancel, not by capability negotiation.

## development

```bash
bun test
bun run typecheck
```
