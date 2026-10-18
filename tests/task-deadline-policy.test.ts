import { expect, test } from "bun:test";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION, type RelayEnvelope, type TaskRelay } from "../src/task-protocol";
import { virtualTime } from "./virtual-time";

const origin = { relay: "memory", id: "origin" }, target = { relay: "memory", id: "target" };
const envelope = (id: string, destination = target): RelayEnvelope => ({ envelopeId: id, taskId: id, source: origin, target: destination,
  kind: "assignment", protocolVersion: TASK_PROTOCOL_VERSION, payload: "{}", createdAt: new Date().toISOString() });
function relay(): TaskRelay {
  return { id: "memory", connect: async input => ({ endpoint: input.endpoint, receiveCursor: input.receiveCursor }),
    resolve: async input => ({ relay: input.relay, id: input.reference }),
    send: async input => ({ envelopeId: input.envelopeId }),
    receive: async input => ({ deliveries: [], nextCursor: input.cursor, hasMore: false }), acknowledgeDelivery: async () => {} };
}

test("finite 300ms retries recover while the admission slice stops another attempt", async () => {
  const store = createTaskStore(), transport = relay(), attempts: RelayEnvelope[] = [], time = virtualTime();
  const originals = [envelope("first"), envelope("second")]; originals.forEach(item => store.putOutbox(item));
  transport.send = async (input, signal) => { attempts.push(input); await time.sleep(300, signal); return { envelopeId: input.envelopeId }; };
  const core = createTaskCore({ endpoint: origin, store, relay: transport, timers: time.timers });
  try {
    await expect(time.run(core.flushOutbox())).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
    expect(attempts).toEqual([originals[0]!]);
    expect(store.outbox("accepted").map(row => row.envelope)).toEqual([originals[0]!]);
    expect(store.outbox("pending").map(row => row.envelope)).toEqual([originals[1]!]);
    await time.run(core.flushOutbox());
    expect(attempts).toEqual(originals); expect(store.outbox("pending")).toEqual([]);
  } finally { store.close(); }
});

test("finite 300ms requested ACK repair succeeds after initial receive and defers another repair", async () => {
  const store = createTaskStore(), transport = relay(), operations: string[] = [], time = virtualTime();
  store.trackRelayDeliveries(origin, [{ cursor: "1", envelopeId: "first" }, { cursor: "3", envelopeId: "second" }]);
  for (const cursor of ["1", "3"]) store.requestRelayAcknowledgement(origin, cursor);
  transport.receive = async input => { operations.push("receive"); return { deliveries: [], nextCursor: input.cursor, hasMore: false }; };
  transport.acknowledgeDelivery = async (input, signal) => { operations.push(`ack:${input.cursor}`); await time.sleep(300, signal); };
  const core = createTaskCore({ endpoint: origin, store, relay: transport, timers: time.timers });
  try {
    expect(await time.run(core.receive())).toEqual([]);
    expect(operations).toEqual(["receive", "ack:1"]); expect(store.getReceiveCursor()).toBe("1");
    expect(store.requestedRelayAcknowledgements(origin)).toEqual(["3"]);
    await time.run(core.receive()); expect(operations).toEqual(["receive", "ack:1", "receive", "ack:3"]);
    expect(store.getReceiveCursor()).toBe("3"); expect(store.requestedRelayAcknowledgements(origin)).toEqual([]);
  } finally { store.close(); }
});

for (const operation of ["send", "message", "done"] as const) {
  test(`healthy 2.2s foreground ${operation} honors the transport/caller window`, async () => {
    const store = createTaskStore(), transport = relay(), time = virtualTime();
    let slow = operation === "send";
    transport.send = async (input, signal) => { if (slow) await time.sleep(2_200, signal); return { envelopeId: input.envelopeId }; };
    const core = createTaskCore({ endpoint: origin, store, relay: transport, timers: time.timers });
    try {
      const task = await time.run(core.createTask({ target, task: "healthy foreground", timeoutMs: 60_000 }, time.timers.timeout(4_000)));
      if (operation !== "send") {
        slow = true;
        await time.run(core.submitIntent({ taskId: task.taskId, type: operation === "message" ? "task.information" : "task.completed", payload: {} }, time.timers.timeout(6_000)));
      }
      // The accepted foreground request outlived the 2s background deadline.
      expect(time.timers.elapsed()).toBe(2_200);
      expect(store.outbox("pending")).toEqual([]);
      // done no longer adds an origin self-echo envelope; its origin view is a local presentation.
      expect(store.outbox("accepted")).toHaveLength(operation === "send" ? 1 : 2);
    } finally { store.close(); }
  });
}

test("slow foreground acceptance cannot leave speculative old work to another target unbounded", async () => {
  const store = createTaskStore(), transport = relay(), old = envelope("old", { ...target, id: "elsewhere" }), time = virtualTime(); store.putOutbox(old);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  transport.send = async (input, signal) => {
    if (input.envelopeId === old.envelopeId) { entered(); await held; }
    else await time.sleep(2_200, signal);
    return { envelopeId: input.envelopeId };
  };
  const core = createTaskCore({ endpoint: origin, store, relay: transport, timers: time.timers });
  const attempt = core.createTask({ target, task: "foreground then bounded speculation", timeoutMs: 60_000 });
  try {
    await time.run(Promise.race([started, attempt.then(() => { throw new Error("speculative retry was not admitted"); })]));
    expect(time.timers.elapsed()).toBe(2_200);
    await time.run(attempt);
    // The speculative retry got exactly the background window that opened when the foreground send finished.
    expect(time.timers.elapsed()).toBe(4_200);
    expect(store.outbox("accepted")).toHaveLength(1);
    expect(store.outbox("pending").map(row => row.envelope)).toEqual([old]);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(store.outbox("pending").map(row => row.envelope)).toEqual([old]);
  } finally { release(); await attempt.catch(() => {}); store.close(); }
});

test("slow old work ahead of a foreground send stays bounded by the background window", async () => {
  const store = createTaskStore(), transport = relay(), old = envelope("old"), time = virtualTime(); store.putOutbox(old);
  const sent: string[] = [];
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  transport.send = async input => {
    sent.push(input.envelopeId);
    if (input.envelopeId === old.envelopeId) { entered(); await held; }
    return { envelopeId: input.envelopeId };
  };
  const core = createTaskCore({ endpoint: origin, store, relay: transport, timers: time.timers });
  const attempt = core.createTask({ target, task: "foreground behind bounded old work", timeoutMs: 60_000 });
  try {
    await time.run(started);
    // Per-target fifo: the new assignment waits behind the older one, which only gets the bounded background window.
    await expect(time.run(attempt)).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
    expect(time.timers.elapsed()).toBe(2_000);
    expect(sent).toEqual([old.envelopeId]);
    expect(store.outbox("accepted")).toHaveLength(0);
    expect(store.outbox("pending").map(row => row.envelope)[0]).toEqual(old);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(store.outbox("pending").map(row => row.envelope)[0]).toEqual(old); // a late result after the window is not recorded
  } finally { release(); await attempt.catch(() => {}); store.close(); }
});
