# pi-tasks

Structured task communication for Pi agents.

`pi-tasks` lets one Pi session hand work to another agent/session/worker and get
back durable structured results. Wolfpack is the default transport, but the core
model is not Wolfpack-specific.

## what this is

A task lifecycle and communication layer:

1. create a structured assignment
2. persist task state in a store
3. dispatch the assignment through a transport
4. let the sender keep working
5. record status/results in structured files/data, not terminal prose
6. require the assignee to finish with `agent_task_done`

## what this is not

This is **not** a subagent spawner. Use Wolfpack, another process manager, HTTP
workers, queues, or your own runner to create/host agents. `pi-tasks` only gives
those agents a shared task protocol.

## default behavior

The default Pi extension composes:

- filesystem store at `.wolfpack/tasks/` for compatibility with the original
  Wolfpack-focused plugin
- Wolfpack transport using `wolfpack session send`

Generic filesystem storage defaults to `.pi/tasks/` when used directly.

## install

Install locally into Pi:

```bash
pi install -l ../pi-tasks
```

Temporary one-off run:

```bash
pi -e ../pi-tasks/src/extension.ts
```

Every participating Pi session must load this extension. If a target session does
not have `agent_task_done`, the sender can still create/dispatch the task, but it
will remain non-terminal until timeout or cancellation.

## quick start with wolfpack

1. open or select a Wolfpack target session.
2. from the parent Pi session, call `agent_task_send`:

```json
{
  "to": "target-session-name",
  "task": "inspect the auth middleware and report risks",
  "timeoutMs": 1800000
}
```

3. keep working locally. do **not** poll terminal text for completion.
4. later, call `agent_task_status`, `agent_task_wait`, or `agent_task_inbox`.
5. the target session must finish by calling `agent_task_done` exactly once.

Wolfpack dispatch command used internally:

```bash
wolfpack session send <target-session> <assignment>
```

## tools

| tool | purpose |
| --- | --- |
| `agent_task_send` | create a task and dispatch it through the configured transport |
| `agent_task_status` | read compact structured status for one task |
| `agent_task_wait` | wait in tool code for a terminal result when the user wants it now |
| `agent_task_inbox` | list terminal tasks for the current parent session |
| `agent_task_cancel` | cancel a non-terminal task |
| `agent_task_done` | assignee-side structured completion; terminates the target response |

### completion contract

Assigned agents must call `agent_task_done` as their final action:

```json
{
  "taskId": "task_...",
  "status": "completed",
  "summary": "inspected auth middleware; no bypass found",
  "result": {
    "filesReviewed": ["src/auth.ts"]
  }
}
```

Valid terminal statuses:

- `completed`
- `failed`
- `cancelled`
- `timed_out`
- `rejected`

Terminal completion is first-writer-wins.

## task protocol

Assignments are delivered as human-readable text plus a structured envelope with:

- `type: "pi.task.assignment.v1"`
- `taskId`
- `fromSession`
- `instructions`
- protocol requirements telling the assignee to use `agent_task_done`

Task state includes:

- `pending`
- `dispatched`
- `running`
- terminal status
- assignment/result refs
- event history
- optional result payload/artifacts/error

Filesystem layout:

```text
<tasksDir>/<taskId>/
├── task.json
├── assignment.json
├── events.jsonl
└── result.json
```

## architecture

`pi-tasks` separates storage from delivery:

```ts
interface TaskStore {
  createOrReuseDispatchedTask(...): Promise<...>;
  readTask(...): Promise<...>;
  readTaskResult(...): Promise<...>;
  waitForTask(...): Promise<...>;
  listInbox(...): Promise<...>;
  ackTask(...): Promise<...>;
  cancelTask(...): Promise<...>;
  completeTask(...): Promise<...>;
}

interface TaskTransport {
  getCurrentSessionName(env): string;
  dispatchTask(input): Promise<DispatchTaskResult>;
}
```

Most integrations only need a new `TaskTransport`; reuse the filesystem store
unless task state must live in a remote system.

## custom transport example

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentTaskTools } from "pi-tasks/src/extension";
import { createFilesystemTaskStore } from "pi-tasks/src/stores/filesystem";
import type { TaskTransport } from "pi-tasks/src/task-communication";

const httpTransport: TaskTransport = {
  name: "http",
  getCurrentSessionName(env) {
    return env.PI_TASK_SESSION ?? "unknown-session";
  },
  async dispatchTask({ target, assignment, signal }) {
    const response = await fetch(`https://tasks.example/sessions/${target}`, {
      method: "POST",
      body: assignment,
      signal,
    });
    if (response.ok) return { ok: true };
    return { ok: false, message: await response.text(), retryable: response.status >= 500 };
  },
};

export default function extension(pi: ExtensionAPI): void {
  registerAgentTaskTools(pi, {
    store: createFilesystemTaskStore({ tasksDir: ".pi/tasks" }),
    transport: httpTransport,
  });
}
```

## exported building blocks

- `src/extension.ts`
  - `registerAgentTaskTools`
  - `createDefaultTaskCommunicationLayer`
- `src/task-communication.ts`
  - `TaskStore`
  - `TaskTransport`
  - `TaskCommunicationLayer`
- `src/stores/filesystem.ts`
  - `createFilesystemTaskStore`
- `src/transports/wolfpack.ts`
  - `createWolfpackTaskTransport`
  - `WOLFPACK_TASKS_DIR`
- `src/protocol.ts`
  - `buildAssignment`
  - `compactTaskResult`

## development

```bash
bun install
bun test
bun run typecheck
```

## current limitations

- no built-in HTTP/Redis transport yet
- no runtime backend selector yet; compose a store/transport in an extension
- default extension still uses Wolfpack transport for compatibility
- package is source-first and currently marked private in `package.json`; install locally with Pi
