import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION, TaskProtocolError } from "../src/task-protocol";
import type { TaskRelay } from "../src/task-protocol";
import { deliverTaskInbox } from "../src/task-inbox";

const origin = { relay: "memory", id: "origin" };
const receiver = { relay: "memory", id: "receiver" };

test("archives non-waking facts before ACK, deduplicates an ACK retry and retains parent acknowledgment in session history", async () => {
	const relay = createInMemoryTaskRelay("memory"), parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("archive-parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("archive-child") });
	await parent.connect(); await child.connect();
	const task = await parent.createTask({ target: receiver, task: "archive control facts", timeoutMs: 60_000 });
	await child.receive(); await child.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done" } });
	await parent.receive(); await parent.acknowledgeParent(task.taskId);
	const entries: any[] = []; let archived = false, failed = false;
	const pi = {
		sendMessage(message: any) { entries.push({ type: "custom_message", ...message }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); if (customType === "pi-tasks-event-record") archived = true; },
	};
	const context = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } };
	const acknowledge = child.acknowledgeRelayDelivery.bind(child);
	const ack = spyOn(child, "acknowledgeRelayDelivery").mockImplementation(async cursor => {
		if (archived && !failed) { failed = true; throw new Error("fixture ACK unavailable"); }
		return acknowledge(cursor);
	});
	try {
		await expect(deliverTaskInbox(pi, child, context)).rejects.toThrow("fixture ACK unavailable");
		await deliverTaskInbox(pi, child, context);
		await parent.receive(); await deliverTaskInbox(pi, child, context);
		const records = entries.filter(entry => entry.customType === "pi-tasks-event-record");
		expect(records.some(entry => entry.data.event.type === "task.parent_acknowledged")).toBe(true);
		expect(records.some(entry => entry.data.event.type === "task.delivery_receipt")).toBe(true);
		expect(new Set(records.map(entry => entry.data.eventId)).size).toBe(records.length);
		expect(records.every(entry => entry.data.event.taskId === task.taskId)).toBe(true);
		expect(entries.some(entry => entry.type === "custom_message" && entry.details?.event?.type === "task.parent_acknowledged")).toBe(false);
		const restarted = createTaskCore({ endpoint: receiver, relay, store: createTaskStore(), ids: ids("fresh") });
		expect(restarted.listTasks()).toEqual([]); // The archive does not recreate active state.
	} finally { ack.mockRestore(); parentStore.close(); childStore.close(); }
});

test("records inbound RAM state and structural session evidence before relay acknowledgement", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore(), ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore(), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	const entries: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { entries.push({ type: "custom_message", customType: message.customType, details: message.details }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };

	await deliverTaskInbox(pi, child, context);

	expect(entries).toContainEqual({ type: "custom_message", customType: "pi-tasks-event", details: expect.objectContaining({ taskId: created.taskId, eventId: "parent-2", event: expect.objectContaining({ type: "task.created", payload: expect.objectContaining({ task: "implement" }) }) }) });
	expect(relay.envelopesFor(receiver)).toHaveLength(1);
	await parent.receive();
	expect(parent.getTask(created.taskId)?.events.filter((event) => event.type === "task.delivery_receipt").map((event) => event.payload.stage)).toEqual([
		"receiver_recorded", "pi_inserted", "wake_requested", "wake_accepted",
	]);
});

test("reports receiver receipt (RAM) and blocked Pi insertion to the origin without advancing delivery", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore(), ids: ids("parent") });
	const childStore = createTaskStore();
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => [] } };
	const pi = { sendMessage(): void { undefined; }, appendEntry(): void { undefined; } };

	await deliverTaskInbox(pi, child, context);
	await deliverTaskInbox(pi, child, context);
	await parent.receive();

	expect(childStore.getReceiveCursor()).toBe("0");
	expect(parent.getTask(created.taskId)?.events.filter((event) => event.type === "task.delivery_receipt").map((event) => event.payload)).toEqual([
		expect.objectContaining({ stage: "receiver_recorded", state: "confirmed" }),
		expect.objectContaining({ stage: "pi_insertion", state: "blocked", retryable: true }),
	]);
});

test("keeps the relay delivery retryable until a separate wake is durably accepted", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore(), ids: ids("parent") });
	const childStore = createTaskStore();
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	const entries: unknown[] = [];
	let insertionAttempts = 0;
	let wakeAttempts = 0;
	let rejectWake = true;
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) {
			if (message.customType === "pi-tasks-event") insertionAttempts += 1;
			if (message.customType === "pi-tasks-wake") {
				wakeAttempts += 1;
				if (rejectWake) throw new Error("wake rejected");
			}
			entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };

	await expect(deliverTaskInbox(pi, child, context)).rejects.toThrow("wake rejected");
	expect(childStore.getReceiveCursor()).toBe("0");
	expect(insertionAttempts).toBe(1);

	rejectWake = false;
	await deliverTaskInbox(pi, child, context);
	await deliverTaskInbox(pi, child, context);
	expect(childStore.getReceiveCursor()).toBe("1");
	expect(insertionAttempts).toBe(1);
	expect(wakeAttempts).toBe(2);
	expect(entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-event" && "details" in entry && typeof entry.details === "object" && entry.details !== null && "taskId" in entry.details && entry.details.taskId === created.taskId)).toHaveLength(1);
	await parent.receive();
	expect(parent.getTask(created.taskId)?.events.filter((event) => event.type === "task.delivery_receipt").map((event) => event.payload.stage)).toEqual([
		"receiver_recorded", "pi_inserted", "wake_requested", "wake_accepted",
	]);
});

test.each(["task.completed", "task.failed", "task.cancelled", "task.timed_out"] as const)("retains an acknowledged %s event without waking the parent again", async (terminalType) => {
	const relay = createInMemoryTaskRelay("memory");
	const parentStore = createTaskStore(), childStore = createTaskStore();
	const terminalStatus = {
		"task.completed": "completed",
		"task.failed": "failed",
		"task.cancelled": "cancelled",
		"task.timed_out": "timed_out",
	} as const;
	let now = 0;
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent"), clock: { now: (): number => now } });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const entries: unknown[] = [];
	const wakes: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }, options: { readonly triggerTurn: boolean }) {
			entries.push({ type: "custom_message", ...message });
			if (options.triggerTurn) wakes.push(message);
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	let idle = false;
	const context = { isIdle: (): boolean => idle, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };
	try {
		await parent.connect(); await child.connect();
		const created = await parent.createTask({ target: receiver, task: "report a blocker", timeoutMs: 1 });
		await child.receive();
		if (terminalType === "task.timed_out") {
			now = 1;
			await parent.evaluateTimeouts();
		} else {
			await child.submitIntent({ taskId: created.taskId, type: terminalType, payload: { summary: "blocked" } });
		}

		// Background receive exposes canonical status while the parent is busy;
		// the terminal notification cannot be inserted until that turn ends.
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);
		const task = parent.getTask(created.taskId);
		expect(task?.status).toBe(terminalStatus[terminalType]);
		const terminal = task?.events.find(event => event.type === terminalType);
		if (!terminal) throw new Error("expected the canonical terminal event before notification");
		expect(entries).toEqual([]);
		await parent.acknowledgeParent(created.taskId);

		idle = true;
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);
		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "custom_message", customType: "pi-tasks-event", details: expect.objectContaining({ taskId: created.taskId, eventId: terminal.eventId, event: terminal }) }),
		]));
		expect(wakes).toEqual([]);
		expect(parent.getTask(created.taskId)?.events.filter(event => event.type === "task.delivery_receipt" && event.payload.eventId === terminal.eventId).map(event => event.payload.stage)).toEqual(["pi_inserted"]);
		expect(await parent.receive()).toEqual([]);
	} finally { parentStore.close(); childStore.close(); }
});

test("retries an acknowledged terminal relay ACK without creating a wake receipt", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const entries: unknown[] = [];
	const wakes: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }, options: { readonly triggerTurn: boolean }) {
			entries.push({ type: "custom_message", ...message });
			if (options.triggerTurn) wakes.push(message);
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	let idle = false;
	const context = { isIdle: (): boolean => idle, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };
	try {
		await parent.connect(); await child.connect();
		const created = await parent.createTask({ target: receiver, task: "report a blocker", timeoutMs: 60_000 });
		await child.receive();
		await child.submitIntent({ taskId: created.taskId, type: "task.failed", payload: { summary: "blocked" } });
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);
		const terminal = parent.getTask(created.taskId)?.events.find((event) => event.type === "task.failed");
		if (terminal === undefined) throw new Error("expected the canonical failure before acknowledgment");
		await parent.acknowledgeParent(created.taskId);

		idle = true;
		const acknowledge = parent.acknowledgeRelayDelivery.bind(parent);
		let relayAckFailed = false;
		const relayAck = spyOn(parent, "acknowledgeRelayDelivery").mockImplementation(async (cursor) => {
			if (!relayAckFailed) {
				relayAckFailed = true;
				throw new Error("fixture relay ACK unavailable");
			}
			return acknowledge(cursor);
		});
		try {
			await expect(deliverTaskInbox(pi, parent, context)).rejects.toThrow("fixture relay ACK unavailable");
			await deliverTaskInbox(pi, parent, context);
			await deliverTaskInbox(pi, parent, context);
		} finally { relayAck.mockRestore(); }

		expect(relayAckFailed).toBe(true);
		expect(wakes).toEqual([]);
		expect(parent.getTask(created.taskId)?.events.filter(event => event.type === "task.delivery_receipt" && event.payload.eventId === terminal.eventId).map(event => event.payload.stage)).toEqual(["pi_inserted"]);
		expect(await parent.receive()).toEqual([]);
	} finally { parentStore.close(); childStore.close(); }
});

test("retains an issued terminal wake when parent acknowledgment completes during deferred wake-request relay flush", async () => {
	const backing = createInMemoryTaskRelay("memory");
	let wakeRequestStarted!: () => void;
	let releaseWakeRequest!: () => void;
	const firstWakeRequest = new Promise<void>((resolve) => { wakeRequestStarted = resolve; });
	const releaseFirstWakeRequest = new Promise<void>((resolve) => { releaseWakeRequest = resolve; });
	let delayWakeRequest = true;
	const relay: TaskRelay = {
		id: backing.id,
		connect: (input) => backing.connect(input),
		resolve: (input) => backing.resolve(input),
		send: async (input) => {
			const payload = JSON.parse(input.payload) as { readonly type?: string; readonly payload?: { readonly stage?: string } };
			if (delayWakeRequest && input.source.id === origin.id && input.kind === "canonical_event" && payload.type === "task.delivery_receipt" && payload.payload?.stage === "wake_requested") {
				delayWakeRequest = false;
				wakeRequestStarted();
				await releaseFirstWakeRequest;
			}
			return backing.send(input);
		},
		receive: (input) => backing.receive(input),
		acknowledgeDelivery: (input) => backing.acknowledgeDelivery(input),
	};
	const parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const entries: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { entries.push({ type: "custom_message", ...message }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	let idle = false;
	const context = { isIdle: (): boolean => idle, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };
	try {
		await parent.connect(); await child.connect();
		const created = await parent.createTask({ target: receiver, task: "report a blocker", timeoutMs: 60_000 });
		await child.receive();
		await child.submitIntent({ taskId: created.taskId, type: "task.failed", payload: { summary: "blocked" } });
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);
		idle = true;

		const delivery = deliverTaskInbox(pi, parent, context);
		await firstWakeRequest;
		const wakesBeforeRelayFlush = entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-wake");
		await parent.acknowledgeParent(created.taskId);
		releaseWakeRequest();
		await delivery;

		expect(wakesBeforeRelayFlush).toHaveLength(1);
		expect(parent.getTask(created.taskId)?.events.some((event) => event.type === "task.parent_acknowledged")).toBe(true);
		expect(entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-wake")).toHaveLength(1);
		expect(parent.getTask(created.taskId)?.events.filter((event) => event.type === "task.delivery_receipt").map((event) => event.payload.stage)).toEqual(["pi_inserted", "wake_requested", "wake_accepted"]);
	} finally {
		releaseWakeRequest();
		parentStore.close();
		childStore.close();
	}
});

test("retries wake-request evidence after an ACK without duplicating the already-issued terminal wake", async () => {
	const backing = createInMemoryTaskRelay("memory");
	let rejectWakeRequest = true;
	const relay: TaskRelay = {
		id: backing.id,
		connect: (input) => backing.connect(input),
		resolve: (input) => backing.resolve(input),
		send: async (input) => {
			const payload = JSON.parse(input.payload) as { readonly type?: string; readonly payload?: { readonly stage?: string } };
			if (rejectWakeRequest && input.source.id === origin.id && input.kind === "canonical_event" && payload.type === "task.delivery_receipt" && payload.payload?.stage === "wake_requested") {
				throw new TaskProtocolError("RELAY_UNAVAILABLE", "wake request relay unavailable");
			}
			return backing.send(input);
		},
		receive: (input) => backing.receive(input),
		acknowledgeDelivery: (input) => backing.acknowledgeDelivery(input),
	};
	const parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const entries: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { entries.push({ type: "custom_message", ...message }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	let idle = false;
	const context = { isIdle: (): boolean => idle, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };
	try {
		await parent.connect(); await child.connect();
		const created = await parent.createTask({ target: receiver, task: "report a blocker", timeoutMs: 60_000 });
		await child.receive();
		await child.submitIntent({ taskId: created.taskId, type: "task.failed", payload: { summary: "blocked" } });
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);
		idle = true;

		await expect(deliverTaskInbox(pi, parent, context)).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE", retryable: true });
		expect(entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-wake")).toHaveLength(1);
		rejectWakeRequest = false;
		await parent.acknowledgeParent(created.taskId);
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);

		expect(entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-wake")).toHaveLength(1);
		expect(parent.getTask(created.taskId)?.events.filter((event) => event.type === "task.delivery_receipt").map((event) => event.payload.stage)).toEqual(["pi_inserted", "wake_requested", "wake_accepted"]);
	} finally { parentStore.close(); childStore.close(); }
});

test.each(["task.information", "task.question", "task.answer"] as const)("delivers parent-authored %s to the child without waking the parent through its own echo", async (type) => {
	const relay = createInMemoryTaskRelay("memory");
	const parentStore = createTaskStore(), childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const parentEntries: unknown[] = [];
	const childEntries: unknown[] = [];
	const pi = (entries: unknown[]) => ({
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { entries.push({ type: "custom_message", ...message }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	});
	const context = (entries: unknown[]) => ({ isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } });
	try {
		await parent.connect(); await child.connect();
		const created = await parent.createTask({ target: receiver, task: "answer a question", timeoutMs: 60_000 });
		await child.receive();
		await parent.submitIntent({ taskId: created.taskId, type, payload: { message: "parent-authored" } });
		const event = parent.getTask(created.taskId)?.events.at(-1);
		if (event === undefined) throw new Error("expected parent-authored canonical event");

		await deliverTaskInbox(pi(parentEntries), parent, context(parentEntries));
		await deliverTaskInbox(pi(childEntries), child, context(childEntries));

		expect(parentEntries).toEqual([]);
		expect(parent.getTask(created.taskId)?.events).toContainEqual(event);
		expect(childEntries).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "custom_message", customType: "pi-tasks-event", details: expect.objectContaining({ taskId: created.taskId, eventId: event.eventId, event }) }),
		]));
	} finally { parentStore.close(); childStore.close(); }
});

test.each(["task.information", "task.question", "task.answer"] as const)("retains origin-authored self-target %s without echoing it into the local inbox", async (type) => {
	const relay = createInMemoryTaskRelay("memory");
	const store = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store, ids: ids("parent") });
	const entries: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { entries.push({ type: "custom_message", ...message }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };
	try {
		await parent.connect();
		const created = await parent.createTask({ target: origin, task: "answer locally", timeoutMs: 60_000 });
		const assignment = (await parent.receive()).at(0);
		if (assignment === undefined) throw new Error("expected self-target assignment");
		await parent.acknowledgeRelayDelivery(assignment.cursor);
		await parent.submitIntent({ taskId: created.taskId, type, payload: { message: "origin-authored" } });
		const event = parent.getTask(created.taskId)?.events.at(-1);
		if (event === undefined) throw new Error("expected origin-authored canonical event");

		await deliverTaskInbox(pi, parent, context);

		expect(parent.getTask(created.taskId)?.events).toContainEqual(event);
		expect(entries).toEqual([]);
	} finally { store.close(); }
});

test("origin acknowledges raw receiver intents before rendering their canonical message and completion", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parentStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore(), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	const childEntries: unknown[] = [];
	const childPi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }) { childEntries.push({ type: "custom_message", customType: message.customType, details: message.details }); },
		appendEntry(customType: string, data: unknown) { childEntries.push({ type: "custom", customType, data }); },
	};
	const ready = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => childEntries } };
	await deliverTaskInbox(childPi, child, ready);
	await child.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "progress" } });
	await child.submitIntent({ taskId: created.taskId, type: "task.completed", payload: { summary: "finished" } });

	const parentEntries: unknown[] = [];
	const parentPi = {
		sendMessage(message: { readonly customType: string; readonly content: string; readonly details: unknown }) { parentEntries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details }); },
		appendEntry(customType: string, data: unknown) { parentEntries.push({ type: "custom", customType, data }); },
	};
	const parentContext = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => parentEntries } };

	await deliverTaskInbox(parentPi, parent, parentContext);

	expect(parent.getTask(created.taskId)?.status).toBe("completed");
	expect(parent.getTask(created.taskId)?.events.filter((event) => event.type === "task.delivery_receipt").map((event) => event.payload.stage)).toEqual([
		"receiver_recorded", "pi_inserted", "wake_requested", "wake_accepted",
	]);
	expect(parent.getTask(created.taskId)?.events.slice(-2).map((event) => event.type)).toEqual(["task.information", "task.completed"]);
	expect(parentStore.getReceiveCursor()).toBe("7");
	expect(parentEntries).toEqual([]);

	await deliverTaskInbox(parentPi, parent, parentContext);

	expect(parentEntries).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("progress") }),
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("finished") }),
	]));
});

test("retains retryable delivery evidence before advancing past preserved nonretryable evidence", async () => {
	const backing = createInMemoryTaskRelay("memory");
	let peerFailure: "retryable" | "blocked" | undefined;
	const relay: TaskRelay = {
		id: backing.id,
		connect: (input) => backing.connect(input),
		resolve: (input) => backing.resolve(input),
		send: async (input) => {
			if (peerFailure !== undefined && input.source.id === origin.id && input.target.id === receiver.id && input.kind === "canonical_event") {
				if (peerFailure === "retryable") throw new TaskProtocolError("RELAY_UNAVAILABLE", "relay is temporarily unavailable");
				throw new TaskProtocolError("DELIVERY_UNCONFIRMED", "peer delivery outcome is unknown", {
					retryable: false,
					details: { mayHaveBeenDelivered: true },
				});
			}
			return backing.send(input);
		},
		receive: (input) => backing.receive(input),
		acknowledgeDelivery: (input) => backing.acknowledgeDelivery(input),
	};
	const parentStore = createTaskStore();
	const childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const entries: unknown[] = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly content: string; readonly details: unknown }) {
			entries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details });
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };

	try {
		await parent.connect();
		await child.connect();
		const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
		await child.receive();
		await child.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "first" } });
		await child.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "second" } });
		expect(await parent.receive()).toEqual([]); // Canonicalize both raw intents before the peer disappears.
		const cursorBeforeEvidence = parentStore.getReceiveCursor();
		peerFailure = "retryable";

		await expect(deliverTaskInbox(pi, parent, context)).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE", retryable: true });
		expect(parentStore.getReceiveCursor()).toBe(cursorBeforeEvidence);

		peerFailure = "blocked";
		const degradation = await deliverTaskInbox(pi, parent, context);

		expect(degradation).toMatchObject({ code: "DELIVERY_UNCONFIRMED", retryable: false });
		expect(entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-event")).toHaveLength(2);
		expect(parentStore.quarantinedOutbox()).not.toHaveLength(0);
		await expect(deliverTaskInbox(pi, parent, context)).resolves.toBeUndefined();
	} finally {
		parentStore.close();
		childStore.close();
	}
});

test("origin acknowledges raw receiver intents and renders their canonical message and completion once", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore(), ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore(), ids: ids("child") });
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
	const parentContext = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => parentEntries } };

	await deliverTaskInbox(parentPi, parent, parentContext);

	expect(parentEntries).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("progress") }),
		expect.objectContaining({ type: "custom_message", content: expect.stringContaining("finished") }),
	]));
	expect(parentEntries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-event")).toHaveLength(2);
	expect(parentEntries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-wake")).toHaveLength(2);
});

test("recovers the next assignment after terminal completion, parent acknowledgement, and receiver core replacement", async () => {
	const directory = mkdtempSync("/tmp/pi-tasks-inbox-");
	const receiverPath = `${directory}/receiver.sqlite`;
	const relay = createInMemoryTaskRelay("memory");
	const parentStore = createTaskStore();
	let childStore = createTaskStore();
	const parent = createTaskCore({ endpoint: origin, relay, store: parentStore, ids: ids("parent") });
	let child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("child") });
	const entries: unknown[] = [];
	const sent: Array<{ readonly customType: string; readonly details: unknown }> = [];
	const pi = {
		sendMessage(message: { readonly customType: string; readonly details: unknown }, _options: { readonly triggerTurn: boolean }) {
			sent.push({ customType: message.customType, details: message.details });
			entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => entries } };

	try {
		await parent.connect();
		await child.connect();
		const first = await parent.createTask({ target: receiver, task: "first assignment", timeoutMs: 1_000 });
		await deliverTaskInbox(pi, child, context);
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);

		await child.submitIntent({ taskId: first.taskId, type: "task.completed", payload: { summary: "first complete" } });
		await deliverTaskInbox(pi, parent, context);
		await deliverTaskInbox(pi, parent, context);
		expect(parent.getTask(first.taskId)?.status).toBe("completed");
		await parent.acknowledgeParent(first.taskId);
		await deliverTaskInbox(pi, child, context);
		expect(child.getTask(first.taskId)?.events.map((event) => event.type)).toContain("task.parent_acknowledged");

		const second = await parent.createTask({ target: receiver, task: "second assignment after same-lifetime core replacement", timeoutMs: 1_000 });
		await child.receive();
		expect(child.getTask(second.taskId)?.status).toBe("active");
		// Replace the core object, retaining this lifetime's RAM state.
		child = createTaskCore({ endpoint: receiver, relay, store: childStore, ids: ids("restarted-child") });
		await child.connect();
		await deliverTaskInbox(pi, child, context);

		expect(entries.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "pi-tasks-event" && "details" in entry && typeof entry.details === "object" && entry.details !== null && "taskId" in entry.details && entry.details.taskId === second.taskId)).toHaveLength(1);
		expect(sent.filter((message) => message.customType === "pi-tasks-wake" && typeof message.details === "object" && message.details !== null && "taskId" in message.details && message.details.taskId === second.taskId)).toHaveLength(1);
		await deliverTaskInbox(pi, child, context);
		expect(sent.filter((message) => message.customType === "pi-tasks-wake" && typeof message.details === "object" && message.details !== null && "taskId" in message.details && message.details.taskId === second.taskId)).toHaveLength(1);
	} finally {
		childStore.close();
		parentStore.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("fails closed on an unknown canonical event without advancing the relay delivery cursor", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const parent = createTaskCore({ endpoint: origin, relay, store: createTaskStore(), ids: ids("parent") });
	const child = createTaskCore({ endpoint: receiver, relay, store: createTaskStore(), ids: ids("child") });
	await parent.connect();
	await child.connect();
	const created = await parent.createTask({ target: receiver, task: "implement", timeoutMs: 1_000 });
	await child.receive();
	await child.acknowledgeRelayDelivery("1");
	await relay.send({ envelopeId: "unknown-envelope", protocolVersion: TASK_PROTOCOL_VERSION, source: origin, target: receiver, taskId: created.taskId, kind: "canonical_event", payload: JSON.stringify({ eventId: "unknown-event", taskId: created.taskId, type: "task.unrecognized", sequence: "2", source: origin, target: receiver, occurredAt: 1, payload: {} }) });
	const pi = { sendMessage() { throw new Error("must not insert an unknown event"); }, appendEntry() { throw new Error("must not advance cursor"); } };
	const context = { isIdle: (): boolean => true, hasPendingMessages: (): boolean => false, sessionManager: { getEntries: (): readonly unknown[] => [] } };

	await expect(deliverTaskInbox(pi, child, context)).rejects.toThrow("canonical event envelope headers or payload are invalid");
	await expect(deliverTaskInbox(pi, child, context)).rejects.toThrow("canonical event envelope headers or payload are invalid");
});

function ids(prefix: string): () => string {
	let current = 0;
	return (): string => `${prefix}-${++current}`;
}
