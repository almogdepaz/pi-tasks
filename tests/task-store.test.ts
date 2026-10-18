import { expect, spyOn, test } from "bun:test";
import { createTaskStore } from "../src/task-store";
import type { TaskStoreOptions } from "../src/task-store";
import { TASK_PROTOCOL_VERSION, TaskEnvelopeKind } from "../src/task-protocol";
const task = (taskId: string) => ({ taskId, protocolVersion: "pi-tasks/v2", origin: { relay: "memory", id: "a" }, target: { relay: "memory", id: "b" }, task: "work", createdAt: 1, expiresAt: 10, status: "active" as const });

test("endpoint stores are isolated RAM lifetimes, not a second task archive", () => {
  const first = createTaskStore(); first.putTask(task("old")); first.setEndpointGeneration("old-generation"); first.setReceiveCursor("42");
  const independent = createTaskStore(); expect(independent.listTasks()).toEqual([]);
  first.close(); first.close(); expect(() => first.listTasks()).toThrow("closed");
  const fresh = createTaskStore(); expect(fresh.listTasks()).toEqual([]); expect(fresh.getEndpointGeneration()).toBeUndefined(); expect(fresh.getReceiveCursor()).toBe("0");
  independent.close(); fresh.close();
});

test("persistence options are rejected rather than opening SQLite or importing history", () => {
  expect(() => createTaskStore({ path: "/must-not-open/tasks.sqlite" } as unknown as TaskStoreOptions)).toThrow("memory-only");
});

test("snapshots do not leak mutable live records and ordering is deterministic", () => {
  const store = createTaskStore(), input = task("a"); store.putTask(input); input.origin.id = "changed";
  // Stored values are deep-frozen, so a write through a snapshot either throws or is lost; it never reaches the store.
  const snapshot = store.getTask("a")!; expect(() => { (snapshot.origin as { id: string }).id = "also-changed"; }).toThrow(TypeError);
  expect(store.getTask("a")?.origin.id).toBe("a");
  store.putTask(task("b")); expect(store.listTasks().map(t => t.taskId)).toEqual(["a", "b"]); store.close();
});

test("capacity is checked before admission and failed transactions restore all mutations and credits", () => {
  const store = createTaskStore({ maxEntries: 2 }); store.putTask(task("a"));
  expect(() => store.transaction(() => { store.setStatus("a", "completed"); store.putTask(task("b")); store.putTask(task("c")); })).toThrow("full");
  expect(store.listTasks().map(t => [t.taskId, t.status])).toEqual([["a", "active"]]);
  store.putTask(task("b")); expect(store.listTasks()).toHaveLength(2); store.close();
  const bytes = createTaskStore({ maxBytes: 100 }); expect(() => bytes.putTask(task("x"))).toThrow("full"); expect(bytes.listTasks()).toEqual([]); bytes.close();
});

test("nested rollback preserves outer writes and repeated writes retain only one undo image", () => {
  const store = createTaskStore(); store.putTask(task("a"));
  expect(() => store.transaction(() => {
    for (let i = 0; i < 1000; i++) store.setStatus("a", "completed");
    expect(() => store.transaction(() => { store.setStatus("a", "failed"); throw new Error("inner"); })).toThrow("inner");
    expect(store.getTask("a")?.status).toBe("completed");
    store.transaction(() => store.setStatus("a", "cancelled"));
    throw new Error("outer");
  })).toThrow("outer");
  expect(store.getTask("a")?.status).toBe("active"); store.close();
});

test("sparse individual ACKs cannot skip an earlier pending delivery", () => {
  const store = createTaskStore(), endpoint = { relay: "memory", id: "a" }; store.setEndpointBinding(endpoint);
  store.trackRelayDeliveries(endpoint, [{ cursor: "1", envelopeId: "one" }, { cursor: "3", envelopeId: "three" }]);
  store.requestRelayAcknowledgement(endpoint, "3"); store.acknowledgeRelayCursor(endpoint, "3"); expect(store.getReceiveCursor()).toBe("0");
  expect(store.pendingRelayEnvelopeId(endpoint, "1")).toBe("one");
  store.requestRelayAcknowledgement(endpoint, "1"); store.acknowledgeRelayCursor(endpoint, "1"); expect(store.getReceiveCursor()).toBe("3");
  expect(store.requestedRelayAcknowledgements(endpoint)).toEqual([]); store.close();
});

test("onChange fires once per top-level commit or non-transactional write, never inside a transaction", () => {
  const store = createTaskStore(); let changes = 0, insideTransaction = -1;
  const unsubscribe = store.onChange(() => { changes += 1; });
  store.putTask(task("a")); expect(changes).toBe(1);
  store.transaction(() => { store.setStatus("a", "completed"); store.transaction(() => { store.setReceiveCursor("2"); }); insideTransaction = changes; });
  expect(insideTransaction).toBe(1); expect(changes).toBe(2);
  expect(() => store.transaction(() => { store.setReceiveCursor("3"); throw new Error("rollback"); })).toThrow("rollback"); expect(changes).toBe(2);
  store.putTask(task("a")); expect(changes).toBe(2); // rejected duplicate writes nothing
  unsubscribe(); store.setReceiveCursor("4"); expect(changes).toBe(2); store.close();
});

test("onChange listeners observe committed outbox state and a throwing listener cannot corrupt the store", () => {
  const store = createTaskStore(), source = { relay: "memory", id: "a" }, target = { relay: "memory", id: "b" };
  const observed: boolean[] = []; let later = 0;
  const failing = store.onChange(() => { throw new Error("listener bug"); });
  store.onChange(() => { observed.push(store.hasPendingOutbox()); later += 1; });
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    store.putOutbox({ envelopeId: "e1", protocolVersion: TASK_PROTOCOL_VERSION, source, target, taskId: "t", kind: TaskEnvelopeKind.intent, payload: "{}" });
    store.markOutboxAccepted("e1");
    expect(observed).toEqual([true, false]); expect(later).toBe(2);
    expect(store.getOutboxRecord("e1")?.state).toBe("accepted"); expect(store.hasPendingOutbox()).toBe(false);
    expect(errors).toHaveBeenCalledTimes(2);
  } finally { errors.mockRestore(); failing(); store.close(); }
});
