import { expect, test } from "bun:test";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { TASK_PROTOCOL_VERSION, TaskProtocolError, type RelayEnvelope, type TaskRelay } from "../src/task-protocol";
import { createTaskStore } from "../src/task-store";
import { createTaskWorkScope } from "../src/task-work-scope";

const origin = { relay: "memory", id: "origin" }, worker = { relay: "memory", id: "worker" }, other = { relay: "memory", id: "other" };

/** Records every send and ACK on the shared wire in call order; `fail` refuses matching sends. */
function wire(base: TaskRelay) {
	const log: string[] = [], sent: RelayEnvelope[] = [];
	let fail: (envelope: RelayEnvelope) => boolean = () => false;
	const transport: TaskRelay = {
		id: base.id, connect: (input, signal) => base.connect(input, signal), resolve: (input, signal) => base.resolve(input, signal),
		receive: (input, signal) => base.receive(input, signal),
		async send(input, signal) {
			if (fail(input)) throw new TaskProtocolError("RELAY_UNAVAILABLE", "fixture send refused", { retryable: true });
			log.push(`send:${input.target.id}:${input.kind}:${(JSON.parse(input.payload) as { type?: string }).type ?? input.kind}`); sent.push(input);
			return base.send(input, signal);
		},
		async acknowledgeDelivery(input, signal) { await base.acknowledgeDelivery(input, signal); log.push(`ack:${input.cursor}`); },
	};
	return { transport, log, sent, refuse(predicate: (envelope: RelayEnvelope) => boolean) { fail = predicate; } };
}

function session() {
	const messages: Array<{ customType: string; details: TaskEventDetails }> = [];
	const entries: unknown[] = [];
	return {
		messages,
		events: () => messages.filter(message => message.customType === "pi-tasks-event").map(message => message.details.taskId),
		wakes: () => messages.filter(message => message.customType === "pi-tasks-wake").map(message => message.details.taskId),
		pi: {
			sendMessage(message: { customType: string; details: TaskEventDetails }) { messages.push(message); entries.push({ type: "custom_message", ...message }); },
			appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		},
		context: { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } },
	};
}

/** One background refresh pass, as the extension drives it. */
async function refresh(core: ReturnType<typeof createTaskCore>, ui: ReturnType<typeof session>) {
	const work = createTaskWorkScope(undefined, "phased");
	await core.connect(work.signal, work);
	await core.evaluateTimeouts(work.signal, work);
	return deliverTaskInbox(ui.pi, core, ui.context, work.signal, work);
}

test("one refresh sends timeout fan-out, intake fan-out and receipts to one target in that order", async () => {
	const base = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore(), net = wire(base);
	const clock = { value: 1_000 };
	const parent = createTaskCore({ endpoint: origin, relay: net.transport, store: parentStore, clock: { now: () => clock.value } });
	const child = createTaskCore({ endpoint: worker, relay: base, store: childStore });
	try {
		await parent.connect(); await child.connect();
		const expiring = await parent.createTask({ target: worker, task: "expires", timeoutMs: 1_000 });
		const talking = await parent.createTask({ target: worker, task: "talks", timeoutMs: 60_000 });
		await child.receive();
		await child.submitIntent({ taskId: talking.taskId, type: "task.information", payload: { message: "raw update" } });
		const inbound = await child.createTask({ target: origin, task: "assigned to the origin", timeoutMs: 60_000 });
		clock.value += 2_000; net.log.length = 0; net.sent.length = 0;
		await refresh(parent, session());
		expect(net.log.filter(entry => entry.startsWith(`send:${worker.id}:`))).toEqual([
			"send:worker:canonical_event:task.timed_out", "send:worker:canonical_event:task.information", "send:worker:intent:task.delivery_receipt"]);
		expect(net.sent.filter(envelope => envelope.target.id === worker.id).map(envelope => envelope.taskId)).toEqual([expiring.taskId, talking.taskId, inbound.taskId]);
	} finally { parentStore.close(); childStore.close(); }
});

test("a failed receipt send withholds that item's ACK and younger ACKs behind it to the same origin, and the next refresh recovers them without duplicates", async () => {
	const base = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore(), net = wire(base);
	const parent = createTaskCore({ endpoint: origin, relay: base, store: parentStore });
	const child = createTaskCore({ endpoint: worker, relay: net.transport, store: childStore });
	try {
		await parent.connect(); await child.connect();
		const tasks: string[] = [];
		for (const task of ["one", "two", "three"]) tasks.push((await parent.createTask({ target: worker, task, timeoutMs: 60_000 })).taskId);
		const ui = session();
		net.refuse(envelope => envelope.kind === "intent" && envelope.taskId === tasks[1]);
		await expect(refresh(child, ui)).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
		const unacked = async () => (await base.receive({ endpoint: worker, cursor: "0", limit: 50 })).deliveries.map(delivery => delivery.envelope.taskId);
		// The first item is ACKed; the second keeps its relay delivery, and same-origin FIFO also holds the third.
		expect((await unacked())[0]).toBe(tasks[1]!); expect(await unacked()).not.toContain(tasks[0]!);
		expect(ui.events().slice(0, 2)).toEqual([tasks[0]!, tasks[1]!]);

		net.refuse(() => false);
		expect(await refresh(child, ui)).toBeUndefined();
		expect(await unacked()).toEqual([]);
		expect(ui.events()).toEqual(tasks);
		expect(ui.wakes()).toEqual(tasks);
		// Each item's single wake receipt was accepted exactly once.
		expect(net.sent.filter(envelope => envelope.kind === "intent").map(envelope => envelope.taskId).sort()).toEqual([...tasks].sort());
	} finally { parentStore.close(); childStore.close(); }
});

test("old-work retry starts only after required receipts and ACKs of the refresh", async () => {
	const base = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore(), net = wire(base);
	const parent = createTaskCore({ endpoint: origin, relay: base, store: parentStore });
	const child = createTaskCore({ endpoint: worker, relay: net.transport, store: childStore });
	try {
		await parent.connect(); await child.connect();
		await base.connect({ endpoint: other, receiveCursor: "0", protocolVersion: TASK_PROTOCOL_VERSION });
		net.refuse(envelope => envelope.target.id === other.id);
		await expect(child.createTask({ target: other, task: "old outgoing work", timeoutMs: 60_000 })).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
		await parent.createTask({ target: worker, task: "fresh assignment", timeoutMs: 60_000 });
		net.refuse(() => false); net.log.length = 0;
		expect(await refresh(child, session())).toBeUndefined();
		expect(net.log).toEqual(["send:origin:intent:task.delivery_receipt", "ack:1", "send:other:assignment:assignment"]);
	} finally { parentStore.close(); childStore.close(); }
});

test("receipts ship after the whole presentation, and a failed receipt to one origin holds only its own ACK", async () => {
	const base = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), otherStore = createTaskStore(), childStore = createTaskStore(), net = wire(base);
	const parent = createTaskCore({ endpoint: origin, relay: base, store: parentStore });
	const otherParent = createTaskCore({ endpoint: other, relay: base, store: otherStore });
	const child = createTaskCore({ endpoint: worker, relay: net.transport, store: childStore });
	try {
		await parent.connect(); await otherParent.connect(); await child.connect();
		// Receipts to one target keep FIFO order, so the held receipt goes to a different origin than its neighbours.
		const tasks: string[] = [];
		for (const [core, task] of [[parent, "one"], [otherParent, "two"], [parent, "three"]] as const) tasks.push((await core.createTask({ target: worker, task, timeoutMs: 60_000 })).taskId);
		const ui = session(), present = ui.pi.sendMessage;
		ui.pi.sendMessage = message => { net.log.push(`pi:${message.customType}:${message.details.taskId}`); present(message); };
		net.refuse(envelope => envelope.kind === "intent" && envelope.target.id === other.id);
		await expect(refresh(child, ui)).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
		const lastPresented = net.log.findLastIndex(entry => entry.startsWith("pi:")), firstReceipt = net.log.findIndex(entry => entry.startsWith("send:"));
		expect(lastPresented).toBe(5);
		expect(firstReceipt).toBeGreaterThan(lastPresented);
		const unacked = (await base.receive({ endpoint: worker, cursor: "0", limit: 50 })).deliveries.map(delivery => delivery.envelope.taskId);
		expect(unacked).toEqual([tasks[1]!]);

		// The re-driven item is already woken: no second wake, and its receipt is offered again, not duplicated.
		net.refuse(() => false); net.log.length = 0;
		expect(await refresh(child, ui)).toBeUndefined();
		expect(net.log.filter(entry => !entry.startsWith("ack:"))).toEqual(["send:other:intent:task.delivery_receipt"]);
		expect(ui.wakes()).toEqual(tasks);
		expect(childStore.pendingRelayDeliveries(worker)).toEqual([]);
	} finally { parentStore.close(); otherStore.close(); childStore.close(); }
});
