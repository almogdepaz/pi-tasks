import { describe, expect, test } from "bun:test";

import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION } from "../src/task-protocol";
import { deliverTaskInbox } from "../src/task-inbox";

const origin = { relay: "memory", id: "origin" };
const receiver = { relay: "memory", id: "receiver" };

test("persists inbound state, inserts structural evidence, then records a logical receipt before relay acknowledgement", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	const entries: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { entries.push({ type: "custom_message", customType: message.customType, details: message.details }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };

	await deliverTaskInbox(pi, child, context);

	expect(entries).toContainEqual({ type: "custom_message", customType: "pi-tasks-event", details: { taskId: created.taskId, eventId: "parent-2" } });
	expect(relay.envelopesFor(receiver)).toHaveLength(1);
	await parent.receive();
	expect(parent.getTask(created.taskId)?.events.map((event) => event.type)).toEqual(["task.created", "task.delivery_receipt"]);
});

test("origin acknowledges raw receiver intents before rendering their canonical message and completion", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parentStore = createTaskStore({ path: ":memory:" });
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	const childEntries: unknown[] = [];
	const childPi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { childEntries.push({ type: "custom_message", customType: message.customType, details: message.details }); },
		appendEntry(customType: string, data: unknown) { childEntries.push({ type: "custom", customType, data }); },
	};
	const ready = { hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => childEntries } };
	await deliverTaskInbox(childPi, child, ready);
	await child.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "progress" } });
	await child.submitIntent({ taskId: created.taskId, type: "task.completed", payload: { summary: "finished" } });

	const parentEntries: unknown[] = [];
	const parentPi = {
		sendMessage(message: { readonly customType: string; readonly content: string; readonly details: unknown }) { parentEntries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details }); },
		appendEntry(customType: string, data: unknown) { parentEntries.push({ type: "custom", customType, data }); },
	};
	const parentContext = { hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => parentEntries } };

	await deliverTaskInbox(parentPi, parent, parentContext);

	expect(parent.getTask(created.taskId)?.status).toBe("completed");
	expect(parent.getTask(created.taskId)?.events.map((event) => event.type).slice(0, 4)).toEqual(["task.created", "task.delivery_receipt", "task.information", "task.completed"]);
	expect(parentStore.getReceiveCursor()).toBe("4");
	expect(parentEntries).toEqual([]);

	await deliverTaskInbox(parentPi, parent, parentContext);

	expect(parentEntries).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("progress") }),
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("finished") }),
	]));
});

test("origin acknowledges raw receiver intents and renders their canonical message and completion once", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	await child.receive();
	await child.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "progress" } });
	await child.submitIntent({ taskId: created.taskId, type: "task.completed", payload: { summary: "finished" } });

	expect(await parent.receive()).toEqual([]);
	const echoed = await relay.receive({ endpoint: origin, cursor: "0", limit: 100 });
	expect(echoed.deliveries).toHaveLength(2);
	expect(echoed.deliveries.every((delivery) => delivery.envelope.kind === "canonical_event")).toBe(true);

	const parentEntries: unknown[] = [];
	const parentPi = {
		sendMessage(message: { readonly customType: string; readonly content: string; readonly details: unknown }) { parentEntries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details }); },
		appendEntry(customType: string, data: unknown) { parentEntries.push({ type: "custom", customType, data }); },
	};
	const parentContext = { hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => parentEntries } };

	await deliverTaskInbox(parentPi, parent, parentContext);

	expect(parentEntries).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("progress") }),
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("finished") }),
	]));
	expect(parentEntries.filter((entry) => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "custom_message")).toHaveLength(2);
});

test("fails closed on an unknown canonical event without advancing the relay delivery cursor", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore({ path: ":memory:" }), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	await child.receive();
	await child.acknowledgeRelayDelivery("1");
	await relay.send({ envelopeId: "unknown-envelope", protocolVersion: TASK_PROTOCOL_VERSION, source: origin, target: receiver, taskId: created.taskId, kind: "canonical_event", payload: JSON.stringify({ eventId: "unknown-event", taskId: created.taskId, type: "task.unrecognized", sequence: "2", source: origin, target: receiver, occurredAt: 1, payload: {} }) });
	const pi = { sendMessage() { throw new Error("must not insert an unknown event"); }, appendEntry() { throw new Error("must not advance cursor"); } };
	const context = { hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => [] } };

	await expect(deliverTaskInbox(pi, child, context)).rejects.toThrow("canonical event envelope headers or payload are invalid");
	await expect(deliverTaskInbox(pi, child, context)).rejects.toThrow("canonical event envelope headers or payload are invalid");
});

function ids(prefix: string): () => string {
	let current = 0;
	return (): string => `${prefix}-${++current}`;
}
