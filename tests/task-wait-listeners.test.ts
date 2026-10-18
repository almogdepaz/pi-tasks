import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAgentTaskTools as registerV2Tools } from "../src/extension";
import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import type { TaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import type { TaskRelay } from "../src/task-protocol";
import type { TaskSnapshot } from "../src/task-protocol";

interface WaitTool {
	execute(
		id: string,
		parameters: Record<string, unknown>,
		signal: AbortSignal,
		update: ((result: unknown) => void) | undefined,
		context: unknown,
	): Promise<{ readonly details: unknown }>;
}

interface TrackedSignal {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	readonly additions: () => number;
	readonly removals: () => number;
	readonly listenerCount: () => number;
}

describe("task wait abort listeners", () => {
	test("v2 removes listeners after repeated polling and cancellation", async () => {
		let statusChecks = 0;
		const completedSignal = trackAbortListeners();
		const completedChanges = trackChangeListeners();
		const completedWait = v2WaitTool({
			getTask: () => v2Task(++statusChecks >= 3 ? "completed" : "active"),
			onChange: completedChanges.onChange,
		} as unknown as TaskCore);

		const completed = await completedWait.execute("call", { taskId: "task-1", timeoutMs: 5_000 }, completedSignal.signal, undefined, {});

		expect(completed.details).toMatchObject({ taskId: "task-1", status: "completed" });
		expect(completedSignal.additions()).toBe(2);
		expect(completedSignal.removals()).toBe(2);
		expect(completedSignal.listenerCount()).toBe(0);
		expect(completedChanges.subscriptions()).toBe(2);
		expect(completedChanges.active()).toBe(0);

		const cancelledSignal = trackAbortListeners();
		const cancelledChanges = trackChangeListeners();
		const cancelledWait = v2WaitTool({ getTask: () => v2Task("active"), onChange: cancelledChanges.onChange } as unknown as TaskCore);
		setTimeout(() => cancelledSignal.controller.abort(), 10);

		const cancelled = await cancelledWait.execute("call", { taskId: "task-1", timeoutMs: 5_000 }, cancelledSignal.signal, undefined, {});

		expect(cancelled.details).toEqual({ error: { code: "TASK_ERROR", message: "task wait was cancelled", retryable: true } });
		expect(cancelledSignal.additions()).toBe(1);
		expect(cancelledSignal.removals()).toBe(1);
		expect(cancelledSignal.listenerCount()).toBe(0);
		expect(cancelledChanges.subscriptions()).toBe(1);
		expect(cancelledChanges.active()).toBe(0);
	});

});

describe("event-driven task wait", () => {
	afterEach(() => { jest.useRealTimers(); });

	test("resolves on a store change without an extra relay request", async () => {
		jest.useFakeTimers();
		const backing = createInMemoryTaskRelay("memory");
		let parentReceives = 0;
		const relay: TaskRelay = {
			id: backing.id,
			connect: (input) => backing.connect(input),
			resolve: (input) => backing.resolve(input),
			send: (input) => backing.send(input),
			acknowledgeDelivery: (input) => backing.acknowledgeDelivery(input),
			receive: (input) => { if (input.endpoint.id === "parent") parentReceives += 1; return backing.receive(input); },
		};
		const parentStore = createTaskStore(), childStore = createTaskStore();
		const parent = createTaskCore({ endpoint: { relay: "memory", id: "parent" }, relay, store: parentStore });
		const child = createTaskCore({ endpoint: { relay: "memory", id: "child" }, relay: backing, store: childStore });
		const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
		const tools: Record<string, WaitTool> = {};
		const entries: unknown[] = [];
		registerV2Tools({
			on(event: string, handler: unknown): void { handlers.set(event, handler as (event: unknown, context: unknown) => Promise<unknown>); },
			registerTool(tool: unknown) { const registered = tool as WaitTool & { readonly name: string }; tools[registered.name] = registered; },
			sendMessage(message: unknown): void { entries.push(message); },
			appendEntry(customType: string, data: unknown): void { entries.push({ customType, data }); },
		} as unknown as ExtensionAPI, parent);
		const context = {
			isIdle: (): boolean => true,
			hasPendingMessages: (): boolean => false,
			sessionManager: { getEntries: (): readonly unknown[] => entries },
			ui: { setStatus(): void { undefined; }, theme: { fg: (_color: string, text: string): string => text } },
		};
		try {
			await parent.connect(); await child.connect();
			const task = await parent.createTask({ target: child.endpoint, task: "finish", timeoutMs: 60_000 });
			await child.receive();
			await handlers.get("session_start")!({}, context);
			const beforeWait = parentReceives;
			let settled = false;
			const waiting = tools.agent_task_wait!.execute("call", { taskId: task.taskId, timeoutMs: 30_000 }, new AbortController().signal, undefined, context)
				.finally(() => { settled = true; });
			await settle();
			expect(parentReceives).toBe(beforeWait + 1); // the single requested refresh
			expect(settled).toBe(false);
			await child.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done" } });
			await parent.receive(); // background cadence stand-in: commits the terminal event to the store
			await settle();
			expect(settled).toBe(true); // no timer advanced: the store change woke the wait
			expect((await waiting).details).toMatchObject({ taskId: task.taskId, status: "completed" });
			expect(parentReceives).toBe(beforeWait + 2);
		} finally {
			await handlers.get("session_shutdown")?.({}, context);
			parentStore.close(); childStore.close();
		}
	});

	test("backoff doubles from 250ms and caps at 2s", async () => {
		jest.useFakeTimers();
		let checks = 0;
		const changes = trackChangeListeners();
		const wait = v2WaitTool({ getTask: () => { checks += 1; return v2Task("active"); }, onChange: changes.onChange } as unknown as TaskCore);
		const controller = new AbortController();
		const waiting = wait.execute("call", { taskId: "task-1", timeoutMs: 60_000 }, controller.signal, undefined, {});
		await settle();
		const steps: Array<readonly [number, number]> = [[249, 1], [1, 2], [499, 2], [1, 3], [1_000, 4], [2_000, 5], [1_999, 5], [1, 6], [2_000, 7]];
		for (const [advance, expected] of steps) {
			jest.advanceTimersByTime(advance); await settle();
			expect(checks).toBe(expected);
		}
		controller.abort();
		expect((await waiting).details).toEqual({ error: { code: "TASK_ERROR", message: "task wait was cancelled", retryable: true } });
		expect(changes.active()).toBe(0);
	});
});

async function settle(): Promise<void> {
	for (let i = 0; i < 200; i++) await Promise.resolve();
}

function trackChangeListeners() {
	let subscriptions = 0;
	const listeners = new Set<() => void>();
	return {
		onChange(listener: () => void): () => void {
			subscriptions += 1;
			const entry = (): void => listener();
			listeners.add(entry);
			return () => { listeners.delete(entry); };
		},
		subscriptions: (): number => subscriptions,
		active: (): number => listeners.size,
	};
}

function v2WaitTool(core: TaskCore): WaitTool {
	const tools: Record<string, WaitTool> = {};
	registerV2Tools({
		on: () => undefined,
		registerTool(tool: unknown) { const registered = tool as WaitTool & { readonly name: string }; tools[registered.name] = registered; },
	} as unknown as ExtensionAPI, core);
	return tools.agent_task_wait!;
}

function trackAbortListeners(): TrackedSignal {
	const controller = new AbortController();
	const signal = controller.signal;
	const listeners = new Set<Parameters<AbortSignal["addEventListener"]>[1]>();
	let additions = 0;
	let removals = 0;
	const addEventListener = signal.addEventListener.bind(signal);
	const removeEventListener = signal.removeEventListener.bind(signal);
	Object.defineProperties(signal, {
		addEventListener: {
			value(...args: Parameters<AbortSignal["addEventListener"]>): void {
				const [type, listener] = args;
				if (type === "abort") { additions += 1; listeners.add(listener); }
				addEventListener(...args);
			},
		},
		removeEventListener: {
			value(...args: Parameters<AbortSignal["removeEventListener"]>): void {
				const [type, listener] = args;
				if (type === "abort") { removals += 1; listeners.delete(listener); }
				removeEventListener(...args);
			},
		},
	});
	return { controller, signal, additions: () => additions, removals: () => removals, listenerCount: () => listeners.size };
}

function v2Task(status: TaskSnapshot["status"]): TaskSnapshot {
	const endpoint = { relay: "memory", id: "parent" };
	return {
		taskId: "task-1",
		protocolVersion: "pi-tasks/v2",
		origin: endpoint,
		target: endpoint,
		task: "wait",
		createdAt: 0,
		expiresAt: 5_000,
		status,
		events: [],
		terminalDelivery: { state: "not_submitted" },
	};
}
