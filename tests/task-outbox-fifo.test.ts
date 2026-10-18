import { afterEach, expect, spyOn, test } from "bun:test";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { TaskEnvelopeKind, TaskProtocolError, type RelayEnvelope, type TaskRelay } from "../src/task-protocol";
import { createTaskStore } from "../src/task-store";

const origin = { relay: "memory", id: "origin" };
const receiver = { relay: "memory", id: "receiver" };

afterEach(() => { spyOn(Date, "now").mockRestore(); });

// Receiver-side relay whose next send can be refused or held; `accepted` is the order the relay took envelopes.
async function fixture() {
	const backing = createInMemoryTaskRelay("memory");
	const attempts: string[] = [], accepted: string[] = [];
	let refuseNext: TaskProtocolError | undefined, hold: Promise<void> | undefined;
	const relay: TaskRelay = {
		id: backing.id, connect: input => backing.connect(input), resolve: input => backing.resolve(input),
		receive: input => backing.receive(input), acknowledgeDelivery: input => backing.acknowledgeDelivery(input),
		send: async input => {
			attempts.push(input.envelopeId);
			const refusal = refuseNext; refuseNext = undefined;
			if (refusal) throw refusal;
			const gate = hold; hold = undefined;
			if (gate) await gate;
			const result = await backing.send(input);
			accepted.push(input.envelopeId);
			return result;
		},
	};
	const parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay: backing, store: parentStore });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore });
	await parent.connect(); await child.connect();
	const { taskId } = await parent.createTask({ target: receiver, task: "talk", timeoutMs: 600_000 });
	for (const item of await child.receive()) if (item.kind === "relay") await child.acknowledgeRelayDelivery(item.delivery.cursor);
	const say = (message: string) => child.submitIntent({ taskId, type: "task.information", payload: { message } });
	const intentId = (message: string) => childStore.outbox("pending").concat(childStore.outbox("accepted"))
		.find(record => record.envelope.kind === TaskEnvelopeKind.intent && record.envelope.payload.includes(`"message":"${message}"`))!.envelope.envelopeId;
	const messages = () => parent.getTask(taskId)!.events.filter(event => event.type === "task.information").map(event => event.payload.message);
	return {
		parent, child, childStore, attempts, accepted, say, intentId, messages,
		refuse(error: TaskProtocolError): void { refuseNext = error; },
		hold(): () => void { const gate = Promise.withResolvers<void>(); hold = gate.promise; return gate.resolve; },
		close(): void { parentStore.close(); childStore.close(); },
	};
}

test("a capacity-refused first message holds the second until it is accepted, preserving relay order after the cooldown", async () => {
	const f = await fixture();
	try {
		f.refuse(new TaskProtocolError("RELAY_CAPACITY", "mailbox full", { retryable: true }));
		await expect(f.say("one")).rejects.toMatchObject({ code: "RELAY_CAPACITY" });
		await expect(f.say("two")).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
		const one = f.intentId("one"), two = f.intentId("two");
		expect(f.attempts).toEqual([one]); // the younger envelope never reached the relay
		await expect(f.child.flushOutbox()).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" }); // still cooling down
		expect(f.accepted).toEqual([]);
		const now = Date.now();
		spyOn(Date, "now").mockImplementation(() => now + 6_000);
		await f.child.flushOutbox();
		expect(f.accepted).toEqual([one, two]);
		await f.parent.receive();
		expect(f.messages()).toEqual(["one", "two"]);
	} finally { f.close(); }
});

test("a younger message waits for an older in-flight send to the same target instead of racing it", async () => {
	const f = await fixture();
	try {
		const release = f.hold();
		const first = f.say("one");
		await Promise.resolve();
		const second = f.say("two");
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(f.attempts).toHaveLength(1);
		release();
		await first; await second;
		expect(f.accepted).toEqual([f.intentId("one"), f.intentId("two")]);
		await f.parent.receive();
		expect(f.messages()).toEqual(["one", "two"]);
	} finally { f.close(); }
});

test("a quarantined first message does not block the second", async () => {
	const f = await fixture();
	try {
		f.refuse(new TaskProtocolError("TARGET_NOT_REGISTERED", "gone", { retryable: false }));
		await expect(f.say("one")).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		expect(f.childStore.quarantinedOutbox()).toHaveLength(1);
		await f.say("two");
		expect(f.accepted).toEqual([f.intentId("two")]);
	} finally { f.close(); }
});

test("pending selection yields only the oldest pending envelope per target, transaction-safe", () => {
	const store = createTaskStore();
	const envelope = (envelopeId: string, target: typeof origin): RelayEnvelope => ({
		envelopeId, protocolVersion: "1", source: receiver, target, taskId: "t", kind: TaskEnvelopeKind.intent, payload: "{}",
	});
	try {
		store.transaction(() => { store.putOutbox(envelope("a1", origin)); store.putOutbox(envelope("a2", origin)); });
		store.putOutbox(envelope("b1", receiver));
		expect(() => store.transaction(() => { store.putOutbox(envelope("a0", origin)); throw new Error("rollback"); })).toThrow("rollback");
		expect(store.pendingOutboxAhead("a2")).toEqual(["a1"]);
		expect(store.pendingOutboxAhead("a1")).toEqual([]);
		expect(store.selectPendingOutbox(8, Date.now()).map(record => record.envelope.envelopeId).sort()).toEqual(["a1", "b1"]);
		store.markOutboxAccepted("a1");
		expect(store.pendingOutboxAhead("a2")).toEqual([]);
		expect(store.selectPendingOutbox(8, Date.now()).map(record => record.envelope.envelopeId).sort()).toEqual(["a2", "b1"]);
	} finally { store.close(); }
});
