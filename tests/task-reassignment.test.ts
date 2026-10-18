import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentTaskTools, WORKER_GATE_DENIAL_CODE } from "../src/extension";
import { createInMemoryTaskRelay, type InMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore, type TaskCore } from "../src/task-core";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { MAX_RELAY_PAYLOAD_BYTES, TASK_PROTOCOL_VERSION, TaskEnvelopeKind, TaskProtocolError, type RelayEnvelope, type TaskEndpoint, type TaskEvent, type TaskRelay } from "../src/task-protocol";
import { createTaskStore } from "../src/task-store";
import { createTaskWorkScope } from "../src/task-work-scope";

const origin = { relay: "memory", id: "origin" }, worker = { relay: "memory", id: "worker" }, successor = { relay: "memory", id: "worker-2" };

/**
 * Stands in for the server change #28 needs: a retired endpoint id resolves to its session's
 * successor, and sends to it fail as unregistered. The in-memory relay stays the conformance fixture.
 */
function replaceable(base: InMemoryTaskRelay) {
	const successors = new Map<string, TaskEndpoint>(), sent: RelayEnvelope[] = [];
	let resolves = 0;
	const relay: TaskRelay = {
		id: base.id, connect: input => base.connect(input),
		async resolve(input) {
			resolves++;
			return successors.get(input.reference) ?? base.resolve(input);
		},
		async send(input) {
			if (successors.has(input.target.id)) throw new TaskProtocolError("TARGET_NOT_REGISTERED", "target is not registered", { retryable: false, details: { targetId: input.target.id } });
			const accepted = await base.send(input);
			sent.push(input);
			return accepted;
		},
		receive: input => base.receive(input),
		acknowledgeDelivery: input => base.acknowledgeDelivery(input),
	};
	return { relay, sent, resolves: () => resolves, replace(lost: TaskEndpoint, next: TaskEndpoint) { successors.set(lost.id, next); } };
}

function session() {
	const messages: Array<{ customType: string; details: TaskEventDetails }> = [];
	const entries: unknown[] = [];
	return {
		entries,
		events: () => messages.filter(message => message.customType === "pi-tasks-event").map(message => message.details.event!),
		wakes: () => messages.filter(message => message.customType === "pi-tasks-wake").map(message => message.details.eventId),
		pi: {
			sendMessage(message: { customType: string; details: TaskEventDetails }) { messages.push(message); entries.push({ type: "custom_message", ...message }); },
			appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		},
		context: { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } },
	};
}

async function refresh(core: TaskCore, ui: ReturnType<typeof session>) {
	const work = createTaskWorkScope(undefined, "phased");
	await core.connect(work.signal, work);
	return deliverTaskInbox(ui.pi, core, ui.context, work.signal, work);
}

type GateHandler = (event: { readonly toolName: string; readonly toolCallId: string; readonly input: unknown }, context: { readonly sessionManager: { readonly getEntries: () => readonly unknown[] } }) => Promise<unknown>;

function workerGate(core: TaskCore): GateHandler {
	const previous = process.env.PI_TASK_WORKER;
	process.env.PI_TASK_WORKER = "1";
	let handler: GateHandler | undefined;
	try {
		registerAgentTaskTools({ on(event: string, candidate: unknown) { if (event === "tool_call") handler = candidate as GateHandler; }, registerTool() { undefined; } } as unknown as ExtensionAPI, core);
	} finally {
		if (previous === undefined) delete process.env.PI_TASK_WORKER; else process.env.PI_TASK_WORKER = previous;
	}
	return handler!;
}

/** Origin assigns to `worker`, they exchange a question and answer, then `worker` is replaced by `successor`. */
async function lostAssignment() {
	const base = createInMemoryTaskRelay("memory"), net = replaceable(base);
	const originStore = createTaskStore(), workerStore = createTaskStore(), successorStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay: net.relay, store: originStore });
	const child = createTaskCore({ endpoint: worker, relay: base, store: workerStore });
	const next = createTaskCore({ endpoint: successor, relay: base, store: successorStore });
	await parent.connect(); await child.connect();
	const { taskId } = await parent.createTask({ target: worker, task: "build the thing", timeoutMs: 60_000 });
	const firstUi = session();
	await refresh(child, firstUi);
	await child.submitIntent({ taskId, type: "task.question", payload: { message: "which branch?" } });
	await parent.receive();
	await parent.submitIntent({ taskId, type: "task.answer", payload: { message: "main" } });
	await child.receive();
	net.replace(worker, successor);
	await next.connect();
	return { base, net, parent, child, next, taskId, firstUi, stores: [originStore, workerStore, successorStore], close() { for (const store of [originStore, workerStore, successorStore]) store.close(); } };
}

test("a lost target's task is reassigned to the resolved successor with its history, and the successor's gate opens through the normal assignment path", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, next, taskId } = fixture;
		const gate = workerGate(next);
		const ui = session();
		expect(await gate({ toolName: "bash", toolCallId: "call", input: {} }, { sessionManager: { getEntries: () => ui.entries } })).toEqual({ block: true, reason: WORKER_GATE_DENIAL_CODE });

		// The origin learns the loss from a blocked send to the current target.
		await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: "still there?" } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		expect(await parent.reassignTask!(taskId)).toEqual({ taskId, target: successor });

		const originTask = parent.getTask(taskId)!;
		expect(originTask.target).toEqual(successor);
		const reassigned = originTask.events.at(-1)!;
		expect(reassigned).toMatchObject({ type: "task.reassigned", sequence: String(originTask.events.length), source: origin, target: successor, payload: { task: "build the thing", previousTarget: worker } });

		expect(await refresh(next, ui)).toBeUndefined();
		// Only the reassignment is presented and woken; carried history is archived in the store.
		expect(ui.events().map(event => event.eventId)).toEqual([reassigned.eventId]);
		expect(ui.wakes()).toEqual([reassigned.eventId]);
		const carried = next.getTask(taskId)!;
		expect(carried.target).toEqual(successor);
		expect(carried.status).toBe("active");
		expect(carried.events.map(event => event.type)).toEqual(["task.created", "task.question", "task.answer", "task.information", "task.reassigned"]);
		expect(carried.events.map(event => event.eventId)).toEqual(originTask.events.filter(event => event.type !== "task.delivery_receipt").map(event => event.eventId));

		expect(await gate({ toolName: "bash", toolCallId: "call", input: {} }, { sessionManager: { getEntries: () => ui.entries } })).toBeUndefined();
		// The original assignment evidence of the lost endpoint does not open the successor's gate.
		expect(await gate({ toolName: "bash", toolCallId: "call", input: {} }, { sessionManager: { getEntries: () => fixture.firstUi.entries } })).toEqual({ block: true, reason: WORKER_GATE_DENIAL_CODE });

		// The successor's receipt and completion are accepted by the origin as the current target's.
		await parent.receive();
		expect(parent.getTask(taskId)!.events.some(event => event.type === "task.delivery_receipt" && event.payload.eventId === reassigned.eventId)).toBe(true);
		await next.submitIntent({ taskId, type: "task.completed", payload: { summary: "done" } });
		await parent.receive();
		expect(parent.getTask(taskId)!.status).toBe("completed");
	} finally { fixture.close(); }
});

test("reassignment requires a recorded loss of the current target, and one loss allows one reassignment", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, child, net, taskId } = fixture;
		await expect(parent.reassignTask!(taskId)).rejects.toMatchObject({ code: "REASSIGNMENT_REFUSED", retryable: false });
		expect(net.resolves()).toBe(1);
		await expect(child.reassignTask!(taskId)).rejects.toMatchObject({ code: "NOT_ORIGIN" });

		await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: "one" } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		await parent.reassignTask!(taskId);
		const assignments = () => net.sent.filter(envelope => envelope.kind === TaskEnvelopeKind.assignment && envelope.taskId === taskId).length;
		expect(assignments()).toBe(2);
		await expect(parent.reassignTask!(taskId)).rejects.toMatchObject({ code: "REASSIGNMENT_REFUSED" });
		expect(assignments()).toBe(2);
		// The old target's quarantine no longer counts once the task moved: no second resolution.
		expect(net.resolves()).toBe(2);
	} finally { fixture.close(); }
});

test("a reassignment resolved against a target that has since moved is refused, even when the new target is lost too", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, net, taskId } = fixture;
		await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: "one" } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		// Hold every resolution until released, so two reassignments of the same loss interleave.
		const held: Array<() => void> = [], resolve = net.relay.resolve;
		net.relay.resolve = async input => { await new Promise<void>(release => held.push(release)); return resolve(input); };
		const first = parent.reassignTask!(taskId), second = parent.reassignTask!(taskId);
		await Promise.resolve();
		expect(held).toHaveLength(2);
		// The first commits and its send finds the successor gone as well, recording that loss.
		net.replace(successor, { relay: "memory", id: "worker-3" });
		held[0]!();
		await expect(first).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		expect(parent.getTask(taskId)!.target).toEqual(successor);
		held[1]!();
		await expect(second).rejects.toMatchObject({ code: "REASSIGNMENT_REFUSED" });
		expect(parent.getTask(taskId)!.events.filter(event => event.type === "task.reassigned")).toHaveLength(1);
	} finally { fixture.close(); }
});

test("a reassignment still pending delivery is not sent again", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, base, net, taskId } = fixture;
		await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: "one" } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		base.failNextSend();
		await expect(parent.reassignTask!(taskId)).rejects.toThrow();
		expect(parent.getTask(taskId)!.target).toEqual(successor);
		await expect(parent.reassignTask!(taskId)).rejects.toMatchObject({ code: "REASSIGNMENT_REFUSED" });
		await parent.flushOutbox();
		expect(net.sent.filter(envelope => envelope.kind === TaskEnvelopeKind.assignment && envelope.target.id === successor.id)).toHaveLength(1);
	} finally { fixture.close(); }
});

test("a late intent from the replaced endpoint is rejected by the origin's target fence", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, base, taskId } = fixture;
		await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: "one" } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		await parent.reassignTask!(taskId);
		const late = { envelopeId: "late", protocolVersion: TASK_PROTOCOL_VERSION, source: worker, target: origin, taskId, kind: TaskEnvelopeKind.intent,
			payload: JSON.stringify({ intentId: "late-intent", taskId, type: "task.completed", payload: { summary: "stale" } }), createdAt: new Date().toISOString() };
		await base.connect({ endpoint: worker, receiveCursor: "0", protocolVersion: TASK_PROTOCOL_VERSION });
		await base.send(late);
		await expect(parent.receive()).rejects.toMatchObject({ code: "UNAUTHORIZED_INTENT" });
		expect(parent.getTask(taskId)!.status).toBe("active");
	} finally { fixture.close(); }
});

test("a history over the payload limit carries the latest events and historyTruncated", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, next, net, taskId } = fixture;
		// Origin information to the lost target quarantines one by one; each is still canonical history.
		for (let index = 0; index < 8; index++) {
			await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: `${index}:${"x".repeat(8 * 1024)}` } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		}
		await parent.reassignTask!(taskId);
		const assignment = net.sent.findLast(envelope => envelope.kind === TaskEnvelopeKind.assignment)!;
		expect(new TextEncoder().encode(assignment.payload).byteLength).toBeLessThanOrEqual(MAX_RELAY_PAYLOAD_BYTES);
		const payload = JSON.parse(assignment.payload) as { history: TaskEvent[]; historyTruncated?: true; event: TaskEvent };
		expect(payload.historyTruncated).toBe(true);
		const origins = parent.getTask(taskId)!.events.filter(event => event.type !== "task.delivery_receipt" && event.eventId !== payload.event.eventId);
		expect(payload.history.length).toBeGreaterThan(0);
		expect(payload.history.length).toBeLessThan(origins.length);
		// The newest events are kept, in order.
		expect(payload.history.map(event => event.eventId)).toEqual(origins.slice(-payload.history.length).map(event => event.eventId));

		const ui = session();
		expect(await refresh(next, ui)).toBeUndefined();
		expect(ui.events().map(event => event.type)).toEqual(["task.reassigned"]);
		expect(next.getTask(taskId)!.events.map(event => event.eventId)).toEqual([...payload.history.map(event => event.eventId), payload.event.eventId]);
	} finally { fixture.close(); }
});

test("a receiver rejects a reassignment whose carried history belongs to another task or origin", async () => {
	const fixture = await lostAssignment();
	try {
		const { parent, next, base, net, taskId } = fixture;
		await expect(parent.submitIntent({ taskId, type: "task.information", payload: { message: "one" } })).rejects.toMatchObject({ code: "TARGET_NOT_REGISTERED" });
		await parent.reassignTask!(taskId);
		const genuine = net.sent.findLast(envelope => envelope.kind === TaskEnvelopeKind.assignment)!;
		const payload = JSON.parse(genuine.payload) as { history: TaskEvent[] };
		for (const [index, history] of [
			[payload.history[0]!, { ...payload.history[1]!, taskId: "other-task" }, ...payload.history.slice(2)],
			[payload.history[0]!, { ...payload.history[1]!, source: successor }],
			[payload.history[1]!, payload.history[0]!],
			payload.history.slice(1),
		].entries()) {
			const store = createTaskStore();
			const receiver = createTaskCore({ endpoint: successor, relay: base, store });
			const forged = { ...genuine, envelopeId: `forged-${index}`, payload: JSON.stringify({ ...JSON.parse(genuine.payload), history }) };
			await expect((async () => { await base.send(forged); await receiver.receive(); })()).rejects.toMatchObject({ code: "INVALID_ASSIGNMENT" });
			store.close();
			// Clear the forged item so the next case starts from the genuine one alone.
			const delivery = (await base.receive({ endpoint: successor, cursor: "0", limit: 50 })).deliveries.find(item => item.envelope.envelopeId === forged.envelopeId)!;
			await base.acknowledgeDelivery({ endpoint: successor, cursor: delivery.cursor, envelopeId: forged.envelopeId });
		}
		expect(await refresh(next, session())).toBeUndefined();
	} finally { fixture.close(); }
});
