import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piTasks, { createConfiguredCoreLoader, createSingleFlightInboxRefresh, registerAgentTaskTools } from "../src/extension";
import type { TaskCore } from "../src/task-core";
import { TASK_PROTOCOL_VERSION, TaskEnvelopeKind } from "../src/task-protocol";

interface Tool {
	readonly name: string;
	execute(id: string, parameters: Record<string, unknown>, signal: AbortSignal, update: undefined, context: unknown): Promise<{ readonly content: readonly { readonly text: string }[] }>;
}

test("default extension uses the configured Wolfpack relay adapter rather than an in-memory or missing relay", async () => {
	const previousSession = process.env.WOLFPACK_SESSION_NAME;
	delete process.env.WOLFPACK_SESSION_NAME;
	const tools: Record<string, Tool> = {};
	piTasks({ on: () => undefined, registerTool(tool: unknown) { const value = tool as Tool; tools[value.name] = value; } } as unknown as ExtensionAPI);

	const result = await tools.agent_task_send!.execute("call", { to: { relay: "wolfpack-pi-tasks-v2", id: "opaque" }, task: "implement" }, new AbortController().signal, undefined, {});

	if (previousSession === undefined) delete process.env.WOLFPACK_SESSION_NAME;
	else process.env.WOLFPACK_SESSION_NAME = previousSession;
	expect(result.content[0]?.text).toContain("WOLFPACK_SESSION_NAME is required");
});

test("starts polling after rejected startup and clears the warning after autonomous recovery", async () => {
	let sessionStart: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let sessionShutdown: (() => void) | undefined;
	let poll: (() => void) | undefined;
	let attempts = 0;
	let recovered: (() => void) | undefined;
	const recovery = new Promise<void>((resolve) => { recovered = resolve; });
	const statuses: Array<string | undefined> = [];
	const originalSetInterval = globalThis.setInterval;
	globalThis.setInterval = ((handler: (...args: unknown[]) => void) => {
		poll = (): void => handler();
		return 1 as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	const healthyCore = {
		async connect(): Promise<void> { undefined; },
		async flushOutbox(): Promise<void> { undefined; },
		async evaluateTimeouts(): Promise<void> { undefined; },
		async receive(): Promise<readonly []> { return []; },
	} as unknown as TaskCore;
	const context = {
		hasPendingMessages: (): boolean => false,
		sessionManager: { getEntries: (): readonly unknown[] => [] },
		ui: {
			setStatus: (_key: string, value: string | undefined): void => {
				statuses.push(value);
				if (value === undefined) recovered?.();
			},
			theme: { fg: (_color: string, text: string): string => text },
		},
	};

	try {
		registerAgentTaskTools({
			on(event: string, handler: unknown): void {
				if (event === "session_start") sessionStart = handler as (event: unknown, context: unknown) => Promise<unknown>;
				if (event === "session_shutdown") sessionShutdown = handler as () => void;
			},
			registerTool(): void { undefined; },
		} as unknown as ExtensionAPI, undefined, async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient relay failure");
			return healthyCore;
		});

		await sessionStart!({}, context);
		expect(statuses).toEqual(["tasks: relay unavailable"]);
		expect(poll).toBeDefined();
		poll?.();
		await recovery;
		await Promise.resolve();
		expect(attempts).toBe(2);
		expect(statuses.at(-1)).toBeUndefined();
	} finally {
		sessionShutdown?.();
		globalThis.setInterval = originalSetInterval;
	}
});

test("invalidates a pending lifecycle poll when the session shuts down", async () => {
	let sessionStart: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let agentEnd: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let sessionShutdown: (() => void) | undefined;
	let poll: (() => void) | undefined;
	let receiveCalls = 0;
	let releasePoll: (() => void) | undefined;
	let pollStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => { pollStarted = resolve; });
	const pendingPoll = new Promise<void>((resolve) => { releasePoll = resolve; });
	const statuses: Array<string | undefined> = [];
	let deliveries = 0;
	const originalSetInterval = globalThis.setInterval;
	globalThis.setInterval = ((handler: (...args: unknown[]) => void) => {
		poll = (): void => handler();
		return 1 as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	const source = { relay: "memory", id: "parent" };
	const target = { relay: "memory", id: "receiver" };
	const core = {
		async connect(): Promise<void> { undefined; },
		async flushOutbox(): Promise<void> { undefined; },
		async evaluateTimeouts(): Promise<void> { undefined; },
		async receive() {
			receiveCalls += 1;
			if (receiveCalls === 1) return [];
			pollStarted?.();
			await pendingPoll;
			return [{
				cursor: "1",
				envelope: {
					envelopeId: "late-event", protocolVersion: TASK_PROTOCOL_VERSION, source, target, taskId: "task-1", kind: TaskEnvelopeKind.canonicalEvent,
					payload: JSON.stringify({ eventId: "event-1", taskId: "task-1", type: "task.information", sequence: "1", source, target, occurredAt: 1, payload: { message: "late" } }),
				},
			}] as const;
		},
	} as unknown as TaskCore;
	const context = {
		hasPendingMessages: (): boolean => false,
		sessionManager: { getEntries: (): readonly unknown[] => [] },
		ui: {
			setStatus: (_key: string, value: string | undefined): void => { statuses.push(value); },
			theme: { fg: (_color: string, text: string): string => text },
		},
	};

	try {
		registerAgentTaskTools({
			on(event: string, handler: unknown): void {
				if (event === "session_start") sessionStart = handler as (event: unknown, context: unknown) => Promise<unknown>;
				if (event === "agent_end") agentEnd = handler as (event: unknown, context: unknown) => Promise<unknown>;
				if (event === "session_shutdown") sessionShutdown = handler as () => void;
			},
			registerTool(): void { undefined; },
			sendMessage(): void { deliveries += 1; },
		} as unknown as ExtensionAPI, core);

		await sessionStart!({}, context);
		const statusesBeforeShutdown = [...statuses];
		poll?.();
		await started;
		const joinedRefresh = agentEnd!({}, context);
		sessionShutdown?.();
		releasePoll?.();
		await expect(joinedRefresh).resolves.toBeUndefined();
		expect(deliveries).toBe(0);
		expect(statuses).toEqual(statusesBeforeShutdown);
	} finally {
		sessionShutdown?.();
		globalThis.setInterval = originalSetInterval;
	}
});

test("contains agent_end relay failures and leaves the unavailable warning", async () => {
	let sessionStart: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let agentEnd: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let sessionShutdown: (() => void) | undefined;
	const statuses: Array<string | undefined> = [];
	const context = {
		hasPendingMessages: (): boolean => false,
		sessionManager: { getEntries: (): readonly unknown[] => [] },
		ui: {
			setStatus: (_key: string, value: string | undefined): void => { statuses.push(value); },
			theme: { fg: (_color: string, text: string): string => text },
		},
	};
	registerAgentTaskTools({
		on(event: string, handler: unknown): void {
			if (event === "session_start") sessionStart = handler as (event: unknown, context: unknown) => Promise<unknown>;
			if (event === "agent_end") agentEnd = handler as (event: unknown, context: unknown) => Promise<unknown>;
			if (event === "session_shutdown") sessionShutdown = handler as () => void;
		},
		registerTool(): void { undefined; },
	} as unknown as ExtensionAPI, undefined, async () => { throw new Error("relay unavailable"); });

	try {
		await sessionStart!({}, context);
		await expect(agentEnd!({}, context)).resolves.toBeUndefined();
		expect(statuses.at(-1)).toBe("tasks: relay unavailable");
	} finally {
		sessionShutdown?.();
	}
});

test("retries a rejected configured core during a later lifecycle inbox refresh", async () => {
	let sessionStart: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let agentEnd: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	let attempts = 0;
	const calls: string[] = [];
	const healthyCore = {
		async connect(): Promise<void> { calls.push("connect"); },
		async flushOutbox(): Promise<void> { calls.push("flush"); },
		async evaluateTimeouts(): Promise<void> { calls.push("timeout"); },
		async receive(): Promise<readonly []> { calls.push("receive"); return []; },
	} as unknown as TaskCore;
	const context = {
		hasPendingMessages: (): boolean => false,
		sessionManager: { getEntries: (): readonly unknown[] => [] },
		ui: { setStatus: (): void => undefined, theme: { fg: (_color: string, text: string): string => text } },
	};
	registerAgentTaskTools({
		on(event: string, handler: unknown): void {
			if (event === "session_start") sessionStart = handler as (event: unknown, context: unknown) => Promise<unknown>;
			if (event === "agent_end") agentEnd = handler as (event: unknown, context: unknown) => Promise<unknown>;
		},
		registerTool(): void { undefined; },
	} as unknown as ExtensionAPI, undefined, async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("transient relay failure");
		return healthyCore;
	});

	await sessionStart!({}, context);
	await agentEnd!({}, context);

	expect(attempts).toBe(2);
	expect(calls).toEqual(["flush", "timeout", "receive"]);
});

test("clears a rejected configured core before retrying it", async () => {
	let attempts = 0;
	const core = {} as TaskCore;
	const configuredCore = createConfiguredCoreLoader(async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("transient relay failure");
		return core;
	});

	await expect(configuredCore()).rejects.toThrow("transient relay failure");
	await expect(configuredCore()).resolves.toBe(core);
	expect(attempts).toBe(2);
});

test("serializes concurrent inbox refreshes and accepts a new refresh only after the prior lifecycle completes", async () => {
	let calls = 0;
	let release: (() => void) | undefined;
	const refresh = createSingleFlightInboxRefresh(async () => {
		calls += 1;
		await new Promise<void>((resolve) => { release = resolve; });
	});

	const first = refresh();
	const second = refresh();
	expect(second).toBe(first);
	expect(calls).toBe(1);
	release?.();
	await first;

	const third = refresh();
	expect(third).not.toBe(first);
	expect(calls).toBe(2);
	release?.();
	await third;
});
