import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentTaskTools, WORKER_GATE_DENIAL_CODE } from "../src/extension";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore, type TaskCore } from "../src/task-core";
import { deliverTaskInbox, type TaskEventDetails } from "../src/task-inbox";
import { createTaskStore } from "../src/task-store";
import { createTaskWorkScope } from "../src/task-work-scope";

const origin = { relay: "memory", id: "origin" }, worker = { relay: "memory", id: "worker" };
type GateContext = { readonly sessionManager: { readonly getEntries: () => readonly unknown[] } };
type Gate = (event: { readonly toolName: string; readonly toolCallId: string; readonly input: unknown }, context: GateContext) => Promise<{ readonly block: true; readonly reason?: string } | undefined>;

/** A long-lived session whose entry array counts element reads; Pi returns a fresh copy of the same entry objects per call. */
function countedSession(prefix: number) {
	const entries: unknown[] = Array.from({ length: prefix }, (_, index) => index % 2
		? { type: "custom_message", customType: "pi-tasks-event", details: { taskId: `old-${index}`, eventId: `old-event-${index}` } }
		: { type: "message", message: { role: "user", content: `turn ${index}` } });
	const counter = { reads: 0 };
	const counted = (items: unknown[]) => new Proxy(items, { get(target, property, receiver) { if (typeof property === "string" && /^\d+$/.test(property)) counter.reads++; return Reflect.get(target, property, receiver); } });
	const sessionManager = { getEntries: () => counted([...entries]) };
	const pi = {
		sendMessage(message: { customType: string; details: TaskEventDetails }) { entries.push({ type: "custom_message", ...message }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	return { entries, counter, sessionManager, pi, context: { isIdle: () => true, hasPendingMessages: () => false, sessionManager } };
}

function workerGate(core: TaskCore): Gate {
	const previous = process.env.PI_TASK_WORKER;
	process.env.PI_TASK_WORKER = "1";
	let gate: Gate | undefined;
	try {
		registerAgentTaskTools({ on(event: string, handler: unknown) { if (event === "tool_call") gate = handler as Gate; }, registerTool() { undefined; } } as unknown as ExtensionAPI, core);
	} finally { if (previous === undefined) delete process.env.PI_TASK_WORKER; else process.env.PI_TASK_WORKER = previous; }
	return gate!;
}

test("a 10k-entry session is scanned once, not once per delivery or per gated tool call", async () => {
	const relay = createInMemoryTaskRelay("memory"), originStore = createTaskStore(), workerStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: originStore });
	const child = createTaskCore({ endpoint: worker, relay, store: workerStore });
	try {
		await parent.connect(); await child.connect();
		const ui = countedSession(10_000), gate = workerGate(child);
		const deliver = () => { const work = createTaskWorkScope(undefined, "phased"); return deliverTaskInbox(ui.pi, child, ui.context, work.signal, work); };
		// The first delivery and the first gate call index the existing prefix once.
		await deliver();
		expect(await gate({ toolName: "bash", toolCallId: "warm", input: {} }, ui)).toEqual({ block: true, reason: WORKER_GATE_DENIAL_CODE });
		ui.counter.reads = 0;
		const before = ui.entries.length;
		for (let index = 0; index < 5; index++) {
			await parent.createTask({ target: worker, task: `assignment ${index}`, timeoutMs: 60_000 });
			expect(await deliver()).toBeUndefined();
			expect(await gate({ toolName: "bash", toolCallId: `call-${index}`, input: {} }, ui)).toBeUndefined();
		}
		// Five assignments: an event, a wake and a relay cursor entry each.
		expect(ui.entries.slice(before).map(entry => (entry as { customType: string }).customType)).toEqual(Array.from({ length: 5 }, () => ["pi-tasks-event", "pi-tasks-wake", "pi-tasks-relay-cursor"]).flat());
		expect(ui.counter.reads).toBeLessThan(1_000);
	} finally { originStore.close(); workerStore.close(); }
});

test("a session whose entries were rewritten rather than appended is rescanned, and the gate fails closed on lost evidence", async () => {
	const relay = createInMemoryTaskRelay("memory"), originStore = createTaskStore(), workerStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: originStore });
	const child = createTaskCore({ endpoint: worker, relay, store: workerStore });
	try {
		await parent.connect(); await child.connect();
		const ui = countedSession(10), gate = workerGate(child);
		await parent.createTask({ target: worker, task: "assigned", timeoutMs: 60_000 });
		const work = createTaskWorkScope(undefined, "phased");
		expect(await deliverTaskInbox(ui.pi, child, ui.context, work.signal, work)).toBeUndefined();
		expect(await gate({ toolName: "bash", toolCallId: "open", input: {} }, ui)).toBeUndefined();
		// Same length and a new last entry: the assignment evidence is gone from the rewritten session.
		const assignment = ui.entries.findIndex(entry => (entry as { customType?: string; details?: { taskId?: string } }).customType === "pi-tasks-event" && !(entry as { details: { taskId: string } }).details.taskId.startsWith("old-"));
		ui.entries.splice(assignment, 1); ui.entries.push({ type: "message", message: { role: "user", content: "rewritten" } });
		expect(await gate({ toolName: "bash", toolCallId: "closed", input: {} }, ui)).toEqual({ block: true, reason: WORKER_GATE_DENIAL_CODE });
	} finally { originStore.close(); workerStore.close(); }
});
