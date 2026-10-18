import { afterEach, expect, jest, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ACTIVE_POLL_MS, IDLE_POLL_MS, registerAgentTaskTools } from "../src/extension";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import type { TaskRelay } from "../src/task-protocol";

interface Tool {
	readonly name: string;
	execute(id: string, parameters: Record<string, unknown>, signal: AbortSignal, update: undefined, context: unknown): Promise<unknown>;
}
type Handler = (event: unknown, context: unknown) => Promise<unknown>;

const parentEndpoint = { relay: "memory", id: "parent" };
const childEndpoint = { relay: "memory", id: "child" };

afterEach(() => { jest.useRealTimers(); });

// Drain promise continuations without advancing (fake) time.
async function settle(): Promise<void> {
	for (let i = 0; i < 200; i++) await Promise.resolve();
}

function harness() {
	const backing = createInMemoryTaskRelay("memory");
	let receives = 0, inFlight = 0, maxInFlight = 0;
	let release: (() => void) | undefined;
	let gate: Promise<void> | undefined;
	const relay: TaskRelay = {
		id: backing.id,
		connect: (input) => backing.connect(input),
		resolve: (input) => backing.resolve(input),
		send: (input) => backing.send(input),
		acknowledgeDelivery: (input) => backing.acknowledgeDelivery(input),
		receive: async (input) => {
			if (input.endpoint.id === parentEndpoint.id) {
				receives += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
				try { if (gate) await gate; return await backing.receive(input); } finally { inFlight -= 1; }
			}
			return backing.receive(input);
		},
	};
	const store = createTaskStore(), childStore = createTaskStore();
	const core = createTaskCore({ endpoint: parentEndpoint, relay, store });
	const child = createTaskCore({ endpoint: childEndpoint, relay: backing, store: childStore });
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const entries: unknown[] = [];
	registerAgentTaskTools({
		on(event: string, handler: unknown): void { handlers.set(event, handler as Handler); },
		registerTool(tool: Tool): void { tools.set(tool.name, tool); },
		sendMessage(message: unknown): void { entries.push(message); },
		appendEntry(customType: string, data: unknown): void { entries.push({ customType, data }); },
	} as unknown as ExtensionAPI, core);
	const context = {
		isIdle: (): boolean => true,
		hasPendingMessages: (): boolean => false,
		sessionManager: { getEntries: (): readonly unknown[] => entries },
		ui: { setStatus(): void { undefined; }, theme: { fg: (_color: string, text: string): string => text } },
	};
	return {
		core, child, context, handlers, tools,
		receives: (): number => receives,
		maxInFlight: (): number => maxInFlight,
		hold(): void { gate = new Promise<void>((resolve) => { release = resolve; }); },
		release(): void { gate = undefined; release?.(); },
		async start(): Promise<void> { await child.connect(); await handlers.get("session_start")!({}, context); },
		async close(): Promise<void> { await handlers.get("session_shutdown")?.({}, context); store.close(); childStore.close(); },
	};
}

test("idle endpoint polls every IDLE_POLL_MS through one timer chain", async () => {
	jest.useFakeTimers();
	const h = harness();
	try {
		await h.start();
		expect(h.receives()).toBe(1);
		jest.advanceTimersByTime(IDLE_POLL_MS - 1); await settle();
		expect(h.receives()).toBe(1);
		jest.advanceTimersByTime(1); await settle();
		expect(h.receives()).toBe(2);
		jest.advanceTimersByTime(IDLE_POLL_MS); await settle();
		expect(h.receives()).toBe(3); // exact counts prove a single poll chain (work-scope deadlines also hold fake timers)
	} finally { await h.close(); }
});

test("an active task polls every ACTIVE_POLL_MS", async () => {
	jest.useFakeTimers();
	const h = harness();
	try {
		await h.core.connect(); await h.child.connect();
		await h.core.createTask({ target: childEndpoint, task: "stay active", timeoutMs: 60_000 });
		await h.start();
		const afterStart = h.receives();
		jest.advanceTimersByTime(ACTIVE_POLL_MS - 1); await settle();
		expect(h.receives()).toBe(afterStart);
		jest.advanceTimersByTime(1); await settle();
		expect(h.receives()).toBe(afterStart + 1);
		jest.advanceTimersByTime(ACTIVE_POLL_MS); await settle();
		expect(h.receives()).toBe(afterStart + 2);
		expect(ACTIVE_POLL_MS).toBe(1_000);
		expect(IDLE_POLL_MS).toBe(5_000);
	} finally { await h.close(); }
});

test("cadence returns to idle after the task becomes terminal", async () => {
	jest.useFakeTimers();
	const h = harness();
	try {
		await h.core.connect(); await h.child.connect();
		const task = await h.core.createTask({ target: childEndpoint, task: "finish soon", timeoutMs: 60_000 });
		await h.child.receive();
		await h.start();
		await h.child.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done" } });
		jest.advanceTimersByTime(ACTIVE_POLL_MS); await settle();
		expect(h.core.getTask(task.taskId)?.status).toBe("completed");
		const afterTerminal = h.receives();
		jest.advanceTimersByTime(IDLE_POLL_MS - 1); await settle();
		expect(h.receives()).toBe(afterTerminal);
		jest.advanceTimersByTime(1); await settle();
		expect(h.receives()).toBe(afterTerminal + 1);
	} finally { await h.close(); }
});

test("agent_task_send requests an immediate refresh without waiting for the timer", async () => {
	jest.useFakeTimers();
	const h = harness();
	try {
		await h.start();
		const before = h.receives();
		await h.tools.get("agent_task_send")!.execute("call", { to: childEndpoint, task: "go" }, new AbortController().signal, undefined, h.context);
		await settle();
		expect(h.receives()).toBe(before + 1);
	} finally { await h.close(); }
});

test("turn_end requests a refresh", async () => {
	jest.useFakeTimers();
	const h = harness();
	try {
		await h.start();
		const before = h.receives();
		await h.handlers.get("turn_end")!({}, h.context);
		await settle();
		expect(h.receives()).toBe(before + 1);
	} finally { await h.close(); }
});

test("concurrent refresh requests coalesce into one trailing refresh and never overlap", async () => {
	jest.useFakeTimers();
	const h = harness();
	try {
		await h.core.connect(); await h.child.connect();
		const task = await h.core.createTask({ target: childEndpoint, task: "talk", timeoutMs: 60_000 });
		await h.start();
		const before = h.receives();
		h.hold();
		const message = h.tools.get("agent_task_message")!;
		await message.execute("call-1", { taskId: task.taskId, type: "information", message: "one" }, new AbortController().signal, undefined, h.context);
		await settle();
		expect(h.receives()).toBe(before + 1); // first request is running and held
		await message.execute("call-2", { taskId: task.taskId, type: "information", message: "two" }, new AbortController().signal, undefined, h.context);
		await message.execute("call-3", { taskId: task.taskId, type: "information", message: "three" }, new AbortController().signal, undefined, h.context);
		await h.handlers.get("turn_end")!({}, h.context);
		await settle();
		expect(h.receives()).toBe(before + 1);
		h.release(); await settle();
		expect(h.receives()).toBe(before + 2); // exactly one coalesced trailing refresh
		expect(h.maxInFlight()).toBe(1);
	} finally { h.release(); await h.close(); }
});

test("a gate-enabled worker without an eligible assignment polls every ACTIVE_POLL_MS", async () => {
	jest.useFakeTimers();
	const previous = process.env.PI_TASK_WORKER;
	process.env.PI_TASK_WORKER = "1";
	let h: ReturnType<typeof harness> | undefined;
	try {
		h = harness();
		await h.start();
		const afterStart = h.receives();
		jest.advanceTimersByTime(ACTIVE_POLL_MS); await settle();
		expect(h.receives()).toBe(afterStart + 1);
	} finally {
		if (previous === undefined) delete process.env.PI_TASK_WORKER; else process.env.PI_TASK_WORKER = previous;
		await h?.close();
	}
});

test("session shutdown cancels the background timer", async () => {
	jest.useFakeTimers();
	const h = harness();
	await h.start();
	const afterStart = h.receives();
	await h.close();
	jest.advanceTimersByTime(IDLE_POLL_MS * 3); await settle();
	expect(h.receives()).toBe(afterStart);
});

test("a failing cadence evaluation keeps polling instead of ending the timer chain", async () => {
	jest.useFakeTimers();
	const h = harness();
	const statuses: Array<string | undefined> = [];
	const context = { ...h.context, ui: { ...h.context.ui, setStatus(_key: string, status: string | undefined): void { statuses.push(status); } } };
	const pending = spyOn(h.core, "hasPendingWork").mockImplementationOnce(() => { throw new Error("snapshot failed"); });
	try {
		await h.child.connect();
		await h.handlers.get("session_start")!({}, context);
		expect(h.receives()).toBe(1);
		expect(statuses.at(-1)).toBe("tasks: local task state unreadable: snapshot failed");
		jest.advanceTimersByTime(ACTIVE_POLL_MS); await settle(); // a failed evaluation errs toward polling
		expect(h.receives()).toBe(2);
		jest.advanceTimersByTime(IDLE_POLL_MS - 1); await settle();
		expect(h.receives()).toBe(2);
		jest.advanceTimersByTime(1); await settle(); // evaluation recovered: idle cadence again
		expect(h.receives()).toBe(3);
	} finally { pending.mockRestore(); await h.handlers.get("session_shutdown")?.({}, context); await h.close(); }
});

test("a refresh failure escaping the lifecycle is logged instead of rejecting the caller, and polling continues", async () => {
	jest.useFakeTimers();
	const h = harness();
	const context = { ...h.context, ui: { ...h.context.ui, setStatus(): void { throw new Error("ui disposed"); } } };
	const logged = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await h.child.connect();
		await expect(h.handlers.get("session_start")!({}, context)).resolves.toBeUndefined();
		expect(h.receives()).toBe(1);
		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]?.[1])).toContain("ui disposed");
		jest.advanceTimersByTime(IDLE_POLL_MS); await settle(); // the fire-and-forget timer refresh fails the same way without an unhandled rejection
		expect(h.receives()).toBe(2);
		expect(logged).toHaveBeenCalledTimes(2);
	} finally { logged.mockRestore(); await h.handlers.get("session_shutdown")?.({}, context); await h.close(); }
});
