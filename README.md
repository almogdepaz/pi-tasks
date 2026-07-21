# pi-tasks

Task communication for Pi agents, with Wolfpack as the default v1 transport.

## goal

This package defines a durable task protocol for agent-to-agent work handoff:

1. create a structured assignment
2. persist task state in a generic store
3. dispatch the assignment through a transport
4. let the sender continue without blocking
5. record structured status/results independently of terminal prose
6. let the assignee finish with `agent_task_done`

It is not a subagent spawner. Subagents, Wolfpack sessions, HTTP workers, or any
other task runner can sit behind the same communication contract.

## architecture

The package is split into:

- protocol/types: assignment/result/event/status contracts
- store: durable task lifecycle (`create`, `read`, `wait`, `inbox`, `ack`, `cancel`, `complete`)
- transport: session identity + assignment delivery
- Pi extension: registers the `agent_task_*` tools over a composed store+transport layer

For v1, selection is internal factory-based. The default extension composes:

- `createFilesystemTaskStore({ tasksDir: ".wolfpack/tasks" })`
- `createWolfpackTaskTransport({ exec: pi.exec })`

Other packages can import `registerAgentTaskTools` and provide:

```ts
{
  store: createFilesystemTaskStore({ tasksDir: ".pi/tasks" }),
  transport: myTransport,
}
```

## task storage

Generic filesystem storage defaults to `.pi/tasks/`. The default Wolfpack
composition preserves the existing project-local path:

```text
.wolfpack/tasks/<taskId>/
├── task.json
├── assignment.json
├── events.jsonl
└── result.json
```

## wolfpack default transport

The parent sends work with `agent_task_send`. The tool creates a task record,
builds a `pi.task.assignment.v1` assignment, then the Wolfpack transport dispatches:

```bash
wolfpack session send <target-session> <assignment>
```

The target session completes only by calling `agent_task_done`. Completion/result
state is recorded in `result.json`, not inferred from terminal output.

Every participating Pi session needs this package loaded. If the target session
does not load it, the task remains non-terminal until timeout or cancellation.

## supporting another transport

Most integrations only need a `TaskTransport`:

- `getCurrentSessionName(env)` — identify this running agent/session
- `dispatchTask(input)` — deliver assignment text to a target

Use the shared filesystem store unless you need centralized/remote persistence.
Only implement a new `TaskStore` when task state should live somewhere else
(server, redis, database, etc.).

## tools

- `agent_task_send` — create a task and dispatch it through the configured transport
- `agent_task_status` — read compact structured task status
- `agent_task_wait` — wait for a terminal status when the user wants the result now
- `agent_task_inbox` — list terminal tasks for the current parent session
- `agent_task_cancel` — cancel a non-terminal task
- `agent_task_done` — assignee-side structured completion tool

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

Terminal statuses are first-writer-wins.

## install

Install the package into Pi:

```bash
pi install -l ../pi-tasks
```

Temporary one-off run:

```bash
pi -e ../pi-tasks/src/extension.ts
```

## development

```bash
bun test
bun run typecheck
```
