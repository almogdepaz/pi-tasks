import { expect, test } from "bun:test";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION, TaskProtocolError, type RelayEnvelope, type TaskRelay } from "../src/task-protocol";

const origin = { relay: "memory", id: "origin" }, target = { relay: "memory", id: "target" };
const envelope = (id: string): RelayEnvelope => ({ envelopeId: id, taskId: id, source: origin, target,
  kind: "assignment", protocolVersion: TASK_PROTOCOL_VERSION, payload: "{}", createdAt: new Date().toISOString() });
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new TaskProtocolError("ABORTED", "fixture cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function relay(): TaskRelay {
  return { id: "memory", connect: async input => ({ endpoint: input.endpoint, receiveCursor: input.receiveCursor }),
    resolve: async input => ({ relay: input.relay, id: input.reference }),
    send: async input => ({ envelopeId: input.envelopeId }),
    receive: async input => ({ deliveries: [], nextCursor: input.cursor, hasMore: false }), acknowledgeDelivery: async () => {} };
}

test("finite 300ms retries recover while the admission slice stops another attempt", async () => {
  const store = createTaskStore(), transport = relay(), attempts: RelayEnvelope[] = [];
  const originals = [envelope("first"), envelope("second")]; originals.forEach(item => store.putOutbox(item));
  transport.send = async (input, signal) => { attempts.push(input); await delay(300, signal); return { envelopeId: input.envelopeId }; };
  const core = createTaskCore({ endpoint: origin, store, relay: transport });
  try {
    await expect(core.flushOutbox()).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
    expect(attempts).toEqual([originals[0]!]);
    expect(store.outbox("accepted").map(row => row.envelope)).toEqual([originals[0]!]);
    expect(store.outbox("pending").map(row => row.envelope)).toEqual([originals[1]!]);
    await core.flushOutbox();
    expect(attempts).toEqual(originals); expect(store.outbox("pending")).toEqual([]);
  } finally { store.close(); }
});

test("finite 300ms requested ACK repair succeeds after initial receive and defers another repair", async () => {
  const store = createTaskStore(), transport = relay(), operations: string[] = [];
  store.trackRelayDeliveries(origin, [{ cursor: "1", envelopeId: "first" }, { cursor: "3", envelopeId: "second" }]);
  for (const cursor of ["1", "3"]) store.requestRelayAcknowledgement(origin, cursor);
  transport.receive = async input => { operations.push("receive"); return { deliveries: [], nextCursor: input.cursor, hasMore: false }; };
  transport.acknowledgeDelivery = async (input, signal) => { operations.push(`ack:${input.cursor}`); await delay(300, signal); };
  const core = createTaskCore({ endpoint: origin, store, relay: transport });
  try {
    expect(await core.receive()).toEqual([]);
    expect(operations).toEqual(["receive", "ack:1"]); expect(store.getReceiveCursor()).toBe("1");
    expect(store.requestedRelayAcknowledgements(origin)).toEqual(["3"]);
    await core.receive(); expect(operations).toEqual(["receive", "ack:1", "receive", "ack:3"]);
    expect(store.getReceiveCursor()).toBe("3"); expect(store.requestedRelayAcknowledgements(origin)).toEqual([]);
  } finally { store.close(); }
});

for (const operation of ["send", "message", "done"] as const) {
  test(`healthy 2.2s foreground ${operation} honors the transport/caller window`, async () => {
    const store = createTaskStore(), transport = relay();
    let slow = operation === "send";
    transport.send = async (input, signal) => { if (slow) await delay(2_200, signal); return { envelopeId: input.envelopeId }; };
    const core = createTaskCore({ endpoint: origin, store, relay: transport });
    try {
      const task = await core.createTask({ target, task: "healthy foreground", timeoutMs: 60_000 }, AbortSignal.timeout(4_000));
      if (operation !== "send") {
        slow = true;
        await core.submitIntent({ taskId: task.taskId, type: operation === "message" ? "task.information" : "task.completed", payload: {} }, AbortSignal.timeout(6_000));
      }
      expect(store.outbox("pending")).toEqual([]);
      expect(store.outbox("accepted")).toHaveLength(operation === "send" ? 1 : operation === "message" ? 2 : 3);
    } finally { store.close(); }
  }, 8_000);
}

test("slow foreground acceptance cannot leave speculative old work unbounded", async () => {
  const store = createTaskStore(), transport = relay(), old = envelope("old"); store.putOutbox(old);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  transport.send = async (input, signal) => {
    if (input.envelopeId === old.envelopeId) { entered(); await held; }
    else await delay(2_200, signal);
    return { envelopeId: input.envelopeId };
  };
  const core = createTaskCore({ endpoint: origin, store, relay: transport });
  const attempt = core.createTask({ target, task: "foreground then bounded speculation", timeoutMs: 60_000 });
  try {
    await Promise.race([started, attempt.then(() => { throw new Error("speculative retry was not admitted"); })]);
    await attempt;
    expect(store.outbox("accepted")).toHaveLength(1);
    expect(store.outbox("pending").map(row => row.envelope)).toEqual([old]);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(store.outbox("pending").map(row => row.envelope)).toEqual([old]);
  } finally { release(); await attempt.catch(() => {}); store.close(); }
}, 7_000);
