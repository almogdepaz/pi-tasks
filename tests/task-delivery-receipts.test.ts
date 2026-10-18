import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { registerAgentTaskTools } from "../src/extension";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { TaskEnvelopeKind } from "../src/task-protocol";
import { createTaskStore, type TaskStore } from "../src/task-store";

const origin = { relay: "memory", id: "origin" };
const receiver = { relay: "memory", id: "receiver" };
function ids(prefix: string) { let next = 0; return () => `${prefix}-${++next}`; }
/** Fake Pi session; `accept` decides whether Pi records an emitted message in its entries. */
function presentation() {
	const messages: Array<{ customType: string; details: TaskEventDetails }> = [];
	const entries: unknown[] = [];
	const accept = { event: true, wake: true };
	return {
		messages, accept,
		pi: {
			sendMessage(message: { customType: string; details: TaskEventDetails }) {
				messages.push(message);
				if (message.customType === "pi-tasks-wake" ? accept.wake : accept.event) entries.push({ type: "custom_message", ...message });
			},
			appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		},
		context: { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } },
	};
}
async function fixture() {
	const relay = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	await parent.connect(); await child.connect();
	const { taskId } = await parent.createTask({ target: receiver, task: "receipts", timeoutMs: 60_000 });
	return { parentStore, childStore, parent, child, taskId, close() { parentStore.close(); childStore.close(); } };
}
/** Receipt stages the receiver put on the wire, in send order. */
function sentStages(store: TaskStore): string[] {
	return [...store.outbox("pending"), ...store.outbox("accepted")]
		.filter(record => record.envelope.kind === TaskEnvelopeKind.intent)
		.map(record => JSON.parse(record.envelope.payload) as { type: string; payload: { stage: string; state: string } })
		.filter(intent => intent.type === "task.delivery_receipt")
		.map(intent => `${intent.payload.stage}:${intent.payload.state}`);
}
async function status(core: ReturnType<typeof createTaskCore>, taskId: string): Promise<unknown> {
	const tools: Record<string, { execute(...args: unknown[]): Promise<{ details: unknown }> }> = {};
	registerAgentTaskTools({ on: () => undefined, registerTool(tool: { name: string }) { tools[tool.name] = tool as never; } } as unknown as ExtensionAPI, core);
	return (await tools.agent_task_status!.execute("call", { taskId }, new AbortController().signal, undefined, {})).details;
}
const confirmed = { receiverReceipt: "confirmed", piInsertion: "confirmed", wakeAcceptance: "confirmed", modelExecution: "not_evidenced" };

test("common path sends one origin-local wake_accepted receipt that implies every earlier stage", async () => {
	const f = await fixture(), child = presentation(), parent = presentation();
	await deliverTaskInbox(child.pi, f.child, child.context);
	expect(child.messages.map(message => message.customType)).toEqual(["pi-tasks-event", "pi-tasks-wake"]);
	expect(sentStages(f.childStore)).toEqual(["wake_accepted:confirmed"]);

	await deliverTaskInbox(parent.pi, f.parent, parent.context);
	expect(f.parent.getTask(f.taskId)!.events.filter(event => event.type === "task.delivery_receipt").map(event => event.payload.stage)).toEqual(["wake_accepted"]);
	// Receipts stay at the origin: no canonical fan-out to the worker and no origin presentation.
	expect([...f.parentStore.outbox("pending"), ...f.parentStore.outbox("accepted")].map(record => record.envelope.kind)).toEqual([TaskEnvelopeKind.assignment]);
	expect(f.parentStore.pendingPresentations()).toEqual([]);
	expect(parent.messages).toEqual([]);
	expect(await status(f.parent, f.taskId)).toMatchObject({ deliveryEvidence: confirmed });

	expect(await f.child.receive()).toEqual([]);
	expect(f.child.getTask(f.taskId)!.events.map(event => event.type)).toEqual(["task.created"]);
	f.close();
});

test("blocked insertion reports receiver_recorded and pi_insertion blocked, then a later wake supersedes it", async () => {
	const f = await fixture(), child = presentation(), parent = presentation();
	child.accept.event = false;
	await deliverTaskInbox(child.pi, f.child, child.context);
	expect(sentStages(f.childStore)).toEqual(["receiver_recorded:confirmed", "pi_insertion:blocked"]);
	await deliverTaskInbox(parent.pi, f.parent, parent.context);
	expect(await status(f.parent, f.taskId)).toMatchObject({ deliveryEvidence: { receiverReceipt: "confirmed", piInsertion: "blocked", wakeAcceptance: "not_confirmed" } });

	child.accept.event = true;
	await deliverTaskInbox(child.pi, f.child, child.context);
	expect(sentStages(f.childStore)).toEqual(["receiver_recorded:confirmed", "pi_insertion:blocked", "wake_accepted:confirmed"]);
	await deliverTaskInbox(parent.pi, f.parent, parent.context);
	expect(await status(f.parent, f.taskId)).toMatchObject({ deliveryEvidence: confirmed });
	f.close();
});

test("an unobserved wake withdraws its never-sent wake_accepted record and reports insertion instead", async () => {
	const f = await fixture(), child = presentation(), parent = presentation();
	child.accept.wake = false;
	await deliverTaskInbox(child.pi, f.child, child.context);
	expect(sentStages(f.childStore)).toEqual(["pi_inserted:confirmed"]);
	expect(f.childStore.quarantinedOutbox()).toEqual([]);
	await deliverTaskInbox(parent.pi, f.parent, parent.context);
	expect(await status(f.parent, f.taskId)).toMatchObject({ deliveryEvidence: { receiverReceipt: "confirmed", piInsertion: "confirmed", wakeAcceptance: "not_confirmed" } });

	// No stale reservation survives the withdrawal: the next accepted wake still ships its receipt.
	child.accept.wake = true;
	await deliverTaskInbox(child.pi, f.child, child.context);
	expect(sentStages(f.childStore)).toEqual(["pi_inserted:confirmed", "wake_accepted:confirmed"]);
	await deliverTaskInbox(parent.pi, f.parent, parent.context);
	expect(await status(f.parent, f.taskId)).toMatchObject({ deliveryEvidence: confirmed });
	f.close();
});

test("a self-targeted task records its single receipt locally after the wake", async () => {
	const relay = createInMemoryTaskRelay("memory"), store = createTaskStore(), self = presentation();
	const core = createTaskCore({ endpoint: origin, relay, store, ids: ids("self") });
	await core.connect();
	const { taskId } = await core.createTask({ target: origin, task: "self", timeoutMs: 60_000 });
	await deliverTaskInbox(self.pi, core, self.context);
	expect(self.messages.map(message => message.customType)).toEqual(["pi-tasks-event", "pi-tasks-wake"]);
	expect(core.getTask(taskId)!.events.map(event => [event.type, event.payload.stage])).toEqual([["task.created", undefined], ["task.delivery_receipt", "wake_accepted"]]);
	expect(store.outbox("pending")).toEqual([]);
	expect(store.outbox("accepted").map(record => record.envelope.kind)).toEqual([TaskEnvelopeKind.assignment]);
	expect(await status(core, taskId)).toMatchObject({ deliveryEvidence: confirmed });
	await deliverTaskInbox(self.pi, core, self.context);
	expect(self.messages).toHaveLength(2);
	store.close();
});

test("a wake that throws withdraws its never-sent wake_accepted record before the outbox flush", async () => {
	const f = await fixture(), child = presentation();
	const send = child.pi.sendMessage;
	child.pi.sendMessage = message => { if (message.customType === "pi-tasks-wake") throw new Error("wake rejected"); send(message); };
	await expect(deliverTaskInbox(child.pi, f.child, child.context)).rejects.toThrow("wake rejected");
	expect(sentStages(f.childStore)).toEqual([]);
	child.pi.sendMessage = send;
	await deliverTaskInbox(child.pi, f.child, child.context);
	expect(sentStages(f.childStore)).toEqual(["wake_accepted:confirmed"]);
	f.close();
});
