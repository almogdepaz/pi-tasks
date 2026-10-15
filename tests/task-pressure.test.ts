import { expect, test } from "bun:test";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION, TaskProtocolError } from "../src/task-protocol";
import type { TaskRelay } from "../src/task-protocol";

function wrapper(relay: TaskRelay, send: TaskRelay["send"]): TaskRelay {
  return { id: relay.id, connect: input => relay.connect(input), resolve: input => relay.resolve(input),
    receive: input => relay.receive(input), acknowledgeDelivery: input => relay.acknowledgeDelivery(input), send };
}

const origin = { relay: "memory", id: "origin" }, target = { relay: "memory", id: "target" };

test("rejecting admissions do not rescan and resend the entire pending backlog", async () => {
  const relay = createInMemoryTaskRelay("memory"), store = createTaskStore();
  await relay.connect({ endpoint: target, protocolVersion: TASK_PROTOCOL_VERSION, receiveCursor: "0" });
  const attempts: string[] = [];
  const core = createTaskCore({ endpoint: origin, store, relay: wrapper(relay, async envelope => {
    attempts.push(envelope.envelopeId);
    throw new TaskProtocolError("RELAY_CAPACITY", "full", { retryable: true });
  }) });
  await core.connect();
  for (let i = 0; i < 32; i++) {
    await expect(core.createTask({ target, task: `pending ${i}`, timeoutMs: 60_000 })).rejects.toBeDefined();
  }
  expect(store.outbox("pending")).toHaveLength(32);
  expect(attempts.length).toBeLessThanOrEqual(64);
  const before = attempts.length;
  await core.receive();
  expect(attempts.length - before).toBeLessThanOrEqual(8);
});

test("replayed raw intent cannot ACK while its canonical fanout remains rejected", async () => {
  const relay = createInMemoryTaskRelay("memory"), store = createTaskStore(), peerStore = createTaskStore();
  let blocked = false;
  const core = createTaskCore({ endpoint: origin, store, relay: wrapper(relay, async envelope => {
    if (blocked && envelope.target.id === target.id) throw new TaskProtocolError("RELAY_CAPACITY", "full", { retryable: true });
    return relay.send(envelope);
  }) });
  const peer = createTaskCore({ endpoint: target, store: peerStore, relay });
  await core.connect(); await peer.connect();
  const task = await core.createTask({ target, task: "fanout", timeoutMs: 60_000 });
  await peer.receive();
  await peer.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done" } });
  blocked = true;
  await expect(core.receive()).rejects.toBeDefined();
  await expect(core.receive()).rejects.toBeDefined();
  expect(store.getReceiveCursor()).toBe("0");
  expect(relay.envelopesFor(origin).some(envelope => envelope.kind === "intent")).toBe(true);
  expect(core.getTask(task.taskId)?.events.filter(event => event.type === "task.completed")).toHaveLength(1);
});
