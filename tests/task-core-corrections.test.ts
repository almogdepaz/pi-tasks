import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION } from "../src/task-protocol";
import type { TaskEndpoint } from "../src/task-protocol";

const ORIGIN: TaskEndpoint = { relay: "memory", id: "origin" };
const RECEIVER: TaskEndpoint = { relay: "memory", id: "receiver" };
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("rejects hostile receiver timeout intents before durable receipt or task history mutation", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const originStore = createTaskStore({ path: ":memory:" });
	const receiverStore = createTaskStore({ path: ":memory:" });
	const origin = createTaskCore({ endpoint: ORIGIN, relay, store: originStore, ids: sequence("origin") });
	const receiver = createTaskCore({ endpoint: RECEIVER, relay, store: receiverStore, ids: sequence("receiver") });
	await origin.connect();
	await receiver.connect();
	const created = await origin.createTask({ target: RECEIVER, task: "implement", timeoutMs: 1_000 });
	await receiver.receive();
	await receiver.acknowledgeRelayDelivery("1");

	await relay.send({
		envelopeId: "hostile-timeout",
		protocolVersion: TASK_PROTOCOL_VERSION,
		source: RECEIVER,
		target: ORIGIN,
		taskId: created.taskId,
		kind: "intent",
		payload: JSON.stringify({ intentId: "hostile-intent", taskId: created.taskId, type: "task.timed_out", payload: {} }),
	});

	await expect(origin.receive()).rejects.toThrow("intent envelope headers or payload are invalid");
	expect(origin.getTask(created.taskId)?.events.map((event) => event.type)).toEqual(["task.created"]);
	expect(originStore.getReceiveCursor()).toBe("0");
	await expect(origin.receive()).rejects.toThrow("intent envelope headers or payload are invalid");
	expect(origin.getTask(created.taskId)?.events.map((event) => event.type)).toEqual(["task.created"]);
});

test("rejects mismatched assignment headers before durable receipt and preserves that failure after restart", async () => {
	const directory = mkdtempSync("/tmp/pi-tasks-core-");
	temporaryDirectories.push(directory);
	const path = join(directory, "tasks.sqlite");
	const relay = createInMemoryTaskRelay("memory");
	const store = createTaskStore({ path });
	const receiver = createTaskCore({ endpoint: RECEIVER, relay, store, ids: sequence("receiver") });
	await receiver.connect();
	await relay.connect({ endpoint: ORIGIN, protocolVersion: TASK_PROTOCOL_VERSION, receiveCursor: "0" });
	await relay.send({
		envelopeId: "mismatched-assignment",
		protocolVersion: TASK_PROTOCOL_VERSION,
		source: ORIGIN,
		target: RECEIVER,
		taskId: "header-task",
		kind: "assignment",
		payload: JSON.stringify({
			task: { taskId: "payload-task", protocolVersion: TASK_PROTOCOL_VERSION, origin: ORIGIN, target: RECEIVER, task: "hostile", createdAt: 1, expiresAt: 2, status: "active" },
			event: { eventId: "created", taskId: "payload-task", type: "task.created", sequence: "1", source: ORIGIN, target: RECEIVER, occurredAt: 1, payload: { task: "hostile" } },
		}),
	});

	await expect(receiver.receive()).rejects.toThrow("assignment envelope headers do not match its payload");
	expect(receiver.listTasks()).toEqual([]);
	store.close();

	const restartedStore = createTaskStore({ path });
	const restarted = createTaskCore({ endpoint: RECEIVER, relay, store: restartedStore, ids: sequence("restart") });
	await expect(restarted.receive()).rejects.toThrow("assignment envelope headers do not match its payload");
	expect(restarted.listTasks()).toEqual([]);
	restartedStore.close();
});

test("rejects assignments whose created event payload disagrees with the task header", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const store = createTaskStore({ path: ":memory:" });
	const receiver = createTaskCore({ endpoint: RECEIVER, relay, store, ids: sequence("receiver") });
	await receiver.connect();
	await relay.connect({ endpoint: ORIGIN, protocolVersion: TASK_PROTOCOL_VERSION, receiveCursor: "0" });
	await relay.send({
		envelopeId: "mismatched-created-payload",
		protocolVersion: TASK_PROTOCOL_VERSION,
		source: ORIGIN,
		target: RECEIVER,
		taskId: "task-1",
		kind: "assignment",
		payload: JSON.stringify({
			task: { taskId: "task-1", protocolVersion: TASK_PROTOCOL_VERSION, origin: ORIGIN, target: RECEIVER, task: "trusted instructions", createdAt: 1, expiresAt: 2, status: "active" },
			event: { eventId: "created", taskId: "task-1", type: "task.created", sequence: "1", source: ORIGIN, target: RECEIVER, occurredAt: 1, payload: { task: "hostile instructions" } },
		}),
	});

	await expect(receiver.receive()).rejects.toThrow("assignment envelope headers do not match its payload");
	expect(receiver.listTasks()).toEqual([]);
});

test("retries a durable canonical outbox before acknowledging a replayed receiver intent", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const originStore = createTaskStore({ path: ":memory:" });
	const origin = createTaskCore({ endpoint: ORIGIN, relay, store: originStore, ids: sequence("origin") });
	const receiver = createTaskCore({ endpoint: RECEIVER, relay, store: createTaskStore({ path: ":memory:" }), ids: sequence("receiver") });
	await origin.connect();
	await receiver.connect();
	const created = await origin.createTask({ target: RECEIVER, task: "implement", timeoutMs: 1_000 });
	await receiver.receive();
	await receiver.acknowledgeRelayDelivery("1");
	await receiver.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "durable before acknowledgement" } });

	relay.failNextSend();
	await expect(origin.receive()).rejects.toThrow("in-memory relay send failed");
	expect(originStore.outbox("pending")).toHaveLength(2);
	expect(originStore.getReceiveCursor()).toBe("0");

	const replayed = await origin.receive();
	expect(replayed).toHaveLength(1);
	expect(originStore.outbox("pending")).toHaveLength(0);
	expect(Number(originStore.getReceiveCursor())).toBeGreaterThan(0);
});

test("scans every locally-owned origin task for timeout after relay acceptance fails and survives restart", async () => {
	const directory = mkdtempSync("/tmp/pi-tasks-core-");
	temporaryDirectories.push(directory);
	const path = join(directory, "tasks.sqlite");
	const relay = createInMemoryTaskRelay("memory");
	const now = { value: 1_000 };
	const clock = { now: (): number => now.value };
	const store = createTaskStore({ path });
	const origin = createTaskCore({ endpoint: ORIGIN, relay, store, clock, ids: sequence("origin") });
	await origin.connect();
	await relay.connect({ endpoint: RECEIVER, protocolVersion: TASK_PROTOCOL_VERSION, receiveCursor: "0" });
	relay.failNextSend();
	await expect(origin.createTask({ target: RECEIVER, task: "implement", timeoutMs: 500 })).rejects.toThrow("in-memory relay send failed");
	store.close();

	now.value = 1_501;
	const restartedStore = createTaskStore({ path });
	const restarted = createTaskCore({ endpoint: ORIGIN, relay, store: restartedStore, clock, ids: sequence("restart") });
	await restarted.evaluateTimeouts();

	expect(restarted.getTask("origin-1")?.status).toBe("timed_out");
	expect(restarted.getTask("origin-1")?.events.map((event) => event.type)).toEqual(["task.created", "task.timed_out"]);
	restartedStore.close();
});

function sequence(prefix: string): () => string {
	let current = 0;
	return (): string => `${prefix}-${++current}`;
}
