import { expect, test } from "bun:test";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { createTaskWorkScope } from "../src/task-work-scope";
import { TASK_PROTOCOL_VERSION, TaskProtocolError, type RelayEnvelope, type TaskRelay } from "../src/task-protocol";
import { virtualTime } from "./virtual-time";

const origin = { relay: "memory", id: "origin" }, worker = { relay: "memory", id: "worker" }, blocked = { relay: "memory", id: "blocked" };

function slowOldWork(backing: TaskRelay, time: ReturnType<typeof virtualTime>) {
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
        await time.sleep(retryDelayMs, signal, () => new TaskProtocolError("ABORTED", "fixture request cancelled"));
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

async function refresh(core: ReturnType<typeof createTaskCore>, ui: ReturnType<typeof presentation>, time: ReturnType<typeof virtualTime>) {
  const work = createTaskWorkScope(undefined, "phased", time.timers);
  await time.run(core.connect(work.signal, work));
  // The speculative timeout stays visible, but cannot undo current-page progress.
  await expect(time.run(deliverTaskInbox(ui.pi, core, ui.context, work.signal, work))).rejects.toMatchObject({ code: "ABORTED" });
}

/** Phased inbox delivery on virtual time. */
function deliver(core: ReturnType<typeof createTaskCore>, ui: ReturnType<typeof presentation>, time: ReturnType<typeof virtualTime>) {
  const work = createTaskWorkScope(undefined, "phased", time.timers);
  return time.run(deliverTaskInbox(ui.pi, core, ui.context, work.signal, work));
}

test("healthy assignment is inserted, woken and ACKed before an unrelated slow retry over repeated refreshes", async () => {
  const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore(), time = virtualTime();
  const slow = slowOldWork(backing, time);
  const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: backing });
  const child = createTaskCore({ endpoint: worker, store: childStore, relay: slow.transport, timers: time.timers });
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
      await refresh(child, ui, time);
      observations.push({ events: ui.messages.filter(message => message.customType === "pi-tasks-event").length,
        wakes: ui.messages.filter(message => message.customType === "pi-tasks-wake").length, cursor: childStore.getReceiveCursor() });
      expect(child.getTask(assignment.taskId)).toBeDefined();
      expect(childStore.outbox("pending").map(row => row.envelope)).toEqual(old);
    }
    expect(observations).toEqual([{ events: 1, wakes: 1, cursor: "1" }, { events: 1, wakes: 1, cursor: "1" }]);
    expect(slow.attempts).toEqual([old[0]!, old[0]!]);
    // Each refresh ended at its own 2s background window, not at the 3s retry.
    expect(time.timers.elapsed()).toBe(4_000);
  } finally { parentStore.close(); childStore.close(); }
});

for (const path of ["busy inbox", "direct receive"] as const) {
  test(`${path} canonicalizes progress and completion in the initial page before unrelated slow retries`, async () => {
    const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore(), time = virtualTime();
    const slow = slowOldWork(backing, time);
    const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: slow.transport, timers: time.timers });
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
        if (path === "direct receive") await expect(time.run(parent.receive())).rejects.toMatchObject({ code: "ABORTED" });
        else await refresh(parent, ui, time);
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
      expect(time.timers.elapsed()).toBe(4_000);
    } finally { parentStore.close(); childStore.close(); }
  });
}

for (const state of ["empty", "busy", "queued", "missing-insertion", "evidence-error", "receive-error", "direct-empty"] as const) {
  test(`old work retains a bounded opportunity after current-page completion or yield: ${state}`, async () => {
    const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore(), time = virtualTime();
    const slow = slowOldWork(backing, time);
    const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: backing });
    const child = createTaskCore({ endpoint: worker, store: childStore, relay: slow.transport, timers: time.timers });
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

      if (state === "direct-empty") expect(await time.run(child.receive())).toEqual([]);
      else if (state === "receive-error") await expect(deliver(child, ui, time)).rejects.toBe(failure);
      else if (state === "evidence-error") await expect(deliver(child, ui, time)).rejects.toMatchObject({ code: failure.code, message: failure.message });
      else await deliver(child, ui, time);

      expect(slow.attempts).toEqual([old]);
      expect(childStore.getOutboxRecord(old.envelopeId)).toEqual({ state: "accepted", envelope: old });
      if (state === "busy" || state === "queued" || state === "missing-insertion" || state === "evidence-error") {
        expect(childStore.getReceiveCursor()).toBe("0");
        // The only common-path receipt is wake_accepted, flushed after the observed wake.
        expect(ui.messages.filter(message => message.customType === "pi-tasks-wake")).toHaveLength(state === "evidence-error" ? 1 : 0);
      }
      if (state === "evidence-error") expect(childStore.outbox("pending").map(row => [row.envelope.kind, (JSON.parse(row.envelope.payload) as { payload: { stage: string } }).payload.stage])).toEqual([["intent", "wake_accepted"]]);
    } finally { parentStore.close(); childStore.close(); }
  });
}
