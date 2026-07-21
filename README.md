# pi-tasks

Structured task communication for Pi agents.

`pi-tasks` lets one Pi session hand work to another agent, session, process, or
worker and get durable structured results back. Wolfpack is the default
transport, but the core model is not Wolfpack-specific.

## what this is

A task lifecycle and communication layer:

1. create a structured assignment
2. persist task state in a store
3. dispatch the assignment through a transport
4. let the sender keep working
5. record status/results in structured files/data, not terminal prose
6. require the assignee to finish through the task protocol

## what this is not

This is **not** a subagent spawner. Use Wolfpack, another process manager, HTTP
workers, queues, cron jobs, or your own runner to create/host agents. `pi-tasks`
only gives those agents a shared task protocol.

## mental model

`pi-tasks` separates task state from assignment delivery:

```text
parent pi session
  agent_task_send
    ↓
  TaskStore      creates task + durable refs
  TaskTransport  delivers assignment text to target
    ↓
target runner/session/worker
  receives pi.task.assignment.v1
  does work
  completes task through agent_task_done or equivalent store/server completion API
    ↓
parent pi session
  agent_task_status / agent_task_wait / agent_task_inbox
```

The `to` field is transport-specific. For Wolfpack it is a session name/id. For
HTTP it might be a worker id. For a queue it might be a queue/topic name. For a
local CLI transport it might be a tmux pane, process id, or script target.

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

Every participating Pi session must load this extension. If a target Pi session
does not have `agent_task_done`, the sender can still create/dispatch the task,
but it will remain non-terminal until timeout or cancellation.

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

## using without wolfpack

You have two choices:

1. reuse the filesystem store and write only a transport
2. replace both store and transport when task state needs to live remotely

Most integrations should start with option 1. Storage is already generic; only
identity and delivery are environment-specific.

### pattern 1: another way to message pi sessions

Use this when your targets are still Pi sessions, but delivery is not Wolfpack:
for example tmux, screen, ssh, a local supervisor, or a custom session manager.

You implement:

- `getCurrentSessionName(env)` — stable name for the current Pi session
- `dispatchTask({ target, assignment })` — send assignment text to the target

You keep:

- `createFilesystemTaskStore({ tasksDir: ".pi/tasks" })`
- `agent_task_done` in the target Pi session
- `agent_task_status`, `agent_task_wait`, and `agent_task_inbox` in the parent

Example local CLI transport:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentTaskTools } from "pi-tasks/src/extension";
import { createFilesystemTaskStore } from "pi-tasks/src/stores/filesystem";
import type { TaskTransport } from "pi-tasks/src/task-communication";

function createCliTransport(pi: ExtensionAPI): TaskTransport {
  return {
    name: "local-cli",
    getCurrentSessionName(env) {
      return env.PI_TASK_SESSION ?? env.USER ?? "unknown-session";
    },
    async dispatchTask({ target, assignment, signal }) {
      const result = await pi.exec("my-session-send", [target, assignment], { signal });
      if (result.code === 0) return { ok: true };
      return {
        ok: false,
        message: result.stderr || result.stdout || "my-session-send failed",
        retryable: true,
      };
    },
  };
}

export default function extension(pi: ExtensionAPI): void {
  registerAgentTaskTools(pi, {
    store: createFilesystemTaskStore({ tasksDir: ".pi/tasks" }),
    transport: createCliTransport(pi),
  });
}
```

### pattern 2: http workers

Use this when a service owns worker processes and can receive assignments over
HTTP. If workers are Pi sessions, have them call `agent_task_done`. If workers are
not Pi sessions, expose a completion endpoint or let workers import/use your
store implementation directly.

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
  async dispatchTask({ target, assignment, task, signal }) {
    const response = await fetch(`https://tasks.example/sessions/${target}/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.id, assignment }),
      signal,
    });

    if (response.ok) return { ok: true };

    return {
      ok: false,
      message: await response.text(),
      retryable: response.status >= 500,
    };
  },
};

export default function extension(pi: ExtensionAPI): void {
  registerAgentTaskTools(pi, {
    store: createFilesystemTaskStore({ tasksDir: ".pi/tasks" }),
    transport: httpTransport,
  });
}
```

For non-Pi HTTP workers, the server needs a matching completion path. The worker
should report a terminal result equivalent to:

```json
{
  "taskId": "task_...",
  "status": "completed",
  "summary": "finished the assigned work",
  "result": {}
}
```

The important part is not the HTTP shape; it is preserving the task lifecycle:
once terminal, no second completion can replace it.

### pattern 3: file inbox / polling workers

Use this when a local worker watches a directory or queue instead of receiving a
pushed message.

One simple design:

- store tasks in `.pi/tasks`
- transport writes assignment text to `.pi/task-inbox/<target>/<taskId>.txt`
- worker watches its inbox directory
- worker reads the assignment, does the work, then completes through a store API
  or by invoking a Pi session that has `agent_task_done`

That transport can return `{ ok: true }` once the assignment file is durably
written. Completion is still separate and later.

### when to implement a custom store

Do **not** implement a custom store just because you have a new dispatch
mechanism. Implement `TaskStore` only when task state itself must be somewhere
else:

- a central HTTP service
- Redis/Postgres/SQLite shared by multiple machines
- a multi-host queue system
- a hosted control plane

If only delivery changes, keep the filesystem store.

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

Assigned Pi agents must call `agent_task_done` as their final action:

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

Non-Pi workers should complete through an equivalent store/server API with the
same terminal status and payload semantics.

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
  expireTaskIfOverdue(...): Promise<...>;
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

Registration composes both:

```ts
registerAgentTaskTools(pi, {
  store: createFilesystemTaskStore({ tasksDir: ".pi/tasks" }),
  transport: myTransport,
});
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
- `src/store.ts`
  - low-level filesystem store functions, if you need finer control than
    `createFilesystemTaskStore`

## development

```bash
bun install
bun test
bun run typecheck
```

## current limitations

- no built-in HTTP/Redis transport yet
- no runtime transport selector yet; compose a store/transport in an extension
- default extension still uses Wolfpack transport for compatibility
- package is source-first and currently marked private in `package.json`; install locally with Pi
