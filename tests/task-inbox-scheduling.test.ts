import { expect, test } from "bun:test";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { createTaskWorkScope } from "../src/task-work-scope";
import { TASK_PROTOCOL_VERSION, TaskProtocolError, type RelayEnvelope, type TaskRelay } from "../src/task-protocol";

const origin = { relay: "memory", id: "origin" }, worker = { relay: "memory", id: "worker" }, blocked = { relay: "memory", id: "blocked" };

function slowOldWork(backing: TaskRelay) {
  let seeding = true, retryDelayMs = 3_000;
  const attempts: RelayEnvelope[] = [];
  const transport: TaskRelay = {
    id: backing.id,
    connect: (input, signal) => backing.connect(input, signal),
    resolve: (input, signal) => backing.resolve(input, signal),
    receive: (input, signal) => backing.receive(input, signal),
    acknowledgeDelivery: (input, signal) => backing.acknowledgeDelivery(input, signal),
    async send(input, signal) {
      if (input.target.id === blocked.id) {
        if (seeding) throw new TaskProtocolError("RELAY_UNAVAILABLE", "seed unrelated old work", { retryable: true });
        attempts.push(input);
        // A finite, cooperative request slower than the overall refresh window.
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new TaskProtocolError("ABORTED", "fixture request cancelled")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, retryDelayMs);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      return backing.send(input, signal);
    },
  };
  return { transport, attempts, startRetries(delayMs = 3_000) { seeding = false; retryDelayMs = delayMs; } };
}

function presentation(idle: boolean, queued: boolean) {
  const messages: Array<{ customType: string; details: TaskEventDetails }> = [];
  const entries: unknown[] = [];
  return {
    messages,
    pi: {
      sendMessage(message: { customType: string; details: TaskEventDetails }) { messages.push(message); entries.push({ type: "custom_message", ...message }); },
      appendEntry(customType: string, data: { cursor: string } | TaskEventDetails) { entries.push({ type: "custom", customType, data }); },
    },
    context: { isIdle: () => idle, hasPendingMessages: () => queued, sessionManager: { getEntries: () => entries } },
  };
}

async function refresh(core: ReturnType<typeof createTaskCore>, ui: ReturnType<typeof presentation>) {
  const work = createTaskWorkScope(); work.retryAllowed = false;
  await core.connect(work.signal, work);
  // The speculative timeout stays visible, but cannot undo current-page progress.
  await expect(deliverTaskInbox(ui.pi, core, ui.context, work.signal, work)).rejects.toMatchObject({ code: "ABORTED" });
}

test("healthy assignment is inserted, woken and ACKed before an unrelated slow retry over repeated refreshes", async () => {
  const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
  const slow = slowOldWork(backing);
  const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: backing });
  const child = createTaskCore({ endpoint: worker, store: childStore, relay: slow.transport });
  const ui = presentation(true, false);
  try {
    await parent.connect(); await child.connect();
    await backing.connect({ endpoint: blocked, receiveCursor: "0", protocolVersion: TASK_PROTOCOL_VERSION });
    await expect(child.createTask({ target: blocked, task: "unrelated old outgoing work", timeoutMs: 60_000 })).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
    const old = childStore.outbox("pending").map(row => row.envelope);
    expect(old).toHaveLength(1); slow.startRetries();
    const assignment = await parent.createTask({ target: worker, task: "healthy incoming assignment", timeoutMs: 60_000 });
    const observations: Array<{ events: number; wakes: number; cursor: string }> = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      await refresh(child, ui);
      observations.push({ events: ui.messages.filter(message => message.customType === "pi-tasks-event").length,
        wakes: ui.messages.filter(message => message.customType === "pi-tasks-wake").length, cursor: childStore.getReceiveCursor() });
      expect(child.getTask(assignment.taskId)).toBeDefined();
      expect(childStore.outbox("pending").map(row => row.envelope)).toEqual(old);
    }
    expect(observations).toEqual([{ events: 1, wakes: 1, cursor: "1" }, { events: 1, wakes: 1, cursor: "1" }]);
    expect(slow.attempts).toEqual([old[0]!, old[0]!]);
  } finally { parentStore.close(); childStore.close(); }
}, 10_000);

for (const path of ["busy inbox", "direct receive"] as const) {
  test(`${path} canonicalizes progress and completion in the initial page before unrelated slow retries`, async () => {
    const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
    const slow = slowOldWork(backing);
    const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: slow.transport });
    const child = createTaskCore({ endpoint: worker, store: childStore, relay: backing });
    const ui = presentation(false, true);
    try {
      await parent.connect(); await child.connect();
      await backing.connect({ endpoint: blocked, receiveCursor: "0", protocolVersion: TASK_PROTOCOL_VERSION });
      const assignment = await parent.createTask({ target: worker, task: "healthy completion", timeoutMs: 60_000 });
      await child.receive();
      await expect(parent.createTask({ target: blocked, task: "unrelated old outgoing work", timeoutMs: 60_000 })).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
      const old = parentStore.outbox("pending").map(row => row.envelope);
      expect(old).toHaveLength(1); slow.startRetries();
      await child.submitIntent({ taskId: assignment.taskId, type: "task.information", payload: { message: "progress" } });
      await child.submitIntent({ taskId: assignment.taskId, type: "task.completed", payload: { summary: "done" } });
      const observations: Array<{ status: string | undefined; events: string[]; cursor: string }> = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        if (path === "direct receive") await expect(parent.receive()).rejects.toMatchObject({ code: "ABORTED" });
        else await refresh(parent, ui);
        observations.push({ status: parent.getTask(assignment.taskId)?.status,
          events: parent.getTask(assignment.taskId)!.events.map(event => event.type), cursor: parentStore.getReceiveCursor() });
        expect(parentStore.outbox("pending").map(row => row.envelope)).toEqual(old);
      }
      expect(observations.map(observation => observation.status)).toEqual(["completed", "completed"]);
      for (const observation of observations) {
        expect(observation.events).toEqual(["task.created", "task.information", "task.completed"]);
        expect(observation.cursor).toBe("3"); // The relay cursor includes the earlier assignment to the worker.
      }
      expect(ui.messages).toEqual([]);
      expect(slow.attempts).toEqual([old[0]!, old[0]!]);
    } finally { parentStore.close(); childStore.close(); }
  }, 10_000);
}

for (const state of ["empty", "busy", "queued", "missing-insertion", "evidence-error", "receive-error", "direct-empty"] as const) {
  test(`old work retains a bounded opportunity after current-page completion or yield: ${state}`, async () => {
    const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
    const slow = slowOldWork(backing);
    const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: backing });
    const child = createTaskCore({ endpoint: worker, store: childStore, relay: slow.transport });
    const ui = presentation(state !== "busy", state === "queued");
    try {
      await parent.connect(); await child.connect();
      await backing.connect({ endpoint: blocked, receiveCursor: "0", protocolVersion: TASK_PROTOCOL_VERSION });
      await expect(child.createTask({ target: blocked, task: "old outgoing work", timeoutMs: 60_000 })).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
      const old = childStore.outbox("pending")[0]!.envelope;
      if (state !== "empty" && state !== "direct-empty" && state !== "receive-error") {
        await parent.createTask({ target: worker, task: "incoming work", timeoutMs: 60_000 });
      }
      slow.startRetries(0);
      const failure = new TaskProtocolError("RELAY_UNAVAILABLE", "required current-page operation failed", { retryable: true });
      if (state === "receive-error") slow.transport.receive = async () => { throw failure; };
      if (state === "evidence-error") {
        const send = slow.transport.send;
        slow.transport.send = (input, signal) => {
          if (input.kind === "intent") return Promise.reject(failure);
          return send(input, signal);
        };
      }
      if (state === "missing-insertion") ui.pi.sendMessage = message => { ui.messages.push(message); };

      if (state === "direct-empty") expect(await child.receive()).toEqual([]);
      else if (state === "receive-error") await expect(deliverTaskInbox(ui.pi, child, ui.context)).rejects.toBe(failure);
      else if (state === "evidence-error") await expect(deliverTaskInbox(ui.pi, child, ui.context)).rejects.toMatchObject({ code: failure.code, message: failure.message });
      else await deliverTaskInbox(ui.pi, child, ui.context);

      expect(slow.attempts).toEqual([old]);
      expect(childStore.getOutboxRecord(old.envelopeId)).toEqual({ state: "accepted", envelope: old });
      if (state === "busy" || state === "queued" || state === "missing-insertion" || state === "evidence-error") {
        expect(childStore.getReceiveCursor()).toBe("0");
        expect(ui.messages.filter(message => message.customType === "pi-tasks-wake")).toEqual([]);
      }
      if (state === "evidence-error") expect(childStore.outbox("pending").map(row => row.envelope.kind)).toEqual(["intent"]);
    } finally { parentStore.close(); childStore.close(); }
  });
}
