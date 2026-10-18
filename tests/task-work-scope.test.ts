import { expect, test } from "bun:test";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { capacityRetryAt, createTaskWorkScope } from "../src/task-work-scope";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { deliverTaskInbox } from "../src/task-inbox";
import { TASK_PROTOCOL_VERSION, TaskProtocolError } from "../src/task-protocol";
import type { RelayEnvelope, TaskRelay } from "../src/task-protocol";

const origin = { relay: "memory", id: "origin" }, target = { relay: "memory", id: "target" };
const envelope = (id: string, destination = target): RelayEnvelope => ({
  envelopeId: id, source: origin, target: destination, taskId: id, kind: "assignment",
  protocolVersion: TASK_PROTOCOL_VERSION, payload: "{}", createdAt: new Date().toISOString(),
});
function relay(send: TaskRelay["send"], receive?: TaskRelay["receive"]): TaskRelay {
  return { id: "memory", connect: async input => ({ endpoint: input.endpoint, receiveCursor: input.receiveCursor }),
    resolve: async input => ({ relay: input.relay, id: input.reference }), send,
    receive: receive ?? (async input => ({ deliveries: [], hasMore: false, nextCursor: input.cursor })),
    acknowledgeDelivery: async () => undefined };
}
async function flush(core: ReturnType<typeof createTaskCore>) {
  try { await core.flushOutbox(); } catch (error) {
    expect(error).toBeInstanceOf(TaskProtocolError);
    expect(["RELAY_CAPACITY", "TASK_DELIVERY_DEFERRED", "RELAY_UNAVAILABLE"]).toContain((error as TaskProtocolError).code);
  }
}

test("rotation advances past rejecting targets and recovers immutable old work without starvation", async () => {
  const store = createTaskStore(), attempts: RelayEnvelope[] = [];
  const bad = { ...target, id: "bad" };
  for (let i = 0; i < 24; i++) store.putOutbox(envelope(String(i), i < 8 ? bad : target));
  const original = store.outbox("pending").map(record => record.envelope);
  let rejecting = true;
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => {
    attempts.push(input);
    if (rejecting && input.target.id === bad.id) throw new TaskProtocolError("RELAY_CAPACITY", "full", { retryable: true });
    return { envelopeId: input.envelopeId };
  }) });
  for (let i = 0; i < 3; i++) { const before = attempts.length; await flush(core); expect(attempts.length - before).toBeLessThanOrEqual(8); }
  expect(store.outbox("accepted")).toHaveLength(16);
  rejecting = false;
  store.outbox("pending").forEach(record => store.postponeOutbox!(record.envelope.envelopeId, 0));
  for (let i = 0; i < 3; i++) await flush(core);
  expect(store.outbox("pending")).toEqual([]);
  expect(store.outbox("accepted").map(record => record.envelope)).toEqual(original);
  store.close();
});

test("old work has a positive share during continuous fresh scoped operations", async () => {
  const store = createTaskStore(), attempts: string[] = [];
  for (let i = 0; i < 24; i++) store.putOutbox(envelope(`old-${i}`));
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => { attempts.push(input.envelopeId); return { envelopeId: input.envelopeId }; }) });
  for (let i = 0; i < 4; i++) {
    const before = attempts.length;
    await core.createTask({ target, task: `new-${i}`, timeoutMs: 60_000 });
    expect(attempts.length - before).toBeLessThanOrEqual(9);
  }
  expect(store.outbox("accepted").filter(record => record.envelope.envelopeId.startsWith("old-"))).toHaveLength(24);
  store.close();
});

test("omitted scoped IDs in canonical fanout never report acceptance", async () => {
  const store = createTaskStore(), attempts: RelayEnvelope[] = [];
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => { attempts.push(input); return { envelopeId: input.envelopeId }; }) });
  const task = await core.createTask({ target, task: "partial", timeoutMs: 60_000 });
  const scope = createTaskWorkScope();
  // Canonical fanout is a single target replica (the origin view is local), so the whole scoped send budget is spent.
  for (let i = 0; i < 56; i++) expect(scope.claimSend(`spent-${i}`, false)).toBe(true);
  await expect(core.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done" } }, scope.signal, scope)).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
  expect(store.outbox("pending")).toHaveLength(1);
  const pending = store.outbox("pending")[0]!.envelope;
  expect(attempts.some(input => input.envelopeId === pending.envelopeId)).toBe(false);
  await core.flushOutbox();
  expect(attempts.at(-1)).toEqual(pending);
  store.close();
});

test("concurrent same-ID terminal operations share one physical send", async () => {
  const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
  const parent = createTaskCore({ endpoint: origin, relay: backing, store: parentStore });
  let release!: () => void, entered!: () => void, sends = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transport: TaskRelay = { id: backing.id, connect: input => backing.connect(input), resolve: input => backing.resolve(input),
    receive: input => backing.receive(input), acknowledgeDelivery: input => backing.acknowledgeDelivery(input),
    send: async input => { sends++; entered(); await held; return backing.send(input); } };
  const child = createTaskCore({ endpoint: target, relay: transport, store: childStore });
  await parent.connect(); await child.connect();
  const task = await parent.createTask({ target, task: "terminal", timeoutMs: 60_000 }); await child.receive();
  const input = { taskId: task.taskId, type: "task.completed" as const, payload: { summary: "done" } };
  const first = child.submitIntent(input); await ready;
  const second = child.submitIntent(input); release(); await Promise.all([first, second]);
  expect(sends).toBe(1); expect(childStore.outbox("accepted")).toHaveLength(1);
  parentStore.close(); childStore.close();
});

test("connect and receive share ACK repair budget without losing the receive lane", async () => {
  const store = createTaskStore(); let acks = 0, receives = 0;
  const base = 9007199254740993n;
  store.trackRelayDeliveries(origin, Array.from({ length: 60 }, (_, i) => ({ cursor: String(base + BigInt(i) * 3n), envelopeId: `ack-${i}` })));
  for (let i = 0; i < 60; i++) store.requestRelayAcknowledgement(origin, String(base + BigInt(i) * 3n));
  const transport = relay(async input => ({ envelopeId: input.envelopeId }), async input => { receives++; return { deliveries: [], hasMore: false, nextCursor: input.cursor }; });
  const core = createTaskCore({ endpoint: origin, store, relay: { ...transport, acknowledgeDelivery: async () => { acks++; } } });
  const scope = createTaskWorkScope();
  await core.connect(scope.signal, scope); await core.receive(scope.signal, scope);
  expect(acks).toBe(48); expect(receives).toBe(1);
  expect(store.getReceiveCursor()).toBe(String(base + 47n * 3n));
  await core.connect(); expect(acks).toBe(60);
  expect(store.getReceiveCursor()).toBe(String(base + 59n * 3n));
  store.close();
});

test("abort fences late send completion and leaves the same immutable envelope retryable", async () => {
  const store = createTaskStore(); const original = envelope("pending"); store.putOutbox(original);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let waiting = true;
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => { if (waiting) await held; return { envelopeId: input.envelopeId }; }) });
  const controller = new AbortController();
  const attempt = core.flushOutbox(controller.signal); controller.abort();
  await expect(attempt).rejects.toMatchObject({ code: "ABORTED" });
  expect(store.outbox("accepted")).toEqual([]);
  waiting = false; await core.flushOutbox(); release(); await Promise.resolve();
  expect(store.outbox("accepted")[0]!.envelope).toEqual(original);
  store.close();
});

test("indexed selection survives nested rollback, quarantine, acceptance and clear", () => {
  const store = createTaskStore();
  expect(() => store.transaction(() => { store.putOutbox(envelope("rolled")); throw new Error("rollback"); })).toThrow("rollback");
  expect(store.selectPendingOutbox!(8, Date.now())).toEqual([]);
  store.transaction(() => {
    store.putOutbox(envelope("outer"));
    expect(() => store.transaction(() => { store.putOutbox(envelope("inner")); throw new Error("inner"); })).toThrow("inner");
  });
  expect(store.selectPendingOutbox!(8, Date.now()).map(record => record.envelope.envelopeId)).toEqual(["outer"]);
  expect(() => store.transaction(() => { store.markOutboxAccepted("outer"); throw new Error("restore"); })).toThrow("restore");
  expect(store.selectPendingOutbox!(8, Date.now())).toHaveLength(1);
  store.quarantineOutbox("outer", { errorCode: "TARGET_NOT_REGISTERED", reason: "inactive", details: {}, quarantinedAt: Date.now() });
  expect(store.selectPendingOutbox!(8, Date.now())).toEqual([]);
  store.putOutbox(envelope("clear")); store.clear(); expect(store.hasPendingOutbox!()).toBe(false);
  store.close();
});

test("foreground receipts use indexed lookups, not whole accepted/pending outbox snapshots", async () => {
  const store = createTaskStore();
  store.outbox = () => { throw new Error("whole outbox scan"); };
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => ({ envelopeId: input.envelopeId })) });
  const task = await core.createTask({ target, task: "indexed", timeoutMs: 60_000 });
  await core.recordInsertion({ taskId: task.taskId, eventId: "event" });
  store.close();
});

test("raw-intent ACK progress still fetches only one initial page per refresh", async () => {
  const backing = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
  let pages = 0;
  const transport: TaskRelay = { id: backing.id, connect: input => backing.connect(input), resolve: input => backing.resolve(input),
    send: input => backing.send(input), acknowledgeDelivery: input => backing.acknowledgeDelivery(input),
    receive: async input => { pages++; return backing.receive({ ...input, limit: 1 }); } };
  const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: transport });
  const child = createTaskCore({ endpoint: target, store: childStore, relay: backing });
  await parent.connect(); await child.connect();
  const tasks = await Promise.all([parent.createTask({ target, task: "one", timeoutMs: 60_000 }), parent.createTask({ target, task: "two", timeoutMs: 60_000 })]);
  await child.receive();
  for (const task of tasks) await child.submitIntent({ taskId: task.taskId, type: "task.completed", payload: {} });
  const entries: unknown[] = [];
  await deliverTaskInbox({
    sendMessage(message) { entries.push({ type: "custom_message", ...message }); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  }, parent, { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } });
  const presented = () => entries.flatMap(entry => {
    const candidate = entry as { customType?: string; details?: { taskId?: string } };
    return candidate.customType === "pi-tasks-event" ? [candidate.details?.taskId] : [];
  });
  expect(pages).toBe(1);
  expect(tasks.map(task => parent.getTask(task.taskId)?.status)).toEqual(["completed", "active"]);
  // The canonicalized completion is presented locally in the same refresh, without another page.
  expect(presented()).toEqual([tasks[0].taskId]);
  await deliverTaskInbox({
    sendMessage(message) { entries.push({ type: "custom_message", ...message }); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  }, parent, { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } });
  expect(pages).toBe(2);
  expect(tasks.map(task => parent.getTask(task.taskId)?.status)).toEqual(["completed", "completed"]);
  expect(presented()).toEqual([tasks[0].taskId, tasks[1].taskId]);
  expect(BigInt(parentStore.getReceiveCursor())).toBeGreaterThan(0n);
  parentStore.close(); childStore.close();
});

test("reserved inbox intake runs before speculative retries without losing old work", async () => {
  const store = createTaskStore(); store.putOutbox(envelope("old"));
  let sends = 0, receives = 0;
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => {
    sends++; return { envelopeId: input.envelopeId };
  }, async input => { receives++; expect(sends).toBe(0); return { deliveries: [], hasMore: false, nextCursor: input.cursor }; }) });
  const scope = createTaskWorkScope(); scope.retryAllowed = false;
  await expect(core.flushOutbox(scope.signal, scope)).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
  expect(store.outbox("pending")).toHaveLength(1);
  await deliverTaskInbox({ sendMessage() {}, appendEntry() {} }, core,
    { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => [] } }, scope.signal, scope);
  expect(receives).toBe(1); expect(sends).toBe(1); expect(store.outbox("pending")).toEqual([]);
  store.close();
});

test("capacity honors validated longer hints and ignores invalid hints without extra timers", () => {
  const now = Date.now();
  const error = (hint: unknown) => new TaskProtocolError("RELAY_CAPACITY", "full", { retryable: true, details: { retryAfterMs: hint } });
  expect(capacityRetryAt(error(15_000))!).toBeGreaterThanOrEqual(now + 15_000);
  for (const invalid of [undefined, NaN, Infinity, -1, "15000"]) {
    expect(capacityRetryAt(error(invalid))!).toBeGreaterThanOrEqual(now + 5_000);
    expect(capacityRetryAt(error(invalid))!).toBeLessThan(now + 6_000);
  }
  expect(capacityRetryAt(new TaskProtocolError("TARGET_NOT_REGISTERED", "inactive", { retryable: false }))).toBeUndefined();
});

test("ACK capacity cooldown applies to both connect repair and direct replay ACK", async () => {
  const store = createTaskStore(); let attempts = 0, rejecting = true;
  store.trackRelayDeliveries(origin, [{ cursor: "9007199254740993", envelopeId: "raw" }]);
  store.requestRelayAcknowledgement(origin, "9007199254740993");
  const transport = relay(async input => ({ envelopeId: input.envelopeId }));
  const core = createTaskCore({ endpoint: origin, store, relay: { ...transport, acknowledgeDelivery: async () => {
    attempts++; if (rejecting) throw new TaskProtocolError("RELAY_CAPACITY", "full", { retryable: true });
  } } });
  await expect(core.connect()).rejects.toMatchObject({ code: "RELAY_CAPACITY" });
  await core.connect(); await core.receive();
  await expect(core.acknowledgeRelayDelivery("9007199254740993")).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
  expect(attempts).toBe(1); expect(store.getReceiveCursor()).toBe("0");
  rejecting = false; store.requestRelayAcknowledgement(origin, "9007199254740993", 0);
  await core.connect(); expect(attempts).toBe(2); expect(store.getReceiveCursor()).toBe("9007199254740993");
  store.close();
});

test("a noncooperative old retry yields at the overall background bound and cannot accept late", async () => {
  const store = createTaskStore(), original = envelope("held"); store.putOutbox(original);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let waiting = true, receives = 0;
  const core = createTaskCore({ endpoint: origin, store, relay: relay(async input => {
    if (waiting) await held; return { envelopeId: input.envelopeId };
  }, async input => { receives++; return { deliveries: [], hasMore: false, nextCursor: input.cursor }; }) });
  const started = Date.now();
  await expect(core.flushOutbox()).rejects.toMatchObject({ code: "ABORTED" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(store.outbox("accepted")).toEqual([]);
  waiting = false; await core.receive(); release(); await Promise.resolve();
  expect(receives).toBe(1); expect(store.outbox("accepted")[0]!.envelope).toEqual(original);
  store.close();
});
