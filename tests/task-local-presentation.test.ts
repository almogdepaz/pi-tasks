import { expect, test } from "bun:test";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { TaskProtocolError, type TaskEndpoint } from "../src/task-protocol";
import { createTaskStore } from "../src/task-store";

const origin = { relay: "memory", id: "origin" }, worker = { relay: "memory", id: "worker" }, other = { relay: "memory", id: "other" };
function ids(prefix: string) { let next = 0; return () => `${prefix}-${++next}`; }
function presentation(options: { idle?: () => boolean; acceptWake?: () => boolean } = {}) {
	const messages: Array<{ customType: string; details: TaskEventDetails }> = [], records: Array<{ customType: string; data: unknown }> = [], entries: unknown[] = [];
	return {
		messages, records, entries,
		events: () => messages.filter(message => message.customType === "pi-tasks-event").map(message => message.details.eventId),
		pi: {
			sendMessage(message: { customType: string; details: TaskEventDetails }) {
				messages.push(message);
				if (message.customType !== "pi-tasks-wake" || (options.acceptWake?.() ?? true)) entries.push({ type: "custom_message", ...message });
			},
			appendEntry(customType: string, data: unknown) { records.push({ customType, data }); entries.push({ type: "custom", customType, data }); },
		},
		context: { isIdle: options.idle ?? (() => true), hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } },
	};
}
function countingRelay() {
	const relay = createInMemoryTaskRelay("memory"), ops: string[] = [];
	const send = relay.send.bind(relay), receive = relay.receive.bind(relay), acknowledge = relay.acknowledgeDelivery.bind(relay);
	relay.send = async (envelope) => { ops.push(`send:${envelope.source.id}>${envelope.target.id}:${envelope.kind}`); return send(envelope); };
	relay.receive = async (input) => { ops.push(`receive:${input.endpoint.id}`); return receive(input); };
	relay.acknowledgeDelivery = async (input) => { ops.push(`ack:${input.endpoint.id}`); return acknowledge(input); };
	return { relay, ops };
}
async function fixture() {
	const { relay, ops } = countingRelay();
	const stores = { origin: createTaskStore(), worker: createTaskStore(), other: createTaskStore() };
	const core = (endpoint: TaskEndpoint, store: ReturnType<typeof createTaskStore>) => createTaskCore({ endpoint, relay, store, ids: ids(endpoint.id) });
	const parent = core(origin, stores.origin), child = core(worker, stores.worker), third = core(other, stores.other);
	await parent.connect(); await child.connect(); await third.connect();
	const parentPi = presentation(), childPi = presentation();
	const { taskId } = await parent.createTask({ target: worker, task: "work", timeoutMs: 60_000 });
	await deliverTaskInbox(childPi.pi, child, childPi.context);
	await deliverTaskInbox(parentPi.pi, parent, parentPi.context); // Drain receiver evidence.
	ops.length = 0;
	const close = () => { for (const store of Object.values(stores)) store.close(); };
	return { relay, ops, stores, parent, child, third, parentPi, childPi, taskId, close };
}
const completion = (f: Awaited<ReturnType<typeof fixture>>) => f.parent.getTask(f.taskId)!.events.find(event => event.type === "task.completed")!;

test("store presentation queue is ordered, exactly-once and transactional", () => {
	const store = createTaskStore();
	store.putTask({ taskId: "t", protocolVersion: "pi-tasks/v2", origin, target: worker, task: "x", createdAt: 1, expiresAt: 2, status: "active" });
	expect(() => store.transaction(() => { store.enqueuePresentation({ taskId: "t", eventId: "rolled-back" }); throw new Error("abort"); })).toThrow("abort");
	store.enqueuePresentation({ taskId: "t", eventId: "a" });
	store.enqueuePresentation({ taskId: "t", eventId: "b" });
	store.enqueuePresentation({ taskId: "t", eventId: "a" });
	const pending = store.pendingPresentations();
	expect(pending.map(item => [item.taskId, item.eventId])).toEqual([["t", "a"], ["t", "b"]]);
	expect(pending[0]!.order).toBeLessThan(pending[1]!.order);
	expect(() => store.transaction(() => { store.completePresentation("a"); throw new Error("abort"); })).toThrow("abort");
	expect(store.pendingPresentations()).toHaveLength(2);
	store.completePresentation("a");
	expect(store.pendingPresentations().map(item => item.eventId)).toEqual(["b"]);
	store.close();
});

test("origin canonicalizes a worker completion and returns it locally in the same receive, without a self envelope", async () => {
	const f = await fixture();
	await f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	f.ops.length = 0;
	const items = await f.parent.receive();
	const event = completion(f);
	expect(items.map(item => item.kind)).toEqual(["local"]);
	expect(items[0]).toMatchObject({ kind: "local", event });
	expect(f.ops.filter(op => op.includes(">origin"))).toEqual([]);
	expect((await f.relay.receive({ endpoint: origin, cursor: f.stores.origin.getReceiveCursor(), limit: 100 })).deliveries.filter(item => item.envelope.kind === "canonical_event")).toEqual([]);
	f.close();
});

test("parent presents a worker completion in one refresh with three origin relay operations", async () => {
	const f = await fixture();
	await f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	f.ops.length = 0;
	await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context);
	const event = completion(f);
	expect(f.parentPi.messages.map(message => [message.customType, message.details.eventId])).toEqual([["pi-tasks-event", event.eventId], ["pi-tasks-wake", event.eventId]]);
	expect(f.ops).toEqual(["receive:origin", "send:origin>worker:canonical_event", "ack:origin"]);
	// Local presentation emits no origin receipt intents or insertion evidence.
	expect(f.parent.getTask(f.taskId)!.events.filter(candidate => candidate.type === "task.delivery_receipt" && candidate.payload.eventId === event.eventId)).toEqual([]);
	expect(f.stores.origin.pendingPresentations()).toEqual([]);
	await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context);
	expect(f.parentPi.events()).toEqual([event.eventId]);
	f.close();
});

test.each(["relay-first", "local-first"] as const)("local and relay items keep arrival order (%s)", async order => {
	const f = await fixture();
	const assign = () => f.third.createTask({ target: origin, task: "nested", timeoutMs: 60_000 });
	const complete = () => f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	if (order === "relay-first") { await assign(); await complete(); } else { await complete(); await assign(); }
	await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context);
	const created = f.parent.listTasks().find(task => task.origin.id === other.id)!.events[0]!;
	const expected = order === "relay-first" ? [created.eventId, completion(f).eventId] : [completion(f).eventId, created.eventId];
	expect(f.parentPi.events()).toEqual(expected);
	f.close();
});

test("a held relay item keeps a later local item behind it", async () => {
	const f = await fixture();
	await f.third.createTask({ target: origin, task: "nested", timeoutMs: 60_000 });
	await f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	let idle = false;
	const held = presentation({ idle: () => idle });
	await deliverTaskInbox(held.pi, f.parent, held.context);
	expect(held.messages).toEqual([]);
	expect(f.stores.origin.pendingPresentations()).toHaveLength(1);
	idle = true;
	await deliverTaskInbox(held.pi, f.parent, held.context);
	const created = f.parent.listTasks().find(task => task.origin.id === other.id)!.events[0]!;
	expect(held.events()).toEqual([created.eventId, completion(f).eventId]);
	f.close();
});

test("held or partially presented local items are presented on a later refresh exactly once", async () => {
	const f = await fixture();
	await f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	let idle = false, acceptWake = false;
	const view = presentation({ idle: () => idle, acceptWake: () => acceptWake });
	await deliverTaskInbox(view.pi, f.parent, view.context);
	expect(view.messages).toEqual([]);
	idle = true;
	await deliverTaskInbox(view.pi, f.parent, view.context); // Inserted, but Pi did not accept the wake.
	expect(f.stores.origin.pendingPresentations()).toHaveLength(1);
	acceptWake = true;
	await deliverTaskInbox(view.pi, f.parent, view.context);
	await deliverTaskInbox(view.pi, f.parent, view.context);
	const event = completion(f);
	expect(view.messages.map(message => message.customType)).toEqual(["pi-tasks-event", "pi-tasks-wake", "pi-tasks-wake"]);
	expect(view.events()).toEqual([event.eventId]);
	expect(f.stores.origin.pendingPresentations()).toEqual([]);
	f.close();
});

test("parent acknowledgement works after local presentation and drains non-visible local facts", async () => {
	const f = await fixture();
	await f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context);
	await f.parent.acknowledgeParent(f.taskId);
	for (let i = 0; i < 3; i++) { await deliverTaskInbox(f.childPi.pi, f.child, f.childPi.context); await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context); }
	const events = f.parent.getTask(f.taskId)!.events;
	expect(events.some(event => event.type === "task.parent_acknowledged")).toBe(true);
	expect(events.filter(event => event.type === "task.delivery_receipt").length).toBeGreaterThan(0);
	expect(f.stores.origin.pendingPresentations()).toEqual([]);
	const archived = new Set(f.parentPi.records.flatMap(record => record.customType === "pi-tasks-event-record" ? [(record.data as TaskEventDetails).eventId] : []));
	for (const event of events.filter(candidate => candidate.type === "task.parent_acknowledged")) expect(archived.has(event.eventId)).toBe(true);
	// Delivery receipts are origin-local status: recorded in the log, never presented or archived.
	for (const event of events.filter(candidate => candidate.type === "task.delivery_receipt")) expect(archived.has(event.eventId)).toBe(false);
	expect(f.parentPi.events()).toEqual([completion(f).eventId]);
	f.close();
});

test("origin-authored information is not presented to the origin", async () => {
	const f = await fixture();
	await f.parent.submitIntent({ taskId: f.taskId, type: "task.information", payload: { message: "fyi" } });
	await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context);
	expect(f.parentPi.messages).toEqual([]);
	expect(f.stores.origin.pendingPresentations()).toEqual([]);
	await deliverTaskInbox(f.childPi.pi, f.child, f.childPi.context);
	expect(f.childPi.messages.map(message => message.customType)).toContain("pi-tasks-event");
	f.close();
});

test("a self-targeted task presents its completion once through the relay", async () => {
	const f = await fixture(), self = presentation();
	const { taskId } = await f.parent.createTask({ target: origin, task: "self", timeoutMs: 60_000 });
	await deliverTaskInbox(self.pi, f.parent, self.context);
	await f.parent.submitIntent({ taskId, type: "task.completed", payload: { summary: "done" } });
	for (let i = 0; i < 3; i++) await deliverTaskInbox(self.pi, f.parent, self.context);
	const event = f.parent.getTask(taskId)!.events.find(candidate => candidate.type === "task.completed")!;
	expect(self.events().filter(eventId => eventId === event.eventId)).toHaveLength(1);
	expect(f.stores.origin.pendingPresentations()).toEqual([]);
	f.close();
});

test("a failed raw ACK still surfaces but no longer holds back the local item it produced", async () => {
	const f = await fixture();
	await f.child.submitIntent({ taskId: f.taskId, type: "task.completed", payload: { summary: "done" } });
	const acknowledge = f.relay.acknowledgeDelivery.bind(f.relay);
	let fail = true;
	f.relay.acknowledgeDelivery = async (input) => { if (fail) throw new TaskProtocolError("RELAY_UNAVAILABLE", "fixture ack unavailable", { retryable: true }); return acknowledge(input); };
	await expect(deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context)).rejects.toThrow("fixture ack unavailable");
	expect(f.parentPi.events()).toEqual([completion(f).eventId]);
	expect(f.stores.origin.pendingPresentations()).toEqual([]);
	expect(f.stores.origin.requestedRelayAcknowledgements(f.parent.endpoint, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
	fail = false;
	await deliverTaskInbox(f.parentPi.pi, f.parent, f.parentPi.context);
	expect(f.parentPi.events()).toEqual([completion(f).eventId]);
	expect(f.stores.origin.requestedRelayAcknowledgements(f.parent.endpoint, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual([]);
	f.close();
});
